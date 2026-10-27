"""Shared archive reads; local capture and paid generation are explicit jobs."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import threading
import secrets
import time
from collections import OrderedDict

from .archive import ArchiveError, archive_status, digest
from .generation import GenerationManager, MODES
from .paths import data_root
from .summaries import (TZ, available_days, day_bounds, discussion_messages, load_archive,
                        prepare_day, readable_content, summary_for_browser, display_name)
from .summarize import save, check_effort
from .resources import load_resources, browser_resources, coverage, blob_path, resource_specs, coverage_specs

# Only expose known reader messages, never arbitrary subprocess output or paths.
READ_ERRORS = {
    '图片存储已达 3 GB 上限，请先按日期清理聊天记录',
    '磁盘剩余空间不足 5 GB，已停止新增图片，请先清理空间',
    '微信未运行，请打开微信并登录后重试',
    '未找到唯一的微信主进程，请登录目标账号后重试',
    '无法核实微信进程版本', '当前进程不是已选定的微信 4.1.15.13',
    '账号目录无效', '指定账号没有所需数据库', '来源账号标识不匹配',
    '指定账号密钥不足，未切换账号或读取聊天；请检查登录和读取权限',
    '目标群在本机没有可读取的消息表',
    'WAL 头部不完整或页大小不支持', 'WAL 正在写入，请稍后重试',
    'WAL 尚无完整提交边界，请稍后重试',
    'WAL 涉及数据库收缩，当前读取器停止处理',
    'WAL 包含当前上游不能完整处理的页',
    '数据库在制作读取副本时发生变化，请重试',
    'ChatLab 本地运行组件缺失；已保存的导出文件可手动导入',
    'ChatLab 未确认完整导入；导出文件已保留，可直接重试导入',
    '读取超时，请保持微信登录后重试',
    '读取达到本次时限，已保存的消息与附件保留，可继续读取。',
    'ChatLab 官方格式校验失败，未推进读取进度',
    '消息已保存，部分附件或网页内容尚未取齐，请补取后核对。',
    '检测到电脑正在被操作，客户端补下载已暂停，已取得内容保留',
    '请先关闭已有的微信图片查看窗口，再补取附件',
    '微信控件树暂不可读取，已停止客户端补下载',
    '微信搜索未返回唯一的目标群，已停止客户端操作',
    '无法唯一定位微信读取控件，已停止补下载',
    '微信读取窗口未就绪，已停止补下载',
    '微信搜索框暂不可安全写入，已停止补下载',
    '微信窗口被其他窗口遮挡，已暂停客户端补下载',
    '指定微信进程与归档账号不一致，已停止客户端补下载',
    '归档文件持续被占用，已保留原记录，请稍后重试',
}

READ_EXCEPTION_ERRORS = {
    'PermissionError': '读取时文件被占用或访问被拒绝，已保存记录保留（PermissionError）',
    'OSError': '读取时发生文件或系统错误，已保存记录保留（OSError）',
    'MemoryError': '读取时可用内存不足，已保存记录保留（MemoryError）',
    'UnicodeEncodeError': '保存读取结果时遇到文字编码错误，已保存记录保留（UnicodeEncodeError）',
    'UnicodeDecodeError': '解析读取结果时遇到文字编码错误，已保存记录保留（UnicodeDecodeError）',
}
READ_ERRORS.update(READ_EXCEPTION_ERRORS.values())


def safe_read_error(reason, fallback='读取未完成，已保存记录保留。请重试。'):
    if not isinstance(reason, str):
        return fallback
    return reason if reason in READ_ERRORS else READ_EXCEPTION_ERRORS.get(reason, fallback)


def now():
    return datetime.now(timezone.utc).isoformat()


class WeChatService:
    def __init__(self, root=None, read_runner=None, generation_runner=None):
        self.root = Path(root) if root else data_root()
        self.generations = GenerationManager(self.root, **({'runner': generation_runner} if generation_runner else {}))
        self.read_runner = read_runner or self._read_once
        self.guard = threading.Lock()
        self.active_read = None
        self.catalog_guard = threading.RLock()
        self.children = {}
        self.candidates = {}
        self.context_guard = threading.Lock()
        self.context_cache = None
        self.data_guard = threading.RLock()
        self.archive_cache = None
        self.inventory_cache = None
        self.day_cache = OrderedDict()
        self.asset_index_cache = None
        self.queue_owner = self
        self.queue_thread = None

    def _services(self):
        services = [self] if (self.root / 'config.json').is_file() else []
        with self.catalog_guard:
            for path in sorted((self.root / 'groups').glob('group_*/config.json')):
                if path.parent.is_symlink() or not path.resolve().is_relative_to(self.root.resolve()):
                    continue
                key = path.parent.name
                if key not in self.children:
                    self.children[key] = WeChatService(path.parent, self.read_runner if self.read_runner != self._read_once else None,
                                                       self.generations.runner)
                    self.children[key].queue_owner = self
                services.append(self.children[key])
        return services

    def _service_for(self, value):
        for service in self._services():
            config = json.loads((service.root / 'config.json').read_text(encoding='utf-8'))
            if value == self.group_id(config):
                return service
        raise ArchiveError('未找到已授权的归档群。')

    def find_groups(self, payload):
        name = payload.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ArchiveError('请输入完整群名（不超过 100 字）')
        if not (self.root / 'config.json').is_file():
            raise ArchiveError('请先接入本机微信账号，再添加群。')
        config = json.loads((self.root / 'config.json').read_text(encoding='utf-8'))
        python = os.environ.get('OBSERVE_WECHAT_PYTHON') or shutil.which('python') or sys.executable
        try:
            result = subprocess.run([python, '-X', 'utf8', '-m', 'host_service.wechat.main', 'find-groups',
                                     '--config', str(self.root / 'config.json'), '--group-name', name.strip()],
                                    cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', timeout=120,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except subprocess.TimeoutExpired:
            raise ArchiveError('查找超时，请保持微信登录后重试') from None
        if result.returncode:
            for line in result.stderr.splitlines():
                try:
                    event = json.loads(line)
                    if event.get('status') in ('failed', 'incomplete'):
                        raise ArchiveError(safe_read_error(event.get('reason'), '查找群失败，请保持微信登录后重试'))
                except (ValueError, AttributeError):
                    pass
            raise ArchiveError('查找群失败，请保持微信登录后重试')
        try:
            matches = json.loads(result.stdout.splitlines()[-1])['matches']
            if not isinstance(matches, list) or len(matches) > 100:
                raise ValueError()
            if any(not isinstance(m, dict) or not isinstance(m.get('group_id'), str)
                   or not m['group_id'].endswith('@chatroom') or m.get('group_name') != name.strip() for m in matches):
                raise ValueError()
        except (ValueError, KeyError, IndexError, TypeError):
            raise ArchiveError('查找结果无效，请重试') from None
        if len(matches) > 1:
            raise ArchiveError('找到多个同名群，请先在微信修改目标群名后重新查找')
        if json.loads((self.root / 'config.json').read_text(encoding='utf-8')) != config:
            raise ArchiveError('本机微信账号配置已变化，请重新查找群')
        with self.catalog_guard:
            self.candidates = {k: v for k, v in self.candidates.items() if v['expires'] > time.monotonic()}
            self.candidates = dict(list(self.candidates.items())[-100:])
            rows = []
            configured = {g['id'] for g in self.context()['groups']}
            for match in matches:
                candidate = secrets.token_hex(16)
                self.candidates[candidate] = {'config': dict(config, **match), 'expires': time.monotonic() + 600}
                rows.append({'id': candidate, 'name': match['group_name'],
                             'added': self.group_id(dict(config, **match)) in configured})
            return {'groups': rows}

    def add_group(self, payload):
        if payload.get('confirmed') is not True:
            raise ArchiveError('请先确认目标与操作范围')
        with self.catalog_guard:
            value = payload.get('candidate')
            candidate = self.candidates.get(value) if isinstance(value, str) else None
            if not candidate or candidate['expires'] <= time.monotonic():
                raise ArchiveError('查找结果已过期，请重新查找群')
            config = dict(candidate['config'])
            current = json.loads((self.root / 'config.json').read_text(encoding='utf-8'))
            if any(current.get(k) != config.get(k) for k in ('account_id', 'account_dir', 'db_dir')):
                raise ArchiveError('本机微信账号配置已变化，请重新查找群')
            group = self.group_id(config)
            if any(group == self.group_id(json.loads((s.root / 'config.json').read_text(encoding='utf-8')))
                   for s in self._services()):
                return {'group': group, 'added': False}
            target = self.root / 'groups' / group
            config['data_dir'] = str(target.resolve())
            if target.exists():
                raise ArchiveError('群目录已存在，请核对本机配置后重试')
            save(target / 'config.json', config)
            return {'group': group, 'added': True}

    def _archive(self, batch_metadata=None):
        if not (self.root / 'config.json').is_file():
            raise ArchiveError('尚未配置本机微信归档，请先接入指定账号与群。')
        with self.data_guard:
            for _ in range(2):
                stamp = self._archive_stamp()
                if self.archive_cache is not None and self.archive_cache[0] == stamp:
                    if batch_metadata is not None:
                        batch_metadata.extend(self.archive_cache[2])
                    return self.archive_cache[1]
                metadata = []
                archive = load_archive(self.root, batch_metadata=metadata)
                if stamp != self._archive_stamp():
                    continue
                self.archive_cache = (stamp, archive, metadata)
                self.day_cache.clear()
                if batch_metadata is not None:
                    batch_metadata.extend(metadata)
                return archive
            raise ArchiveError('聊天归档正在更新，请稍后重试')

    @staticmethod
    def _file_stamp(files):
        result = []
        for path in files:
            try:
                stat = path.stat()
                result.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino))
            except FileNotFoundError:
                result.append((str(path), None))
        return tuple(result)

    def _archive_stamp(self):
        return self._file_stamp([self.root/'config.json', self.root/'cleaned-ranges.json',
                                 *sorted((self.root/'batches').glob('*.json'))])

    def _inventory(self, config):
        with self.data_guard:
            for _ in range(2):
                stamp = (self._file_stamp([self.root/'resources.json']), self.group_id(config))
                if self.inventory_cache is not None and self.inventory_cache[0] == stamp:
                    return self.inventory_cache[1]
                inventory = load_resources(self.root, config)
                if stamp[0] != self._file_stamp([self.root/'resources.json']):
                    continue
                self.inventory_cache = (stamp, inventory)
                self.day_cache.clear()
                return inventory
            raise ArchiveError('图片归档正在更新，请稍后重试')

    def _prepared_day(self, day):
        day_bounds(day)
        with self.data_guard:
            archive = self._archive()
            inventory = self._inventory(archive[0])
            key = (self.archive_cache[0], self.inventory_cache[0], datetime.now(TZ).date())
            cached = self.day_cache.get(day)
            if cached is None or cached[0] != key:
                prepared = prepare_day(self.root, day, archive=archive, inventory=inventory)
                self.day_cache[day] = (key, prepared)
            self.day_cache.move_to_end(day)
            while len(self.day_cache) > 4:
                self.day_cache.popitem(last=False)
            return self.day_cache[day][1]

    def group_id(self, config):
        return 'group_' + digest([config['account_id'], config['group_id']])[:20]

    def require_group(self, value):
        config = json.loads((self.root / 'config.json').read_text(encoding='utf-8'))
        if value != self.group_id(config):
            raise ArchiveError('未找到已授权的归档群。')
        return config

    def read_jobs(self, limit=30):
        rows = []
        for file in (self.root / 'read-jobs').glob('*.json'):
            job = json.loads(file.read_text(encoding='utf-8'))
            if job['status'] == 'running' and job['id'] != self.active_read:
                job = dict(job, status='unknown', error='上次读取状态待核实，请先核对归档记录。')
            if job.get('kind') == 'read_and_summarize':
                job = self._analysis_receipts(job)
            rows.append(job)
        ids = {row['id'] for row in rows}
        rows.extend(job for service, job in self.queue_owner._queue_entries()
                    if service == self.root and job['id'] not in ids)
        rows.sort(key=lambda r: r['started_at'], reverse=True)
        return rows if limit is None else rows[:limit]

    def summary_checkpoint(self):
        ends = []
        for file in (self.root / 'summaries').glob('*.json'):
            doc = json.loads(file.read_text(encoding='utf-8'))
            if not doc.get('source_hash') or not isinstance(doc.get('summary'), dict):
                continue
            start, end = day_bounds(file.stem)
            cutoff = doc.get('coverage_end', end if not doc.get('partial') else None)
            if type(cutoff) is int and start < cutoff <= end:
                ends.append(cutoff)
        return max(ends, default=None)

    def _analysis_receipts(self, job):
        result = dict(job)
        children = []
        for child in job.get('children', []):
            receipt = self.generations.get(child['id']) or child
            children.append({key: receipt[key] for key in (
                'id', 'date', 'status', 'model', 'credits', 'started_at', 'finished_at',
                'error', 'coverage_end', 'elapsed_seconds', 'media_credits', 'summary_credits',
                'media_models', 'known_credits', 'credits_pending') if key in receipt})
        result['children'] = children
        result['known_credits'] = round(sum(c['credits'] if c.get('credits') is not None else c.get('known_credits',0) for c in children), 6)
        result['credits_pending'] = any(c.get('credits') is None for c in children)
        result['credits'] = None if result['credits_pending'] else result['known_credits']
        return result

    def history(self):
        reads = self.read_jobs(limit=None)
        child_ids = {child['id'] for job in reads for child in job.get('children', [])}
        generations = [dict(job, kind='generate') for job in self.generations.history() if job['id'] not in child_ids]
        return sorted(reads + generations, key=lambda row: row['started_at'], reverse=True)

    def context(self, group=None):
        self._ensure_queue_worker()
        services = self._services()
        if not services:
            return {'groups': [], 'members': [], 'batches': [], 'read_jobs': []}
        selected = self._service_for(group) if group else services[0]
        contexts = [(s, s._single_context()) for s in services]
        result = next(c for s, c in contexts if s is selected)
        return dict(result, groups=[g for _, c in contexts for g in c['groups']],
                    read_jobs=sorted([j for _, c in contexts for j in c['read_jobs']],
                                     key=lambda j: j['started_at'], reverse=True))

    def _single_context(self):
        # Task progress stays live; immutable archive metadata is rebuilt only
        # when its inputs change, not once per polling request and per group.
        with self.context_guard:
            files = [self.root / 'config.json',self.root / 'cleaned-ranges.json']
            for folder in ('batches', 'receipts', 'summaries'):
                files.extend(sorted((self.root / folder).glob('*.json')))
            stamp = []
            for file in files:
                try:
                    stat = file.stat()
                    stamp.append((str(file), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino))
                except FileNotFoundError:
                    stamp.append((str(file), None))
            if self.context_cache is None or self.context_cache[0] != stamp:
                value, config, specs, message_ids = self._build_context()
                self.context_cache = (stamp, value, config, specs, message_ids)
            _, value, config, specs, _ = self.context_cache
            # Download progress changes frequently. Updating these small counts
            # must not reparse/revalidate every historical message again.
            group = dict(value['groups'][0], resource_coverage=coverage_specs(specs, self._inventory(config)))
            pending=self.root/'cleanup-pending.json'
            if pending.exists():
                info=self.root/'cleanup-pending-info.json'
                item=(json.loads(info.read_text(encoding='utf-8')) if info.exists() else
                      json.loads(pending.read_text(encoding='utf-8'))['preview'])
                group['cleanup_pending']={'from':item['from_date'],'to':item['to_date']}
            return dict(value, groups=[group], read_jobs=self.read_jobs())

    def _build_context(self):
        metadata = []
        config, messages, ranges = self._archive(batch_metadata=metadata)
        batches = []
        for batch in metadata:
            receipt = self.root / 'receipts' / (batch['batch'] + '.json')
            imported = receipt.exists() and json.loads(receipt.read_text(encoding='utf-8')).get('status') == 'imported'
            batches.append({'id': batch['batch'], 'start': batch['start'], 'end': batch['end'],
                            'status': 'imported' if imported else 'saved_pending_import'})
        members = {}
        for m in messages:
            key = 'u_' + digest(m['sender'])[:20]
            members[key] = display_name(m['accountName'], 'p000').replace('未命名 00', '未命名群友')
        # No raw account id, filesystem path, credentials or source database fields.
        group = {'id': self.group_id(config), 'name': config['group_name'],
                 'summary_end': self.summary_checkpoint(),
                 'start': min((r[0] for r in ranges), default=None), 'end': max((r[1] for r in ranges), default=None),
                 'message_count': len(messages), 'account_label': '已配置账号 · ' + digest(config['account_id'])[:6],
                 'status': 'saved_pending_import' if any(b['status'] != 'imported' for b in batches) else 'imported'}
        return ({'groups': [group], 'members': [{'id': k, 'name': v} for k, v in members.items()],
                 'batches': batches}, config, resource_specs(messages),
                frozenset(message['platformMessageId'] for message in messages))

    def get(self, action, query):
        if action == 'context':
            return self.context(query.get('group'))
        selected = self._service_for(query.get('group'))
        if selected is not self:
            return selected.get(action, query)
        self.require_group(query.get('group'))
        if action == 'asset':
            asset_id = query.get('asset', '')
            self._single_context()
            with self.context_guard:
                config, allowed_messages = self.context_cache[2], self.context_cache[4]
                context_stamp = self.context_cache[0]
            with self.data_guard:
                inventory = self._inventory(config)
                key = (context_stamp, self.inventory_cache[0])
                if self.asset_index_cache is None or self.asset_index_cache[0] != key:
                    index = {asset['id']: asset for message_id, record in inventory['messages'].items()
                             if message_id in allowed_messages for item in record['items'] for asset in item.get('assets', [])}
                    self.asset_index_cache = (key, index)
                asset = self.asset_index_cache[1].get(asset_id)
            if asset is not None:
                return blob_path(self.root, asset), asset
            raise ArchiveError('附件不存在于所选群')
        if action == 'days':
            return {'days': [dict(d, ready=(self.root / 'summaries' / (d['date'] + '.json')).exists())
                             for d in available_days(self.root, archive=self._archive())]}
        if action == 'history':
            return {'jobs': self.history()}
        day = query.get('date')
        day_bounds(day)
        if action == 'summary':
            return summary_for_browser(self.root, day, prepared=self._prepared_day(day))
        if action == 'generation':
            return {'job': self.generations.latest(day)}
        if action == 'original':
            prepared = self._prepared_day(day)
            topic = None
            if query.get('topic') is not None:
                value = query['topic']
                if not str(value).isdigit():
                    raise ArchiveError('话题不存在')
                result = summary_for_browser(self.root, day, prepared=prepared)
                topics = result.get('summary', {}).get('topics', [])
                if int(value) >= len(topics):
                    raise ArchiveError('话题不存在')
                topic = topics[int(value)]
            rows = discussion_messages(prepared, topic)
            return {'messages': rows, 'total': len(rows), 'complete': topic is None or topic['discussion_complete']}
        raise ArchiveError('接口不存在')

    def search(self, payload):
        selected = self._service_for(payload.get('group'))
        if selected is not self:
            return selected.search(payload)
        self.require_group(payload.get('group'))
        config, messages, _ = self._archive()
        inventory = self._inventory(config)
        start, _ = day_bounds(payload.get('from'))
        _, end = day_bounds(payload.get('to'))
        if start >= end:
            raise ArchiveError('日期范围无效')
        keyword = payload.get('keyword', '')
        member = payload.get('member', '')
        if not isinstance(keyword, str) or len(keyword) > 200 or not isinstance(member, str):
            raise ArchiveError('筛选条件无效')
        def display(m):
            key = 'm_' + digest(m['platformMessageId'])[:16]
            return {'id': key, 'member': 'u_' + digest(m['sender'])[:20],
                         'sender': display_name(m['accountName'], 'p000').replace('未命名 00', '未命名群友'),
                         'time': datetime.fromtimestamp(m['timestamp'], TZ).strftime('%Y-%m-%d %H:%M:%S'),
                         'timestamp': m['timestamp'], 'content': readable_content(m['content']),
                         'resources': browser_resources(m, inventory),
                         'reply_to': 'm_' + digest(m['replyToMessageId'])[:16] if m.get('replyToMessageId') else ''}
        anchor = payload.get('anchor')
        if anchor:
            index = next((i for i, m in enumerate(messages) if 'm_' + digest(m['platformMessageId'])[:16] == anchor), None)
            if index is None:
                raise ArchiveError('原文定位不存在')
            return {'messages': [display(m) for m in messages[max(0, index - 15):index + 16]],
                    'anchor': anchor, 'total': len(messages), 'next': None}
        filtered = [m for m in messages if start <= m['timestamp'] < end and
                    (not member or 'u_' + digest(m['sender'])[:20] == member) and
                    (not keyword or keyword.casefold() in readable_content(m['content']).casefold())]
        offset = payload.get('offset', 0)
        if type(offset) is not int or offset < 0 or offset > len(filtered):
            raise ArchiveError('分页位置无效')
        return {'messages': [display(m) for m in filtered[offset:offset + 100]], 'total': len(filtered),
                'next': offset + 100 if offset + 100 < len(filtered) else None}

    def post(self, action, payload):
        if action == 'search':
            return self.search(payload)
        if action == 'find-groups':
            return self.find_groups(payload)
        if action == 'add-group':
            return self.add_group(payload)
        with self.catalog_guard:
            if action == 'analyze-batch':
                return self.enqueue_analysis(payload)
            if self._pending_queue():
                raise ArchiveError('请等待排队的读取与总结完成后再执行此操作')
            selected = self._service_for(payload.get('group'))
            for service in self._services():
                if service is not selected and (service.active_read or service.generations.active
                        or any(j['status'] == 'unknown' for j in service.read_jobs())):
                    raise ArchiveError('请等待其他群的任务完成并核对状态后再执行')
            return selected._post_local(action, payload)

    def _post_local(self, action, payload):
        self.require_group(payload.get('group'))
        if payload.get('confirmed') is not True:
            raise ArchiveError('请先确认目标与操作范围')
        if action in ('cleanup-preview','cleanup'):
            from .cleanup import preview, execute
            with self.guard:
                if self.active_read or self.generations.active or any(j['status']=='unknown' for j in self.read_jobs()):
                    raise ArchiveError('请等待当前任务完成并核对状态后再清理')
                first,last=payload.get('from'),payload.get('to')
                result=(preview(self.root,first,last) if action=='cleanup-preview' else
                        execute(self.root,first,last,payload.get('token')))
                if action=='cleanup':
                    with self.context_guard:self.context_cache=None
                return result
        if (self.root/'cleanup-pending.json').exists():
            raise ArchiveError('有未完成的清理，请先按原时间段继续清理')
        if action == 'retry-image':
            from .resources import requirements
            with self.guard:
                if self.active_read or self.generations.active or any(j['status']=='unknown' for j in self.read_jobs()):
                    raise ArchiveError('请等待当前任务完成后重试图片')
                config, messages, _ = self._archive()
                target = next((m for m in messages if 'm_' + digest(m['platformMessageId'])[:16] == payload.get('message')), None)
                if target is None or not any(s['kind']=='image' for s in requirements(target)):
                    raise ArchiveError('图片消息不存在于所选群')
                self.read_runner(dict(kind='resources', message=payload['message'], days=None))
                return {'message': payload['message'], 'resources': browser_resources(target, self._inventory(config))}
        if action == 'generate':
            with self.guard:
                if self.active_read or any(j['status'] == 'unknown' for j in self.read_jobs()):
                    raise ArchiveError('请等待读取完成并核对状态后再生成总结')
                return {'job': self.generations.start(payload.get('date'), payload.get('mode'), payload.get('request_id'))}
        if action == 'read':
            return {'job': self.start_read(payload)}
        if action == 'analyze':
            return {'job': self.start_analysis(payload)}
        raise ArchiveError('接口不存在')

    def _queue_batches(self):
        path = self.root / 'analysis-queue.json'
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else []

    def _queue_entries(self):
        # The manifest is committed atomically before any work starts. Never
        # resolve arbitrary filesystem paths from an incoming request.
        for batch in self._queue_batches():
            for job in batch['jobs']:
                yield self._service_for(job['group']).root, dict(job)

    def _pending_queue(self):
        return any(not (root / 'read-jobs' / (job['id'] + '.json')).exists()
                   for root, job in self._queue_entries())

    def enqueue_analysis(self, payload):
        groups = payload.get('groups')
        request_id = payload.get('request_id')
        if payload.get('confirmed') is not True:
            raise ArchiveError('请先确认目标与操作范围')
        if (not isinstance(groups, list) or not groups or len(groups) > 100
                or any(not isinstance(group, str) for group in groups) or len(set(groups)) != len(groups)):
            raise ArchiveError('请选择不重复的群聊（最多 100 个）')
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        spec = {key: payload.get(key) for key in ('groups', 'scope', 'date', 'mode')}
        batches = self._queue_batches()
        previous = next((batch for batch in batches if batch['id'] == request_id), None)
        if previous:
            if previous['spec'] != spec:
                raise ArchiveError('请求标识与原任务不一致')
            jobs = previous['jobs']
        else:
            jobs = []
            for group in groups:
                service = self._service_for(group)
                if any(job['status'] in ('queued', 'running', 'unknown') for job in service.read_jobs(limit=None)):
                    raise ArchiveError('所选群已有排队、执行中或待核实的任务')
                if (service.root / 'cleanup-pending.json').exists():
                    raise ArchiveError('所选群有未完成的清理，请先继续清理')
                job = service.start_analysis(dict(payload, group=group,
                    request_id=digest(['batch', request_id, group])[:32]), prepare_only=True)
                jobs.append(dict(job, status='queued', phase='queued', batch_id=request_id))
            batches.append(dict(id=request_id, spec=spec, jobs=jobs))
            save(self.root / 'analysis-queue.json', batches)
        self._ensure_queue_worker()
        receipts = {job['id']: job for service in self._services() for job in service.read_jobs(limit=None)}
        return {'jobs': [receipts.get(job['id'], job) for job in jobs]}

    def _ensure_queue_worker(self):
        if self.queue_owner is not self:
            return
        with self.catalog_guard:
            if self.queue_thread is not None and self.queue_thread.is_alive():
                return
            if not self._pending_queue():
                return
            self.queue_thread = threading.Thread(target=self._run_queue, daemon=True)
            self.queue_thread.start()

    def _run_queue(self):
        while True:
            with self.catalog_guard:
                services = self._services()
                # An interrupted paid job needs reconciliation, never an
                # automatic retry. Pending entries remain durable and visible.
                if any(any(j['status'] == 'unknown' for j in service.read_jobs(limit=None))
                       or any(j['status'] == 'unknown' for j in service.generations.history()) for service in services):
                    self.queue_thread = None
                    return
                busy = any(service.active_read or service.generations.active for service in services)
                pending = next(((root, job) for root, job in self._queue_entries()
                                if not (root / 'read-jobs' / (job['id'] + '.json')).exists()), None)
                if pending is None:
                    self.queue_thread = None
                    return
                if not busy:
                    _, job = pending
                    service = self._service_for(job['group'])
                    with service.guard:
                        job.update(status='running', phase='reading', queued_at=job['started_at'], started_at=now())
                        save(service.root / 'read-jobs' / (job['id'] + '.json'), job)
                        service.active_read = job['id']
            if busy:
                time.sleep(.1)
            else:
                service._execute_analysis(job)

    def start_analysis(self, payload, prepare_only=False):
        scope, mode, request_id = payload.get('scope'), payload.get('mode'), payload.get('request_id')
        if scope not in ('continue', 'all', 'date') or mode not in MODES:
            raise ArchiveError('请选择有效的总结范围与模型')
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        day = payload.get('date') if scope == 'date' else None
        if scope == 'date':
            day_bounds(day)
        with self.guard:
            target = self.root / 'read-jobs' / (request_id + '.json')
            if target.exists():
                previous = json.loads(target.read_text(encoding='utf-8'))
                if any(previous.get(k) != v for k, v in dict(kind='read_and_summarize', scope=scope,
                       mode=mode, date=day, group=payload['group']).items()):
                    raise ArchiveError('请求标识与原任务不一致')
                if previous['status'] == 'running' and self.active_read != request_id:
                    previous = dict(previous, status='unknown', error='上次读取状态待核实，请先核对归档记录。')
                return self._analysis_receipts(previous)
            if not prepare_only and (self.active_read or self.generations.active or any(j['status'] == 'unknown' for j in self.read_jobs())):
                raise ArchiveError('已有任务正在执行或待核实')
            if any(j['status'] == 'unknown' for j in self.generations.history()):
                raise ArchiveError('上次总结状态待核实，请先核对消耗，避免重复生成')
            end = int(time.time())
            checkpoint = self.summary_checkpoint()
            start = 0
            if scope == 'date':
                start, day_end = day_bounds(day)
                end = min(end, day_end)
            elif scope == 'continue':
                if checkpoint is None:
                    raise ArchiveError('还没有成功总结，请先选择全部聊天或指定日期')
                start = checkpoint
            if not 0 <= start < end:
                raise ArchiveError('该范围暂时没有可读取的聊天')
            model, effort = MODES[mode]
            check_effort(model, effort)
            # Re-read the boundary day's context so its daily brief can be
            # updated with images and replies; immutable batches deduplicate it.
            capture_start = day_bounds(datetime.fromtimestamp(start, TZ).strftime('%Y-%m-%d'))[0] if start else 0
            job = dict(id=request_id, group=payload['group'], kind='read_and_summarize', scope=scope,
                       date=day, mode=mode, model=model, start=start, end=end, capture_start=max(0, capture_start),
                       status='running', phase='reading', started_at=now(), children=[], credits=0)
            if prepare_only:
                return job
            save(target, job)
            self.active_read = request_id
            threading.Thread(target=self._execute_analysis, args=(job,), daemon=True).start()
            return dict(job)

    def _execute_analysis(self, job):
        job = dict(job)
        path = self.root / 'read-jobs' / (job['id'] + '.json')
        def persist():
            job.update(self._analysis_receipts(job))
            save(path, job)
        try:
            result = self.read_runner(dict(job, kind='sync', days=None, start=job['capture_start']))
            if result.get('status') != 'imported':
                job.update(status=result.get('status', 'failed'), error=safe_read_error(
                    result.get('error'), '部分聊天内容读取失败，总结尚未开始。'))
                return
            job['resource_coverage'] = result.get('resource_coverage', {})
            config, messages, _ = self._archive()
            job['message_count'] = sum(job['start'] <= m['timestamp'] < job['end'] for m in messages)
            candidates = [d['date'] for d in available_days(self.root)
                          if day_bounds(d['date'])[0] < job['end'] and day_bounds(d['date'])[1] > job['start']]
            job.update(phase='summarizing', dates=candidates)
            persist()
            for day in candidates:
                prepared = prepare_day(self.root, day)
                existing = self.root / 'summaries' / (day + '.json')
                if job['scope'] == 'continue' and existing.exists():
                    doc = json.loads(existing.read_text(encoding='utf-8'))
                    if doc.get('source_hash') == prepared['source_hash']:
                        continue
                child_id = digest([job['id'], day])[:32]
                child = dict(id=child_id, date=day, model=job['model'], status='pending', credits=0)
                job['children'].append(child)
                job['current_date'] = day
                persist()
                try:
                    self.generations.start(day, job['mode'], child_id)
                except ArchiveError as exc:
                    job['children'][-1].update(status='failed', error=str(exc), credits=0)
                    raise
                while True:
                    receipt = self.generations.get(child_id)
                    if receipt and receipt['status'] != 'running':
                        break
                    time.sleep(.1)
                persist()
                if receipt['status'] != 'complete':
                    job.update(status=receipt['status'], error=receipt.get('error', '总结未完成，已保留记录与消耗。'))
                    return
            job.update(status='complete', phase='complete')
        except ArchiveError as exc:
            job.update(status='failed', error=str(exc))
        except Exception:
            job.update(status='failed', error='本次读取与总结未完成，已保存内容和消耗记录保留。')
        finally:
            job.update(finished_at=now(), elapsed_seconds=round(
                (datetime.now(timezone.utc) - datetime.fromisoformat(job['started_at'])).total_seconds(), 2))
            with self.guard:
                try:
                    persist()
                finally:
                    self.active_read = None

    def start_read(self, payload):
        kind = payload.get('kind')
        days = payload.get('days')
        images_only = payload.get('images_only', False)
        if type(images_only) is not bool or (images_only and kind != 'resources'):
            raise ArchiveError('读取范围无效')
        request_id = payload.get('request_id')
        if kind not in ('sync', 'import', 'resources') or (days is not None and (type(days) is not int or not 1 <= days <= 365)):
            raise ArchiveError('读取范围无效')
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        with self.guard:
            target = self.root / 'read-jobs' / (request_id + '.json')
            if target.exists():
                previous = json.loads(target.read_text(encoding='utf-8'))
                if (previous['kind'] != kind or previous['days'] != days or previous['group'] != payload['group']
                        or previous.get('images_only',False) != images_only):
                    raise ArchiveError('请求标识与原任务不一致')
                return previous
            if self.active_read or any(j['status'] == 'unknown' for j in self.read_jobs()):
                raise ArchiveError('已有读取任务正在执行或待核实')
            if self.generations.active:
                raise ArchiveError('请等待本次总结完成后再更新归档')
            job = {'id': request_id, 'group': payload['group'], 'kind': kind, 'days': days,
                   'status': 'running', 'started_at': now()}
            if images_only:
                job['images_only'] = True
            save(target, job)
            self.active_read = request_id
            threading.Thread(target=self._execute_read, args=(job,), daemon=True).start()
            return dict(job)

    def _read_once(self, job):
        # Reuse the existing reader's Python runtime; do not install packages
        # into the independent video host environment.
        python = os.environ.get('OBSERVE_WECHAT_PYTHON') or shutil.which('python') or sys.executable
        args = [python, '-X', 'utf8', '-m', 'host_service.wechat.main', job['kind'],
                '--config', str(self.root / 'config.json')]
        if job.get('message'):
            args.extend(['--message', job['message'], '--images-only'])
        elif job.get('images_only'):
            args.append('--images-only')
        if job['kind'] == 'sync' and job['days'] is not None:
            args.extend(['--days', str(job['days'])])
        elif job['kind'] == 'sync' and job.get('start') is not None and job.get('end') is not None:
            args.extend(['--start', str(job['start']), '--end', str(job['end'])])
        # Background reading must not take over WeChat's mixed image/video
        # viewer. Its previous/next navigation can download excluded videos.
        # Read local originals in a batch; keep missing resources explicit.
        try:
            result = subprocess.run(args, cwd=Path(__file__).resolve().parents[2], capture_output=True,
                                    text=True, encoding='utf-8', errors='replace', timeout=180 if job.get('message') else 1800,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except subprocess.TimeoutExpired:
            raise ArchiveError('读取达到本次时限，已保存的消息与附件保留，可继续读取。') from None
        if result.returncode:
            for line in result.stderr.splitlines():
                try:
                    event = json.loads(line)
                    if event.get('status') == 'incomplete':
                        return {'status': 'incomplete', 'error': safe_read_error(event.get('reason'), '本次读取不完整，请稍后重试。')}
                    if event.get('status') == 'failed':
                        raise ArchiveError(safe_read_error(event.get('reason')))
                except (ValueError, AttributeError):
                    pass
            raise ArchiveError('读取未完成；已保存的归档保留，可核对记录后重试。')
        rows = []
        for line in result.stdout.splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        last = rows[-1] if rows else {}
        if last.get('status') == 'incomplete':
            return {'status': 'incomplete', 'error': safe_read_error(last.get('client_error'),
                    '消息已保存，部分附件或网页内容尚未取齐，请补取后核对。')}
        if last.get('status') not in ('imported', 'no_messages', 'up_to_date'):
            raise ArchiveError('读取进程没有返回完整的归档确认，已保留原记录。')
        return {'status': 'imported', 'result': last['status'],
                'resource_coverage': last.get('resource_coverage', {})}

    def _execute_read(self, job):
        job = dict(job)
        try:
            result = self.read_runner(job)
            job.update(status=result.get('status', 'imported'))
            if result.get('error'):
                job['error'] = safe_read_error(result['error'], '本次读取不完整，请稍后重试。')
        except Exception as exc:
            # Capture failure never advances the archive's success boundary.
            try:
                pending = any(b['status'] != 'imported' for b in self.context()['batches'])
            except Exception:
                pending = False
            job.update(status='saved_pending_import' if pending else 'failed',
                       error=safe_read_error(str(exc)) if isinstance(exc, ArchiveError) else '读取未完成，已保存记录保留。请重试。')
        finally:
            job['finished_at'] = now()
            with self.guard:
                save(self.root / 'read-jobs' / (job['id'] + '.json'), job)
                self.active_read = None
