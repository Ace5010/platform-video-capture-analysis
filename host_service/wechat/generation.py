"""用户主动触发的单次总结任务；持久化状态，保留旧版本。"""
from datetime import datetime, timezone
import json
from pathlib import Path
import threading
import uuid
from .archive import ArchiveError
from .summaries import prepare_day
from .summarize import run, save, check_effort, SummaryFailure

MODES = {'low': ('glm-5.3-flash', 'low'), 'high': ('hy4-preview', 'high'),
         'deepseek': ('deepseek-v4.1-flash', 'high')}


class GenerationManager:
    def __init__(self, data_dir, runner=run):
        self.root = Path(data_dir).resolve()
        self.runner = runner
        self.guard = threading.Lock()
        self.active = None

    def latest(self, day):
        files = sorted((self.root / 'generation-jobs').glob('*.json'))
        rows = [json.loads(p.read_text(encoding='utf-8')) for p in files]
        matches = [r for r in rows if r['date'] == day]
        if not matches:
            return None
        result = max(matches, key=lambda row: row['started_at'])
        if result['status'] == 'running' and result['id'] != self.active:
            result = dict(result, status='unknown', error='上次任务状态待核实，请先核对消耗，避免重复生成。')
        return result

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
            if not prepared['summarizable'] or not prepared['messages']:
                raise ArchiveError('这一天的聊天归档不完整，暂时不能总结')
            if (self.root / 'summary-runs' / (day + '.lock')).exists():
                raise ArchiveError('这一天有执行记录待核实，暂不重复调用')
            model, effort = MODES[mode]
            check_effort(model, effort)
            job = {'id': request_id, 'date': day, 'mode': mode, 'model': model, 'effort': effort,
                   'status': 'running', 'started_at': datetime.now(timezone.utc).isoformat(),
                   'partial': prepared['partial'], 'coverage_end': prepared['coverage_end']}
            save(prior, job)
            self.active = request_id
            threading.Thread(target=self._execute, args=(job,), daemon=True).start()
            return dict(job)

    def _execute(self, job):
        job = dict(job)
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
        except SummaryFailure as error:
            receipt = error.receipt
            job.update(status='failed', error=str(error))
            for key in ('run_id', 'credits', 'credit_source', 'elapsed_seconds', 'error_stage'):
                if key in receipt:
                    job[key] = receipt[key]
        except ArchiveError as error:
            job.update(status='failed', error=str(error))
        except Exception as error:
            job.update(status='failed', error=f'总结结果发布失败（{type(error).__name__}），请检查后台运行日志。')
        finally:
            job['finished_at'] = datetime.now(timezone.utc).isoformat()
            with self.guard:
                save(self.root / 'generation-jobs' / (job['id'] + '.json'), job)
                self.active = None
