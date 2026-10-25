import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from host_service.wechat.archive import ArchiveError, archive_status, build_export, save_export
from host_service.wechat.reader import IncompleteRead, StrictLog, active_pid, check_wal_boundary, load_upstream, make_reader, read_rows

ACCOUNT, GROUP = "wxid_fixture", "123_fixture@chatroom"
START = 1792454400


def row(number, **overrides):
    return {"local_id": number, "server_id": str(9000000000000000000 + number),
            "shard": "message__message_0.db", "local_type": 1,
            "real_sender_id": 2, "sender_username": "wxid_a", "sort_seq": number,
            "create_time": START + 1, "message_content": "中文 English 😀\n第二行",
            "compress_content": None, "chat_id": GROUP, **overrides}


class Tests(unittest.TestCase):
    def build(self, rows):
        return build_export(ACCOUNT, GROUP, "虚构测试群", START, START + 86400, rows, {"wxid_a": "同名", "wxid_b": "同名"})

    def test_identity_text_real_duplicates(self):
        data = self.build([row(1), row(1), row(2), row(3, sender_username="wxid_b")])
        self.assertEqual(len(data["messages"]), 3)
        self.assertEqual(len(data["members"]), 2)
        self.assertEqual(data["messages"][0]["content"], "中文 English 😀\n第二行")
        self.assertNotEqual(data["messages"][0]["platformMessageId"], data["messages"][1]["platformMessageId"])

    def test_shard_local_id_and_unknown_member(self):
        data = self.build([row(1, server_id=0), row(1, server_id=0, shard="message__message_1.db", sender_username="")])
        self.assertEqual(len(data["messages"]), 2)
        self.assertTrue(any(m["accountName"] == "未知成员" for m in data["messages"]))

    def test_compressed_long_text_preserves_whitespace(self):
        import zstandard
        text = "  保留换行\n" + "长文" * 50000 + "\n  "
        compressed = zstandard.ZstdCompressor().compress(text.encode())
        msg = self.build([row(1, message_content=compressed)])["messages"][0]
        self.assertEqual(msg["content"], text)
        self.assertEqual(msg["_source"]["message_content"]["encoding"], "base64")

    def test_link_reply_and_media(self):
        link = '<msg><appmsg><type>5</type><title>链接标题</title><url>https://example.invalid/a</url></appmsg></msg>'
        quote = '<msg><appmsg><type>57</type><title>回复文字</title><refermsg><svrid>9000000000000000001</svrid><displayname>同名</displayname><content>原句</content></refermsg></appmsg></msg>'
        data = self.build([row(1), row(2, local_type=49, message_content=link), row(3, local_type=49, message_content=quote), row(4, local_type=3, message_content=b'\xff\x00')])
        a, b, c, d = data["messages"]
        self.assertIn("https://example.invalid/a", b["content"])
        self.assertEqual(c["replyToMessageId"], a["platformMessageId"])
        self.assertIn("原句", c["content"])
        self.assertEqual(d["type"], 1)
        self.assertIn("未获取", d["content"])

    def test_reject_bad_time_scope_conflicting_id(self):
        for rows in ([row(1, create_time=START * 1000)], [row(1, create_time=START - 1)],
                     [row(1, chat_id="other@chatroom")], [row(1), row(1, message_content="冲突")]):
            with self.assertRaises(ArchiveError):
                self.build(rows)

    def test_system_and_pat_are_not_ordinary_unknown_text(self):
        pat = '<msg><appmsg><type>62</type><patinfo><fromusername>wxid_b</fromusername><template>${wxid_b} 拍了拍 ${wxid_a}</template></patinfo></appmsg></msg>'
        data = self.build([row(1, local_type=10000, sender_username=""), row(2, local_type=266287972401, sender_username="", message_content=pat)])
        self.assertEqual(data["messages"][0]["sender"], "SYSTEM")
        self.assertEqual(data["messages"][1]["type"], 22)
        self.assertEqual(data["messages"][1]["content"], "同名 拍了拍 同名")
        self.assertEqual(data["messages"][1]["_source"]["message_content"], pat)
        self.assertEqual(data["messages"][1]["sender"], "wxid_b")

    def test_atomic_save_repeat_and_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = self.build([row(1), row(2)])
            first = save_export(tmp, data)
            data["chatlab"]["exportedAt"] += 10
            self.assertEqual(save_export(tmp, data), first)
            self.assertEqual(len(archive_status(tmp)), 1)
            data = self.build([row(3)])
            with patch("host_service.wechat.archive.os.replace", side_effect=OSError("disk unavailable")):
                with self.assertRaises(OSError):
                    save_export(tmp, data)
            self.assertEqual(len(archive_status(tmp)), 1)
            save_export(tmp, data)
            self.assertEqual(len(archive_status(tmp)), 2)
            first.write_text("broken", encoding="utf-8")
            with self.assertRaises(ArchiveError):
                archive_status(tmp)

    def test_isolated_import_and_account_no_switch_or_key_files(self):
        module = load_upstream()
        self.assertFalse(any(n.startswith("wechatauto") for n in sys.modules))
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            contact = base / "chosen" / "db_storage" / "contact" / "contact.db"
            contact.parent.mkdir(parents=True)
            contact.write_bytes(b"fixture")
            with patch.object(module.WeChatDB, "_extract_keys_pid", return_value={}), \
                 patch.object(module.WeChatDB, "_try_other_accounts", side_effect=AssertionError("must not run")):
                with self.assertRaises(ArchiveError):
                    make_reader(module, base, "chosen", 123, base / "cache")
            self.assertFalse(list(base.rglob("keys*")))

    def test_snapshot_pagination_nonmonotonic_seq_and_failure(self):
        module = load_upstream()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            table = "Msg_" + __import__("hashlib").md5(GROUP.encode()).hexdigest()
            files = []
            for shard in range(2):
                path = root / f"message_{shard}.db"
                con = sqlite3.connect(path)
                con.execute("CREATE TABLE Name2Id(user_name TEXT)")
                con.execute("INSERT INTO Name2Id(rowid,user_name) VALUES(2,?)", ("wxid_a" if shard == 0 else "wxid_b",))
                con.execute(f'CREATE TABLE "{table}"(local_id INTEGER,server_id TEXT,sort_seq INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,compress_content BLOB)')
                con.executemany(f'INSERT INTO "{table}" VALUES(?,?,?,?,?,?,?,?)', [(n, str(shard * 1000 + n), 500-n, 1, 2, START+n%2, "虚构", None) for n in range(1, 252)])
                con.execute(f'INSERT INTO "{table}" VALUES(999,"9999",999,1,2,?,"范围外",NULL)', (START+86400,))
                con.commit()
                con.close()
                files.append((path.name, str(path), path.stat().st_size))
            class FixtureDB:
                _db_files = files
                _shard_label = module.WeChatDB._shard_label
                _name2id_map = module.WeChatDB._name2id_map
                def _open(self, rel):
                    con = sqlite3.connect((root / rel).as_uri()+"?mode=ro", uri=True)
                    con.row_factory = sqlite3.Row
                    return con
            db = FixtureDB()
            rows, names, evidence = read_rows(db, GROUP, START, START+86400, page_size=100)
            self.assertEqual(len(rows), 502)
            self.assertEqual({r["sender_username"] for r in rows}, {"wxid_a", "wxid_b"})
            self.assertEqual(evidence["source_count"], 502)
            with patch.object(db, "_open", side_effect=sqlite3.DatabaseError("bad shard")):
                with self.assertRaises(sqlite3.DatabaseError):
                    read_rows(db, GROUP, START, START+86400)

    def test_upstream_degradation_is_failure(self):
        with self.assertRaises(IncompleteRead):
            StrictLog().warning("WAL 合并失败")

    def test_restart_pid_requires_unique_verified_process(self):
        from types import SimpleNamespace
        with patch("host_service.wechat.reader.process_version", side_effect=[ArchiveError("stale"), {}]) as verify, \
             patch("host_service.wechat.reader.subprocess.run", return_value=SimpleNamespace(stdout="456")):
            self.assertEqual(active_pid(123), 456)
            self.assertEqual(verify.call_args.args, (456,))
        with patch("host_service.wechat.reader.process_version", side_effect=ArchiveError("stale")), \
             patch("host_service.wechat.reader.subprocess.run", return_value=SimpleNamespace(stdout="[456,789]")):
            with self.assertRaises(ArchiveError):
                active_pid(123)

    def test_wal_reset_old_frames_and_uncommitted_tail(self):
        import struct
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture-wal"
            header = struct.pack(">IIII", 0x377F0682, 3007000, 4096, 1) + b"newsalts" + bytes(8)
            old = struct.pack(">II", 1, 1) + b"oldsalts" + bytes(4104)
            path.write_bytes(header + old + bytes(112))
            check_wal_boundary(path, 4096)
            uncommitted = struct.pack(">II", 1, 0) + b"newsalts" + bytes(4104)
            path.write_bytes(header + uncommitted)
            with self.assertRaises(IncompleteRead):
                check_wal_boundary(path, 4096)


if __name__ == "__main__":
    unittest.main()
