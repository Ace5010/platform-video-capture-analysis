from contextlib import closing
"""Explicit, date-scoped local cleanup; resumable, group-bound and fee-preserving."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3

from .archive import ArchiveError, atomic_json, digest


def exclusions(root):
    file=Path(root)/'cleaned-ranges.json'
    return json.loads(file.read_text(encoding='utf-8')).get('ranges',[]) if file.exists() else []


def without_ranges(start,end,ranges):
    parts=[(start,end)]
    for lo,hi in ranges:
        parts=[piece for a,b in parts for piece in ((a,min(b,lo)),(max(a,hi),b)) if piece[0]<piece[1]]
    return parts


def keep_messages(root,messages):
    ranges=exclusions(root)
    return [m for m in messages if not any(a<=m['timestamp']<b for a,b in ranges)]


def owned(root,relative):
    root=Path(root).resolve();file=root/relative
    if file.is_symlink() or not file.resolve().is_relative_to(root) or file.resolve()==root:
        raise ArchiveError('清理路径不属于当前群，已停止')
    return file


def bounds(first,last):
    from .summaries import day_bounds
    start,_=day_bounds(first);_,end=day_bounds(last)
    if start>=end:raise ArchiveError('清理日期范围无效')
    return start,end


def _documents(root):
    # Historical exports are duplicates, not fee receipts. Include them in the
    # same range compaction so old chat contents cannot remain as hidden copies.
    for folder in ('batches','history'):
        for file in sorted((root/folder).glob('*.json')):
            doc=json.loads(file.read_text(encoding='utf-8'))
            if isinstance(doc,dict) and isinstance(doc.get('messages'),list) and '_archive' in doc:
                yield file,doc


def _plan(root,first,last):
    from .summaries import load_archive
    from .resources import load_resources
    root=Path(root).resolve();start,end=bounds(first,last)
    config,messages,_=load_archive(root)
    selected={m['platformMessageId'] for m in messages if start<=m['timestamp']<end}
    inventory=load_resources(root,config)
    kept={key:value for key,value in inventory['messages'].items() if key not in selected}
    def assets(rows):
        return {a['id'] for value in rows.values() for item in value['items'] for a in item.get('assets',[])}
    retained=assets(kept)
    candidates=assets({key:value for key,value in inventory['messages'].items() if key in selected})-retained
    all_referenced=assets(inventory['messages'])
    retained_runs=set()
    files=[];summary_count=0;prepared=[]
    for file,doc in _documents(root):
        if not any(start<=m['timestamp']<end for m in doc['messages']):continue
        original=doc['_archive']
        if original['account_id']!=config['account_id'] or original['chat_id']!=config['group_id']:
            raise ArchiveError('清理副本包含其他账号或群，已停止')
        check=dict(doc,chatlab=dict(doc['chatlab'],exportedAt=0))
        if digest(check)!=file.stem:raise ArchiveError('清理前归档校验失败')
        files.append(file)
        for lo,hi in without_ranges(original['start'],original['end'],[(start,end)]):
            value=dict(doc,messages=[m for m in doc['messages'] if lo<=m['timestamp']<hi],
                       _archive=dict(original,start=lo,end=hi))
            people={m['sender'] for m in value['messages']}
            value['members']=[m for m in doc['members'] if m['platformId'] in people]
            identity=dict(value,chatlab=dict(value['chatlab'],exportedAt=0))
            relative=str(file.parent.relative_to(root)/(digest(identity)+'.json'))
            prepared.append((relative,value))
            if file.parent.name=='batches':
                old_receipt=root/'receipts'/(file.stem+'.json')
                if old_receipt.exists():
                    receipt=json.loads(old_receipt.read_text(encoding='utf-8'))
                    prepared.append((str(Path('receipts')/(digest(identity)+'.json')),
                                     dict(receipt,compacted_from=file.stem,retained_messages=len(value['messages']))))
    for folder in ('summaries','summary-variants'):
        for file in (root/folder).rglob('*.json'):
            day=file.stem if folder=='summaries' else file.parent.name
            if first<=day<=last and re.fullmatch(r'\d{4}-\d{2}-\d{2}',day):
                files.append(file);summary_count+=int(folder=='summaries')
    for receipt in (root/'summary-runs').glob('*/receipt.json'):
        value=json.loads(receipt.read_text(encoding='utf-8'))
        all_referenced.update(a['sha256'] for a in value.get('images',[]))
        if first<=value.get('date','')<=last:
            # Keep the original accounting receipt. Remove only its auxiliary
            # prompts/output, which can contain the cleaned messages.
            files.extend(p for p in receipt.parent.iterdir() if p.is_file() and p.name!='receipt.json')
            candidates.update(a['sha256'] for a in value.get('images',[]) if a.get('source_id') not in retained)
        else:
            retained_runs.update(a['sha256'] for a in value.get('images',[]))
    orphaned={p.name for p in (root/'assets/blobs').glob('*') if p.is_file() and re.fullmatch('[a-f0-9]{64}',p.name)}-all_referenced
    candidates.update(orphaned)
    asset_files=[owned(root,str(Path('assets/blobs')/key)) for key in candidates-retained-retained_runs if re.fullmatch('[a-f0-9]{64}',key)]
    files.extend(p for p in asset_files if p.is_file())
    # ChatLab caches are derived data, isolated under this selected group.
    # Invalidate all cached statistics, but preserve the DB and every message
    # outside the requested time range.
    for folder in ('chatlab/contacts','chatlab/insight'):
        files.extend(p for p in (root/folder).rglob('*.json') if p.is_file())
    files=sorted(set(files))
    files=[owned(root,str(p.relative_to(root))) for p in files]
    databases=[]
    for db in sorted((root/'chatlab/databases').glob('*.db')):
        owned(root,str(db.relative_to(root)))
        with closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)) as conn:
            meta=conn.execute('select group_id from meta').fetchall()
            if meta!=[(config['group_id'],)]:raise ArchiveError('聊天索引与当前群不一致，已停止清理')
            columns={r[1] for r in conn.execute('pragma table_info(message)')}
            if not {'id','ts','platform_message_id'}<=columns:raise ArchiveError('聊天索引结构尚未支持安全清理')
        databases.append(str(db.relative_to(root)))
    watched=[*files,*[p for p,_ in _documents(root)],root/'resources.json',root/'cleaned-ranges.json',root/'assets/blobs',
             *[root/p for p in databases],*[root/(p+'-wal') for p in databases],
             *list((root/'summary-runs').glob('*/receipt.json'))]
    stamp=[]
    for p in sorted(set(watched)):
        if p.exists():
            s=p.stat();stamp.append((str(p.relative_to(root)),s.st_size,s.st_mtime_ns))
    token=digest([config['account_id'],config['group_id'],first,last,stamp])
    public=dict(token=token,from_date=first,to_date=last,messages=len(selected),summaries=summary_count,
                attachments=sum(p.is_file() for p in asset_files),unused_cache_files=len(orphaned),
                reclaim_bytes=max(0,sum(p.stat().st_size for p in files)-sum(len(json.dumps(v,ensure_ascii=False).encode()) for _,v in prepared)))
    return public,dict(files=[str(p.relative_to(root)) for p in files],prepared=prepared,
                       inventory=dict(inventory,messages=kept),databases=databases,start=start,end=end)


def preview(root,first,last):
    pending=Path(root)/'cleanup-pending.json'
    if pending.exists():
        prior=json.loads(pending.read_text(encoding='utf-8'))
        if (prior['preview']['from_date'],prior['preview']['to_date'])!=(first,last):
            raise ArchiveError('有未完成的清理，请先继续原时间段')
        return dict(prior['preview'],resuming=True)
    return _plan(root,first,last)[0]


def execute(root,first,last,token):
    root=Path(root).resolve();pending=root/'cleanup-pending.json'
    if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{64}',token):
        raise ArchiveError('请先预览清理范围')
    completed=root/'cleanup-receipts'/(token+'.json')
    if completed.is_file():
        result=json.loads(completed.read_text(encoding='utf-8'))
        if (result['from_date'],result['to_date'])!=(first,last):raise ArchiveError('清理范围与回执不一致')
        return result
    if pending.exists():
        transaction=json.loads(pending.read_text(encoding='utf-8'))
        if (transaction['preview']['from_date'],transaction['preview']['to_date'],transaction['preview']['token'])!=(first,last,token):
            raise ArchiveError('请继续原时间段的清理')
    else:
        public,plan=_plan(root,first,last)
        if token!=public['token']:raise ArchiveError('记录已变化，请重新预览后清理')
        if public['messages']==0:raise ArchiveError('该时间段没有可清理的聊天记录')
        transaction=dict(preview=public,plan=plan,started_at=datetime.now(timezone.utc).isoformat())
        atomic_json(root/'cleanup-pending-info.json',public)
        atomic_json(pending,transaction)
    public,plan=transaction['preview'],transaction['plan'];start,end=plan['start'],plan['end']
    try:
        ranges=exclusions(root)
        if [start,end] not in ranges:ranges.append([start,end])
        atomic_json(root/'cleaned-ranges.json',{'ranges':sorted(ranges)})
        for relative,value in plan['prepared']:
            file=owned(root,relative);file.parent.mkdir(parents=True,exist_ok=True);atomic_json(file,value)
        atomic_json(root/'resources.json',plan['inventory'])
        for relative in plan['databases']:
            db=owned(root,relative)
            with closing(sqlite3.connect(db,timeout=15)) as conn, conn:
                conn.execute('pragma secure_delete=ON')
                conn.execute('delete from message_context where message_id in (select id from message where ts>=? and ts<?)',(start,end))
                conn.execute('delete from message where ts>=? and ts<?',(start,end))
                conn.execute('delete from message_context where segment_id in (select id from segment where start_ts<? and end_ts>=?)',(end,start))
                conn.execute('delete from segment where start_ts<? and end_ts>=?',(end,start))
                conn.commit()
                conn.execute('vacuum')
        for relative in plan['files']:
            owned(root,relative).unlink(missing_ok=True)
        result=dict(public,status='complete',finished_at=datetime.now(timezone.utc).isoformat())
        folder=root/'cleanup-receipts';folder.mkdir(exist_ok=True)
        atomic_json(folder/(token+'.json'),result)
        pending.unlink()
        (root/'cleanup-pending-info.json').unlink(missing_ok=True)
        return result
    except Exception as error:
        if isinstance(error,ArchiveError):raise
        raise ArchiveError('清理尚未完成，已保存进度；请按原时间段继续清理') from None
