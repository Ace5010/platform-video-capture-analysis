"""Isolated resource contracts; no production data, keys or model calls."""
import base64
import hashlib
import json
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError, build_export, save_export
from host_service.wechat.resources import (requirements, decrypt_image, signature,
    collect_resources, load_resources, coverage, browser_resources, save_blob,
    blob_path, fetch_public, webpage, require_summary_resources, summary_images)
from host_service.wechat.summaries import prepare_day, day_bounds, model_messages
from host_service.wechat.service import WeChatService

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
GROUP, ACCOUNT = 'fixture@chatroom', 'wxid_fixture'
START, END = day_bounds('2026-10-25')


def message(kind, body='', number=1, **source):
    return build_export(ACCOUNT, GROUP, '测试群', START, END, [dict(
        local_type=kind, message_content=body, server_id=number, local_id=number,
        create_time=START + number, sort_seq=number, shard='message__message_0.db',
        sender_username='fixture_sender', **source)])['messages'][0]


class ResourceTests(unittest.TestCase):
    def test_image_only_scope_never_collects_video_audio_or_files(self):
        from host_service.wechat import resources as module
        messages=[message(43,number=1),message(34,number=2),
                  message(49,'<msg><appmsg><type>6</type><title>clip.mp4</title></appmsg></msg>',number=3)]
        with patch.object(module,'collect_one',side_effect=AssertionError('excluded content downloaded')) as collect:
            report=collect_resources(self.root,self.config,messages)
        collect.assert_not_called();self.assertEqual(report['total'],0);self.assertTrue(report['complete'])
        inventory=load_resources(self.root,self.config)
        for msg in messages:
            resources=browser_resources(msg,inventory)
            self.assertEqual(resources[0]['status'],'excluded')
            self.assertFalse(resources[0].get('assets'))
            require_summary_resources({'messages':[{'resources':resources}]})

    def test_wrapped_xml_declaration_and_invalid_reference_preserve_visible_content(self):
        from host_service.wechat.resources import xml_root
        root=xml_root('<msg><?xml version="1.0"?><appmsg><title>甲&#1;乙&#x1F600;</title></appmsg></msg>')
        self.assertEqual(root.findtext('.//title'),'甲&#1;乙😀')
        with self.assertRaises(ArchiveError):
            xml_root('<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///secret">]><msg>&x;</msg>')

    def test_resource_workers_are_bounded_and_progress_is_serial_and_durable(self):
        from host_service.wechat import resources as module
        messages = [message(3, number=n) for n in range(1, 9)]
        manifest = load_resources(self.root, self.config)
        old_id = messages[0]['platformMessageId']
        manifest['messages'][old_id] = {'items':[dict(kind='image', status='missing', error='仍缺原图')]}
        (self.root/'resources.json').write_text(json.dumps(manifest), encoding='utf-8')
        barrier = threading.Barrier(4)
        guard = threading.Lock()
        active = peak = 0
        started = []
        writer_threads = set()
        original_save = module.atomic_json
        def read(_root, _config, msg, _spec, _key, _fetcher):
            nonlocal active, peak
            with guard:
                active += 1; peak = max(peak, active); started.append(msg['platformMessageId'])
            try:
                barrier.wait(timeout=5)
                if msg['platformMessageId'] == old_id: raise ArchiveError('仍缺原图')
                return {'text':'完整内容', 'assets':[]}
            finally:
                with guard: active -= 1
        def save(*args):
            writer_threads.add(threading.get_ident())
            original_save(*args)
        with patch.object(module, 'collect_one', side_effect=read), patch.object(module, 'atomic_json', side_effect=save):
            result = collect_resources(self.root, self.config, messages)
        self.assertEqual(peak, 4)
        self.assertNotIn(old_id, started[:4])
        self.assertEqual(writer_threads, {threading.get_ident()})
        self.assertEqual((result['ready'],result['missing']), (7,1))
        self.assertEqual(len(load_resources(self.root,self.config)['messages']),8)
        with patch.object(module, 'collect_one', side_effect=ArchiveError('仍缺原图')) as retry, \
             patch.object(module, 'atomic_json') as saved:
            collect_resources(self.root,self.config,messages)
        self.assertEqual(retry.call_count,1)
        saved.assert_not_called()

    def test_compressed_share_type_is_available_in_host_runtime(self):
        import zstandard
        body = '<msg><appmsg><type>5</type><title>测试文章</title><url>https://example.invalid/article</url></appmsg></msg>'
        packed = zstandard.ZstdCompressor().compress(body.encode())
        msg = message(49, '', compress_content=packed)
        self.assertEqual(requirements(msg)[0]['kind'], 'website')
        self.assertEqual(requirements(msg)[0]['url'], 'https://example.invalid/article')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.account = self.root / 'source' / ACCOUNT
        self.account.mkdir(parents=True)
        self.config = dict(account_id=ACCOUNT, account_dir=ACCOUNT, group_id=GROUP,
                           group_name='测试群', db_dir=str(self.account.parent))
        (self.root / 'config.json').write_text(json.dumps(self.config), encoding='utf-8')

    def test_classify_media_links_and_unknown_cards_without_silent_omission(self):
        for kind, category in [(3,'image'), (34,'audio'), (43,'video'), (47,'sticker'), (11000,'sticker'), (48,'location'), (999,'unknown')]:
            self.assertEqual(requirements(message(kind))[0]['kind'], category)
        for subtype, category in [('5','website'), ('6','file'), ('19','forward'), ('33','card')]:
            self.assertEqual(requirements(message(49, f'<msg><appmsg><type>{subtype}</type><title>x</title></appmsg></msg>'))[0]['kind'], category)
        self.assertEqual(len(requirements(message(1, '链接 https://example.invalid/a\nhttps://example.invalid/b'))), 2)
        self.assertEqual(requirements(message(1, '😀 普通文字')), [])

    def test_selected_group_full_image_never_uses_thumbnail(self):
        md5 = 'a' * 32
        msg = message(3, packed_info_data=md5.encode())
        folder = self.account/'msg'/'attach'/hashlib.md5(GROUP.encode()).hexdigest()/'2026-10'/'Img'
        folder.mkdir(parents=True)
        (folder/(md5+'_t.dat')).write_bytes(PNG)
        report = collect_resources(self.root,self.config,[msg])
        self.assertEqual(report['missing'], 1)
        preview = browser_resources(msg,load_resources(self.root,self.config))[0]
        self.assertEqual(preview['error_code'],'thumbnail_only')
        self.assertEqual(preview['assets'][0]['tier'],'thumbnail')
        with patch('host_service.wechat.resources.collect_one') as repeated:
            collect_resources(self.root,self.config,[msg])
            repeated.assert_not_called()
        prepared = {'messages':[{'id':'m_one','resources':[preview]}]}
        self.assertEqual(summary_images(self.root,prepared),[])
        # Even an incorrectly promoted legacy receipt cannot send a thumbnail.
        preview['status']='ready'
        self.assertEqual(summary_images(self.root,prepared),[])
        (folder/(md5+'.dat')).write_bytes(PNG)
        report = collect_resources(self.root,self.config,[msg])
        self.assertTrue(report['complete'])
        inventory = load_resources(self.root,self.config)
        asset = browser_resources(msg,inventory)[0]['assets'][0]
        self.assertEqual(asset['tier'],'received')
        self.assertEqual(blob_path(self.root,asset).read_bytes(),PNG)
        self.assertNotIn(str(self.account), json.dumps(browser_resources(msg,inventory)))
        wrong = dict(self.config, group_id='other@chatroom')
        with self.assertRaises(ArchiveError): load_resources(self.root,wrong)

    def test_image_failure_categories_and_single_retry_preserve_other_records(self):
        md5='b'*32
        msg=message(3,packed_info_data=md5.encode())
        unrelated=message(1,'https://example.invalid',number=2)
        inventory=load_resources(self.root,self.config)
        other={'items':[dict(kind='website',status='missing',error='既有记录')]}
        inventory['messages'][unrelated['platformMessageId']]=other
        (self.root/'resources.json').write_text(json.dumps(inventory),encoding='utf-8')
        def collect():
            collect_resources(self.root,self.config,[msg,unrelated],images_only=True,
                              fetcher=lambda _:self.fail('Image retry must not access network'))
            inventory=load_resources(self.root,self.config)
            self.assertEqual(inventory['messages'][unrelated['platformMessageId']],other)
            return browser_resources(msg,inventory)[0]
        self.assertEqual(collect()['error_code'],'file_missing')
        folder=self.account/'msg'/'attach'/hashlib.md5(GROUP.encode()).hexdigest()/'2026-10'/'Img'
        folder.mkdir(parents=True)
        (folder/(md5+'.dat')).write_bytes(b'broken image')
        (folder/(md5+'_t.dat')).write_bytes(PNG)
        failed=collect()
        self.assertEqual(failed['error_code'],'decode_failed')
        self.assertEqual(failed['error'],'图片解析失败')
        self.assertEqual(failed['assets'][0]['tier'],'thumbnail')
        (folder/(md5+'.dat')).write_bytes(PNG)
        self.assertEqual(collect()['status'],'ready')
        self.assertNotIn('error_code',collect())

    def test_original_priority_across_identifiers_and_upgrade_after_arrival(self):
        from host_service.wechat.resources import image_candidates,index_image_files
        first,second='c'*32,'d'*32
        msg=message(3,packed_info_data=(first+' '+second).encode())
        folder=self.account/'msg'/'attach'/hashlib.md5(GROUP.encode()).hexdigest()/'2026-10'/'Img'
        folder.mkdir(parents=True)
        (folder/(first+'.dat')).write_bytes(PNG)
        collect_resources(self.root,self.config,[msg])
        (folder/(second+'_h.dat')).write_bytes(PNG)
        cfg=dict(self.config,_image_file_index=index_image_files(self.config))
        self.assertEqual(image_candidates(cfg,msg,requirements(msg)[0])[0][1],'original')
        collect_resources(self.root,self.config,[msg])
        self.assertEqual(browser_resources(msg,load_resources(self.root,self.config))[0]['assets'][0]['tier'],'original')

    def test_single_image_cli_never_reads_history_or_downloads_other_resources(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from types import SimpleNamespace
        from host_service.wechat.main import main
        from host_service.wechat.archive import digest
        target=message(3,packed_info_data=b'a'*32)
        unrelated=message(1,'https://example.invalid',number=2)
        config=dict(self.config,data_dir=str(self.root),pid=123)
        (self.root/'config.json').write_text(json.dumps(config),encoding='utf-8')
        mid='m_'+digest(target['platformMessageId'])[:16]
        upstream=SimpleNamespace(extract_master_key_from_cfg=lambda _: (None,19,ACCOUNT))
        with patch.object(sys,'argv',['wechat','resources','--config',str(self.root/'config.json'),'--message',mid]), \
             patch('host_service.wechat.summaries.load_archive',return_value=(config,[target,unrelated],[(START,END)])), \
             patch('host_service.wechat.reader.collect') as history, \
             patch('host_service.wechat.reader.active_pid',return_value=123), \
             patch('host_service.wechat.reader.load_upstream',return_value=upstream), \
             patch('host_service.wechat.resources.collect_resources',return_value={'complete':False}) as collect, \
             redirect_stdout(StringIO()):
            self.assertEqual(main(),0)
        history.assert_not_called()
        self.assertEqual(collect.call_args.args[2],[target])
        self.assertTrue(collect.call_args.kwargs['images_only'])

    def test_batch_image_index_is_scoped_and_refreshes_on_next_read(self):
        from host_service.wechat import resources
        md5 = 'c' * 32
        msg = message(3, packed_info_data=md5.encode())
        folder = self.account/'msg'/'attach'/hashlib.md5(GROUP.encode()).hexdigest()/'2026-10'/'Img'
        folder.mkdir(parents=True)
        (folder/(md5+'_t.dat')).write_bytes(PNG)
        other = self.account/'msg'/'attach'/'another-group'/'2026-10'/'Img'
        other.mkdir(parents=True)
        (other/(md5+'.dat')).write_bytes(PNG)
        self.assertFalse(collect_resources(self.root,self.config,[msg])['complete'])
        (folder/(md5+'.dat')).write_bytes(PNG)
        with patch.object(resources,'index_image_files',wraps=resources.index_image_files) as indexed:
            self.assertTrue(collect_resources(self.root,self.config,[msg])['complete'])
            self.assertEqual(indexed.call_count,1)
        self.assertNotIn('_image_file_index',self.config)

    def test_v2_decryption_alignment_xor_and_corruption(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        cfg = 19
        key = hashlib.md5((str(cfg)+ACCOUNT).encode()).hexdigest()[:16].encode()
        head, tail = PNG[:32], PNG[32:]
        encrypted = Cipher(algorithms.AES(key),modes.ECB()).encryptor().update(head + b'\x10'*16)
        container = b'\x07\x08V2\x08\x07' + struct.pack('<II',32,len(tail)) + b'\x00' + encrypted + bytes(x^(cfg&255) for x in tail)
        self.assertEqual(decrypt_image(container,cfg,ACCOUNT),PNG)
        with self.assertRaises(ArchiveError): decrypt_image(container,20,ACCOUNT)
        with self.assertRaises(ArchiveError): decrypt_image(container[:20],cfg,ACCOUNT)
        self.assertEqual(decrypt_image(bytes(x ^ 0x88 for x in PNG)),PNG)
        self.assertIsNone(signature(PNG[:-20]))

    def test_sticker_actual_file_fingerprint_and_retry_retains_success(self):
        md5 = hashlib.md5(PNG).hexdigest()
        msg = message(47, f'<msg><emoji md5="{md5}" cdnurl="https://example.invalid/emoji" /></msg>')
        calls = []
        def fetch(url):
            calls.append(url)
            return PNG,'image/png',url
        report = collect_resources(self.root,self.config,[msg],fetcher=fetch)
        self.assertTrue(report['complete'])
        collect_resources(self.root,self.config,[msg],fetcher=lambda _: self.fail('already saved'))
        self.assertEqual(len(calls),1)
        resource = browser_resources(msg,load_resources(self.root,self.config))[0]
        self.assertNotIn('cdnurl',json.dumps(resource))
        file = self.root/'assets'/'blobs'/resource['assets'][0]['id']
        file.write_bytes(b'corrupt')
        with self.assertRaises(ArchiveError): blob_path(self.root,resource['assets'][0])
        collect_resources(self.root,self.config,[msg],fetcher=fetch)
        self.assertEqual(coverage([msg],load_resources(self.root,self.config))['missing'],1)

    def test_website_full_body_and_images_missing_image_is_not_success(self):
        html = ('<html><body>' + '正文内容 '*70 + '<script>隐藏密钥</script><img data-src="/image.png"></body></html>').encode()
        msg = message(49,'<msg><appmsg><type>5</type><title>网页</title><url>https://example.invalid/page</url></appmsg></msg>')
        def fetch(url):
            return (PNG,'image/png',url) if url.endswith('.png') else (html,'text/html; charset=utf-8',url)
        report = collect_resources(self.root,self.config,[msg],fetcher=fetch)
        self.assertTrue(report['complete'])
        item = browser_resources(msg,load_resources(self.root,self.config))[0]
        self.assertNotIn('隐藏密钥',item['text'])
        self.assertEqual(len(item['assets']),1)  # only images are exposed to reading/model input
        self.assertTrue(item['assets'][0]['mime'].startswith('image/'))
        with self.assertRaises(ArchiveError): webpage(b'<body>please log in</body>','text/html','https://example.invalid')

    def test_public_fetch_rejects_private_dns_credentials_and_redirect_budget(self):
        with patch('socket.getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',80))]):
            with self.assertRaises(ArchiveError): fetch_public('http://example.invalid/')
        for url in ['file:///etc/passwd','http://user:password@example.invalid','http://127.0.0.1:43129/health']:
            with self.assertRaises(ArchiveError): fetch_public(url)

    def test_resource_coverage_changes_summary_hash_and_passes_image_to_model(self):
        msg = message(3, packed_info_data=b'a'*32)
        payload = build_export(ACCOUNT,GROUP,'测试群',START,END,[dict(msg['_source'], message_content='',packed_info_data=b'a'*32)])
        batch = save_export(self.root/'batches',payload)
        before_bytes = batch.read_bytes()
        before = prepare_day(self.root,'2026-10-25')
        with self.assertRaises(ArchiveError): require_summary_resources(before)
        asset = save_blob(self.root,PNG,'image/png','图片')
        manifest = load_resources(self.root,self.config)
        manifest['messages'][msg['platformMessageId']] = {'items':[{'status':'ready','assets':[asset]}]}
        (self.root/'resources.json').write_text(json.dumps(manifest),encoding='utf-8')
        after = prepare_day(self.root,'2026-10-25')
        self.assertNotEqual(before['source_hash'],after['source_hash'])
        require_summary_resources(after)
        self.assertEqual(len(summary_images(self.root,after)),1)
        self.assertEqual(batch.read_bytes(),before_bytes)
        service = WeChatService(self.root)
        group = service.group_id(self.config)
        file, registered = service.get('asset',dict(group=group,asset=asset['id']))
        self.assertEqual(file.read_bytes(),PNG)
        self.assertEqual(registered['id'],asset['id'])
        with patch.object(service, '_archive', side_effect=AssertionError('each image must not reload all history')):
            self.assertEqual(service.get('asset',dict(group=group,asset=asset['id']))[0].read_bytes(), PNG)
        with self.assertRaises(ArchiveError): service.get('asset',dict(group=group,asset='../config.json'))
        batch.write_text('{}', encoding='utf-8')
        with self.assertRaises((ArchiveError, KeyError)):
            service.get('asset',dict(group=group,asset=asset['id']))

    def test_website_text_is_part_of_model_input_not_just_card_title(self):
        prepared = {'messages':[dict(id='m',content='网站标题',resources=[{'text':'实际网页正文'}])], 'replies':{}}
        self.assertIn('实际网页正文',model_messages(prepared)[0]['content'])

    def test_service_cache_refreshes_image_status_and_revokes_removed_asset(self):
        msg=message(3,packed_info_data=b'a'*32)
        save_export(self.root/'batches',build_export(ACCOUNT,GROUP,'测试群',START,END,
                    [dict(msg['_source'],message_content='',packed_info_data=b'a'*32)]))
        service=WeChatService(self.root);group=service.group_id(self.config)
        query=dict(group=group,date='2026-10-25')
        self.assertEqual(service.get('original',query)['messages'][0]['resources'][0]['status'],'pending')
        asset=save_blob(self.root,PNG,'image/png','图片')
        inventory=load_resources(self.root,self.config)
        inventory['messages'][msg['platformMessageId']]={'items':[dict(kind='image',status='ready',assets=[asset])]}
        from host_service.wechat.archive import atomic_json
        atomic_json(self.root/'resources.json',inventory)
        original=service.get('original',query)
        self.assertEqual(original['messages'][0]['resources'][0]['status'],'ready')
        self.assertEqual(service.get('asset',dict(group=group,asset=asset['id']))[1]['id'],asset['id'])
        inventory['messages'].clear();atomic_json(self.root/'resources.json',inventory)
        self.assertEqual(service.get('original',query)['messages'][0]['resources'][0]['status'],'pending')
        with self.assertRaises(ArchiveError):service.get('asset',dict(group=group,asset=asset['id']))

    def test_missing_images_are_explicit_and_do_not_block_authorized_summary(self):
        from host_service.wechat.resources import missing_resources
        prepared={'resource_coverage':{'missing':1},'sources':{'m1':{'sender':'甲'}},
                  'messages':[{'id':'m1','time':'09:10:00','resources':[
                      {'kind':'image','label':'图片','status':'missing','error':'本机没有完整图片'},
                      {'kind':'video','label':'视频','status':'excluded'}]}]}
        with self.assertRaises(ArchiveError):require_summary_resources(prepared)
        require_summary_resources(prepared,allow_missing=True)
        self.assertEqual(missing_resources(prepared),[dict(message='m1',time='09:10:00',sender='甲',
                         kind='image',label='图片',reason='本机没有完整图片')])

    def test_long_image_tiles_reconstruct_all_original_pixels_and_keep_blob(self):
        from PIL import Image
        from io import BytesIO
        from hashlib import sha256
        output = BytesIO()
        original = Image.new('RGBA', (31, 12614), (10, 20, 30, 127))
        for y in range(original.height):
            original.putpixel((y % 31, y), (y % 256, 77, 88, 255))
        original.save(output, format='PNG')
        asset = save_blob(self.root, output.getvalue(), 'image/png', '长图')
        prepared = {'sources': {}, 'messages': [{'id': 'm1', 'resources': [{'kind': 'image', 'assets': [asset]}]}]}
        with tempfile.TemporaryDirectory(dir=self.root) as tmp:
            images = summary_images(self.root, prepared, temporary_dir=tmp)
            self.assertEqual(len(images), 4)
            joined = Image.new('RGBA', original.size)
            for index, (_, tile, path) in enumerate(images):
                self.assertEqual(tile['tile_index'], index + 1)
                self.assertEqual(tile['source_id'], asset['id'])
                with Image.open(path) as piece:
                    self.assertLessEqual(max(piece.size), 4096)
                    joined.paste(piece, tile['tile_box'][:2])
                self.assertEqual(sha256(path.read_bytes()).hexdigest(), tile['id'])
            self.assertEqual(joined.tobytes(), original.tobytes())
        self.assertEqual(blob_path(self.root, asset).read_bytes(), output.getvalue())
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch('host_service.wechat.resources.MAX_SUMMARY_IMAGE_COUNT', 3):
            gaps = []
            self.assertEqual(summary_images(self.root, prepared, temporary_dir=tmp, skipped=gaps), [])
            self.assertEqual(len(gaps), 1)
            self.assertFalse(list(Path(tmp).iterdir()))

    def test_oversized_animation_is_wholly_reported_and_static_image_still_read(self):
        from PIL import Image
        from io import BytesIO
        import tempfile
        output=BytesIO()
        frames=[Image.new('RGB',(20,20),c) for c in ('red','green','blue')]
        frames[0].save(output,format='GIF',save_all=True,append_images=frames[1:],duration=100)
        animated=save_blob(self.root,output.getvalue(),'image/gif','动图')
        static=save_blob(self.root,PNG,'image/png','图片')
        prepared={'sources':{},'messages':[{'id':'m1','time':'09:00','resources':[
                     {'kind':'sticker','label':'表情包','assets':[animated]}]},
                   {'id':'m2','time':'09:01','resources':[{'kind':'image','label':'图片','assets':[static]}]}]}
        before=set((self.root/'assets/blobs').iterdir());gaps=[]
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch('host_service.wechat.resources.MAX_SUMMARY_IMAGE_COUNT',2):
            images=summary_images(self.root,prepared,temporary_dir=tmp,skipped=gaps)
            self.assertEqual([x[0] for x in images],['m2'])
            self.assertEqual(gaps[0]['message'],'m1')
            self.assertFalse(list(Path(tmp).iterdir()))
        self.assertEqual(set((self.root/'assets/blobs').iterdir()),before)


if __name__ == '__main__': unittest.main()
