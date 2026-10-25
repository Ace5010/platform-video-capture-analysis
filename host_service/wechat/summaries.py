"""按自然日准备最小输入、校验总结及原文引用。真实正文只留在本机或交给已授权的 Buddy 调用。"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import unicodedata
import xml.etree.ElementTree as ET

from .archive import ArchiveError, digest

TZ = timezone(timedelta(hours=8))


def day_bounds(day):
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ArchiveError("日期格式应为 YYYY-MM-DD")
    try:
        start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ)
    except ValueError:
        raise ArchiveError("日期无效") from None
    return int(start.timestamp()), int((start + timedelta(days=1)).timestamp())


def load_archive(data_dir):
    root = Path(data_dir)
    config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    messages, ranges = {}, []
    for file in sorted((root / "batches").glob("*.json")):
        doc = json.loads(file.read_text(encoding="utf-8"))
        check = dict(doc, chatlab=dict(doc["chatlab"], exportedAt=0))
        if digest(check) != file.stem:
            raise ArchiveError("归档校验失败，已停止加载")
        scope = doc["_archive"]
        if scope["account_id"] != config["account_id"] or scope["chat_id"] != config["group_id"]:
            raise ArchiveError("归档包含未选择的账号或群")
        ranges.append((scope["start"], scope["end"]))
        for message in doc["messages"]:
            mid = message["platformMessageId"]
            if mid in messages:
                # 不同批次成员显示名可能变化；来源正文和身份必须一致。
                fields = ("sender", "timestamp", "type", "content", "replyToMessageId")
                if any(messages[mid].get(k) != message.get(k) for k in fields):
                    raise ArchiveError("重复来源消息存在内容冲突")
            messages[mid] = message
    return config, sorted(messages.values(), key=lambda m: (m["timestamp"], m["_source"].get("sort_seq") or 0, m["platformMessageId"])), ranges


def covers_day(ranges, start, end):
    cursor = start
    for lo, hi in sorted(ranges):
        if hi <= cursor:
            continue
        if lo > cursor:
            return False
        cursor = max(cursor, hi)
        if cursor >= end:
            return True
    return False


def summary_scope(ranges, day, now=None):
    start, end = day_bounds(day)
    current = now or datetime.now(TZ)
    complete = covers_day(ranges, start, end)
    cutoff = max((min(hi, end, int(current.timestamp())) for lo, hi in ranges
                  if lo < end and hi > start), default=start)
    partial = (not complete and day == current.astimezone(TZ).strftime('%Y-%m-%d')
               and cutoff > start and covers_day(ranges, start, cutoff))
    return {'complete': complete, 'summarizable': complete or partial,
            'partial': partial, 'coverage_end': end if complete else cutoff}


def prepare_day(data_dir, day):
    start, end = day_bounds(day)
    config, all_messages, ranges = load_archive(data_dir)
    selected = [m for m in all_messages if start <= m["timestamp"] < end]
    people = {}
    sources, minimal = {}, []
    for message in selected:
        sender = message["sender"]
        if sender not in people:
            people[sender] = {"id": f"p{len(people) + 1:03}", "name": message["accountName"]}
        source_id = "m_" + digest(message["platformMessageId"])[:16]
        display = {"id": source_id, "sender": people[sender]["name"], "speaker": people[sender]["id"],
                   "time": datetime.fromtimestamp(message["timestamp"], TZ).strftime("%H:%M:%S"),
                   "timestamp": message["timestamp"], "type": message["type"], "content": message["content"]}
        sources[source_id] = display
        minimal.append({k: display[k] for k in ("id", "speaker", "time", "type", "content")})
    payload = {"date": day, "timezone": "Asia/Shanghai", "messages": minimal}
    # Keep the existing source fingerprint stable; reply metadata is derived separately.
    replies = {}
    for message in selected:
        target = message.get('replyToMessageId')
        if target:
            replies['m_' + digest(message['platformMessageId'])[:16]] = 'm_' + digest(target)[:16]
    return {"date": day, "group_name": config["group_name"], **summary_scope(ranges, day),
            "messages": minimal, "sources": sources, "people": {p["id"]: p["name"] for p in people.values()},
            "source_hash": digest(payload), "message_count": len(selected), "replies": replies}


def readable_content(content):
    """Preserve user text and quoted text, excluding transport XML and media keys."""
    content = str(content or '')
    declaration = re.search(r'<!DOCTYPE\b|<!ENTITY\b', content, re.IGNORECASE)
    if declaration:
        return content[:declaration.start()] + '[引用内容不可解析]'
    match = re.search(r'<\?xml\b|<msg\b|<appmsg\b', content)
    if not match:
        return content
    prefix, xml = content[:match.start()], content[match.start():]
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return prefix + '[引用内容不可解析]'
    if root.find('.//img') is not None or root.tag == 'img':
        return prefix + '[图片：未获取原件]'
    if root.find('.//videomsg') is not None:
        return prefix + '[视频：未获取原件]'
    if root.find('.//voicemsg') is not None:
        return prefix + '[语音：未获取原件]'
    app = root if root.tag == 'appmsg' else root.find('.//appmsg')
    if app is not None:
        title = app.findtext('title', '')
        quoted = app.find('refermsg')
        if quoted is not None:
            name = quoted.findtext('displayname', '')
            body = readable_content(quoted.findtext('content', ''))
            return prefix + title + (f'\n引用 {name}：{body}' if body else '')
        description = app.findtext('des', '')
        return prefix + '\n'.join(x for x in (title, description if description != title else '') if x) or '[分享内容不可读取]'
    return prefix + '[媒体内容：未获取原件]'


def model_messages(prepared):
    return [dict(m, content=readable_content(m['content']),
                 reply_to=prepared.get('replies', {}).get(m['id'], '')) for m in prepared['messages']]


def discussion_messages(prepared, topic=None):
    """Membership is separate from evidence refs; never truncate or use a time window."""
    ids = None if topic is None else set(topic.get('discussion_refs', topic['refs']))
    if topic is not None and 'discussion_refs' not in topic:
        ids.update(r for v in topic.get('views', []) for r in v.get('refs', []))
    return [dict(id=key, sender=display_name(m['sender'], m.get('speaker', 'p000')),
                 speaker=m.get('speaker', ''), time=m['time'], content=readable_content(m['content']),
                 reply_to=prepared.get('replies', {}).get(key, ''))
            for key, m in prepared['sources'].items() if ids is None or key in ids]


def expand_discussion(prepared, ids):
    """Include both sides of archived reply chains, even across distant times."""
    members = set(ids)
    edges = [(r, p) for r, p in prepared.get('replies', {}).items()
             if r in prepared['sources'] and p in prepared['sources']]
    while True:
        expanded = members | {i for r, p in edges if r in members or p in members for i in (r, p)}
        if expanded == members:
            return [key for key in prepared['sources'] if key in members]
        members = expanded


def available_days(data_dir):
    _, messages, ranges = load_archive(data_dir)
    days = sorted({datetime.fromtimestamp(m["timestamp"], TZ).strftime("%Y-%m-%d") for m in messages})
    return [{"date": day, **summary_scope(ranges, day)} for day in days]


def _text(value, label, limit=8000, optional=False):
    if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
        raise ArchiveError(f"总结中的{label}格式无效")
    return value.strip()


def validate_summary(value, prepared):
    if not isinstance(value, dict):
        raise ArchiveError("模型没有返回有效总结")
    version = value.get('format_version', 1)
    if version not in (1, 2, 3):
        raise ArchiveError('总结规范版本无效')
    overview = _text(value.get("overview"), "总览", 2400)
    topics = value.get("topics")
    if not isinstance(topics, list) or not 1 <= len(topics) <= 64:
        raise ArchiveError("总结的话题数量无效")
    def references(ids):
        if not isinstance(ids, list) or not 1 <= len(ids) <= (max(512, len(prepared['sources'])) if version >= 2 else 20) or any(not isinstance(i, str) or i not in prepared["sources"] for i in ids):
            raise ArchiveError("总结引用了本日归档以外的消息")
        return list(dict.fromkeys(ids))
    clean = []
    for topic in topics:
        if not isinstance(topic, dict):
            raise ArchiveError("话题格式无效")
        # New formats use blocks. Ignore obsolete presentation fields before
        # validating them; they never contribute prose, people or references.
        if version >= 2:
            topic = {key: value for key, value in topic.items()
                     if key not in ('points', 'outcome', 'views', 'details')}
        refs = references(topic.get("refs"))
        views = topic.get("views", [])
        if not isinstance(views, list) or len(views) > 12:
            raise ArchiveError("观点格式无效")
        checked_views = []
        for view in views:
            if not isinstance(view, dict) or view.get("speaker") not in prepared["people"]:
                raise ArchiveError("观点使用了无效发言者")
            ids = references(view.get("refs"))
            if not all(prepared["sources"][i]["speaker"] == view["speaker"] for i in ids):
                raise ArchiveError("观点的发言者与引用消息不一致")
            checked_views.append({"speaker": view["speaker"], "text": _text(view.get("text"), "观点", 4000), "refs": ids})
        bullets = topic.get('points', [])
        if not isinstance(bullets, list) or len(bullets) > 8:
            raise ArchiveError('话题要点格式无效')
        blocks = []
        if version >= 2:
            raw_blocks = topic.get('blocks', [])
            if not isinstance(raw_blocks, list) or len(raw_blocks) > 24:
                raise ArchiveError('讨论段落格式无效')
            for block in raw_blocks:
                if not isinstance(block, dict):
                    raise ArchiveError('讨论段落格式无效')
                speaker = block.get('speaker', '')
                ids = references(block.get('refs'))
                if not isinstance(speaker, str) or (speaker and (speaker not in prepared['people'] or
                                any(prepared['sources'][i]['speaker'] != speaker for i in ids))):
                    raise ArchiveError('讨论段落的发言者与原文不一致')
                blocks.append({'heading': _text(block.get('heading', ''), '段落标题', 200, True),
                               'speaker': speaker, 'text': _text(block.get('text'), '讨论段落'), 'refs': ids})
            refs = list(dict.fromkeys(refs + [r for b in blocks for r in b['refs']]))
        item = {"title": _text(topic.get("title"), "标题", 200),
                      "summary": _text(topic.get("summary"), "正文"),
                      "details": _text(topic.get("details", ""), "讨论细节", 8000, True),
                      "outcome": _text(topic.get("outcome", ""), "结论", 4000, True),
                      "views": checked_views, "refs": refs, "blocks": blocks,
                      "points": [_text(point, '要点', 1600) for point in bullets]}
        if version == 3:
            members = references(topic.get('discussion_refs'))
            if not set(refs) <= set(members):
                raise ArchiveError('总结依据没有全部纳入话题讨论')
            if any(b['speaker'] for b in blocks):
                raise ArchiveError('v3 按问题整合观点，人物须标在综合正文中')
            quotes = topic.get('quotes', [])
            if not isinstance(quotes, list) or len(quotes) > 2:
                raise ArchiveError('代表性原话最多两条')
            item['quotes'] = []
            for q in quotes:
                if not isinstance(q, dict) or q.get('ref') not in members:
                    raise ArchiveError('原话不属于本话题')
                src = prepared['sources'][q['ref']]
                text = _text(q.get('text'), '原话', 600)
                own_text = readable_content(src['content']).split('\n引用', 1)[0]
                if q.get('speaker') != src['speaker'] or text not in own_text:
                    raise ArchiveError('原话内容或人物与来源不一致')
                item['quotes'].append({'ref': q['ref'], 'speaker': q['speaker'], 'text': text})
            item['discussion_refs'] = expand_discussion(prepared, members)
            item['navigation_title'] = _text(topic.get('navigation_title', item['title']), '目录标题', 100)
            item['progress'] = _text(topic.get('progress', ''), '讨论进展', 1600, True)
            comparisons = topic.get('comparisons', [])
            if not isinstance(comparisons, list) or len(comparisons) > 3:
                raise ArchiveError('观点对照格式无效')
            item['comparisons'] = []
            for c in comparisons:
                if not isinstance(c, dict):
                    raise ArchiveError('观点对照格式无效')
                c_refs = references(c.get('refs'))
                if not set(c_refs) <= set(members):
                    raise ArchiveError('观点对照未纳入完整讨论')
                item['comparisons'].append({'heading': _text(c.get('heading'), '对照标题', 200),
                                            'text': _text(c.get('text'), '对照内容', 2400), 'refs': c_refs})
        clean.append(item)
    notes = value.get("notes", [])
    if not isinstance(notes, list) or len(notes) > 8:
        raise ArchiveError("总结备注格式无效")
    highlights = value.get('highlights', []) if version == 1 else []
    if not isinstance(highlights, list) or len(highlights) > 6:
        raise ArchiveError('今日重点格式无效')
    if version >= 2:
        texts = [overview, *notes]
        for topic in clean:
            texts.extend([topic['title'], topic['summary']])
            texts.extend(x for b in topic['blocks'] for x in (b['heading'], b['text']))
            if version == 3:
                texts.extend([topic['navigation_title'], topic['progress']])
                texts.extend(x for c in topic['comparisons'] for x in (c['heading'], c['text']))
        if any(m.group() not in prepared['people'] for text in texts
               for m in re.finditer(r'(?<![A-Za-z0-9])p\d{3}(?!\d)', text)):
            raise ArchiveError('正文提及了不存在的群友')
    result = {"format_version": version, "overview": overview, "highlights": [_text(n, '重点', 500) for n in highlights], "topics": clean, "notes": [_text(n, "备注", 1000) for n in notes]}
    if version == 3:
        excluded = value.get('excluded_messages')
        if not isinstance(excluded, list):
            raise ArchiveError('缺少全天消息归属核对')
        excluded_ids = set()
        reasons = {'无主题闲聊', '独立系统消息', '无可读内容'}
        for entry in excluded:
            if not isinstance(entry, dict) or entry.get('id') not in prepared['sources'] or entry.get('reason') not in reasons or entry['id'] in excluded_ids:
                raise ArchiveError('未归入话题的消息记录无效')
            excluded_ids.add(entry['id'])
        assigned = {r for t in clean for r in t['discussion_refs']}
        if assigned & excluded_ids or assigned | excluded_ids != set(prepared['sources']):
            raise ArchiveError('全天消息存在遗漏或冲突，未发布总结')
        # A connected reply cannot silently disappear into an exclusion bucket.
        for reply, parent in prepared.get('replies', {}).items():
            if reply in excluded_ids and parent in assigned:
                raise ArchiveError('相关回复被排除，须归入讨论后再发布')
        result['excluded_messages'] = [{'id': e['id'], 'reason': e['reason']} for e in excluded]
    return result


def display_name(name, speaker):
    # Keep identity separate from prose, including invisible or empty nicknames.
    name = ''.join(c for c in str(name or '') if unicodedata.category(c) not in ('Cc', 'Cf') or c == '\u200d').strip()
    return name or f'未命名 {int(speaker[1:]):02}'


def summary_for_browser(data_dir, day):
    prepared = prepare_day(data_dir, day)
    path = Path(data_dir) / "summaries" / (day + ".json")
    if not path.exists():
        return {"date": day, "status": "missing", "complete": prepared["complete"]}
    doc = json.loads(path.read_text(encoding="utf-8"))
    validation_prepared = prepared
    if doc['source_hash'] != prepared['source_hash'] and doc['summary'].get('format_version') == 3:
        recorded = {r for t in doc['summary']['topics'] for r in t['discussion_refs']}
        recorded.update(e['id'] for e in doc['summary']['excluded_messages'])
        validation_prepared = dict(prepared, sources={k:v for k,v in prepared['sources'].items() if k in recorded})
    checked = validate_summary(doc["summary"], validation_prepared)
    for topic in checked['topics']:
        topic['discussion_complete'] = checked['format_version'] == 3 and doc['source_hash'] == prepared['source_hash']
        topic['discussion_count'] = len(discussion_messages(prepared, topic))
        for quote in topic.get('quotes', []):
            quote['time'] = prepared['sources'][quote['ref']]['time']
    # Resolve names only in the renderer so every occurrence gets the same badge.
    people = {speaker: display_name(name, speaker) for speaker, name in prepared['people'].items()}
    return {"date": day, "status": "ready", "stale": doc["source_hash"] != prepared["source_hash"],
            "summary": checked, "people": people,
            "partial": doc.get('partial', False), "coverage_end": doc.get('coverage_end'),
            "editorial_revision": doc.get('editorial_revision', '')}
