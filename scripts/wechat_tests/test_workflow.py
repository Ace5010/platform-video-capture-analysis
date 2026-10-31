"""Isolated capture → daily summaries → persisted receipts; no WeChat or model access."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from host_service.wechat.archive import ArchiveError, build_export, save_export
from host_service.wechat.service import WeChatService
from host_service.wechat.summaries import day_bounds, prepare_day
from host_service.wechat.summarize import save, SummaryFailure


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        save(self.root / 'config.json', dict(account_id='account', group_id='group@chatroom', group_name='测试群'))
        self.days = ['2026-10-20', '2026-10-21']
        self.reads, self.calls = [], []
        for day in self.days:
            start, end = day_bounds(day)
            rows = [dict(local_id=start, server_id=str(start), shard='test', local_type=1,
                         sender_username='a', sort_seq=start, create_time=start+3600,
                         message_content='测试讨论', compress_content=None, chat_id='group@chatroom')]
            save_export(self.root/'batches', build_export('account', 'group@chatroom', '测试群', start, end, rows, {'a': '甲'}))
        self.service = WeChatService(self.root, read_runner=self.read, generation_runner=self.generate)
        self.group = self.service.context()['groups'][0]['id']
        for module in ['service', 'generation']:
            mock = patch(f'host_service.wechat.{module}.check_effort')
            mock.start(); self.addCleanup(mock.stop)
        self.addCleanup(self.wait)

    def read(self, job):
        self.reads.append(job)
        return {'status': 'imported'}

    def test_context_reuses_archive_but_tracks_jobs_receipts_and_new_batches(self):
        with patch.object(self.service, '_build_context', wraps=self.service._build_context) as build:
            first = self.service.context()
            self.service.context()
            self.assertEqual(build.call_count, 0)  # setUp already loaded it
            save(self.root/'read-jobs'/('b'*32+'.json'), dict(id='b'*32, status='failed', started_at='2026-10-20', error='fixture'))
            self.assertEqual(self.service.context()['read_jobs'][0]['error'], 'fixture')
            self.assertEqual(build.call_count, 0)
            batch = first['batches'][0]['id']
            save(self.root/'receipts'/(batch+'.json'), dict(status='imported'))
            self.assertEqual(next(b for b in self.service.context()['batches'] if b['id']==batch)['status'], 'imported')
            self.assertEqual(build.call_count, 1)
            start, end = day_bounds('2026-10-22')
            rows = [dict(local_id=start, server_id=str(start), shard='test', local_type=1,
                         sender_username='a', sort_seq=start, create_time=start+1,
                         message_content='新增消息', chat_id='group@chatroom')]
            save_export(self.root/'batches', build_export('account', 'group@chatroom', '测试群', start, end, rows))
            self.assertEqual(len(self.service.context()['batches']), 3)
            self.assertEqual(build.call_count, 2)
            target = next((self.root/'batches').glob('*.json'))
            target.write_text('{}', encoding='utf-8')
            with self.assertRaises((ArchiveError, KeyError)):
                self.service.context()

    def test_context_refreshes_resource_inventory_and_summary_checkpoint(self):
        from host_service.wechat.resources import scope
        config = json.loads((self.root/'config.json').read_text(encoding='utf-8'))
        with patch.object(self.service, '_build_context', wraps=self.service._build_context) as build:
            save(self.root/'resources.json', dict(version=1, scope=scope(config), messages={}))
            self.assertTrue(self.service.context()['groups'][0]['resource_coverage']['complete'])
            self.assertEqual(build.call_count, 0)
            _, end = day_bounds(self.days[0])
            save(self.root/'summaries'/(self.days[0]+'.json'), dict(source_hash='fixture', summary={}, coverage_end=end))
            self.assertEqual(self.service.context()['groups'][0]['summary_end'], end)
            self.assertEqual(build.call_count, 1)

    def test_read_revision_tracks_saved_content_without_exposing_metadata(self):
        from host_service.wechat.resources import scope
        first = self.service.context()['revision']
        self.assertRegex(first, r'^[a-f0-9]{64}$')
        self.assertEqual(self.service.context()['revision'], first)
        save(self.root/'read-jobs'/('b'*32+'.json'), dict(id='b'*32, status='failed', started_at='2026-10-20', error='fixture'))
        self.assertEqual(self.service.context()['revision'], first)
        config = json.loads((self.root/'config.json').read_text(encoding='utf-8'))
        save(self.root/'resources.json', dict(version=1, scope=scope(config), messages={}))
        resources = self.service.context()['revision']
        self.assertNotEqual(resources, first)
        _, end = day_bounds(self.days[0])
        target = self.root/'summaries'/(self.days[0]+'.json')
        save(target, dict(source_hash='fixture', summary={}, coverage_end=end))
        published = self.service.context()['revision']
        self.assertNotEqual(published, resources)
        save(target, dict(source_hash='fixture', summary={'topics': []}, coverage_end=end))
        revised = self.service.context()['revision']
        self.assertNotEqual(revised, published)
        self.assertEqual(WeChatService(self.root).context()['revision'], revised)
        target.unlink()
        self.assertNotEqual(self.service.context()['revision'], revised)

    def generate(self, day, **kwargs):
        self.calls.append(day)
        prepared = prepare_day(self.root, day)
        doc = dict(source_hash=prepared['source_hash'], coverage_end=prepared['coverage_end'],
                   partial=prepared['partial'], summary={'format_version': 4})
        save(self.root/'summary-variants'/day/(kwargs['variant']+'.json'), doc)
        return {'run_id': 'fixture-'+day, 'credits': .25, 'elapsed_seconds': 1}

    def start(self, scope='all', request_id='a'*32, **kwargs):
        return self.service.post('analyze', dict(group=self.group, confirmed=True, scope=scope,
                                                mode='deepseek', request_id=request_id, **kwargs))['job']

    def wait(self):
        until = time.monotonic()+5
        while (self.service.active_read or self.service.generations.active) and time.monotonic() < until:
            time.sleep(.01)
        self.assertIsNone(self.service.active_read)
        self.assertIsNone(self.service.generations.active)

    def test_all_serial_days_costs_and_idempotency_survive_restart(self):
        self.start(); self.wait()
        self.assertEqual(self.calls, self.days)
        self.assertEqual(self.reads[0]['start'], 0)
        job = self.service.history()[0]
        self.assertEqual((job['status'], job['credits'], len(job['children'])), ('complete', .5, 2))
        self.assertEqual(len(self.service.history()), 1)  # children never duplicate total costs
        self.assertEqual(self.service.summary_checkpoint(), day_bounds(self.days[-1])[1])
        restarted = WeChatService(self.root, read_runner=lambda _: self.fail('duplicate capture'))
        payload = dict(group=self.group, confirmed=True, scope='all', mode='deepseek', request_id='a'*32)
        self.assertEqual(restarted.post('analyze', payload)['job']['credits'], .5)
        with self.assertRaises(ArchiveError): restarted.post('analyze', dict(payload, scope='date', date=self.days[0]))

    def test_continue_uses_summary_cutoff_not_latest_read_and_skips_unchanged(self):
        day = self.days[0]
        prepared = prepare_day(self.root, day)
        checkpoint = day_bounds(day)[0]+43200
        save(self.root/'summaries'/(day+'.json'), dict(source_hash=prepared['source_hash'], summary={}, partial=True, coverage_end=checkpoint))
        self.start(scope='continue'); self.wait()
        job = self.service.history()[0]
        self.assertEqual(job['start'], checkpoint)
        self.assertEqual(self.reads[0]['start'], day_bounds(day)[0])
        self.assertEqual(self.calls, [self.days[1]])
        self.assertEqual(job['credits'], .25)

    def test_date_only_and_failed_charge_preserves_old_summary(self):
        day = self.days[0]
        save(self.root/'summaries'/(day+'.json'), {'old': True})
        def fail(day, **kwargs):
            self.calls.append(day)
            raise SummaryFailure('模型输出未通过校验', {'credits': .12, 'run_id': 'failed', 'elapsed_seconds': 2})
        self.service.generations.runner = fail
        self.start(scope='date', date=day); self.wait()
        job = self.service.history()[0]
        self.assertEqual(self.calls, [day])
        self.assertEqual((job['status'], job['credits']), ('failed', .12))
        self.assertEqual((self.reads[0]['start'], self.reads[0]['end']), day_bounds(day))
        self.assertEqual(json.loads((self.root/'summaries'/(day+'.json')).read_text()), {'old': True})
        self.assertIsNone(self.service.summary_checkpoint())

    def test_capture_failure_never_calls_model(self):
        self.service.read_runner = lambda _: {'status': 'incomplete', 'error': '微信未运行，请打开微信并登录后重试'}
        self.start(); self.wait()
        job = self.service.history()[0]
        self.assertEqual((job['status'], job['credits'], self.calls), ('incomplete', 0, []))

    def test_resource_gate_preserves_zero_cost_receipt(self):
        with patch('host_service.wechat.generation.require_summary_resources', side_effect=ArchiveError('图片尚未取齐')):
            self.start(); self.wait()
        job = self.service.history()[0]
        self.assertEqual((job['status'], job['credits'], self.calls), ('failed', 0, []))
        self.assertEqual(job['children'][0]['error'], '图片尚未取齐')

    def test_unknown_credits_retained_and_remaining_days_stop(self):
        def fail(day, **kwargs):
            self.calls.append(day)
            raise SummaryFailure('积分尚未核实', {'run_id': 'unknown-cost'})
        self.service.generations.runner = fail
        self.start(); self.wait()
        job = self.service.history()[0]
        self.assertEqual(self.calls, self.days[:1])
        self.assertIsNone(job['credits'])
        self.assertTrue(job['credits_pending'])
        self.assertEqual(job['known_credits'], 0)

    def test_no_checkpoint_and_invalid_dates_rejected_before_capture(self):
        for kwargs in [dict(scope='continue'), dict(scope='date', date='2026-02-30'), dict(scope='date', date='2099-01-01')]:
            with self.assertRaises(ArchiveError): self.start(**kwargs)
        self.assertEqual(self.reads, [])

    def test_running_work_and_orphan_cannot_be_resubmitted(self):
        entered, finish = threading.Event(), threading.Event()
        def read(job):
            entered.set(); finish.wait(4); return {'status': 'imported'}
        self.service.read_runner = read
        try:
            self.start(); self.assertTrue(entered.wait(1))
            self.assertEqual(self.start()['id'], 'a'*32)
            with self.assertRaises(ArchiveError): self.start(request_id='b'*32)
            restarted = WeChatService(self.root)
            self.assertEqual(restarted.history()[0]['status'], 'unknown')
            self.assertEqual(restarted.start_analysis(dict(group=self.group, scope='all', mode='deepseek', request_id='a'*32))['status'], 'unknown')
            with self.assertRaises(ArchiveError): restarted.start_analysis(dict(group=self.group, scope='all', mode='low', request_id='c'*32))
        finally:
            finish.set(); self.wait()

    def test_child_receipts_recover_after_parent_interruption(self):
        save(self.root/'read-jobs'/('a'*32+'.json'), dict(id='a'*32, kind='read_and_summarize', group=self.group,
             status='running', started_at='2026-10-21T00:00:00Z', children=[dict(id='b'*32, date=self.days[0], status='pending', credits=0)]))
        save(self.root/'generation-jobs'/('b'*32+'.json'), dict(id='b'*32, date=self.days[0], status='failed',
             credits=.31, model='deepseek-v4.1-flash', started_at='2026-10-21T00:01:00Z'))
        job = self.service.history()[0]
        self.assertEqual((job['status'], job['credits'], len(self.service.history())), ('unknown', .31, 1))

    def test_cli_receives_explicit_range_without_desktop_takeover(self):
        from types import SimpleNamespace
        with patch('host_service.wechat.service.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"status":"imported"}', stderr='')) as run:
            self.service._read_once(dict(kind='sync', days=None, start=123, end=456))
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('--start')+1], '123')
        self.assertEqual(args[args.index('--end')+1], '456')
        self.assertNotIn('--client', args)

    def test_saved_messages_with_missing_images_continue_to_summary(self):
        from types import SimpleNamespace
        response={'status':'imported','resource_coverage':{'total':3,'ready':1,'missing':2,'complete':False}}
        with patch('host_service.wechat.service.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(response),stderr='')):
            read=self.service._read_once(dict(kind='sync',days=None,start=123,end=456))
        self.assertEqual(read['status'],'imported')
        self.service.read_runner=lambda _:read
        self.start(scope='date',date=self.days[0]);self.wait()
        self.assertEqual(self.calls,[self.days[0]])
        self.assertEqual(self.service.history()[0]['resource_coverage']['missing'],2)

    def test_empty_successful_process_output_never_advances_capture(self):
        from types import SimpleNamespace
        with patch('host_service.wechat.service.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='',stderr='')):
            with self.assertRaises(ArchiveError):self.service._read_once(dict(kind='sync',days=None))

    def test_cli_explicit_range_reaches_reader(self):
        import contextlib
        import io
        from host_service.wechat.main import main
        config = self.root/'config.json'
        save(config, dict(json.loads(config.read_text()), data_dir=str(self.root)))
        start, end = day_bounds(self.days[0])
        args = ['wechat', 'sync', '--config', str(config), '--start', str(start), '--end', str(end)]
        with patch('sys.argv', args), patch('host_service.wechat.main.import_export', return_value={'status': 'imported'}), \
                patch('host_service.wechat.reader.collect', return_value=([], {}, {})) as collect, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 0)
        self.assertEqual(collect.call_args.args[1:], (start, end))

    def test_cli_invalid_range_cannot_import_or_capture(self):
        from host_service.wechat.main import main
        config = self.root/'config.json'
        save(config, dict(json.loads(config.read_text()), data_dir=str(self.root)))
        for bounds in [['--start', '100'], ['--start', '200', '--end', '100'], ['--start', '0', '--end', '100', '--days', '1']]:
            with patch('sys.argv', ['wechat', 'sync', '--config', str(config), *bounds]), \
                    patch('host_service.wechat.main.import_export') as imported, patch('host_service.wechat.reader.collect') as collect:
                with self.assertRaises(ArchiveError): main()
                imported.assert_not_called(); collect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
