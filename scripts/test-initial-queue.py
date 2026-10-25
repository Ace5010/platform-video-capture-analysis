"""Isolated initial-account queue regressions; no production data or paid calls."""
import importlib.util
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.browser import BrowserManager, CAPABILITIES
from host_service.config import HostConfig
from host_service.database import Database
from host_service.server import create_server

spec = importlib.util.spec_from_file_location('initial_queue_helpers', Path(__file__).with_name('test-host-service.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def config_at(root):
    return replace(HostConfig.from_env(), data_dir=root, db_path=root / 'monitor.sqlite3',
        temp_dir=root / 'tmp', backup_dir=root / 'backups', secret_path=root / 'secret.dpapi',
        testing=True, mock_qwen=True, listen_host='127.0.0.1', listen_port=0)


def account(identifier, profile=None):
    return {'id': identifier, 'platform': 'douyin', 'name': identifier,
        'url': f'https://www.douyin.com/user/{profile or identifier}', 'status': 'waiting', 'initialSyncStatus': 'pending'}


def wait_for(predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError('isolated queue did not reach its expected state')


def complete_result(identifier):
    return {'accountName': identifier + '-read', 'videos': [{'id': f'video-{identifier}',
        'title': identifier, 'description': identifier, 'coverUrl': 'https://example.test/cover.jpg',
        'publishedAt': '2026-10-09T00:00:00Z', 'durationSeconds': 10,
        'likeCount': 0, 'commentCount': 0, 'favoriteCount': 0, 'shareCount': 0}]}


with tempfile.TemporaryDirectory(prefix='douyin-initial-queue-') as temporary:
    root = Path(temporary)
    database = Database(config_at(root / 'atomic'))
    database.initialize()
    with patch.object(database, '_idempotency_key', side_effect=RuntimeError('isolated insertion failure')):
        try:
            database.add_account_with_initial_job(account('rollback'))
            raise AssertionError('injected queue failure must escape')
        except RuntimeError:
            pass
    assert not database.state()['accounts'], 'failed queue insertion must roll back the account add'
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(lambda n: database.add_account_with_initial_job(account(f'creator-{n}')), range(4)))
    assert len(database.state()['accounts']) == len(database.list_jobs()) == 4
    with ThreadPoolExecutor(max_workers=4) as workers:
        duplicates = list(workers.map(lambda n: database.add_account_with_initial_job(account(f'duplicate-{n}', 'creator-0')), range(8)))
    assert {saved['id'] for saved, _, _ in duplicates} == {'creator-0'}
    assert len(database.list_jobs()) == 4, 'concurrent duplicate adds must reuse one active job'
    database.update_account_if_present({'id': 'creator-0', 'name': 'saved-name', 'status': 'ready', 'initialSyncStatus': 'complete'})
    saved, job, created = database.add_account_with_initial_job(account('creator-0'))
    assert saved['name'] == 'saved-name' and saved['initialSyncStatus'] == 'complete' and job is None and not created

    with database.transaction() as connection:
        expected_order = [row['id'] for row in connection.execute('SELECT id FROM jobs ORDER BY rowid')]
        connection.execute('UPDATE jobs SET created_epoch=1,expires_at=0')
    assert all(job['status'] == 'queued' for job in database.list_jobs()), 'waiting collection must survive its former 30-minute expiry'
    database.pair_connector('fixture', 'fixture', 'fixture', 'fixture', '0.9.7', CAPABILITIES, 'fixture')
    for expected in expected_order:
        claimed = database.claim_job('fixture', CAPABILITIES)
        assert claimed['id'] == expected, 'same-second enqueue order must follow SQLite insertion order'
        database.process_connector_event('fixture', claimed['id'], claimed['claimToken'], expected + '-done', 'job_completed', {})
    retried, created = database.create_job('archive_account', {'accountId': 'creator-2', 'retry': True})
    assert not created and retried['status'] == 'succeeded', 'successful initial jobs must not be repeated'

    # Retry an expired legacy initial job, and isolate an old lease on recovery.
    _, legacy, _ = database.add_account_with_initial_job(account('legacy'))
    with database.transaction() as connection:
        connection.execute("UPDATE jobs SET status='expired' WHERE id=?", (legacy['id'],))
    _, recovered, created = database.add_account_with_initial_job(account('legacy'))
    assert created and recovered['id'] != legacy['id']
    claimed = database.claim_job('fixture', CAPABILITIES)
    with database.transaction() as connection:
        connection.execute('UPDATE jobs SET claim_until=0 WHERE id=?', (claimed['id'],))
    reclaimed = database.claim_job('fixture', CAPABILITIES)
    assert reclaimed['id'] == claimed['id'] and reclaimed['claimToken'] != claimed['claimToken']
    try:
        database.process_connector_event('fixture', claimed['id'], claimed['claimToken'], 'stale', 'job_completed', {})
        raise AssertionError('stale lease must not complete a recovered job')
    except ValueError:
        pass

    assert database.list_jobs(1)[-1]['id'] == reclaimed['id'], 'older running jobs must survive a bounded history window'
    _, newest, _ = database.add_account_with_initial_job(account('newest'))
    limited = database.list_jobs(1)
    assert {job['id'] for job in limited} == {reclaimed['id'], newest['id']}, 'all waiting/running jobs must remain visible'

    for scenario in ['ordinary-failure', 'login-block']:
        config = config_at(root / scenario)
        server = create_server(config)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = helpers.ApiClient('127.0.0.1', server.server_address[1])
        assert client.request('POST', '/api/auth/setup', {'password': helpers.ACCESS_PASSWORD})[0] == 201
        ids = ['first', 'second', 'third'] if scenario == 'ordinary-failure' else ['first', 'second']
        jobs = []
        for identifier in ids:
            status, added, _ = client.request('POST', '/api/accounts/upsert', {'account': account(identifier), 'enqueueInitial': True}, origin=helpers.REMOTE_ORIGIN)
            assert status == 200 and added['created'] and added['job']['payload']['accountId'] == identifier
            jobs.append(added['job']['id'])
        manager = BrowserManager(config, server.database, Mock())
        server.browser = manager
        calls = []
        old_claims = []
        blocked = [scenario == 'login-block']

        def rpc(command, **_kwargs):
            if command['action'] != 'collect':
                return {'running': True}
            identifier = command['account']['id']
            calls.append(identifier)
            if blocked[0]:
                old_claims.append(dict(manager.active_job))
                raise RuntimeError('必须重新登录，请在电脑抖音登录窗口完成登录')
            if scenario == 'ordinary-failure' and identifier == 'second':
                raise RuntimeError('该账号已不存在')
            return complete_result(identifier)

        try:
            with patch.object(manager, '_rpc', side_effect=rpc), patch.object(manager, '_stop_process'):
                manager.start()
                if scenario == 'login-block':
                    wait_for(lambda: manager.status()['collectionPaused'])
                    assert calls == ['first'], 'shared login block must leave later accounts untouched'
                    assert all(server.database.get_job(job_id)['status'] == 'queued' for job_id in jobs)
                    assert BrowserManager(config, server.database, Mock()).status()['collectionPaused'], 'pause must survive a host restart'
                    assert client.request('POST', '/api/browser/resume-collection', {}, csrf='wrong')[0] == 403
                    blocked[0] = False
                    assert client.request('POST', '/api/browser/resume-collection', {}, origin=helpers.REMOTE_ORIGIN)[0] == 200
                wait_for(lambda: all(server.database.get_job(job_id)['status'] in ('succeeded', 'failed') for job_id in jobs))
                state = server.database.state()
                assert state['accounts'][0]['initialSyncStatus'] == 'complete'
                assert len(state['videos']) == 2
                assert not state.get('discoveries'), 'initial archives must not enter latest discoveries'
                if scenario == 'ordinary-failure':
                    assert calls == ids
                    assert server.database.get_job(jobs[1])['status'] == 'failed'
                    assert server.database.get_job(jobs[2])['status'] == 'succeeded', 'failed account must not stop the next job'
                else:
                    assert calls == ['first', 'first', 'second']
                    assert all(server.database.get_job(job_id)['status'] == 'succeeded' for job_id in jobs)
                    assert server.database.get_job(jobs[0])['attemptCount'] == 2
                manager.shutdown()
        finally:
            manager.stop_event.set()
            server.browser = None
            server.shutdown()
            server.server_close()
            server.analysis.shutdown()

print('Initial queue host passed: atomic rollback, concurrent add/dedup, FIFO, long wait, legacy retry, stale lease, failure isolation and persisted login pause/resume.')
