"""Persistent multi-group queue, with isolated archives and model runners."""
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
from host_service.wechat.summarize import save


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = []
        self.release = threading.Event()
        self.entered = threading.Event()
        self.day = '2026-10-20'
        for name, root in [('a', self.root), ('b', self.root/'groups'/'group_b'), ('c', self.root/'groups'/'group_c')]:
            name += '@chatroom'
            save(root/'config.json', dict(account_id='fixture', group_id=name, group_name=name))
            start, end = day_bounds(self.day)
            rows = [dict(local_id=1, server_id='1', shard='test', local_type=1, sender_username='member',
                         sort_seq=1, create_time=start+60, message_content='测试讨论', chat_id=name)]
            save_export(root/'batches', build_export('fixture', name, name, start, end, rows))
        for module in ['service', 'generation']:
            mock = patch(f'host_service.wechat.{module}.check_effort')
            mock.start(); self.addCleanup(mock.stop)
        self.service = self.new_service()
        self.groups = [g['id'] for g in self.service.context()['groups']]
        self.addCleanup(self.finish)

    def new_service(self):
        service = WeChatService(self.root, read_runner=lambda job: {'status': 'imported'})
        for child in service._services():
            group = child.group_id(json.loads((child.root/'config.json').read_text()))
            def read(job, group=group):
                self.events.append(('read', group))
                if len(self.events) == 1:
                    self.entered.set()
                    self.release.wait(5)
                return {'status': 'imported'}
            def generate(day, child=child, group=group, **kwargs):
                self.events.append(('summary', group))
                prepared = prepare_day(child.root, day)
                save(child.root/'summary-variants'/day/(kwargs['variant']+'.json'),
                     dict(source_hash=prepared['source_hash'], coverage_end=prepared['coverage_end'],
                          partial=prepared['partial'], summary={'format_version': 4}))
                return {'credits': .2, 'run_id': group, 'elapsed_seconds': .1}
            child.read_runner = read
            child.generations.runner = generate
        return service

    def payload(self, groups=None, **kwargs):
        return dict(groups=groups or self.groups[:2], scope='all', mode='deepseek',
                    confirmed=True, request_id='a'*32, **kwargs)

    def finish(self):
        self.release.set()
        thread = self.service.queue_thread
        if thread:
            thread.join(8)
            self.assertFalse(thread.is_alive())

    def test_serial_summary_failure_continues_and_append_idempotency(self):
        second = self.service._service_for(self.groups[1])
        def fail(day, **kwargs):
            self.events.append(('failed-summary', self.groups[1]))
            raise ArchiveError('测试失败')
        second.generations.runner = fail
        result = self.service.post('analyze-batch', self.payload())
        self.assertTrue(self.entered.wait(1))
        self.assertEqual(len(result['jobs']), 2)
        duplicate = self.service.post('analyze-batch', self.payload())
        self.assertEqual([j['id'] for j in duplicate['jobs']], [j['id'] for j in result['jobs']])
        with self.assertRaises(ArchiveError):
            self.service.post('analyze-batch', dict(self.payload(), request_id='b'*32))
        self.service.post('analyze-batch', dict(self.payload(self.groups[2:]), request_id='c'*32))
        self.assertEqual([j['status'] for j in second.history()], ['queued'])
        with self.assertRaises(ArchiveError):
            self.service.post('cleanup-preview', dict(group=self.groups[2], confirmed=True))
        self.finish()
        self.assertEqual(self.events, [('read', self.groups[0]), ('summary', self.groups[0]),
                                     ('read', self.groups[1]), ('failed-summary', self.groups[1]),
                                     ('read', self.groups[2]), ('summary', self.groups[2])])
        self.assertEqual([s.history()[0]['status'] for s in self.service._services()], ['complete', 'failed', 'complete'])
        restarted = self.new_service()
        self.assertEqual(restarted.post('analyze-batch', self.payload())['jobs'][0]['credits'], .2)
        self.assertEqual(len(self.events), 6)
        with self.assertRaises(ArchiveError):
            restarted.post('analyze-batch', dict(self.payload(), mode='low'))

    def test_validation_is_atomic_and_queue_recovers_before_dispatch(self):
        with self.assertRaises(ArchiveError):
            self.service.post('analyze-batch', self.payload([self.groups[0], 'invalid']))
        self.assertFalse((self.root/'analysis-queue.json').exists())
        with patch.object(self.service, '_ensure_queue_worker'):
            self.service.post('analyze-batch', self.payload())
        self.assertEqual(self.events, [])
        self.service = self.new_service()
        self.service.context()
        self.assertTrue(self.entered.wait(1))
        self.finish()
        self.assertEqual(len(self.events), 4)

    def test_concurrent_duplicate_submissions_create_one_batch(self):
        barrier = threading.Barrier(3)
        results, errors = [], []
        def submit():
            barrier.wait()
            try:
                results.append(self.service.post('analyze-batch', self.payload()))
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=submit) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual([j['id'] for j in results[0]['jobs']], [j['id'] for j in results[1]['jobs']])
        self.assertEqual(len(self.service._queue_batches()), 1)
        self.finish()
        self.assertEqual(len(self.events), 4)

    def test_interrupted_paid_work_blocks_pending_without_replay(self):
        with patch.object(self.service, '_ensure_queue_worker'):
            jobs = self.service.post('analyze-batch', self.payload())['jobs']
        save(self.root/'read-jobs'/(jobs[0]['id']+'.json'), dict(jobs[0], status='running'))
        self.service = self.new_service()
        self.service.context()
        self.finish()
        self.assertEqual(self.events, [])
        self.assertEqual(self.service.read_jobs()[0]['status'], 'unknown')
        self.assertEqual(self.service._service_for(self.groups[1]).history()[0]['status'], 'queued')


if __name__ == '__main__':
    unittest.main()
