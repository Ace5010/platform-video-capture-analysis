"""指定群消息到 ChatLab 文件；输入与日志不执行聊天中的指令。"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET


class ArchiveError(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def message_id(account, group, row):
    server = row.get("server_id")
    if server is not None and str(server) not in ("", "0", "-1"):
        key = [account, group, "server", str(server)]
    elif row.get("shard") and row.get("local_id") is not None:
        key = [account, group, "local", row["shard"], str(row["local_id"])]
    else:
        raise ArchiveError("消息缺少稳定来源标识，已停止导出")
    return "wx:" + digest(key)


def preserve(value):
    if isinstance(value, bytes):
        return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}
    return value


def decode_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        if value.startswith(b"\x28\xb5\x2f\xfd"):
            import zstandard
            try:
                value = zstandard.ZstdDecompressor().decompress(value, max_output_size=16 * 1024 * 1024)
            except zstandard.ZstdError:
                raise ArchiveError("消息正文解压失败，未推进读取进度") from None
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            raise ArchiveError("消息正文编码无法识别，未推进读取进度") from None
    raise ArchiveError("消息正文类型无法识别")


TYPES = {1: (0, "文字"), 3: (1, "图片"), 34: (2, "语音"), 43: (3, "视频"),
         47: (5, "表情"), 11000: (5, "表情"), 48: (8, "位置"),
         50: (23, "通话"), 10000: (80, "系统消息"), 10002: (81, "撤回提示")}


def sender_for(row):
    if row.get("sender_username"):
        return row["sender_username"]
    # 拍一拍的发送者来自消息内显式 fromusername，不能拿系统行编号猜人。
    if int(row["local_type"]) == 266287972401:
        text = decode_text(row.get("message_content"))
        if "<!DOCTYPE" not in text.upper() and "<!ENTITY" not in text.upper():
            try:
                return ET.fromstring(text).findtext(".//patinfo/fromusername") or ""
            except ET.ParseError:
                pass
    return ""


def member_ids_for(row):
    members = {sender_for(row)} - {""}
    if int(row["local_type"]) == 266287972401:
        members.update(re.findall(r"\$\{([^{}]+)\}", decode_text(row.get("message_content"))))
    return members


def content_for(row, account, group, names=None):
    kind = int(row["local_type"]) & 0xFFFFFFFF
    code, label = TYPES.get(kind, (99, "其他消息"))
    original = row.get("message_content")
    if original in (None, "", b"") and row.get("compress_content"):
        original = row["compress_content"]
    if kind in (1, 49, 10000, 10002):
        text = decode_text(original)
    else:
        # 媒体内容保存在来源字段，仅呈现存在状态，不伪造已保存原件。
        return code, "[" + label + "：未获取原件]", None, "未获取"
    sender = row.get("sender_username")
    if sender and text.startswith(sender + ":\n"):
        text = text[len(sender) + 2:]
    if kind != 49:
        if kind == 1 and not text:
            raise ArchiveError("文字消息正文为空，已停止导出")
        return code, text, None, "文字"
    # XML 仅作字段解析；禁止 DTD/实体，不打开消息中的链接。
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        return 99, text, None, "原始内容"
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return 99, text, None, "原始内容"
    app = root if root.tag == "appmsg" else root.find(".//appmsg")
    if app is None:
        return 99, text, None, "原始内容"
    subtype = app.findtext("type", "")
    title, url = app.findtext("title", ""), app.findtext("url", "")
    description = app.findtext("des", "")
    if subtype == "57":
        ref = app.find("refermsg")
        quoted = ref.findtext("content", "") if ref is not None else ""
        name = ref.findtext("displayname", "") if ref is not None else ""
        sid = ref.findtext("svrid", "") if ref is not None else ""
        target = message_id(account, group, {"server_id": sid}) if sid not in ("", "0", "-1") else None
        return 25, title + ("\n引用 " + name + "：" + quoted if quoted else ""), target, "文字"
    if subtype == "5":
        return 7, "\n".join(x for x in (title, description, url) if x), None, "文字"
    if subtype == "6":
        return 4, "[文件：未获取原件] " + title, None, "未获取"
    if subtype == "62":
        template = app.findtext("patinfo/template") or "[拍一拍]"
        text = re.sub(r"\$\{([^{}]+)\}", lambda match: (names or {}).get(match[1], "未知成员"), template)
        return 22, text, None, "文字"
    return 24, title or text, None, "原始内容"


def build_export(account, group, group_name, start, end, rows, names=None, evidence=None):
    if not account or not group.endswith("@chatroom") or not group_name:
        raise ArchiveError("账号或群标识不完整")
    if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end < 100_000_000_000:
        raise ArchiveError("读取范围必须使用秒级时间")
    names = names or {}
    messages, seen, members = [], {}, {}
    for row in rows:
        ts = row["create_time"]
        if type(ts) is not int or not 0 <= ts < 100_000_000_000:
            raise ArchiveError("来源时间不是秒级整数")
        if not start <= ts < end:
            raise ArchiveError("来源返回了范围外消息")
        if row.get("chat_id", group) != group:
            raise ArchiveError("来源返回了其他群消息")
        mid = message_id(account, group, row)
        sender = sender_for(row) or "unknown:" + digest([account, group, row.get("shard"), row.get("real_sender_id")])
        name = names.get(sender) or ("未知成员" if sender.startswith("unknown:") else sender)
        code, text, reply, media = content_for(row, account, group, names)
        if code in (80, 81):
            sender, name = "SYSTEM", "系统"
        message = {"platformMessageId": mid, "sender": sender, "accountName": name,
                   "timestamp": ts, "type": code, "content": text,
                   "_source": {k: preserve(v) for k, v in row.items()}}
        message["_source"]["media_state"] = media
        if reply:
            message["replyToMessageId"] = reply
        fingerprint = digest(message)
        if mid in seen:
            if seen[mid] != fingerprint:
                raise ArchiveError("相同来源 ID 出现冲突，已停止导出")
            continue
        seen[mid] = fingerprint
        members[sender] = {"platformId": sender, "accountName": name}
        messages.append(message)
    messages.sort(key=lambda m: (m["timestamp"], m["_source"].get("sort_seq") or 0, m["platformMessageId"]))
    return {"chatlab": {"version": "0.0.2", "exportedAt": int(time.time()), "generator": "WeChat-Reader/0.1"},
            "meta": {"name": group_name, "platform": "wechat", "type": "group", "groupId": group},
            "members": list(members.values()), "messages": messages,
            "_archive": {"account_id": account, "chat_id": group, "start": start, "end": end,
                         "timezone": "Asia/Shanghai", "read_status": "complete", "import_status": "pending",
                         "source_evidence": evidence or {}}}


def atomic_json(path, value, validator=None):
    path = Path(path)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    data = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    with tmp.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        json.loads(tmp.read_text(encoding="utf-8"))
        if validator:
            validator(tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def save_export(root, payload):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    # 正式批次文件本身就是进度依据；中断的 .tmp 不计入已完成进度。
    identity = dict(payload)
    identity["chatlab"] = dict(payload["chatlab"], exportedAt=0)
    batch_id = digest(identity)
    target = root / (batch_id + ".json")
    if target.exists():
        previous = json.loads(target.read_text(encoding="utf-8"))
        previous["chatlab"]["exportedAt"] = 0
        if digest(previous) != batch_id:
            raise ArchiveError("已有归档校验失败，保留原文件并停止")
        return target
    def validate(tmp):
        # 官方校验器按扩展名识别；临时文件通过独立 .json 路径校验。
        validation = tmp.with_name(tmp.name + ".json")
        os.replace(tmp, validation)
        try:
            result = subprocess.run(["node", str(Path(__file__).parent / "vendor" / "validate-chatlab.mjs"), str(validation)],
                                    capture_output=True, text=True, timeout=30)
            if result.returncode:
                raise ArchiveError("ChatLab 官方格式校验失败，未推进读取进度")
        finally:
            os.replace(validation, tmp)
    atomic_json(target, payload, validate)
    return target


def archive_status(root):
    result = []
    for path in sorted(Path(root).glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            check = dict(doc, chatlab=dict(doc["chatlab"], exportedAt=0))
            if digest(check) != path.stem:
                raise ValueError()
            result.append({"batch": path.stem, "messages": len(doc["messages"]), **doc["_archive"]})
        except (ValueError, KeyError, TypeError):
            raise ArchiveError("正式归档损坏，保留文件并停止恢复进度") from None
    return result
