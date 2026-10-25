"""Isolated profile deduplication and lossless legacy account repair checks."""
from __future__ import annotations

import json
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.account_identity import canonical_douyin_account_url
from host_service.config import HostConfig
from host_service.database import Database

URL = 'https://www.douyin.com/user/MS4w.Test-profile'


with tempfile.TemporaryDirectory(prefix='douyin-account-merge-') as temporary:
    root = Path(temporary)
    cfg = replace(HostConfig.from_env(), data_dir=root, db_path=root / 'monitor.sqlite3',
                  secret_path=root / 'secret.dpapi', backup_dir=root / 'backups', temp_dir=root / 'tmp', testing=True)
    db = Database(cfg)
    db.initialize()
    for value in (URL, URL + '?nt=1', URL + '?nt=2#works', 'http://douyin.com/user/MS4w.Test-profile/'):
        assert canonical_douyin_account_url(value) == URL
    for value in ('https://evildouyin.com/user/a', 'https://www.douyin.com/video/1', 'https://u:p@www.douyin.com/user/a'):
        assert canonical_douyin_account_url(value) is None

    # Create the exact legacy failure shape without using the now-fixed add path.
    older = {'id': 'older', 'platform': 'douyin', 'url': URL + '?nt=2', 'name': '原有账号',
             'addedAt': '2026-10-01T00:00:00Z', 'collectedHistoryIds': ['v1'],
             'initialSyncStatus': 'complete', 'initialSyncCompletedAt': '2026-10-01T00:05:00Z',
             'avatarUrl': 'saved-avatar', 'followerCount': 10, 'followerDisplayText': '10',
             'followerCountCapturedAt': '2026-10-03T00:00:00Z', 'followerCountIsApproximate': False,
             'currentSyncMode': 'initial', 'collectionError': '旧失败'}
    newer = {'id': 'newer', 'platform': 'douyin', 'url': URL + '?nt=1', 'name': '新名称',
             'addedAt': '2026-10-02T00:00:00Z', 'collectedHistoryIds': ['v1', 'v2'],
             'initialSyncStatus': 'pending', 'followerCount': None, 'followerDisplayText': '1.1万',
             'followerCountCapturedAt': '2026-10-04T00:00:00Z', 'followerCountIsApproximate': True,
             'currentSyncMode': None, 'collectionError': None}
    with db.transaction() as c:
        for index, account in enumerate((older, newer)):
            timestamp = f'2026-10-0{index + 1}T00:00:00Z'
            c.execute('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)',
                      (account['id'], 'douyin', account['url'], account['name'], json.dumps(account), timestamp, timestamp))
        for index, account in enumerate((older, newer)):
            vid = 'v' + str(index + 1)
            db._upsert_video(c, {'id': vid, 'accountId': account['id'], 'title': vid, 'transcript': '保存的完整口播。',
                                'analysis': {'saved': True}, 'analysisUsage': {'estimatedCostCny': 0.2}, 'firstSeenAt': '2026-09-20'})
            db._upsert_snapshot(c, {'videoId': vid, 'accountId': account['id'], 'capturedAt': '2026-10-01', 'likeCount': index})
        now = time.time()
        for account_id, video_id, timestamp in [('older', 'v1', now - 100), ('newer', 'v1', now - 200), ('newer', 'v2', now - 50)]:
            c.execute('INSERT INTO collection_discoveries(account_id,video_id,discovered_at,origin_event_id) VALUES(?,?,?,?)',
                      (account_id, video_id, timestamp, f'{account_id}-{video_id}'))
        c.execute("UPDATE collection_discoveries SET cleared_at='2026-10-04T00:00:00Z' WHERE account_id='older'")
        c.execute("UPDATE collection_discoveries SET cleared_at='2026-10-04T01:00:00Z' WHERE video_id='v2'")
    history_job, _ = db.create_job('analyze_video', {'accountId': 'newer', 'videoId': 'v2', 'analysisVersion': 'v1'})
    try:
        db.merge_accounts('older', ['newer'])
        raise AssertionError('an active job must prevent repair')
    except ValueError as error:
        assert '活动任务' in str(error)
    db.save_analysis_failure(history_job['id'], '模型提交结果未确认，保留费用')
    with closing(db.connect()) as c:
        history = {table: [tuple(row) for row in c.execute(f'SELECT * FROM {table} ORDER BY id')]
                   for table in ('jobs', 'analysis_runs')}
        original_videos = {row['id']: json.loads(row['data_json']) for row in c.execute('SELECT id,data_json FROM videos')}
        original_snapshots = [json.loads(row['data_json']) for row in c.execute('SELECT data_json FROM snapshots ORDER BY id')]

    # A similarly named different profile must not be merged; rejection is atomic.
    db.upsert_account({'id': 'different', 'platform': 'douyin', 'url': 'https://www.douyin.com/user/other', 'name': '新名称'})
    try:
        db.merge_accounts('older', ['newer', 'different'])
        raise AssertionError('distinct profile IDs must not merge')
    except ValueError:
        pass
    assert len(db.state()['accounts']) == 3
    merged = db.merge_accounts('older', ['newer'])
    assert merged['id'] == 'older' and merged['url'] == URL and merged['name'] == '新名称'
    assert merged['addedAt'] == older['addedAt'] and merged['avatarUrl'] == 'saved-avatar'
    assert merged['initialSyncStatus'] == 'complete'
    assert merged['currentSyncMode'] is None and merged['collectionError'] is None
    assert merged['followerCount'] is None and merged['followerDisplayText'] == '1.1万'
    assert merged['collectedHistoryIds'] == ['v1', 'v2'] and merged['mergedAccountIds'] == ['newer']
    with closing(db.connect()) as c:
        assert not list(c.execute('PRAGMA foreign_key_check'))
        for table in history:
            assert [tuple(row) for row in c.execute(f'SELECT * FROM {table} ORDER BY id')] == history[table]
        for row in c.execute('SELECT id,account_id,data_json FROM videos'):
            assert row['account_id'] == 'older'
            actual = json.loads(row['data_json']); actual['accountId'] = original_videos[row['id']]['accountId']
            assert actual == original_videos[row['id']]
        for index, row in enumerate(c.execute('SELECT account_id,data_json FROM snapshots ORDER BY id')):
            assert row['account_id'] == 'older'
            actual = json.loads(row['data_json']); actual['accountId'] = original_snapshots[index]['accountId']
            assert actual == original_snapshots[index]
        discoveries = list(c.execute('SELECT * FROM collection_discoveries ORDER BY video_id'))
        assert len(discoveries) == 2 and discoveries[0]['discovered_at'] == now - 200
        assert all(row['account_id'] == 'older' for row in discoveries)
        assert discoveries[0]['cleared_at'] == '2026-10-04T00:00:00Z'
        assert discoveries[1]['cleared_at'] == '2026-10-04T01:00:00Z'
    assert db.recent_discoveries()[0] == [], 'merge must not restore dismissed notifications from either account'

    # Concurrent clients cannot create another row or overwrite existing metadata.
    def repeated_add(index):
        return db.upsert_account({'id': f'duplicate-{index}', 'platform': 'douyin',
                                 'url': f'{URL}?nt={index}', 'name': '待识别账号'})
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(repeated_add, range(8)))
    assert all(row['id'] == 'older' and row['name'] == '新名称' for row in results)
    assert len(db.state()['accounts']) == 2
    assert db.upsert_account({'id': 'newer', 'status': 'ready'})['id'] == 'older'
    retry_job, created = db.create_job('analyze_video', {'accountId': 'older', 'videoId': 'v2', 'analysisVersion': 'v1'})
    assert not created and retry_job['id'] == history_job['id'], 'merge must not create another paid-analysis attempt'
    db.migrate({'accounts': [newer], 'videos': [{'id': 'v2', 'accountId': 'newer', 'title': 'v2'}]})
    assert len(db.state()['accounts']) == 2 and db.get_video('v2')['accountId'] == 'older'
    archive_job, _ = db.create_job('archive_account', {'account': newer})
    assert archive_job['payload']['accountId'] == 'older' and archive_job['payload']['account']['id'] == 'older'
    print('Account merge passed: canonical identity, concurrent adds, atomic guards, all works/snapshots/history, earliest discovery, latest followers, stale IDs and analysis reuse.')
