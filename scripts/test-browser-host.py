"""Isolated LAN-to-browser queue checks. No production database or paid API."""
import sys
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.browser import BrowserManager, CAPABILITIES
from host_service.config import HostConfig
from host_service.server import create_server

# Reuse the existing authenticated HTTP client, including CSRF and cookies.
import importlib.util
spec = importlib.util.spec_from_file_location('host_tests', Path(__file__).with_name('test-host-service.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

with tempfile.TemporaryDirectory(prefix='douyin-browser-host-') as directory:
    root = Path(directory)
    config = replace(HostConfig.from_env(), listen_host='127.0.0.1', listen_port=0, testing=True,
        data_dir=root, db_path=root/'test.sqlite3', secret_path=root/'secret', temp_dir=root/'temp', backup_dir=root/'backups')
    server = create_server(config)
    manager = BrowserManager(config, server.database, Mock())
    server.browser = manager
    manager.ready = True
    server.database.pair_connector(manager.connector_id, 'test', manager.connector_id, 'internal-test', '0.9.7', CAPABILITIES)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = helpers.ApiClient('127.0.0.1', server.server_port)
    try:
        assert client.request('POST', '/api/auth/setup', {'password': helpers.ACCESS_PASSWORD})[0] == 201
        # Treat a LAN origin as a different browser. It cannot use host-only login controls.
        status, _, _ = client.request('POST', '/api/browser/open', {}, origin=helpers.REMOTE_ORIGIN)
        assert status == 403
        assert client.request('POST', '/api/browser/open', {})[0] == 202
        assert manager.open_event.is_set()
        assert client.request('POST', '/connector/jobs/claim', {})[0] == 409
        state = client.request('GET', '/api/state', origin=helpers.REMOTE_ORIGIN)[1]
        assert state['connector']['mode'] == 'dedicated_browser'
        account = {'id': 'account-browser-test', 'platform': 'douyin', 'name': '测试账号',
            'url': 'https://www.douyin.com/user/test', 'initialSyncStatus': 'complete'}
        assert client.request('POST', '/api/accounts/upsert', {'account': account}, origin=helpers.REMOTE_ORIGIN)[0] == 200
        videos = [{'id': str(7000000000000000000 + index), 'url': f'https://www.douyin.com/video/{7000000000000000000 + index}',
                   'title': '测试视频', 'description': '文案', 'coverUrl': 'https://example.com/cover', 'publishedAt': '2026-09-01', 'durationSeconds': 10, 'likeCount': 1, 'commentCount': 0, 'favoriteCount': 0, 'shareCount': 0} for index in range(5)]
        def capture(_command, **_kwargs):
            assert server.database.state()['accounts'][0]['status'] == 'checking'
            return {'videos': videos + [videos[0]], 'accountName': '测试账号'}
        manager._rpc = Mock(side_effect=capture)
        for run in range(2):
            import time
            with patch('host_service.database.time.time', return_value=time.time() + run * 61):
                status, response, _ = client.request('POST', '/api/jobs',
                    {'type': 'collect_latest', 'payload': {'accountIds': [account['id']]}}, origin=helpers.REMOTE_ORIGIN)
            assert status in (200, 201), response
            job = server.database.claim_job(manager.connector_id, CAPABILITIES)
            assert job is not None
            manager.execute(job)
            assert server.database.get_job(job['id'])['status'] == 'succeeded'
            summary = server.database.get_job(job['id'])['result']
            assert summary['newVideoCount'] == (5 if run == 0 else 0)
            assert summary['accountUpdates'][0]['newVideoCount'] == summary['newVideoCount']
            state = server.database.state()
            assert len(state['videos']) == 5
            assert len(state['accounts'][0]['latestVideoIds']) == 5
            assert state['accounts'][0]['latestCheckNewVideoCount'] == (5 if run == 0 else 0)
            assert state['accounts'][0]['status'] == 'ready'
            assert state['accounts'][0]['currentSyncMode'] is None
        # Refreshing engagement must not move a video's first discovery date.
        original_seen = server.database.state()['videos'][0]['firstSeenAt']
        original_video = server.database.state()['videos'][0]
        with server.database.transaction() as connection:
            server.database._upsert_video(connection, {**original_video, 'firstSeenAt': '2099-01-01T00:00:00Z'})
        assert server.database.state()['videos'][0]['firstSeenAt'] == original_seen
        # Old records without the field use their immutable database creation time.
        import json
        legacy = {**original_video}
        legacy.pop('firstSeenAt')
        with server.database.transaction() as connection:
            connection.execute('UPDATE videos SET data_json=?,created_at=? WHERE id=?',
                (json.dumps(legacy), '2026-08-01T00:00:00Z', legacy['id']))
        assert next(v for v in server.database.state()['videos'] if v['id'] == legacy['id'])['firstSeenAt'] == '2026-08-01T00:00:00Z'
        with patch('host_service.database.time.time', return_value=time.time() + 122):
            server.database.create_job('collect_latest', {'accountIds': [account['id']]})
        manager._rpc = Mock(side_effect=RuntimeError('test capture failure'))
        failed_job = server.database.claim_job(manager.connector_id, CAPABILITIES)
        manager.execute(failed_job)
        assert server.database.state()['accounts'][0]['status'] == 'error'
        assert server.database.get_job(failed_job['id'])['status'] == 'failed'
        server.database.upsert_account({'id': account['id'], 'status': 'checking', 'currentSyncMode': 'latest'})
        repaired = server.database.state()['accounts'][0]
        assert repaired['status'] == 'error' and repaired['currentSyncMode'] is None
        assert 'test capture failure' in repaired['collectionError']
        extra = {**videos[0], 'id': '7000000000000000006', 'url': 'https://www.douyin.com/video/7000000000000000006', 'title': 'new complete'}
        pending = {'id': '7000000000000000007', 'url': 'https://www.douyin.com/video/7000000000000000007', 'missingFields': ['分享数']}
        with patch('host_service.database.time.time', return_value=time.time() + 183):
            server.database.create_job('collect_latest', {'accountIds': [account['id']]})
        manager._rpc = Mock(return_value={'videos': [videos[0], extra], 'pendingVideos': [pending]})
        incomplete_job = server.database.claim_job(manager.connector_id, CAPABILITIES)
        manager.execute(incomplete_job)
        incomplete_state = server.database.state()
        assert incomplete_state['accounts'][0]['status'] == 'error'
        assert incomplete_state['accounts'][0]['latestCheckNewVideoCount'] == 0
        assert len(incomplete_state['videos']) == 5  # no half batch is committed
        assert server.database.get_job(incomplete_job['id'])['status'] == 'failed'
        with patch('host_service.database.time.time', return_value=time.time() + 244):
            server.database.create_job('collect_latest', {'accountIds': [account['id']]})
        # Legacy pending entries survive until a fully successful capture.
        server.database.upsert_account({'id': account['id'], 'pendingVideos': [pending]})
        def finish_pending(command, **_kwargs):
            assert command['account']['pendingVideos'] == [pending]
            return {'videos': [extra, {**videos[0], **pending, 'title': 'now complete'}]}
        manager._rpc = Mock(side_effect=finish_pending)
        manager.execute(server.database.claim_job(manager.connector_id, CAPABILITIES))
        completed_state = server.database.state()
        assert completed_state['accounts'][0]['status'] == 'ready'
        assert completed_state['accounts'][0]['pendingVideos'] == []
        assert completed_state['accounts'][0]['latestCheckNewVideoCount'] == 2
        assert len(completed_state['videos']) == 7
        with patch('host_service.database.time.time', return_value=time.time() + 305):
            server.database.create_job('collect_latest', {'accountIds': [account['id']]})
        manager._rpc = Mock(return_value={'videos': [{**extra, 'durationSeconds': None}]})
        manager.execute(server.database.claim_job(manager.connector_id, CAPABILITIES))
        assert server.database.state()['accounts'][0]['status'] == 'error'
        assert len(server.database.state()['videos']) == 7
        # The browser only delegates capture; the host pipeline owns the full
        # capture/download retry budget. Cancelling via HTTP is CSRF protected.
        analysis_job, _ = server.database.create_job('analyze_video', {'accountId': account['id'], 'videoId': videos[0]['id']})
        claimed = server.database.claim_job(manager.connector_id, CAPABILITIES)
        assert claimed['id'] == analysis_job['id']
        manager.execute(claimed)
        manager.analysis.submit.assert_called_once()
        assert manager.analysis.submit.call_args.kwargs['capture_media'] == manager.capture_analysis_media
        assert server.database.get_job(analysis_job['id'])['claimedBy'] is None
        assert client.request('GET', f"/api/jobs/{analysis_job['id']}/cancel")[0] == 404
        assert server.database.get_job(analysis_job['id'])['status'] == 'running'
        assert client.request('POST', f"/api/jobs/{analysis_job['id']}/cancel", {}, csrf='invalid')[0] == 403
        status, cancelled, _ = client.request('POST', f"/api/jobs/{analysis_job['id']}/cancel", {}, origin=helpers.REMOTE_ORIGIN)
        assert status == 200 and cancelled['job']['status'] == 'cancelled'
        server.database.update_job_progress(analysis_job['id'], 'downloading_original_video')
        assert server.database.get_job(analysis_job['id'])['status'] == 'cancelled'

        # A running batch holds an old account list. Removing a pending/current
        # account must survive both successful and failed late browser replies.
        for removal_stage in ('before_turn', 'during_success', 'during_error'):
            subjects = [{**account, 'id': f'{removal_stage}-{name}',
                         'url': f'https://www.douyin.com/user/{removal_stage}-{name}',
                         'name': name} for name in ('first', 'removed', 'last')]
            for subject in subjects:
                server.database.upsert_account(subject)
            removal_job, _ = server.database.create_job('collect_latest',
                {'accountIds': [subject['id'] for subject in subjects]})
            removal_claim = server.database.claim_job(manager.connector_id, CAPABILITIES)
            assert removal_claim['id'] == removal_job['id']
            visited = []
            def capture_after_removal(command, **_kwargs):
                current = command['account']
                visited.append(current['id'])
                if removal_stage == 'before_turn' and current['id'] == subjects[0]['id']:
                    assert server.database.remove_account(subjects[1]['id'])
                if removal_stage != 'before_turn' and current['id'] == subjects[1]['id']:
                    assert server.database.remove_account(current['id'])
                    if removal_stage == 'during_error':
                        raise RuntimeError('late capture failure after removal')
                return {'videos': [{**videos[0], 'id': f'{current["id"]}-video'}],
                        'accountName': current['name']}
            manager._rpc = Mock(side_effect=capture_after_removal)
            manager.execute(removal_claim)
            after_removal = server.database.state()
            assert not any(item['id'] == subjects[1]['id'] for item in after_removal['accounts']), \
                f'{removal_stage}: background capture resurrected the removed account'
            assert not any(item['accountId'] == subjects[1]['id'] for item in after_removal['videos'])
            assert not any(item['accountId'] == subjects[1]['id'] for item in after_removal['discoveries'])
            assert any(item['accountId'] == subjects[2]['id'] for item in after_removal['videos']), \
                'removal must not interrupt the remaining batch'
            summary = server.database.get_job(removal_claim['id'])
            assert summary['status'] == 'succeeded' and summary['result']['succeeded'] == 2
            assert summary['result']['skipped'] == 1 and summary['result']['failed'] == 0
            if removal_stage == 'before_turn':
                assert subjects[1]['id'] not in visited, 'do not open a removed pending account'

        # The persistence boundary also discards delayed results, including a
        # mixed event whose other account is still monitored. Receipts dedupe.
        removed, retained = [{**account, 'id': f'late-{name}',
            'url': f'https://www.douyin.com/user/late-{name}', 'name': name}
            for name in ('removed', 'retained')]
        for subject in (removed, retained):
            server.database.upsert_account(subject)
        late_job, _ = server.database.create_job('collect_latest',
            {'accountIds': [removed['id'], retained['id']]})
        late_claim = server.database.claim_job(manager.connector_id, CAPABILITIES)
        assert late_claim['id'] == late_job['id']
        manager._event(late_claim, 'started', {})
        assert server.database.remove_account(removed['id'])
        late_videos = [{**videos[0], 'id': f'{subject["id"]}-video', 'accountId': subject['id']}
                       for subject in (removed, retained)]
        late_result = {'mode': 'latest', 'accounts': [removed, retained], 'videos': late_videos,
            'snapshots': [{'videoId': item['id'], 'accountId': item['accountId'],
                           'capturedAt': '2026-10-07T00:00:00Z'} for item in late_videos]}
        manager._event(late_claim, 'collection_result', late_result)
        duplicate, _ = manager._event(late_claim, 'collection_result', late_result)
        assert duplicate is True
        late_state = server.database.state()
        assert not any(item['id'] == removed['id'] for item in late_state['accounts'])
        assert not any(item['accountId'] == removed['id'] for item in late_state['videos'])
        assert not any(item['accountId'] == removed['id'] for item in late_state['snapshots'])
        assert not any(item['accountId'] == removed['id'] for item in late_state['discoveries'])
        assert any(item['id'] == late_videos[1]['id'] for item in late_state['videos'])
        manager._event(late_claim, 'job_completed', {})
        print('LAN browser host passed: mobile-origin queue, host-only login controls, legacy extension blocked, five-video deduplication and repeat idempotency.')
        print('Account removal passed: pending/current removal, late success/failure, mixed events, receipts and remaining batch.')
    finally:
        server.shutdown()
        server.server_close()
        server.analysis.shutdown()
