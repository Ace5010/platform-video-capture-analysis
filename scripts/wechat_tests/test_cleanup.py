from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from host_service.wechat.archive import ArchiveError,build_export,save_export,atomic_json
from host_service.wechat.cleanup import preview,execute,owned
from host_service.wechat.resources import save_blob,load_resources
from host_service.wechat.summaries import day_bounds,load_archive,covers_day
from host_service.wechat.service import WeChatService


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.config=dict(account_id='test',group_id='g@chatroom',group_name='测试群')
        atomic_json(self.root/'config.json',self.config)
        self.start=day_bounds('2026-10-20')[0]
        rows=[dict(local_type=1,message_content=f'完整文字{i}',sender_username='user',shard='test',
                   server_id=str(i+1),local_id=i+1,create_time=self.start+i*86400,sort_seq=i) for i in range(3)]
        self.doc=build_export('test','g@chatroom','测试群',self.start,self.start+3*86400,rows)
        self.old=save_export(self.root/'batches',self.doc)
        (self.root/'history').mkdir();(self.root/'history'/self.old.name).write_bytes(self.old.read_bytes())
        self.shared=save_blob(self.root,b'shared','image/jpeg','共享图片')
        self.deleted=save_blob(self.root,b'deleted','video/mp4','历史视频')
        inventory=load_resources(self.root,self.config)
        for i,m in enumerate(self.doc['messages']):
            inventory['messages'][m['platformMessageId']]={'items':[{'kind':'image','status':'ready','assets':[self.shared]+([self.deleted] if i==1 else [])}]}
        atomic_json(self.root/'resources.json',inventory)
        (self.root/'summaries').mkdir()
        for day in ('2026-10-20','2026-10-21','2026-10-22'):atomic_json(self.root/'summaries'/(day+'.json'),{'date':day})
        folder=self.root/'summary-runs/run';folder.mkdir(parents=True)
        atomic_json(folder/'receipt.json',dict(date='2026-10-21',credits=.3,status='complete'))
        (folder/'stdout.json').write_text('private result')
        self.fee=(folder/'receipt.json').read_bytes()
        db=self.root/'chatlab/databases/test.db';db.parent.mkdir(parents=True)
        with closing(sqlite3.connect(db)) as c, c:
            c.executescript('create table meta(group_id text); create table message(id integer primary key,ts integer,platform_message_id text,content text); create table message_context(message_id integer,segment_id integer); create table segment(id integer,start_ts integer,end_ts integer);')
            c.execute('insert into meta values (?)',('g@chatroom',))
            c.executemany('insert into message values (?,?,?,?)',[(i,m['timestamp'],m['platformMessageId'],m['content']) for i,m in enumerate(self.doc['messages'])])
        self.db=db

    def hashes(self):
        return {str(p.relative_to(self.root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}

    def test_preview_is_readonly_cleanup_releases_unshared_bytes_and_preserves_fees(self):
        before=self.hashes();p=preview(self.root,'2026-10-21','2026-10-21')
        self.assertEqual(self.hashes(),before);self.assertEqual((p['messages'],p['attachments'],p['summaries']),(1,1,1))
        execute(self.root,'2026-10-21','2026-10-21',p['token'])
        self.assertFalse(self.old.exists());self.assertFalse((self.root/'assets/blobs'/self.deleted['id']).exists())
        self.assertTrue((self.root/'assets/blobs'/self.shared['id']).exists())
        _,messages,ranges=load_archive(self.root)
        self.assertEqual([m['content'] for m in messages],['完整文字0','完整文字2'])
        self.assertFalse(covers_day(ranges,*day_bounds('2026-10-21')))
        self.assertTrue(covers_day(ranges,*day_bounds('2026-10-20')))
        self.assertEqual((self.root/'summary-runs/run/receipt.json').read_bytes(),self.fee)
        self.assertFalse((self.root/'summary-runs/run/stdout.json').exists())
        with closing(sqlite3.connect(self.db)) as c, c:
            self.assertEqual(c.execute('select content from message order by ts').fetchall(),[('完整文字0',),('完整文字2',)])
            self.assertEqual(c.execute('pragma integrity_check').fetchone()[0],'ok')
        again=execute(self.root,'2026-10-21','2026-10-21',p['token']);self.assertEqual(again['status'],'complete')
        # An old import cannot resurrect cleaned messages through the reader.
        save_export(self.root/'batches',self.doc)
        self.assertEqual(len(load_archive(self.root)[1]),2)

    def test_changed_preview_or_foreign_index_stops_before_deletion(self):
        p=preview(self.root,'2026-10-21','2026-10-21')
        (self.root/'resources.json').write_text((self.root/'resources.json').read_text()+' ')
        before=self.hashes()
        with self.assertRaisesRegex(ArchiveError,'记录已变化'):execute(self.root,'2026-10-21','2026-10-21',p['token'])
        self.assertEqual(self.hashes(),before)
        with closing(sqlite3.connect(self.db)) as c, c:c.execute("update meta set group_id='foreign@chatroom'")
        with self.assertRaisesRegex(ArchiveError,'当前群不一致'):preview(self.root,'2026-10-21','2026-10-21')
        with self.assertRaises(ArchiveError):owned(self.root,'../outside')

    def test_unreferenced_cache_is_counted_but_other_groups_are_untouched(self):
        orphan=save_blob(self.root,b'cached unreferenced','image/png','cache')
        other=self.root/'groups/group_other';asset=save_blob(other,b'other group','image/png','other')
        p=preview(self.root,'2026-10-21','2026-10-21')
        self.assertEqual(p['unused_cache_files'],1)
        execute(self.root,'2026-10-21','2026-10-21',p['token'])
        self.assertFalse((self.root/'assets/blobs'/orphan['id']).exists())
        self.assertTrue((other/'assets/blobs'/asset['id']).exists())

    def test_interrupted_cleanup_is_resumed_without_reimport_or_duplicate_fee(self):
        p=preview(self.root,'2026-10-21','2026-10-21');original=Path.unlink;failed=False
        def unlink(file,*args,**kwargs):
            nonlocal failed
            if file.name==self.deleted['id'] and not failed:failed=True;raise PermissionError('fixture')
            return original(file,*args,**kwargs)
        with patch.object(Path,'unlink',unlink),self.assertRaisesRegex(ArchiveError,'保存进度'):
            execute(self.root,'2026-10-21','2026-10-21',p['token'])
        self.assertTrue(preview(self.root,'2026-10-21','2026-10-21')['resuming'])
        context=WeChatService(self.root).context()
        self.assertEqual(context['groups'][0]['cleanup_pending'],{'from':'2026-10-21','to':'2026-10-21'})
        execute(self.root,'2026-10-21','2026-10-21',p['token'])
        self.assertFalse((self.root/'cleanup-pending.json').exists())
        self.assertEqual((self.root/'summary-runs/run/receipt.json').read_bytes(),self.fee)

    def test_service_requires_confirmation_idle_and_group_identity(self):
        service=WeChatService(self.root);group=service.group_id(self.config)
        payload=dict(group=group,confirmed=True,**{'from':'2026-10-21','to':'2026-10-21'})
        with self.assertRaises(ArchiveError):service.post('cleanup-preview',dict(payload,confirmed=False))
        with self.assertRaises(ArchiveError):service.post('cleanup-preview',dict(payload,group='foreign'))
        service.active_read='running'
        with self.assertRaisesRegex(ArchiveError,'当前任务'):service.post('cleanup-preview',payload)


class StorageTests(unittest.TestCase):
    def test_quota_covers_all_groups_reuses_existing_and_never_deletes(self):
        from host_service.wechat import storage
        with tempfile.TemporaryDirectory() as temporary,patch.object(storage,'MAX_ASSET_BYTES',10),patch.object(storage,'MIN_FREE_BYTES',0):
            root=Path(temporary);a=save_blob(root,b'123456','image/jpeg','first')
            with self.assertRaisesRegex(ArchiveError,'存储已达'):save_blob(root/'groups/group_other',b'abcdef','image/jpeg','other')
            self.assertEqual(save_blob(root,b'123456','image/jpeg','same')['id'],a['id'])
            self.assertEqual((root/'assets/blobs'/a['id']).read_bytes(),b'123456')
            with patch.object(storage,'MIN_FREE_BYTES',10**20),self.assertRaisesRegex(ArchiveError,'剩余空间'):
                save_blob(root,b'abc','image/jpeg','new')


if __name__=='__main__':unittest.main()
