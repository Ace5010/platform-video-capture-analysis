"""固定版本读取模块的隔离入口，不导入上游 GUI/机器人包。"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import subprocess
import tempfile
import types

from .archive import ArchiveError, member_ids_for

ROOT = Path(__file__).resolve().parent
UPSTREAM_SHA256 = "1b8958a0e9a3f8d6c2f8fe89acd72c14bb542c3c16635c31b52e05c0f19b247b"


class IncompleteRead(ArchiveError):
    pass


class StrictLog:
    failure_reason = None
    def debug(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        # 上游的降级/丢分片告警一律停止，正文与密钥不进入日志。
        raise IncompleteRead(self.failure_reason or "上游读取发生降级，未保存或推进进度；请稍后重试")


def load_upstream():
    source_path = ROOT / "vendor" / "wechat_db.py"
    raw = source_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA256:
        raise ArchiveError("上游源码校验失败")
    source = raw.decode("utf-8")
    anchor = "from wechatauto.logger import wxlog"
    if source.count(anchor) != 1:
        raise ArchiveError("上游导入结构变化")
    module = types.ModuleType("wechat_reader_upstream")
    module.__file__ = str(source_path)
    module.wxlog = StrictLog()
    # 唯一的源码加载补丁：注入隔离日志，完全不执行 wechatauto/__init__.py。
    exec(compile(source.replace(anchor, "# wxlog supplied by isolated loader"), str(source_path), "exec"), module.__dict__)
    return module


def source_stamp(path):
    entries = []
    for file in (Path(path), Path(str(path) + "-wal")):
        try:
            stat = file.stat()
            entries.append((stat.st_size, stat.st_mtime_ns))
        except FileNotFoundError:
            entries.append(None)
    return entries


def check_wal_boundary(path, db_size):
    """仅验证上游合并器适用前提；不自行解密、修复或 checkpoint。"""
    with open(path, "rb") as stream:
        header = stream.read(32)
        if len(header) != 32 or struct.unpack(">I", header[8:12])[0] != 4096:
            raise IncompleteRead("WAL 头部不完整或页大小不支持")
        salt = header[16:24]
        last_commit = None
        max_page = 0
        while frame := stream.read(4120):
            if len(frame) != 4120:
                if len(frame) >= 16 and frame[8:16] != salt:
                    break  # 4 MiB 预分配文件的旧世代/零填充尾部。
                raise IncompleteRead("WAL 正在写入，请稍后重试")
            if frame[8:16] != salt:
                continue  # 上游同样忽略预分配的旧世代尾部。
            pgno, last_commit = struct.unpack(">II", frame[:8])
            max_page = max(max_page, pgno)
        if last_commit is None:
            return  # WAL 重置后可能仅剩旧世代预分配帧；本世代没有待合并内容。
        if last_commit == 0:
            raise IncompleteRead("WAL 尚无完整提交边界，请稍后重试")
        if max_page > last_commit or db_size > last_commit * 4096:
            raise IncompleteRead("WAL 涉及数据库收缩，当前读取器停止处理")


def make_reader(module, db_dir, account, pid, cache, contacts_only=False):
    base = Path(db_dir).resolve()
    account_path = (base / account).resolve()
    if account_path.parent != base or not (account_path / "db_storage").is_dir():
        raise ArchiveError("账号目录无效")

    class SelectedDB(module.WeChatDB):
        def _collect_db_files(self):
            files = super()._collect_db_files()
            return [(r, p, n) for r, p, n in files if
                    Path(p).name == "contact.db" or
                    (not contacts_only and re.fullmatch(r"message/message_\d+\.db", r.replace("\\", "/")))]

        def _load_or_extract_keys(self, master_key=None):
            # 只扫描明确选择的进程；不读/写密钥缓存，不切换账号，不取图片密钥。
            if not self._db_files:
                raise ArchiveError("指定账号没有所需数据库")
            self._keys = self._extract_keys_pid(pid, set())
            missing = [r for r, _, _ in self._db_files if not self._key_works(r)]
            if missing:
                raise ArchiveError("指定账号密钥不足，未切换账号或读取聊天；请检查登录和读取权限")
            self.unkeyed = []

        def _save_keys(self):
            pass

        def _merge_wal(self, dst, wal_path, key, from_frame):
            try:
                check_wal_boundary(wal_path, os.path.getsize(dst))
            except IncompleteRead as exc:
                module.wxlog.failure_reason = str(exc)
                raise
            # 原合并器会跳过部分不认识的页；改为明确失败，避免少读后仍报告成功。
            decrypt = module._decrypt_page
            def checked_decrypt(enc_key, page, pgno):
                result = decrypt(enc_key, page, pgno)
                if pgno > 1 and result[0] not in (0, 2, 5, 10, 13):
                    raise IncompleteRead("WAL 包含当前上游不能完整处理的页")
                return result
            module._decrypt_page = checked_decrypt
            try:
                return super()._merge_wal(dst, wal_path, key, from_frame)
            except IncompleteRead as exc:
                module.wxlog.failure_reason = str(exc)
                raise
            finally:
                module._decrypt_page = decrypt

        def _open(self, rel):
            src = self._db_path(rel)
            before = source_stamp(src)
            conn = super()._open(rel)
            if source_stamp(src) != before:
                conn.close()
                raise IncompleteRead("数据库在制作读取副本时发生变化，请重试")
            return conn

    db = SelectedDB(db_dir=str(base), account=account, workdir=str(cache))
    if db.account != account:
        raise ArchiveError("读取组件改变了账号")
    return db


def process_version(pid):
    if type(pid) is not int or pid <= 0:
        raise ArchiveError("微信进程号无效")
    script = f"[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-Process -Id {pid} -ErrorAction Stop; @{{name=$p.ProcessName; version=$p.MainModule.FileVersionInfo.FileVersion}} | ConvertTo-Json -Compress"
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        info = json.loads(result.stdout)
    except ValueError:
        raise ArchiveError("无法核实微信进程版本") from None
    if info.get("name") != "Weixin" or info.get("version") != "4.1.15.13":
        raise ArchiveError("当前进程不是已选定的微信 4.1.15.13")
    return info


def active_pid(preferred):
    try:
        process_version(preferred)
        return preferred
    except ArchiveError:
        # 微信重启后 PID 会变化，只接受唯一的主进程，再验证版本和账号密钥。
        script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=@(Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\"); ConvertTo-Json -Compress -InputObject @($p | Where-Object {$_.ParentProcessId -notin $p.ProcessId} | Select-Object -ExpandProperty ProcessId)"
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            values = json.loads(result.stdout)
            values = values if isinstance(values, list) else [values]
            if not values:
                raise ArchiveError("微信未运行，请打开微信并登录后重试")
            if len(values) != 1:
                raise ValueError()
            pid = int(values[0])
        except (ValueError, TypeError):
            raise ArchiveError("未找到唯一的微信主进程，请登录目标账号后重试") from None
        process_version(pid)
        return pid


def read_rows(db, group, start, end, page_size=200):
    """每个副本仅打开一次；按时间过滤后 fetchmany，避免 offset 与新消息相互干扰。"""
    table = "Msg_" + hashlib.md5(group.encode()).hexdigest()
    rows, names, counts = [], {}, {}
    found = False
    files = sorted(db._db_files)
    with ExitStack() as stack:
        contacts = []
        for rel, path, _ in files:
            conn = db._open(rel)
            stack.callback(conn.close)
            if Path(path).name == "contact.db":
                contacts.append(conn)
                continue
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                continue
            found = True
            shard = db._shard_label(conn)
            mapping = db._name2id_map(conn)
            cursor = conn.execute(f'SELECT * FROM "{table}" WHERE create_time>=? AND create_time<? '
                                  'ORDER BY create_time, sort_seq, local_id', (start, end))
            count = 0
            while page := cursor.fetchmany(page_size):
                for original in page:
                    row = dict(original)
                    # 仅保留必要来源字段；不复制整个原表。
                    row = {k: row.get(k) for k in ("local_id", "server_id", "sort_seq", "local_type",
                           "real_sender_id", "create_time", "message_content", "compress_content")}
                    row.update(shard=shard, chat_id=group,
                               sender_username=mapping.get(row["real_sender_id"], ""))
                    rows.append(row)
                    count += 1
            counts[shard] = count
        if not found:
            raise ArchiveError("目标群在本机没有可读取的消息表")
        for sender in set().union(*(member_ids_for(r) for r in rows), {group}):
            for conn in contacts:
                hit = conn.execute("SELECT nick_name, remark FROM contact WHERE username=?", (sender,)).fetchone()
                if hit:
                    names[sender] = hit[1] or hit[0] or sender
    return rows, names, {"shard_counts": counts, "source_count": len(rows)}


def collect(config, start, end):
    pid = active_pid(config["pid"])
    module = load_upstream()
    cache_root = Path(config["data_dir"]).resolve() / "cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="read-", dir=cache_root) as directory:
        if not Path(directory).resolve().is_relative_to(cache_root):
            raise ArchiveError("缓存目录范围无效")
        db = make_reader(module, config["db_dir"], config["account_dir"], pid, directory)
        try:
            if db.wxid != config["account_id"]:
                raise ArchiveError("来源账号标识不匹配")
            return read_rows(db, config["group_id"], start, end)
        finally:
            db._keys.clear()


def probe(pid, group_name, data_dir):
    process_version(pid)
    module = load_upstream()
    base = module.auto_detect_db_dir()
    if not base:
        raise ArchiveError("无法定位微信数据目录")
    accounts = module._find_account_dirs(base)
    if len(accounts) != 1:
        return {"db_dir": base, "account_dirs": [Path(a).name for a in accounts], "needs_account_selection": True}
    cache_root = Path(data_dir).resolve() / "cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="probe-", dir=cache_root) as directory:
        if not Path(directory).resolve().is_relative_to(cache_root):
            raise ArchiveError("缓存目录范围无效")
        db = make_reader(module, base, Path(accounts[0]).name, pid, directory, contacts_only=True)
        matches = []
        try:
            for rel, _, _ in db._db_files:
                conn = db._open(rel)
                try:
                    for row in conn.execute("SELECT username,nick_name FROM contact WHERE nick_name=? AND username LIKE '%@chatroom'", (group_name,)):
                        matches.append({"group_id": row[0], "group_name": row[1]})
                finally:
                    conn.close()
            return {"pid": pid, "db_dir": base, "account_dir": db.account, "account_id": db.wxid,
                    "matches": matches, "data_dir": str(Path(data_dir).resolve())}
        finally:
            db._keys.clear()
