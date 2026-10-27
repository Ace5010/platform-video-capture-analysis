"""用户主动触发的单次总结任务；持久化状态，保留旧版本。"""
from datetime import datetime, timezone
import json
from pathlib import Path
import threading
import uuid
from .archive import ArchiveError
from .summaries import prepare_day
from .summarize import run, save, check_effort, SummaryFailure, parse_result
from .resources import require_summary_resources
from .models import require_input

RECEIPT_FIELDS = ('run_id', 'credits', 'credit_source', 'elapsed_seconds', 'error_stage',
                  'media_credits', 'summary_credits', 'media_models', 'known_credits', 'credits_pending')

MODES = {'low': ('glm-5.3-flash', 'low'), 'high': ('hy4-preview', 'high'),
         'deepseek': ('deepseek-v4.1-flash', 'high')}


class GenerationManager:
    def __init__(self, data_dir, runner=run):
        self.root = Path(data_dir).resolve()
        self.runner = runner
        self.guard = threading.Lock()
        self.active = None

    def latest(self, day):
        matches = [r for r in self.history() if r['date'] == day]
        if not matches:
            return None
        return max(matches, key=lambda row: row['started_at'])

    def recover(self, request_id):
        """Revalidate a paid result locally; keep the failed receipt as evidence."""
        with self.guard:
            if self.active or any(job['status'] in ('running', 'unknown') for job in self.history()):
                raise ArchiveError('请等待总结任务结束并核对状态后恢复')
            job = self.get(request_id)
            if not job or job['status'] != 'failed' or not job.get('run_id'):
                raise ArchiveError('没有可恢复的失败总结')
            folder = (self.root / 'summary-runs' / job['run_id']).resolve()
            if not folder.is_relative_to((self.root / 'summary-runs').resolve()):
                raise ArchiveError('总结执行记录无效')
            record = json.loads((folder / 'receipt.json').read_text(encoding='utf-8'))
            if record.get('error_stage') != 'validate' or record.get('exit_code') != 0:
                raise ArchiveError('本次没有可复用的完整模型输出')
            lock = self.root / 'summary-runs' / (job['date'] + '.lock')
            if lock.exists():
                locked_at = datetime.fromisoformat(lock.read_text(encoding='utf-8'))
                if abs((locked_at - datetime.fromisoformat(record['started_at'])).total_seconds()) > 1:
                    raise ArchiveError('当前锁属于另一项执行记录，不能恢复')
            prepared = prepare_day(self.root, job['date'])
            if record['source_hash'] != prepared['source_hash']:
                raise ArchiveError('归档已变化，不能用旧结果覆盖新内容')
            mapping = json.loads((folder / 'reference-map.json').read_text(encoding='utf-8'))
            if mapping['source_hash'] != prepared['source_hash']:
                raise ArchiveError('总结编号映射与当前归档不一致')
            if record.get('images') and record.get('image_count_submitted') != len(record['images']):
                raise ArchiveError('原图片请求尚未核实，不能恢复')
            outer, summary = parse_result((folder / 'stdout.json').read_text(encoding='utf-8-sig'), prepared, mapping['references'])
            doc = dict(date=job['date'], source_hash=prepared['source_hash'], run_id=job['run_id'],
                       summary=summary, partial=prepared['partial'], coverage_end=prepared['coverage_end'],
                       missing_resources=record.get('missing_resources', []), resource_coverage=record.get('resource_coverage', {}))
            audit = folder / 'local-recovery.json'
            if audit.exists():
                raise ArchiveError('已有恢复记录，请先核对发布状态')
            save(audit, dict(original_job=job, repairs=outer['local_repairs'], recovered_at=datetime.now(timezone.utc).isoformat(), additional_credits=0))
            target = self.root / 'summaries' / (job['date'] + '.json')
            if target.exists():
                save(folder / 'before-local-recovery-summary.json', json.loads(target.read_text(encoding='utf-8')))
            save(self.root / 'summary-variants' / job['date'] / ('ui-' + job['id'] + '.json'), doc)
            save(target, doc)
            job.update(status='complete', recovered_error=job.pop('error', None), recovered_at=datetime.now(timezone.utc).isoformat())
            save(self.root / 'generation-jobs' / (job['id'] + '.json'), job)
            if lock.exists():
                lock.rename(folder / 'resolved-by-local-recovery.lock')
            return job

    def get(self, request_id):
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        path = self.root / 'generation-jobs' / (request_id + '.json')
        if not path.is_file():
            return None
        result = json.loads(path.read_text(encoding='utf-8'))
        if result['status'] == 'running' and result['id'] != self.active:
            result = dict(result, status='unknown', error='上次任务状态待核实，请先核对消耗，避免重复生成。')
        return result

    def history(self):
        return sorted((self.get(p.stem) for p in (self.root / 'generation-jobs').glob('*.json')),
                      key=lambda row: row['started_at'], reverse=True)

    def start(self, day, mode, request_id):
        if mode not in MODES:
            raise ArchiveError('请选择有效的总结方式')
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
            raise ArchiveError('请求标识无效')
        with self.guard:
            prior = self.root / 'generation-jobs' / (request_id + '.json')
            if prior.exists():
                existing = json.loads(prior.read_text(encoding='utf-8'))
                if existing['date'] != day or existing['mode'] != mode:
                    raise ArchiveError('请求标识已被另一项任务使用')
                return existing
            if self.active:
                raise ArchiveError('已有总结正在生成，请等待完成')
            previous = self.latest(day)
            if previous and previous['status'] == 'unknown':
                raise ArchiveError('上次任务状态待核实，请先核对消耗，避免重复生成')
            prepared = prepare_day(self.root, day)
            require_summary_resources(prepared, allow_missing=True)
            images = any(asset.get('mime','').startswith('image/') for message in prepared['messages']
                         for resource in message.get('resources',[]) for asset in resource.get('assets',[]))
            if not prepared['summarizable'] or not prepared['messages']:
                raise ArchiveError('这一天的聊天归档不完整，暂时不能总结')
            if (self.root / 'summary-runs' / (day + '.lock')).exists():
                raise ArchiveError('这一天有执行记录待核实，暂不重复调用')
            model, effort = MODES[mode]
            check_effort(model, effort)
            if images:
                require_input(model, 'image')
            job = {'id': request_id, 'date': day, 'mode': mode, 'model': model, 'effort': effort,
                   'status': 'running', 'started_at': datetime.now(timezone.utc).isoformat(),
                   'partial': prepared['partial'], 'coverage_end': prepared['coverage_end']}
            save(prior, job)
            self.active = request_id
            threading.Thread(target=self._execute, args=(job,), daemon=True).start()
            return dict(job)

    def _execute(self, job):
        job = dict(job)
        result = None
        try:
            variant = 'ui-' + job['id']
            result = self.runner(job['date'], model=job['model'], effort=job['effort'],
                                 data_dir=self.root, variant=variant)
            generated = self.root / 'summary-variants' / job['date'] / (variant + '.json')
            doc = json.loads(generated.read_text(encoding='utf-8'))
            target = self.root / 'summaries' / (job['date'] + '.json')
            if target.exists():
                save(self.root / 'summary-variants' / job['date'] / ('before-' + job['id'] + '.json'),
                     json.loads(target.read_text(encoding='utf-8')))
            save(target, doc)
            job.update(status='complete', credits=result.get('credits'), elapsed_seconds=result.get('elapsed_seconds'), run_id=result['run_id'])
            job.update({key: result[key] for key in RECEIPT_FIELDS if key in result})
        except SummaryFailure as error:
            receipt = error.receipt
            job.update(status='failed', error=str(error))
            for key in RECEIPT_FIELDS:
                if key in receipt:
                    job[key] = receipt[key]
        except ArchiveError as error:
            job.update(status='failed', error=str(error))
        except Exception as error:
            action = '总结结果发布失败' if result is not None else '总结执行失败'
            job.update(status='failed', error=f'{action}（{type(error).__name__}），请检查后台运行日志。')
            if result is not None:
                for key in RECEIPT_FIELDS:
                    if key in result:
                        job[key] = result[key]
        finally:
            job['finished_at'] = datetime.now(timezone.utc).isoformat()
            with self.guard:
                save(self.root / 'generation-jobs' / (job['id'] + '.json'), job)
                self.active = None
