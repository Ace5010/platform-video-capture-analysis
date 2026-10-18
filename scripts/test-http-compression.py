"""Isolated real HTTP checks for full, compressed, authenticated snapshots."""
import gzip
import hashlib
import http.client
import json
import sys
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.config import HostConfig
from host_service.server import create_server

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    config = replace(HostConfig.from_env(), testing=True, listen_host='127.0.0.1', listen_port=0,
                     data_dir=root, db_path=root/'monitor.sqlite3', secret_path=root/'secret.dpapi',
                     temp_dir=root/'tmp', backup_dir=root/'backups')
    server = create_server(config)
    token = 's' * 43
    server.database.create_session(hashlib.sha256(token.encode()).hexdigest(), 'c'*64, '127.0.0.1', 60)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    data = {'accounts': [], 'videos': [{'id': str(i), 'transcript': '完整口播内容，保持原样。'*100} for i in range(893)], 'snapshots': []}
    def get(path, encoding=None, authenticated=True):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        headers = {'Origin': 'http://localhost:3000'}
        if authenticated: headers['Cookie'] = 'douyin_monitor_session=' + token
        if encoding is not None: headers['Accept-Encoding'] = encoding
        connection.request('GET', path, headers=headers)
        response = connection.getresponse(); body = response.read(); result = response.status, dict(response.getheaders()), body
        connection.close(); return result
    try:
        with patch.object(server.database, 'state', return_value=data):
            status, plain_headers, plain = get('/api/state', 'identity')
            assert status == 200
            status, headers, compressed = get('/api/state', 'gzip')
            assert status == 200 and headers['Content-Encoding'] == 'gzip'
            assert len(compressed) < len(plain) / 4
            assert gzip.decompress(compressed) == plain
            assert int(headers['Content-Length']) == len(compressed)
            assert set(headers['Vary'].split(', ')) == {'Origin', 'Accept-Encoding'}
            assert headers['Cache-Control'] == 'no-store'
            for encoding in (None, 'identity', 'gzip;q=0', 'gzip;q=invalid', 'br'):
                _, headers, body = get('/api/state', encoding)
                assert 'Content-Encoding' not in headers and body == plain
            for encoding in ('gzip;q=0.5', 'br, gzip'):
                _, headers, body = get('/api/state', encoding)
                assert headers['Content-Encoding'] == 'gzip' and gzip.decompress(body) == plain
            status, headers, _ = get('/api/state', 'gzip', False)
            assert status == 401 and 'Content-Encoding' not in headers
        _, headers, _ = get('/api/auth/status', 'gzip')
        assert 'Content-Encoding' not in headers
        with patch.object(server.database, 'list_jobs', return_value=[{'id': 'x', 'result': '完整结果'*3000}]):
            _, headers, body = get('/api/jobs?limit=100', 'gzip')
            assert headers['Content-Encoding'] == 'gzip'
            assert json.loads(gzip.decompress(body))['jobs'][0]['result'] == '完整结果'*3000
        print('HTTP compression passed: complete 893-record snapshot, negotiation, lengths, CORS, no-store, sessions and full job results.')
    finally:
        server.shutdown(); server.server_close(); server.analysis.shutdown(); thread.join(timeout=5)
