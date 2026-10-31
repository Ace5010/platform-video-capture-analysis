"""Native WeChat API isolation and navigation fixtures; never reads real accounts."""
import importlib.util
import json
import sqlite3
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
from host_service.server import create_server, create_remote_gateway, HostRequestHandler
from types import SimpleNamespace
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

    def test_retry_is_scoped_to_one_image_and_blocks_during_other_work(self):
        from host_service.wechat.archive import digest
        from host_service.wechat.resources import load_resources
        start,end=day_bounds('2026-10-22')
        export=build_export('private-account','private-group@chatroom','测试群',start,end,[dict(
            local_id=999,server_id='999',shard='test',local_type=3,sender_username='a',
            create_time=start+1,message_content='<msg><img/></msg>')])
        save_export(self.root/'batches',export)
        message=export['messages'][0]
        mid='m_'+digest(message['platformMessageId'])[:16]
        calls=[]
        def retry(job):
            calls.append(job)
            config=json.loads((self.root/'config.json').read_text())
            inventory=load_resources(self.root,config)
            inventory['messages'][message['platformMessageId']]={'items':[dict(
                kind='image',status='missing',error='仅有缩略图',error_code='thumbnail_only')]}
            save(self.root/'resources.json',inventory)
            return {'status':'incomplete'}
        self.service.read_runner=retry
        payload=dict(group=self.group,message=mid,confirmed=True)
        for bad in [dict(payload,confirmed=False),dict(payload,message='m_missing'),dict(payload,group='other')]:
            with self.assertRaises(ArchiveError):self.service.post('retry-image',bad)
        self.service.active_read='existing'
        with self.assertRaises(ArchiveError):self.service.post('retry-image',payload)
        self.service.active_read=None
        result=self.service.post('retry-image',payload)
        self.assertEqual(result['resources'][0]['error_code'],'thumbnail_only')
        self.assertEqual(calls,[dict(kind='resources',message=mid,days=None)])
        self.assertEqual(self.service.get('original',dict(group=self.group,date='2026-10-22'))['messages'][0]['resources'],result['resources'])

    def test_image_only_worker_flags_and_scope_are_explicit(self):
        completed=SimpleNamespace(returncode=0,stdout='{"status":"imported"}',stderr='')
        with patch('host_service.wechat.service.subprocess.run',return_value=completed) as run:
            self.service._read_once(dict(kind='resources',days=None,images_only=True))
            self.assertIn('--images-only',run.call_args.args[0])
            self.assertNotIn('--client',run.call_args.args[0])
            self.service._read_once(dict(kind='resources',days=None,message='m_one'))
            args=run.call_args.args[0]
            self.assertEqual(args[args.index('--message')+1],'m_one')
            self.assertIn('--images-only',args)
        for invalid in ('yes',1):
            with self.assertRaises(ArchiveError):
                self.service.start_read(dict(kind='resources',images_only=invalid))
        with self.assertRaises(ArchiveError):
            self.service.start_read(dict(kind='sync',images_only=True))

    def test_read_cache_reuses_verified_archive_and_prepared_day(self):
        from host_service.wechat import service as module
        q=dict(group=self.group,date=self.day)
        prepared=self.service._prepared_day(self.day)
        ids=list(prepared['sources'])
        save(self.root/'summaries'/(self.day+'.json'),dict(source_hash=prepared['source_hash'],summary={
            'format_version':4,'overview':'讨论','topics':[{'title':'测试讨论','summary':'讨论了测试内容。',
            'refs':ids[:1],'discussion_refs':ids}],'excluded_messages':[],'notes':[]}))
        self.service.day_cache.clear()
        with patch.object(module,'load_archive',wraps=module.load_archive) as loaded, \
             patch.object(module,'prepare_day',wraps=module.prepare_day) as built:
            self.service.get('summary',q)
            first=self.service.get('original',dict(q,topic='0'))
            second=self.service.get('original',dict(q,topic='0'))
            self.assertEqual(first,second)
            self.assertEqual(first['total'],120)
            loaded.assert_not_called()  # already verified by context in setUp
            built.assert_called_once()

    def test_read_cache_refreshes_for_new_batches_cleanup_and_corruption(self):
        q=dict(group=self.group,date=self.day)
        self.assertEqual(self.service.get('original',q)['total'],120)
        start,end=day_bounds(self.day)
        rows=[dict(local_id=121,server_id='121',shard='test',local_type=1,sender_username='a',
              sort_seq=121,create_time=start+121,message_content='新消息',chat_id='private-group@chatroom')]
        save_export(self.root/'batches',build_export('private-account','private-group@chatroom','测试群',start,end,rows,{'a':'甲'}))
        self.assertEqual(self.service.get('original',q)['total'],121)
        save(self.root/'cleaned-ranges.json',{'ranges':[[start,start+61]]})
        self.assertEqual(self.service.get('original',q)['total'],61)
        target=next((self.root/'batches').glob('*.json'))
        target.write_text('{}',encoding='utf-8')
        with self.assertRaises((ArchiveError,KeyError)):self.service.get('original',q)

    def test_read_cache_serializes_cold_requests_and_bounds_days(self):
        from concurrent.futures import ThreadPoolExecutor
        from host_service.wechat import service as module
        self.service.archive_cache=None
        with patch.object(module,'load_archive',wraps=module.load_archive) as loaded:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results=list(pool.map(lambda _:self.service.get('original',dict(group=self.group,date=self.day)),range(4)))
            self.assertTrue(all(r['total']==120 for r in results))
            loaded.assert_called_once()
        for day in range(22,28):self.service._prepared_day(f'2026-10-{day}')
        self.assertEqual(len(self.service.day_cache),4)

    def test_search_only_builds_resources_for_the_returned_page(self):
        from host_service.wechat import service as module
        with patch.object(module,'browser_resources',wraps=module.browser_resources) as built:
            result=self.service.search(dict(self.query,offset=100))
            self.assertEqual(len(result['messages']),20)
            self.assertEqual(built.call_count,20)

    def find_fixture(self, matches=None):
        result = SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({'matches': matches if matches is not None else [
            {'group_id': 'second-private@chatroom', 'group_name': '新增测试群'}]}))
        with patch('host_service.wechat.service.subprocess.run', return_value=result):
            return self.service.post('find-groups', {'name': '新增测试群'})

    def test_add_group_keeps_existing_archive_and_isolates_new_group(self):
        original = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*.json')}
        found = self.find_fixture()
        self.assertNotIn('second-private', json.dumps(found))
        token = found['groups'][0]['id']
        with self.assertRaises(ArchiveError):
            self.service.post('add-group', {'candidate': token})
        added = self.service.post('add-group', {'candidate': token, 'confirmed': True})
        other = added['group']
        self.assertNotEqual(other, self.group)
        self.assertFalse(self.service.post('add-group', {'candidate': token, 'confirmed': True})['added'])
        for path, content in original.items():
            self.assertEqual((self.root / path).read_bytes(), content)
        child = self.service._service_for(other)
        config = json.loads((child.root / 'config.json').read_text(encoding='utf-8'))
        self.assertEqual(config['data_dir'], str(child.root.resolve()))
        self.assertEqual(self.service.get('days', {'group': other}), {'days': []})
        self.assertEqual(self.service.context(other)['members'], [])
        self.assertEqual(self.service.context(other)['batches'], [])
        self.assertEqual(self.service.search(self.query)['total'], 120)
        start, end = day_bounds(self.day)
        rows = [dict(local_id=1, server_id='1', shard='test', local_type=1, sender_username='c',
                     sort_seq=1, create_time=start+1, message_content='新群独立消息', compress_content=None,
                     chat_id=config['group_id'])]
        save_export(child.root/'batches', build_export(config['account_id'], config['group_id'], config['group_name'], start, end, rows, {'c':'丙'}))
        self.assertEqual(self.service.search(dict(self.query, group=other))['total'], 1)
        self.assertEqual(self.service.get('original', {'group':other, 'date':self.day})['total'], 1)
        self.assertEqual(self.service.context(other)['members'][0]['name'], '丙')
        self.assertEqual(len(WeChatService(self.root).context()['groups']), 2)
        with patch.object(child.generations, 'latest', return_value={'id':'second-summary'}):
            self.assertEqual(self.service.get('generation', {'group':other, 'date':self.day})['job']['id'], 'second-summary')
        started, finish = threading.Event(), threading.Event()
        def read(job):
            started.set(); finish.wait(3); return {'status':'imported'}
        child.read_runner = read
        self.service.post('read', dict(group=other, kind='sync', days=3, request_id='e'*32, confirmed=True))
        self.assertTrue(started.wait(1))
        try:
            with self.assertRaises(ArchiveError):
                self.service.post('read', dict(group=self.group, kind='sync', days=3, request_id='f'*32, confirmed=True))
        finally:
            finish.set()
            deadline = time.monotonic()+3
            while child.active_read and time.monotonic()<deadline: time.sleep(.01)
        self.assertEqual(child.read_jobs()[0]['status'], 'imported')
        self.assertFalse(self.service.read_jobs())

    def test_group_lookup_validation_expiry_and_duplicate_names(self):
        self.assertEqual(self.find_fixture([]), {'groups': []})
        with self.assertRaisesRegex(ArchiveError, '多个同名群'):
            self.find_fixture([{'group_id': f'{n}@chatroom', 'group_name': '新增测试群'} for n in range(2)])
        for bad in ['', 'x'*101, None]:
            with self.assertRaises(ArchiveError): self.service.post('find-groups', {'name':bad})
        with self.assertRaises(ArchiveError):
            self.service.post('add-group', {'candidate':'../other', 'confirmed':True})
        token = self.find_fixture()['groups'][0]['id']
        self.service.candidates[token]['expires'] = 0
        with self.assertRaisesRegex(ArchiveError, '过期'):
            self.service.post('add-group', {'candidate':token, 'confirmed':True})
        self.assertEqual(len(self.service.context()['groups']), 1)
        result = SimpleNamespace(returncode=1, stdout='', stderr=json.dumps({'status':'failed','reason':'private/path secret'}))
        with patch('host_service.wechat.service.subprocess.run', return_value=result):
            with self.assertRaisesRegex(ArchiveError, '^查找群失败，请保持微信登录后重试$'):
                self.service.post('find-groups', {'name':'新增测试群'})

    def test_lookup_reader_only_opens_contacts_in_selected_account(self):
        from host_service.wechat.reader import find_groups
        contact = self.root/'contact-fixture.sqlite'
        conn = sqlite3.connect(contact)
        conn.execute('CREATE TABLE contact(username TEXT,nick_name TEXT)')
        conn.executemany('INSERT INTO contact VALUES(?,?)', [('wanted@chatroom','新增测试群'),
            ('person','新增测试群'),('other@chatroom','其他群')])
        conn.commit(); conn.close()
        db = SimpleNamespace(wxid='private-account', _keys={'temporary':'secret'},
                             _db_files=[('contact/contact.db',str(contact),1)],
                             _open=lambda rel: sqlite3.connect(contact))
        config = dict(pid=12, db_dir='chosen-directory', account_dir='chosen-account',
                      account_id='private-account', data_dir=str(self.root))
        with patch('host_service.wechat.reader.active_pid', return_value=34), \
             patch('host_service.wechat.reader.load_upstream', return_value=object()), \
             patch('host_service.wechat.reader.make_reader', return_value=db) as make:
            self.assertEqual(find_groups(config,'新增测试群'), [{'group_id':'wanted@chatroom','group_name':'新增测试群'}])
            self.assertTrue(make.call_args.kwargs['contacts_only'])
            self.assertEqual(make.call_args.args[1:4], ('chosen-directory','chosen-account',34))
            self.assertFalse(db._keys)
            self.assertFalse(list((self.root/'cache').iterdir()))
            db.wxid = 'different-account'; db._keys = {'temporary':'secret'}
            with self.assertRaisesRegex(ArchiveError, '来源账号标识不匹配'):
                find_groups(config,'新增测试群')
            self.assertFalse(db._keys)

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
            ('ChatLab 官方格式校验失败，未推进读取进度', 'ChatLab 官方格式校验失败，未推进读取进度'),
            ('归档文件持续被占用，已保留原记录，请稍后重试', '归档文件持续被占用，已保留原记录，请稍后重试'),
            ('PermissionError', '读取时文件被占用或访问被拒绝，已保存记录保留（PermissionError）'),
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

    def test_registered_asset_http_requires_auth_group_and_exact_hash(self):
        import base64
        import http.client
        from host_service.wechat.resources import save_blob, load_resources
        data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
        asset = save_blob(self.root, data, 'image/png', '图片')
        config = json.loads((self.root/'config.json').read_text(encoding='utf-8'))
        manifest = load_resources(self.root, config)
        archived_id = self.service._archive()[1][0]['platformMessageId']
        manifest['messages'][archived_id] = {'items':[{'status':'ready','assets':[asset]}]}
        save(self.root/'resources.json', manifest)
        server = create_server(helpers.create_test_config(self.root/'host'))
        server.wechat = self.service
        thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            client = helpers.ApiClient(*server.server_address)
            path = f'/api/wechat/asset?group={self.group}&asset={asset["id"]}'
            self.assertEqual(client.request('GET',path)[0],401)
            client.request('POST','/api/auth/setup',{'password':'isolated-test-password'},use_cookie=False)
            conn = http.client.HTTPConnection(*server.server_address,timeout=10)
            conn.request('GET',path,headers={'Origin':'http://localhost:3000','Cookie':client.cookie})
            response = conn.getresponse()
            self.assertEqual(response.status,200)
            self.assertEqual(response.getheader('Content-Type'),'image/png')
            self.assertEqual(response.getheader('Cache-Control'),'private, no-store')
            self.assertEqual(response.read(),data); conn.close()
            for query in [f'group=other&asset={asset["id"]}', f'group={self.group}&asset=../config.json']:
                self.assertEqual(client.request('GET','/api/wechat/asset?'+query)[0],400)
            self.assertEqual(client.request('GET',path,origin='https://untrusted.example')[0],403)
        finally:
            server.shutdown();server.server_close();thread.join(3)

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
            self.assertEqual(client.request('POST','/api/wechat/analyze',{'confirmed': True},csrf='bad')[0],403)
            for action in ('cleanup-preview','cleanup','retry-image'):
                self.assertEqual(client.request('POST','/api/wechat/'+action,{'confirmed':True},csrf='bad')[0],403)
            self.assertEqual(client.request('GET',f'/api/wechat/history?group={self.group}')[1], {'jobs': []})
            with patch.object(self.service, 'start_analysis', return_value={'id': 'isolated'}) as start:
                payload = dict(group=self.group, confirmed=True, scope='date', date=self.day, mode='low', request_id='a'*32)
                self.assertEqual(client.request('POST','/api/wechat/analyze',payload)[1], {'job': {'id': 'isolated'}})
                start.assert_called_once_with(payload)
            self.assertEqual(client.request('POST','/api/wechat/find-groups',{'name':'新增测试群'},csrf='bad')[0],403)
            with patch('host_service.wechat.service.subprocess.run', return_value=SimpleNamespace(returncode=0, stderr='', stdout='{"matches": []}')):
                self.assertEqual(client.request('POST','/api/wechat/find-groups',{'name':'新增测试群'})[1], {'groups':[]})
            self.assertEqual(client.request('POST','/api/wechat/search',self.query)[1]['total'],120)
            with patch.object(HostRequestHandler,'_remote_ip',return_value='192.168.1.8'):
                self.assertEqual(client.request('GET','/api/wechat/context')[0],403)
            state=client.request('GET','/api/state')[1]
            self.assertNotIn('测试群',json.dumps(state,ensure_ascii=False))
            self.assertNotIn('话题 apple',json.dumps(state,ensure_ascii=False))
        finally:
            server.shutdown();server.server_close();thread.join(3)

    def test_https_gateway_saved_reads_share_auth_without_management_or_cache(self):
        server=create_server(helpers.create_test_config(self.root/'host'))
        origin='https://workbench.example'
        gateway=create_remote_gateway(server,SimpleNamespace(origin=origin),port=0)
        gateway.wechat=self.service
        threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (server,gateway)]
        for thread in threads: thread.start()
        try:
            local=helpers.ApiClient(*server.server_address)
            local.request('POST','/api/auth/setup',{'password':'isolated-test-password'},use_cookie=False)
            remote=helpers.ApiClient(*gateway.server_address)
            paths=['/api/wechat/context',f'/api/wechat/days?group={self.group}',
                   f'/api/wechat/summary?group={self.group}&date={self.day}',
                   f'/api/wechat/original?group={self.group}&date={self.day}']
            for path in paths:self.assertEqual(remote.request('GET',path,origin=origin)[0],401)
            remote.cookie,remote.csrf=local.cookie,local.csrf
            status,result,headers=remote.request('GET',paths[0],origin=origin)
            self.assertEqual(status,200)
            self.assertEqual(result['groups'][0]['id'],self.group)
            self.assertEqual(result['batches'],[]);self.assertEqual(result['read_jobs'],[])
            self.assertNotIn('account_label',result['groups'][0])
            self.assertRegex(result['revision'], r'^[a-f0-9]{64}$')
            self.assertEqual(result['revision'], self.service.context()['revision'])
            self.assertEqual(dict(headers)['Cache-Control'],'private, no-store')
            for path in paths[1:]:self.assertEqual(remote.request('GET',path,origin=origin)[0],200)
            self.assertEqual(remote.request('POST','/api/wechat/search',self.query,origin=origin)[1]['total'],120)
            self.assertEqual(remote.request('POST','/api/wechat/search',self.query,origin=origin,csrf='bad')[0],403)
            self.assertEqual(remote.request('GET',paths[0],origin='https://untrusted.example')[0],403)
            self.assertEqual(remote.request('POST','/api/wechat/search',{**self.query,'group':'other'},origin=origin)[0],400)
            with patch.object(self.service,'get',side_effect=AssertionError('must not open management')):
                self.assertEqual(remote.request('GET',f'/api/wechat/generation?group={self.group}&date={self.day}',origin=origin)[0],403)
                self.assertEqual(remote.request('GET',f'/api/wechat/history?group={self.group}',origin=origin)[0],403)
            with patch.object(self.service,'post',side_effect=AssertionError('must not execute jobs')):
                for action in ('read','generate','analyze','context','find-groups','add-group','cleanup-preview','cleanup','retry-image','unknown'):
                    self.assertEqual(remote.request('POST','/api/wechat/'+action,{'confirmed':True},origin=origin)[0],403)
        finally:
            for s in (gateway,server):s.shutdown();s.server_close()
            for thread in threads:thread.join(3)

if __name__=='__main__': unittest.main(verbosity=2)
