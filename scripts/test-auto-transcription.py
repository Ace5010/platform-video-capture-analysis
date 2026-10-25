"""Isolated collection -> local transcription -> SQLite checks; no cloud/API keys."""
import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.config import HostConfig
from host_service.database import Database
from host_service.transcription import TranscriptionManager
from host_service.analysis import AnalysisManager
from host_service.server import create_server
from host_service.browser import BrowserManager
from unittest.mock import Mock


with tempfile.TemporaryDirectory(prefix="observer-transcription-") as temp:
    root=Path(temp)
    cfg=replace(HostConfig.from_env(),testing=True,data_dir=root,db_path=root/'test.sqlite3',
                temp_dir=root/'tmp',backup_dir=root/'backup',secret_path=root/'secret',local_asr_dir=root/'asr')
    cfg.ensure_directories()
    for path in ['transcribe.py','hotwords.json','.venv/Scripts/python.exe']:
        p=cfg.local_asr_dir/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('[]',encoding='utf-8')
    db=Database(cfg);db.initialize()
    db.pair_connector('fixture','测试','fixture','isolated-token','0.9.7',['archive_account'])
    account={'id':'a','platform':'douyin','name':'测试','url':'https://www.douyin.com/user/test'}
    account=db.upsert_account(account)
    video={'id':'7000000000000000001','accountId':account['id'],'title':'测试','url':'https://www.douyin.com/video/7000000000000000001','durationSeconds':30,
           'analysis':{'preserve':'原有画面分析'},'analysisStatus':'ready'}
    db.create_job('archive_account',{'accountId':account['id']})
    collection_job=db.claim_job('fixture',['archive_account'])
    def collect(event,videos):
        db.process_connector_event('fixture',collection_job['id'],collection_job['claimToken'],event,'collection_result',{'account':account,'accountId':account['id'],'mode':'initial','videos':videos})
    collect('first',[video])
    assert db.transcription_state(video['id'])['status']=='queued'
    collect('first',[video]);collect('refresh',[video])
    with closing(db.connect()) as c:assert c.execute('SELECT COUNT(*) FROM transcription_jobs').fetchone()[0]==1
    job=db.claim_transcription();assert job and not db.claim_transcription()
    assert db.get_video(video['id'])['transcriptStatus']=='processing'
    collect('refresh-while-running',[{**video,'transcript':None,'transcriptStatus':'idle'}])
    assert db.get_video(video['id'])['transcriptStatus']=='processing'
    assert not db.finish_transcription(video['id'],'stale','错误的迟到稿')
    assert db.finish_transcription(video['id'],job['claimToken'],'完整口播',metadata={'vocabulary':['Opus']})
    saved=db.get_video(video['id']);assert saved['transcriptRaw']=='完整口播' and saved['analysis']==video['analysis'] and saved['analysisStatus']=='ready', saved
    assert db.queue_transcription(video['id'],retry=True) is None
    # Existing text remains reusable by the untouched full-video analysis path.
    manager=AnalysisManager(cfg,db,None)
    assert manager._saved_transcript(video['id'])==saved['transcript'];manager.shutdown()
    collect('ready-preserved',[{**video,'transcript':None,'transcriptStatus':'idle'}])
    assert db.get_video(video['id'])['transcriptStatus']=='ready'
    # Historical migration/upsert does not trigger a batch backfill.
    historical={**video,'id':'7000000000000000002'}
    with db.transaction() as c:db._upsert_video(c,historical)
    assert db.transcription_state(historical['id']) is None
    collect('historical-collected-again',[historical])
    assert db.transcription_state(historical['id'])['status']=='queued'
    # Queue and lease survive restarts; stale attempts cannot overwrite new work.
    db.queue_transcription(historical['id']);old=db.claim_transcription()
    with db.transaction() as c:c.execute('UPDATE transcription_jobs SET claim_until=0 WHERE video_id=?',(historical['id'],))
    db2=Database(cfg);db2.initialize();fresh=db2.claim_transcription()
    assert fresh and fresh['claimToken']!=old['claimToken']
    assert not db2.finish_transcription(historical['id'],old['claimToken'],'过期结果')
    db2.finish_transcription(historical['id'],fresh['claimToken'],error='音轨读取失败')
    assert db2.get_video(historical['id'])['transcriptStatus']=='error' and db2.get_video(historical['id'])['analysis']==video['analysis']
    db2.queue_transcription(historical['id'],retry=True)
    assert db2.transcription_state(historical['id'])['status']=='queued'
    db2.release_transcription(historical['id'],db2.claim_transcription()['claimToken'])
    # New collection and queued ASR are atomic; an invalid later record rolls both back.
    try:collect('rollback',[{**video,'id':'7000000000000000003'},{**video,'id':None}])
    except ValueError:pass
    else:raise AssertionError('Invalid collection should fail')
    assert db2.get_video('7000000000000000003') is None and db2.transcription_state('7000000000000000003') is None
    # Full local pipeline with isolated media I/O; no analysis methods or cloud calls.
    media={'videoId':historical['id'],'page':{'observedVideoId':historical['id']},'audio':{'url':'https://example.invalid/audio','metadata':{'targetBound':True}}}
    worker=TranscriptionManager(cfg,db2,lambda *args,**kw:media)
    def download(url,path,*args,**kw):path.write_bytes(b'fixture')
    probe=type('P',(),{'returncode':0,'stdout':json.dumps({'format':{'duration':'30'},'streams':[{'codec_type':'audio'}]})})()
    with patch('host_service.transcription.download_media',download),patch('host_service.transcription.subprocess.run',return_value=probe),patch.object(worker,'_run_local',return_value={'text':'完整口播稿','audio_seconds':30,'vocabulary':['Opus']}):
        worker.run_job(db2.claim_transcription())
    assert db2.get_video(historical['id'])['transcriptRaw']=='完整口播稿'
    assert not list(cfg.temp_dir.iterdir())
    # A wrong target and short audio fail without publishing a transcript.
    for i,wrong_target in enumerate([True,False],4):
        vid={**video,'id':str(7000000000000000000+i)};collect('case'+str(i),[vid])
        media['videoId']='wrong' if wrong_target else vid['id'];media['page']['observedVideoId']=media['videoId']
        probe.stdout=json.dumps({'format':{'duration':'5'},'streams':[{'codec_type':'audio'}]})
        with patch('host_service.transcription.download_media',download),patch('host_service.transcription.subprocess.run',return_value=probe),patch.object(worker,'_run_local') as model:
            worker.run_job(db2.claim_transcription());assert not model.called
        assert db2.get_video(vid['id'])['transcriptStatus']=='error' and not list(cfg.temp_dir.iterdir())
    # Finished cloud text wins a concurrent local completion rather than being overwritten.
    vid={**video,'id':'7000000000000000006'};collect('race',[vid]);job=db2.claim_transcription()
    with db2.transaction() as c:
        d=json.loads(c.execute('SELECT data_json FROM videos WHERE id=?',(vid['id'],)).fetchone()[0]);d.update(transcript='已完成的另一份稿',transcriptStatus='ready')
        c.execute('UPDATE videos SET data_json=? WHERE id=?',(json.dumps(d),vid['id']))
    db2.finish_transcription(vid['id'],job['claimToken'],'迟到的本地稿')
    assert db2.get_video(vid['id'])['transcript'].startswith('已完成的另一份稿')
    # Collection hands the bound source directly to the local worker; no second page lookup.
    direct={**video,'id':'7000000000000000008'}
    with db2.transaction() as c:db2._upsert_video(c,direct)
    broker=BrowserManager(cfg,db2,None)
    source={'videoId':direct['id'],'accountId':account['id'],'origin':'collection','page':{'observedVideoId':direct['id']},
            'audio':{'url':'https://test.douyinvod.com/full-track.m4a?temporary=private','metadata':{'targetBound':True}}}
    broker.remember_transcription_sources(account['id'],[direct],{direct['id']:source})
    broker._rpc=Mock(side_effect=AssertionError('No second page lookup allowed'))
    db2.queue_transcription(direct['id'])
    fast=TranscriptionManager(cfg,db2,broker.capture_transcription_media)
    probe.stdout=json.dumps({'format':{'duration':'30'},'streams':[{'codec_type':'audio'}]})
    with patch('host_service.transcription.download_media',download),patch('host_service.transcription.subprocess.run',return_value=probe),patch.object(fast,'_run_local',return_value={'text':'采集时直接交接','audio_seconds':30}):
        fast.run_job(db2.claim_transcription())
    assert db2.get_video(direct['id'])['transcriptMetadata']['media_origin']=='collection'
    broker._rpc.assert_not_called()
    with closing(db2.connect()) as c:assert 'temporary=private' not in c.execute('select data_json from videos where id=?',(direct['id'],)).fetchone()[0]
    # Wrong accounts/targets are rejected, and an expired cache is resolved afresh.
    broker.remember_transcription_sources('wrong',[direct],{direct['id']:source})
    assert not broker._transcription_sources
    expiry={**direct,'id':'7000000000000000009'}
    with db2.transaction() as c:db2._upsert_video(c,expiry)
    expired_source={**source,'videoId':expiry['id'],'page':{'observedVideoId':expiry['id']}}
    broker.remember_transcription_sources(account['id'],[expiry],{expiry['id']:expired_source})
    stamp,cached=broker._transcription_sources[expiry['id']];broker._transcription_sources[expiry['id']]=(0,cached)
    broker._rpc=Mock(return_value=expired_source)
    assert broker.capture_transcription_media(expiry,deadline=0,check_cancelled=lambda:None)['videoId']==expiry['id']
    broker._rpc.assert_called_once()
    # A signed URL rejected by the CDN gets one fresh lookup and one ASR run.
    denied={**direct,'id':'7000000000000000010'}
    with db2.transaction() as c:db2._upsert_video(c,denied)
    denied_source={**source,'videoId':denied['id'],'page':{'observedVideoId':denied['id']}}
    broker.remember_transcription_sources(account['id'],[denied],{denied['id']:denied_source})
    fresh_source={**denied_source};fresh_source.pop('origin')
    broker._rpc=Mock(return_value=fresh_source)
    db2.queue_transcription(denied['id']);downloads=[]
    def denied_then_fresh(url,path,*args,**kw):
        downloads.append(url)
        if len(downloads)==1:raise RuntimeError('CDN 返回 HTTP 403')
        path.write_bytes(b'fresh')
    with patch('host_service.transcription.download_media',denied_then_fresh),patch('host_service.transcription.subprocess.run',return_value=probe),patch.object(fast,'_run_local',return_value={'text':'刷新过期地址后识别','audio_seconds':30}) as model:
        fast.run_job(db2.claim_transcription());model.assert_called_once()
    assert len(downloads)==2 and db2.get_video(denied['id'])['transcriptMetadata']['media_origin']=='video_page'
    broker._rpc.assert_called_once()
    # Local extraction uses the existing password/CSRF boundary and needs no Qwen key.
    spec=importlib.util.spec_from_file_location('host_test_helpers',Path(__file__).with_name('test-host-service.py'))
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    server=create_server(replace(cfg,listen_host='127.0.0.1',listen_port=0))
    server.transcriptions=worker
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        client=helper.ApiClient('127.0.0.1',server.server_port)
        body={'type':'transcribe_video','payload':{'videoId':'7000000000000000007'}}
        assert client.request('POST','/api/jobs',body,use_cookie=False)[0]==401
        assert client.request('POST','/api/auth/setup',{'password':'isolated-test-password'},use_cookie=False)[0]==201
        with db2.transaction() as c:db2._upsert_video(c,{**video,'id':body['payload']['videoId']})
        assert client.request('POST','/api/jobs',body,csrf='')[0]==403
        status,response,_=client.request('POST','/api/jobs',body)
        assert status==200 and response['video']['transcriptStatus']=='queued', response
        assert not server.secrets.load()
        assert not any(j['type']=='analyze_video' for j in db2.list_jobs())
    finally:
        server.shutdown();server.server_close();server.analysis.shutdown();thread.join(timeout=5)
print('Auto transcription checks passed: atomic enqueue, dedup, durability, lease fencing, retries, full-audio checks, cleanup, analysis preservation and reuse.')
