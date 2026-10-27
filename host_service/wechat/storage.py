"""Bound new image storage across this archive's groups, without deleting data."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import threading
import time
from .archive import ArchiveError

MAX_ASSET_BYTES = 3_000_000_000
MIN_FREE_BYTES = 5_000_000_000
GUARD = threading.Lock()


def archive_root(root):
    root=Path(root).resolve()
    return root.parent.parent if root.parent.name=='groups' and root.name.startswith('group_') else root


@contextmanager
def allocation(root,size):
    root=archive_root(root);root.mkdir(parents=True,exist_ok=True)
    with GUARD, (root/'asset-write.lock').open('a+b') as lock:
        if lock.tell()==0:lock.write(b'0');lock.flush()
        if os.name=='nt':
            import msvcrt
            deadline=time.monotonic()+30
            while True:
                try:lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1);break
                except OSError:
                    if time.monotonic()>=deadline:raise ArchiveError('图片存储正在被使用，请稍后重试') from None
                    time.sleep(.05)
        try:
            folders=[root/'assets/blobs',*[p/'assets/blobs' for p in (root/'groups').glob('group_*') if not p.is_symlink()]]
            used=sum(p.stat().st_size for folder in folders for p in folder.glob('*') if p.is_file() and not p.is_symlink())
            if used+size>MAX_ASSET_BYTES or (size==0 and used>=MAX_ASSET_BYTES):raise ArchiveError('图片存储已达 3 GB 上限，请先按日期清理聊天记录')
            if shutil.disk_usage(root).free-size<MIN_FREE_BYTES:raise ArchiveError('磁盘剩余空间不足 5 GB，已停止新增图片，请先清理空间')
            yield
        finally:
            if os.name=='nt':lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
