"""Local-only facade. Reads archives; capture and paid generation are explicit jobs."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import threading

from .archive import ArchiveError, archive_status, digest
from .generation import GenerationManager
from .paths import data_root
from .summaries import (TZ, available_days, day_bounds, discussion_messages, load_archive,
                        prepare_day, readable_content, summary_for_browser, display_name)
from .summarize import save

# Only expose known reader messages, never arbitrary subprocess output or paths.
READ_ERRORS = {
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
}


def safe_read_error(reason, fallback='读取未完成，已保存记录保留。请重试。'):
    return reason if isinstance(reason, str) and reason in READ_ERRORS else fallback


def now():
    return datetime.now(timezone.utc).isoformat()


class WeChatService:
    def __init__(self, root=None, read_runner=None, generation_runner=None):
        self.root = Path(root) if root else data_root()
        self.generations = GenerationManager(self.root, **({'runner': generation_runner} if generation_runner else {}))
        self.read_runner = read_runner or self._read_once
        self.guard = threading.Lock()
        self.active_read = None

    def _archive(self):
        if not (self.root / 'config.json').is_file():
            raise ArchiveError('尚未配置本机微信归档，请先接入指定账号与群。')
        return load_archive(self.root)

    def group_id(self, config):
        return 'group_' + digest([config['account_id'], config['group_id']])[:20]

    def require_group(self, value):
        config = json.loads((self.root / 'config.json').read_text(encoding='utf-8'))
        if value != self.group_id(config):
            raise ArchiveError('未找到已授权的归档群。')
        return config

    def read_jobs(self):
        rows = []
        for file in (self.root / 'read-jobs').glob('*.json'):
            job = json.loads(file.read_text(encoding='utf-8'))
            if job['status'] == 'running' and job['id'] != self.active_read:
                job = dict(job, status='unknown', error='上次读取状态待核实，请先核对归档记录。')
            rows.append(job)
        return sorted(rows, key=lambda r: r['started_at'], reverse=True)[:30]

    def context(self):
        config, messages, ranges = self._archive()
        batches = []
        for batch in archive_status(self.root / 'batches'):
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
                 'start': min((r[0] for r in ranges), default=None), 'end': max((r[1] for r in ranges), default=None),
                 'message_count': len(messages), 'account_label': '已配置账号 · ' + digest(config['account_id'])[:6],
                 'status': 'saved_pending_import' if any(b['status'] != 'imported' for b in batches) else 'imported'}
        return {'groups': [group], 'members': [{'id': k, 'name': v} for k, v in members.items()],
                'batches': batches, 'read_jobs': self.read_jobs()}

    def get(self, action, query):
        if action == 'context':
            return self.context()
        self.require_group(query.get('group'))
        if action == 'days':
            return {'days': [dict(d, ready=(self.root / 'summaries' / (d['date'] + '.json')).exists())
                             for d in available_days(self.root)]}
        day = query.get('date')
        day_bounds(day)
        if action == 'summary':
            return summary_for_browser(self.root, day)
        if action == 'generation':
            return {'job': self.generations.latest(day)}
        if action == 'original':
            prepared = prepare_day(self.root, day)
            topic = None
            if query.get('topic') is not None:
                value = query['topic']
                if not str(value).isdigit():
                    raise ArchiveError('话题不存在')
                result = summary_for_browser(self.root, day)
                topics = result.get('summary', {}).get('topics', [])
                if int(value) >= len(topics):
                    raise ArchiveError('话题不存在')
                topic = topics[int(value)]
            rows = discussion_messages(prepared, topic)
            return {'messages': rows, 'total': len(rows), 'complete': topic is None or topic['discussion_complete']}
        raise ArchiveError('接口不存在')

    def search(self, payload):
        self.require_group(payload.get('group'))
        _, messages, _ = self._archive()
        start, _ = day_bounds(payload.get('from'))
        _, end = day_bounds(payload.get('to'))
        if start >= end:
            raise ArchiveError('日期范围无效')
        keyword = payload.get('keyword', '')
        member = payload.get('member', '')
        if not isinstance(keyword, str) or len(keyword) > 200 or not isinstance(member, str):
            raise ArchiveError('筛选条件无效')
        rows = []
        for m in messages:
            key = 'm_' + digest(m['platformMessageId'])[:16]
            rows.append({'id': key, 'member': 'u_' + digest(m['sender'])[:20],
                         'sender': display_name(m['accountName'], 'p000').replace('未命名 00', '未命名群友'),
                         'time': datetime.fromtimestamp(m['timestamp'], TZ).strftime('%Y-%m-%d %H:%M:%S'),
                         'timestamp': m['timestamp'], 'content': readable_content(m['content']),
                         'reply_to': 'm_' + digest(m['replyToMessageId'])[:16] if m.get('replyToMessageId') else ''})
        anchor = payload.get('anchor')
        if anchor:
            index = next((i for i, m in enumerate(rows) if m['id'] == anchor), None)
            if index is None:
                raise ArchiveError('原文定位不存在')
            return {'messages': rows[max(0, index - 15):index + 16], 'anchor': anchor, 'total': len(rows), 'next': None}
        filtered = [m for m in rows if start <= m['timestamp'] < end and
                    (not member or m['member'] == member) and (not keyword or keyword.casefold() in m['content'].casefold())]
        offset = payload.get('offset', 0)
        if type(offset) is not int or offset < 0 or offset > len(filtered):
            raise ArchiveError('分页位置无效')
        return {'messages': filtered[offset:offset + 100], 'total': len(filtered),
                'next': offset + 100 if offset + 100 < len(filtered) else None}

    def post(self, action, payload):
        if action == 'search':
            return self.search(payload)
        self.require_group(payload.get('group'))
        if payload.get('confirmed') is not True:
            raise ArchiveError('请先确认目标与操作范围')
        if action == 'generate':
            with self.guard:
                if self.active_read or any(j['status'] == 'unknown' for j in self.read_jobs()):
                    raise ArchiveError('请等待读取完成并核对状态后再生成总结')
                return {'job': self.generations.start(payload.get('date'), payload.get('mode'), payload.get('request_id'))}
        if action == 'read':
            return {'job': self.start_read(payload)}
        raise ArchiveError('接口不存在')

    def start_read(self, payload):
        kind = payload.get('kind')
        days = payload.get('days')
        request_id = payload.get('request_id')
        if kind not in ('sync', 'import') or (days is not None and (type(days) is not int or not 1 <= days <= 365)):
            raise ArchiveError('读取范围无效')
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        with self.guard:
            target = self.root / 'read-jobs' / (request_id + '.json')
            if target.exists():
                previous = json.loads(target.read_text(encoding='utf-8'))
                if previous['kind'] != kind or previous['days'] != days or previous['group'] != payload['group']:
                    raise ArchiveError('请求标识与原任务不一致')
                return previous
            if self.active_read or any(j['status'] == 'unknown' for j in self.read_jobs()):
                raise ArchiveError('已有读取任务正在执行或待核实')
            if self.generations.active:
                raise ArchiveError('请等待本次总结完成后再更新归档')
            job = {'id': request_id, 'group': payload['group'], 'kind': kind, 'days': days,
                   'status': 'running', 'started_at': now()}
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
        if job['kind'] == 'sync' and job['days'] is not None:
            args.extend(['--days', str(job['days'])])
        try:
            result = subprocess.run(args, cwd=Path(__file__).resolve().parents[2], capture_output=True,
                                    text=True, encoding='utf-8', errors='replace', timeout=1800,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except subprocess.TimeoutExpired:
            raise ArchiveError('读取超时，请保持微信登录后重试') from None
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
        return {'status': 'imported', 'result': rows[-1].get('status', 'imported') if rows else 'imported'}

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
