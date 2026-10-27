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
    find = sub.add_parser('find-groups', help='只查找已配置账号的指定群名，不读取聊天')
    find.add_argument('--config', type=Path, required=True)
    find.add_argument('--group-name', required=True)
    collect = sub.add_parser("collect", help="读取一次，成功后退出")
    collect.add_argument("--config", type=Path, required=True)
    collect.add_argument("--days", type=int, help="显式重读最近若干天；首次默认 3 天，后续从上次成功范围重叠读取")
    collect.add_argument('--client', action='store_true', help='允许指定微信客户端补下载缺少的附件')
    sync = sub.add_parser("sync", help="读取并导入 ChatLab，完成后退出")
    sync.add_argument("--config", type=Path, required=True)
    sync.add_argument("--days", type=int)
    sync.add_argument('--start', type=int, help='显式读取范围的开始时间，含边界')
    sync.add_argument('--end', type=int, help='显式读取范围的结束时间，不含边界')
    sync.add_argument('--client', action='store_true')
    resources = sub.add_parser('resources', help='仅补取已经归档消息的附件与网页，不推进聊天读取范围')
    resources.add_argument('--config', type=Path, required=True)
    resources.add_argument('--client', action='store_true')
    resources.add_argument('--message', help='仅重试这一条已归档的图片消息')
    resources.add_argument('--images-only', action='store_true', help='仅检查本机图片，不访问网页或下载媒体')
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
    if args.command != 'status' and (Path(config['data_dir'])/'cleanup-pending.json').exists():
        raise ArchiveError('有未完成的清理，请先按原时间段继续清理')
    if args.command == 'resources':
        from .summaries import load_archive
        from .reader import collect as read_once, active_pid, load_upstream
        from .resources import collect_resources, requirements, load_resources
        from .archive import digest
        _, messages, ranges = load_archive(config['data_dir'])
        if not messages:
            raise ArchiveError('没有已归档的消息可补取')
        if args.message:
            messages = [m for m in messages if 'm_' + digest(m['platformMessageId'])[:16] == args.message]
            if len(messages) != 1 or not any(s['kind']=='image' for s in requirements(messages[0])):
                raise ArchiveError('图片消息不存在于所选群')
            args.images_only = True
        if args.images_only and args.client:
            raise ArchiveError('本机图片重试不操作微信客户端')
        # Old immutable batches predate packed_info_data. Read its source again,
        # matching stable IDs and archived content; do not change archive bounds.
        by_id = {}
        # Local diagnosis can work with WeChat closed. Missing old file metadata
        # is refreshed only for affected images, without changing the archive.
        prior = load_resources(config['data_dir'],config) if args.images_only else None
        refresh_targets = [m for m in messages if not m['_source'].get('packed_info_data')
                           and any(s['kind']=='image' for s in requirements(m))
                           and not any(i.get('kind')=='image' and i.get('status')=='ready'
                                       for i in prior['messages'].get(m['platformMessageId'],{}).get('items',[]))] if prior else []
        needs_source = not args.images_only or bool(refresh_targets)
        if needs_source:
            start, end = ((min(m['timestamp'] for m in refresh_targets),max(m['timestamp'] for m in refresh_targets)+1) if args.images_only else
                          (min(x[0] for x in ranges), max(x[1] for x in ranges)))
            try:
                rows, names, evidence = read_once(config, start, end)
                refreshed = build_export(config['account_id'], config['group_id'], config['group_name'],
                                         start, end, rows, names, evidence)
                selected_ids = {m['platformMessageId'] for m in refresh_targets} if args.images_only else None
                by_id = {m['platformMessageId']: m for m in refreshed['messages']
                         if selected_ids is None or m['platformMessageId'] in selected_ids}
            except ArchiveError:
                if not args.images_only:
                    raise
        for message in messages:
            current = by_id.get(message['platformMessageId'])
            if current:
                for field in ('sender', 'timestamp', 'type', 'content'):
                    if current[field] != message[field]:
                        raise ArchiveError('补取时来源与归档消息不一致，已停止')
                message['_source'] = current['_source']
        module = load_upstream()
        try:
            key_info = module.extract_master_key_from_cfg(active_pid(config['pid']))
        except ArchiveError:
            if not args.images_only:
                raise
            key_info = None
        image_key = key_info[1] if key_info and key_info[2] == config['account_id'] else None
        key_info = None
        result = collect_resources(config['data_dir'], config, messages, image_key, max_seconds=450,
                                   images_only=args.images_only)
        client_error = None
        if args.client and not result['complete']:
            from .native_client import download_missing, ClientReadError
            try:
                download_missing(config, messages, image_key)
            except ClientReadError as exc:
                client_error = str(exc)
            result = collect_resources(config['data_dir'], config, messages, image_key, max_seconds=450)
        print(json.dumps({'status': 'imported' if result['complete'] else 'incomplete',
                          'resource_coverage': result, 'client_error': client_error}, ensure_ascii=False))
        return 0
    if args.command == 'find-groups':
        from .reader import find_groups
        print(json.dumps({'matches': find_groups(config, args.group_name)}, ensure_ascii=False))
        return 0
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
    end = int(time.time())
    explicit_start, explicit_end = getattr(args, 'start', None), getattr(args, 'end', None)
    if args.command in ('sync', 'collect'):
        if args.days is not None and not 1 <= args.days <= 365:
            raise ArchiveError("天数需在 1 到 365 之间")
        if explicit_start is not None or explicit_end is not None:
            if (args.days is not None or explicit_start is None or explicit_end is None
                    or not 0 <= explicit_start < explicit_end <= end):
                raise ArchiveError('读取范围无效')
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
    matching = [b for b in history if b["account_id"] == config["account_id"] and b["chat_id"] == config["group_id"]]
    start = end - (args.days or 3) * 86400
    if args.days is None and matching:
        start = max(b["end"] for b in matching) - 600
    if explicit_start is not None:
        start, end = explicit_start, explicit_end
    from .reader import collect as read_once
    began = time.monotonic()
    rows, names, evidence = read_once(config, start, end)
    from .cleanup import exclusions
    cleaned=exclusions(config['data_dir'])
    rows=[row for row in rows if not any(a<=row['create_time']<b for a,b in cleaned)]
    if not rows:
        print(json.dumps({"status": "no_messages", "start": start, "end": end}))
        return 0
    payload = build_export(config["account_id"], config["group_id"], config["group_name"], start, end, rows, names, evidence)
    path = save_export(batches, payload)
    receipt = import_export(config, path) if args.command == "sync" else None
    from .resources import collect_resources
    from .reader import active_pid, load_upstream
    # Keys stay in this short-lived process and never enter receipts or batches.
    image_key = None
    module = load_upstream()
    key_info = module.extract_master_key_from_cfg(active_pid(config['pid']))
    if key_info and key_info[2] == config['account_id']:
        image_key = key_info[1]
    key_info = None
    resource_coverage = collect_resources(config['data_dir'], config, payload['messages'], image_key, max_seconds=450)
    client_error = None
    if args.client and not resource_coverage['complete']:
        from .native_client import download_missing, ClientReadError
        try:
            download_missing(config, payload['messages'], image_key)
        except ClientReadError as exc:
            client_error = str(exc)
        resource_coverage = collect_resources(config['data_dir'], config, payload['messages'], image_key, max_seconds=450)
    image_key = None
    tz = timezone(timedelta(hours=8))
    print(json.dumps({"status": "imported" if receipt else "exported_pending_import", "import_receipt": receipt,
                      "resource_coverage": resource_coverage,
                      "client_error": client_error,
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
