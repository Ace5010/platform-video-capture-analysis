"""Existing private data and installed CLI runtimes stay in place."""
import os
from pathlib import Path


def runtime_root():
    return Path(os.environ.get('OBSERVE_WECHAT_RUNTIME_ROOT') or
                Path(__file__).resolve().parents[3] / 'WeChat-Reader').resolve()


def data_root():
    return Path(os.environ.get('OBSERVE_WECHAT_DATA_DIR') or runtime_root() / 'private').resolve()
