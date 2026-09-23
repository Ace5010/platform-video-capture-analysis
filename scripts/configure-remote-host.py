"""Local-only setup; no credential is accepted as a command-line argument."""

from __future__ import annotations

import getpass
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from host_service.config import HostConfig  # noqa: E402
from host_service.remote import RemoteConnection  # noqa: E402
from host_service.security import SecretStore  # noqa: E402


def main() -> None:
    config = HostConfig.from_env()
    public = json.loads((ROOT / "cloudflare-host.json").read_text(encoding="utf-8"))
    origin = str(public["publicOrigin"])
    tunnel_token = getpass.getpass("粘贴 Cloudflare Tunnel token（输入不显示；不是 API Key）：").strip()
    if not tunnel_token:
        raise RuntimeError("未输入隧道凭据，配置未修改")
    store = SecretStore(config.data_dir / "remote-connection.dpapi")
    # Validate with an isolated encrypted file before changing the live config.
    import tempfile
    from dataclasses import replace
    payload = {"origin": origin, "tunnelToken": tunnel_token}
    with tempfile.TemporaryDirectory(prefix="douyin-remote-config-") as directory:
        temporary_config = replace(config, data_dir=Path(directory))
        SecretStore(temporary_config.data_dir / "remote-connection.dpapi").save(payload)
        RemoteConnection.load(temporary_config)
    store.save(payload)
    print("远程连接已使用 Windows DPAPI 保存。确认电脑没有进行中的任务后重启工作台使其生效。")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f"远程连接配置未完成（{type(error).__name__}），未输出任何凭据。", file=sys.stderr)
        sys.exit(1)
