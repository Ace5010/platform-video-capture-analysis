"""Back up and verify an explicitly requested merge of identical profiles.

Usage: python scripts/merge-duplicate-accounts.py KEEP_ID DUPLICATE_ID --apply
Without --apply, only inspect. Stop the host with its normal lifecycle first.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import socket
import sqlite3
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.account_identity import canonical_douyin_account_url
from host_service.config import HostConfig
from host_service.database import Database

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('keep_id')
parser.add_argument('duplicate_ids', nargs='+')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
cfg = HostConfig.from_env()
duplicate_ids = list(dict.fromkeys(value for value in args.duplicate_ids if value != args.keep_id))


def snapshot():
    with closing(sqlite3.connect(cfg.db_path.resolve().as_uri() + '?mode=ro', uri=True)) as c:
        c.row_factory = sqlite3.Row
        tables = [r['name'] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {table: [dict(row) for row in c.execute(f'SELECT * FROM "{table}" ORDER BY rowid')] for table in tables}


before = snapshot()
by_id = {row['id']: row for row in before['accounts']}
selected = [by_id[value] for value in [args.keep_id, *duplicate_ids]]
identity = canonical_douyin_account_url(selected[0]['url'])
if not identity or any(row['platform'] != 'douyin' or canonical_douyin_account_url(row['url']) != identity for row in selected):
    raise ValueError('主页账号 ID 不同，不能合并')
if any(row['status'] in ('queued', 'claimed', 'running') for row in before['jobs']):
    raise ValueError('仍有活动任务，不能合并')
if not args.apply:
    print(json.dumps({'keepId': args.keep_id, 'duplicateIds': duplicate_ids, 'identity': identity,
                      'workCount': sum(row['account_id'] in [args.keep_id, *duplicate_ids] for row in before['videos'])}, ensure_ascii=True))
    sys.exit(0)
with socket.socket() as probe:
    probe.settimeout(1)
    if probe.connect_ex(('127.0.0.1', cfg.listen_port)) == 0:
        raise ValueError('请先用项目启动脚本停止后台服务，再执行合并')

cfg.backup_dir.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = cfg.backup_dir / f'account-merge-{stamp}-{uuid.uuid4().hex[:8]}.sqlite3'
with closing(sqlite3.connect(cfg.db_path.resolve().as_uri() + '?mode=ro', uri=True)) as source:
    with closing(sqlite3.connect(backup)) as target:
        source.backup(target)
Database(cfg).merge_accounts(args.keep_id, duplicate_ids)
after = snapshot()
assert set(before) == set(after), 'schema changed'
assert len(after['accounts']) == len(before['accounts']) - len(duplicate_ids)
unrelated_before = {row['id']: row for row in before['accounts'] if row['id'] not in [args.keep_id, *duplicate_ids]}
unrelated_after = {row['id']: row for row in after['accounts'] if row['id'] != args.keep_id}
assert unrelated_after == unrelated_before, 'unrelated accounts changed'
for table in ('videos', 'snapshots'):
    expected = []
    for row in before[table]:
        row = dict(row)
        if row['account_id'] in duplicate_ids:
            row['account_id'] = args.keep_id
            value = json.loads(row['data_json']); value['accountId'] = args.keep_id
            row['data_json'] = json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        expected.append(row)
    assert after[table] == expected, f'{table} changed beyond account ownership'
expected_discoveries = {}
for row in before['collection_discoveries']:
    row = dict(row)
    if row['account_id'] in duplicate_ids:
        row['account_id'] = args.keep_id
    key = (row['account_id'], row['video_id'])
    if key not in expected_discoveries or row['discovered_at'] < expected_discoveries[key]['discovered_at']:
        expected_discoveries[key] = row
assert {(row['account_id'], row['video_id']): row for row in after['collection_discoveries']} == expected_discoveries
for table in set(before) - {'accounts', 'videos', 'snapshots', 'collection_discoveries'}:
    assert before[table] == after[table], f'{table} history changed'
with closing(sqlite3.connect(cfg.db_path)) as c:
    assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not c.execute('PRAGMA foreign_key_check').fetchall()
report = {'backup': str(backup.resolve()), 'keepId': args.keep_id, 'mergedIds': duplicate_ids,
          'beforeCounts': {table: len(before[table]) for table in ('accounts', 'videos', 'snapshots', 'analysis_runs', 'jobs', 'processed_events', 'collection_discoveries')},
          'afterCounts': {table: len(after[table]) for table in ('accounts', 'videos', 'snapshots', 'analysis_runs', 'jobs', 'processed_events', 'collection_discoveries')},
          'keptAccountWorks': sum(row['account_id'] == args.keep_id for row in after['videos']),
          'verified': True}
audit = {**report, 'unchangedTableHashes': {table: hashlib.sha256(repr(before[table]).encode()).hexdigest()
         for table in set(before) - {'accounts', 'videos', 'snapshots', 'collection_discoveries'}}}
backup.with_suffix('.verification.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
