"""Native WeChat API isolation and navigation fixtures; never reads real accounts."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError, build_export, save_export
from host_service.wechat.service import WeChatService
from host_service.wechat.summaries import day_bounds
from host_service.wechat.summarize import save
from host_service.server import create_server, HostRequestHandler
spec = importlib.util.spec_from_file_location('api_helpers', Path(__file__).resolve().parents[1] / 'test-host-service.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

class NativeWeChatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.day = '2026-10-21'
        start, end = day_bounds(self.day)
        save(self.root/'config.json', dict(account_id='private-account', group_id='private-group@chatroom', group_name='测试群'))
        rows = [dict(local_id=n, server_id=str(n), shard='test', local_type=1, sender_username='a' if n%2 else 'b',
                     sort_seq=n,create_time=start+n,message_content='话题 apple' if n%2 else '关联回复',
                     compress_content=None,chat_id='private-group@chatroom') for n in range(1,121)]
        save_export(self.root/'batches',build_export('private-account','private-group@chatroom','测试群',start,end,rows,{'a':'甲','b':'乙'}))
        self.service = WeChatService(self.root, read_runner=lambda job: {'status':'imported'})
        self.group = self.service.context()['groups'][0]['id']
        self.query = dict(group=self.group, **{'from': self.day, 'to':self.day})

    def test_filters_pagination_context_and_no_identifiers(self):
        c = json.dumps(self.service.context(),ensure_ascii=False)
        self.assertNotIn('private-account',c); self.assertNotIn('private-group@chatroom',c); self.assertNotIn(str(self.root),c)
        first = self.service.search(self.query)
        self.assertEqual((first['total'],len(first['messages']),first['next']),(120,100,100))
        second=self.service.search(dict(self.query,offset=100)); self.assertEqual(len(second['messages']),20)
        filtered=self.service.search(dict(self.query,keyword='APPLE'))
        self.assertEqual(filtered['total'],60)
        member=filtered['messages'][0]['member']
        self.assertEqual(self.service.search(dict(self.query,member=member))['total'],60)
        anchor=filtered['messages'][20]['id']
        context=self.service.search(dict(self.query,anchor=anchor,keyword='no match',member=member))
        self.assertEqual(len(context['messages']),31)
        self.assertEqual(len(set(m['member'] for m in context['messages'])),2)
        self.assertEqual(self.service.get('original',dict(group=self.group,date=self.day))['total'],120)
        for bad in [dict(self.query, group='other'),dict(self.query,offset=-1),dict(self.query,keyword='x'*201)]:
            with self.assertRaises(ArchiveError): self.service.search(bad)

    def test_explicit_read_idempotence_and_generation_exclusion(self):
        started=threading.Event(); finish=threading.Event(); calls=[]
        def read(job):
            calls.append(job['id']); started.set(); finish.wait(3); return {'status':'imported'}
        self.service.read_runner=read
        payload=dict(group=self.group,kind='sync',days=3,request_id='a'*32,confirmed=True)
        with self.assertRaises(ArchiveError): self.service.post('read',dict(payload,confirmed=False))
        self.service.post('read',payload); self.assertTrue(started.wait(1))
        self.service.post('read',payload)
        with self.assertRaises(ArchiveError): self.service.post('generate',dict(group=self.group,date=self.day,mode='deepseek',request_id='b'*32,confirmed=True))
        finish.set()
        deadline=time.monotonic()+3
        while self.service.active_read and time.monotonic()<deadline: time.sleep(.01)
        self.assertEqual(calls,['a'*32]); self.assertEqual(self.service.read_jobs()[0]['status'],'imported')

    def test_incomplete_capture_is_not_success(self):
        from types import SimpleNamespace
        failure=SimpleNamespace(returncode=1,stderr='{"status":"incomplete"}',stdout='')
        with patch('host_service.wechat.service.subprocess.run',return_value=failure) as command:
            result=self.service._read_once({'kind':'sync','days':3})
        self.assertEqual(result['status'],'incomplete')
        self.assertIn('host_service.wechat.main',command.call_args.args[0])
        self.assertIn('--days',command.call_args.args[0])

    def test_read_failure_keeps_actionable_reason_without_leaking_output(self):
        from types import SimpleNamespace
        for reason, expected in [
            ('微信未运行，请打开微信并登录后重试', '微信未运行，请打开微信并登录后重试'),
            ('secret-value private/path/chat.txt', '读取未完成，已保存记录保留。请重试。'),
        ]:
            failure = SimpleNamespace(returncode=1, stdout='', stderr=json.dumps({'status':'failed','reason':reason}))
            with patch('host_service.wechat.service.subprocess.run', return_value=failure):
                with self.assertRaisesRegex(ArchiveError, expected):
                    self.service._read_once({'kind':'sync','days':None})
            self.service.read_runner = lambda job, reason=reason: (_ for _ in ()).throw(ArchiveError(reason))
            self.service._execute_read({'id':'c'*32,'status':'running','started_at':'2026-10-24'})
            saved = json.loads((self.root/'read-jobs'/('c'*32+'.json')).read_text(encoding='utf-8'))
            self.assertEqual(saved['error'], expected)
            self.assertNotEqual(saved['status'], 'imported')

    def test_missing_wechat_process_has_specific_recovery_message(self):
        from types import SimpleNamespace
        from host_service.wechat.reader import active_pid
        with patch('host_service.wechat.reader.process_version', side_effect=ArchiveError('old pid')):
            with patch('host_service.wechat.reader.subprocess.run', return_value=SimpleNamespace(stdout='[]')) as run:
                with self.assertRaisesRegex(ArchiveError, '微信未运行'):
                    active_pid(12)
        self.assertEqual(run.call_args.kwargs['encoding'], 'utf-8')
        self.assertEqual(run.call_args.kwargs['errors'], 'replace')

    def test_incomplete_read_reason_is_persisted(self):
        self.service.read_runner = lambda job: {'status':'incomplete','error':'WAL 正在写入，请稍后重试'}
        self.service._execute_read({'id':'d'*32,'status':'running','started_at':'2026-10-24'})
        saved = json.loads((self.root/'read-jobs'/('d'*32+'.json')).read_text(encoding='utf-8'))
        self.assertEqual(saved['status'], 'incomplete')
        self.assertEqual(saved['error'], 'WAL 正在写入，请稍后重试')

    def test_http_auth_csrf_local_gate_and_shared_state(self):
        server=create_server(helpers.create_test_config(self.root/'host'))
        server.wechat=self.service
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            client=helpers.ApiClient(*server.server_address)
            self.assertEqual(client.request('GET','/api/wechat/context')[0],401)
            self.assertEqual(client.request('POST','/api/auth/setup',{'password':'isolated-test-password'},use_cookie=False)[0],201)
            self.assertEqual(client.request('GET','/api/wechat/context')[0],200)
            self.assertEqual(client.request('POST','/api/wechat/search',self.query,csrf='bad')[0],403)
            self.assertEqual(client.request('POST','/api/wechat/search',self.query)[1]['total'],120)
            with patch.object(self.service,'context',side_effect=AssertionError('must not read archive')):
                self.assertEqual(client.request('GET','/api/wechat/context',origin=helpers.REMOTE_ORIGIN)[0],403)
                with patch.object(HostRequestHandler,'_remote_ip',return_value='192.168.1.8'):
                    self.assertEqual(client.request('GET','/api/wechat/context')[0],403)
            state=client.request('GET','/api/state')[1]
            self.assertNotIn('测试群',json.dumps(state,ensure_ascii=False))
            self.assertNotIn('话题 apple',json.dumps(state,ensure_ascii=False))
        finally:
            server.shutdown();server.server_close();thread.join(3)

if __name__=='__main__': unittest.main(verbosity=2)
