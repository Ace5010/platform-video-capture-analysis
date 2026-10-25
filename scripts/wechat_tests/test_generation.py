import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from host_service.wechat.generation import GenerationManager
from host_service.wechat.summarize import save, check_effort
from host_service.wechat.archive import ArchiveError

class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.day='2026-10-21'
        save(self.root/'summaries'/f'{self.day}.json',{'version':'old'})
        self.prepared=patch('host_service.wechat.generation.prepare_day',return_value={'complete':True,'summarizable':True,'partial':False,'coverage_end':1792598400,'messages':[{}]})
        self.prepared.start(); self.addCleanup(self.prepared.stop)

    def wait(self,manager):
        end=time.monotonic()+3
        while manager.active and time.monotonic()<end: time.sleep(.01)
        self.assertIsNone(manager.active)

    def test_idempotency_publish_and_history(self):
        gate=threading.Event(); calls=[]
        def runner(day,**kw):
            calls.append(kw); gate.wait(2)
            save(self.root/'summary-variants'/day/(kw['variant']+'.json'),{'version':'new'})
            return {'run_id':'fixture','credits':.5,'elapsed_seconds':1}
        manager=GenerationManager(self.root,runner)
        job=manager.start(self.day,'low','a'*32)
        self.assertEqual(manager.start(self.day,'low','a'*32)['id'],job['id'])
        with self.assertRaises(ArchiveError): manager.start(self.day,'high','b'*32)
        gate.set(); self.wait(manager)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['effort'],'low')
        self.assertEqual(json.loads((self.root/'summaries'/f'{self.day}.json').read_text())['version'],'new')
        self.assertEqual(json.loads((self.root/'summary-variants'/self.day/('before-'+'a'*32+'.json')).read_text())['version'],'old')
        self.assertEqual(manager.latest(self.day)['credits'],.5)

    def test_failure_keeps_old_summary_and_records_status(self):
        manager=GenerationManager(self.root,Mock(side_effect=RuntimeError('secret-token private/path/chat.txt')))
        manager.start(self.day,'low','a'*32); self.wait(manager)
        self.assertEqual(manager.latest(self.day)['status'],'failed')
        self.assertIn('RuntimeError',manager.latest(self.day)['error'])
        self.assertNotIn('secret-token',manager.latest(self.day)['error'])
        self.assertNotIn('private/path',manager.latest(self.day)['error'])
        self.assertEqual(json.loads((self.root/'summaries'/f'{self.day}.json').read_text())['version'],'old')

    def test_today_can_queue_without_pretending_full_day_and_gap_is_rejected(self):
        manager=GenerationManager(self.root,Mock(side_effect=RuntimeError('fixture')))
        prepared={'complete':False,'summarizable':True,'partial':True,'coverage_end':123,'messages':[{}]}
        with patch('host_service.wechat.generation.prepare_day',return_value=prepared):
            job=manager.start(self.day,'low','e'*32)
        self.assertTrue(job['partial']); self.assertEqual(job['coverage_end'],123)
        self.wait(manager)
        manager.runner.reset_mock()
        with patch('host_service.wechat.generation.prepare_day',return_value=dict(prepared,summarizable=False)):
            with self.assertRaises(ArchiveError): manager.start(self.day,'low','f'*32)
        manager.runner.assert_not_called()

    def test_unknown_prior_job_does_not_look_successful(self):
        save(self.root/'generation-jobs'/('a'*32+'.json'),{'id':'a'*32,'date':self.day,'status':'running','started_at':'2026-10-21T00:00:00Z'})
        manager=GenerationManager(self.root,Mock())
        self.assertEqual(manager.latest(self.day)['status'],'unknown')
        with self.assertRaises(ArchiveError): manager.start(self.day,'low','b'*32)
        manager.runner.assert_not_called()

    def test_catalog_default_allows_only_explicit_effort(self):
        catalog = self.root/'buddy-runtime/node_modules/@tencent-ai/codebuddy-code/product.internal.json'
        save(catalog, {'models': [
            {'id':'default-only','reasoning':{'effort':'high'}},
            {'id':'explicit','reasoning':{'effort':'high','supportedEfforts':['low']}},
            {'id':'unknown-capability'}]})
        with patch('host_service.wechat.summarize.RUNTIME', self.root):
            check_effort('default-only','high')
            check_effort('explicit','low')
            for model, effort in [('default-only','low'),('explicit','high'),
                                  ('unknown-capability','high'),('missing','high')]:
                with self.subTest(model=model, effort=effort), self.assertRaises(ArchiveError):
                    check_effort(model, effort)
