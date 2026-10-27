from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from host_service.config import HostConfig
from host_service.wechat.archive import ArchiveError
from host_service.wechat.resources import save_blob,require_summary_resources
from host_service.wechat.media_reading import read_media,prepare_media,MediaFailure,validate_video_report
from host_service.wechat.models import require_input,input_routes


class ModelRoutes(unittest.TestCase):
    def test_local_asr_is_shared_serially_and_released_after_failure(self):
        from host_service.transcription import TranscriptionManager
        entered=threading.Event(); release=threading.Event(); calls=[]
        first=TranscriptionManager(None,None,None); second=TranscriptionManager(None,None,None)
        def local(*args,**kwargs):
            calls.append(threading.current_thread().name)
            entered.set();release.wait(2)
            return {'text':'完整音轨'}
        with patch.object(TranscriptionManager,'_run_local_serial',side_effect=local):
            a=threading.Thread(target=lambda:first._run_local(None,None,lambda:None),name='video-queue')
            b=threading.Thread(target=lambda:second._run_local(None,None,lambda:None),name='wechat')
            a.start();self.assertTrue(entered.wait(1));b.start()
            time.sleep(.05);self.assertEqual(calls,['video-queue'])
            release.set();a.join(2);b.join(2)
            self.assertEqual(calls,['video-queue','wechat'])
        with patch.object(first,'_run_local_serial',side_effect=ValueError('fixture')):
            with self.assertRaises(ValueError):first._run_local(None,None,lambda:None)
        with patch.object(second,'_run_local_serial',return_value={'text':'ok'}):
            self.assertEqual(second._run_local(None,None,lambda:None)['text'],'ok')

    def test_reasoning_effort_is_not_a_video_capability(self):
        require_input('deepseek-v4.1-flash','image')
        with self.assertRaises(ArchiveError):require_input('deepseek-v4.1-flash','video')
        with self.assertRaises(ArchiveError):require_input('hy4-preview','video')
        route=input_routes('deepseek-v4.1-flash')
        self.assertEqual(route['text'],'deepseek-v4.1-flash')
        self.assertIsNone(route['video'])
        self.assertIsNone(route['audio'])


@unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg is required')
class MediaReadingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        output=subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=red:s=32x32:r=5:d=1',
                               '-c:v','libx264','-threads','1','-movflags','frag_keyframe+empty_moov','-f','mp4','-'],capture_output=True,check=True,timeout=30).stdout
        self.asset=save_blob(self.root,output,'video/mp4','video')
        self.config=replace(HostConfig.from_env(),data_dir=self.root,db_path=self.root/'isolated.sqlite3',temp_dir=self.root/'tmp')
        self.calls=[]
    def execute(self,payload):
        self.calls.append(payload['model'])
        self.assertEqual(hashlib.sha256(Path(payload['videoPath']).read_bytes()).hexdigest(),payload['sha256'])
        return dict(complete=True,result={'video_received':True,'observations':'从开始到结束是红色画面'},
                    records=[{'model':payload['model'],'usage':{'credit':.2}}],
                    wire=[{'type':'video_request','videoSha256':payload['sha256']}, {'type':'video_response','status':200}])
    def test_full_video_receipt_cache_and_no_duplicate_charge(self):
        text,rows=read_media(self.root,self.asset,config=self.config,execute=self.execute)
        self.assertIn('红色',text);self.assertEqual(rows[0]['credits'],.2)
        cached,rows=read_media(self.root,self.asset,config=self.config,execute=lambda _:self.fail('cached media repeated'))
        self.assertEqual(text,cached);self.assertEqual(rows,[])
        self.assertEqual(self.calls,['minimax-m3'])
        receipts=list((self.root/'media-readings').glob('*/receipt.json'))
        self.assertEqual(json.loads(receipts[0].read_text(encoding='utf-8'))['status'],'complete')
    def test_paid_failure_is_preserved_and_cannot_replay_as_text(self):
        def blind(payload):
            report=self.execute(payload);report['result']['video_received']=False;return report
        with self.assertRaises(MediaFailure) as caught:read_media(self.root,self.asset,config=self.config,execute=blind)
        self.assertEqual(caught.exception.records[0]['credits'],.2)
        with self.assertRaises(MediaFailure):read_media(self.root,self.asset,config=self.config,execute=lambda _:self.fail('paid retry'))
    def test_only_explicit_model_quota_switches_to_verified_fallback(self):
        def quota(payload):
            if payload['model']=='minimax-m3':
                return dict(complete=False,errorCodes=[6003],wire=[{'type':'video_response','status':429}],records=[])
            return self.execute(payload)
        _,rows=read_media(self.root,self.asset,config=self.config,execute=quota)
        self.assertEqual([r['model'] for r in rows],['minimax-m3','minimax-m3.1-flash'])
        self.assertIsNone(rows[0]['credits'])
    def test_summary_uses_observations_without_modifying_archive_and_missing_blocks(self):
        resource={'kind':'video','label':'视频','status':'ready','assets':[self.asset]}
        original={'resource_coverage':{'missing':0},'messages':[{'id':'m','resources':[resource]}]}
        require_summary_resources(original,allow_media=True)
        with self.assertRaises(ArchiveError):require_summary_resources(original)
        prepared,rows=prepare_media(self.root,original,lambda root,asset:('完整画面与口播',[{'credits':.2}]))
        self.assertNotIn('text',resource);self.assertIn('完整画面',prepared['messages'][0]['resources'][0]['text'])
        require_summary_resources(prepared)
        original['resource_coverage']['missing']=1
        with self.assertRaises(ArchiveError):require_summary_resources(original,allow_media=True)


if __name__=='__main__':unittest.main()
