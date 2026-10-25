"""手动执行一次读取或查看归档状态。"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from .archive import ArchiveError, archive_status, atomic_json, build_export, save_export

ROOT = Path(__file__).resolve().parent
from .paths import runtime_root, data_root
RUNTIME = runtime_root()


def import_export(config, path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    env = dict(os.environ, CHATLAB_DATA_DIR=str(Path(config["data_dir"]) / "chatlab"),
               CHATLAB_LOCALE_LANG="zh-CN", CHATLAB_SKIP_UPDATE_CHECK="1")
    cli = RUNTIME / "runtime" / "node_modules" / "chatlab-cli" / "bin" / "chatlab.mjs"
    if not cli.is_file():
        raise ArchiveError("ChatLab 本地运行组件缺失；已保存的导出文件可手动导入")
    run = subprocess.run(["node", str(cli), "import", str(path), "--json"], env=env,
                         capture_output=True, text=True, encoding="utf-8", timeout=120)
    try:
        result = json.loads(run.stdout)
        info = result["data"]
        batch = info["batch"]
        expected = len(data["messages"])
        if run.returncode or not result["ok"] or not info["success"] or not info["sessionId"]:
            raise ValueError()
        if batch["receivedCount"] != expected or batch["writtenCount"] + batch["duplicateCount"] != expected or batch.get("errorCount", 0):
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise ArchiveError("ChatLab 未确认完整导入；导出文件已保留，可直接重试导入") from None
    receipt = {"status": "imported", "session_id": info["sessionId"], "confirmed_at": int(time.time()),
               "received": expected, "written": batch["writtenCount"], "duplicates": batch["duplicateCount"]}
    receipt_dir = Path(config["data_dir"]) / "receipts"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(receipt_dir / (Path(path).stem + ".json"), receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description="指定微信群本地归档")
    sub = parser.add_subparsers(dest="command", required=True)
    probe = sub.add_parser("probe", help="只查找指定群，不导出消息")
    probe.add_argument("--pid", type=int, required=True)
    probe.add_argument("--group-name", required=True)
    probe.add_argument("--data-dir", type=Path, required=True)
    probe.add_argument("--config", type=Path, required=True)
    collect = sub.add_parser("collect", help="读取一次，成功后退出")
    collect.add_argument("--config", type=Path, required=True)
    collect.add_argument("--days", type=int, help="显式重读最近若干天；首次默认 3 天，后续从上次成功范围重叠读取")
    sync = sub.add_parser("sync", help="读取并导入 ChatLab，完成后退出")
    sync.add_argument("--config", type=Path, required=True)
    sync.add_argument("--days", type=int)
    imp = sub.add_parser("import", help="重试导入所有尚未确认的正式批次，不读取微信")
    imp.add_argument("--config", type=Path, required=True)
    status = sub.add_parser("status", help="仅查看归档状态")
    status.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "probe":
        from .reader import probe as find_group
        found = find_group(args.pid, args.group_name, args.data_dir)
        if len(found.get("matches", [])) != 1:
            print(json.dumps(found, ensure_ascii=False))
            return 2
        chosen = found.pop("matches")[0]
        config = {**found, **chosen}
        if args.config.exists():
            raise ArchiveError("配置已存在，保留原配置")
        args.config.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "group_confirmed", "group_name": chosen["group_name"], "matched_groups": 1}, ensure_ascii=False))
        return 0
    config = json.loads(args.config.read_text(encoding="utf-8"))
    batches = Path(config["data_dir"]) / "batches"
    history = archive_status(batches)
    for batch in history:
        receipt = Path(config["data_dir"]) / "receipts" / (batch["batch"] + ".json")
        if receipt.exists():
            batch["import_receipt"] = json.loads(receipt.read_text(encoding="utf-8"))
            batch["import_status"] = batch["import_receipt"]["status"]
    if args.command == "status":
        print(json.dumps({"batches": history}, ensure_ascii=False, indent=2))
        return 0
    if args.command in ("import", "sync"):
        pending = 0
        for batch in history:
            if batch["import_status"] != "imported":
                print(json.dumps(import_export(config, batches / (batch["batch"] + ".json")), ensure_ascii=False))
                pending += 1
    if args.command == "import":
        if not pending:
            print(json.dumps({"status": "up_to_date"}))
        return 0
    end = int(time.time())
    if args.days is not None and not 1 <= args.days <= 365:
        raise ArchiveError("天数需在 1 到 365 之间")
    matching = [b for b in history if b["account_id"] == config["account_id"] and b["chat_id"] == config["group_id"]]
    start = end - (args.days or 3) * 86400
    if args.days is None and matching:
        start = max(b["end"] for b in matching) - 600
    from .reader import collect as read_once
    began = time.monotonic()
    rows, names, evidence = read_once(config, start, end)
    if not rows:
        print(json.dumps({"status": "no_messages", "start": start, "end": end}))
        return 0
    payload = build_export(config["account_id"], config["group_id"], config["group_name"], start, end, rows, names, evidence)
    path = save_export(batches, payload)
    receipt = import_export(config, path) if args.command == "sync" else None
    tz = timezone(timedelta(hours=8))
    print(json.dumps({"status": "imported" if receipt else "exported_pending_import", "import_receipt": receipt,
                      "file": str(path), "messages": len(payload["messages"]),
                      "unknown_senders": sum(m["sender"].startswith("unknown:") for m in payload["messages"]),
                      "from": datetime.fromtimestamp(start, tz).isoformat(), "to": datetime.fromtimestamp(end, tz).isoformat(),
                      "elapsed_seconds": round(time.monotonic() - began, 2)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ArchiveError as exc:
        print(json.dumps({"status": "incomplete" if type(exc).__name__ == "IncompleteRead" else "failed", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        # 不输出来源 SQL、聊天正文或密钥；错误类型足以定位后再做受限诊断。
        print(json.dumps({"status": "failed", "reason": type(exc).__name__, "progress_advanced": False}), file=sys.stderr)
        sys.exit(1)
