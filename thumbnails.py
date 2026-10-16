"""Small derived previews in app data, never copies or writes in the owner root."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def identity(s):
    return f'{s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}'


class ThumbnailCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.gate = threading.BoundedSemaphore(2)
        self.prune_lock = threading.Lock()
        self.last_prune = 0

    def get(self, fd, name, version):
        before = identity(os.fstat(fd))
        if version != before:
            raise ValueError('changed source')
        # All identities are re-opened with Root's no-follow boundary before cache lookup.
        key = hashlib.sha256(('thumb-v1:' + name + ':' + before).encode()).hexdigest()
        target = self.directory / (key + '.jpg')
        try:
            body = target.read_bytes()
            if len(body) <= 512 * 1024:
                return body, key
        except FileNotFoundError:
            pass
        if not self.gate.acquire(blocking=False):
            raise BlockingIOError('preview capacity')
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Decoder is a separate process with CPU/address-space/output/time budgets.
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('thumbnail_worker.py')), str(fd), Path(name).suffix.lower()],
                                    pass_fds=(fd,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=7, check=True)
            body = result.stdout
            if not body.startswith(b'\xff\xd8') or len(body) > 512 * 1024 or identity(os.fstat(fd)) != before:
                raise ValueError('preview unavailable')
            temp = self.directory / (key + '.' + str(threading.get_ident()) + '.tmp')
            try:
                temp.write_bytes(body)
                temp.replace(target)
            finally:
                temp.unlink(missing_ok=True)
            self.prune()
            return body, key
        except (subprocess.SubprocessError, OSError) as exc:
            raise ValueError('preview unavailable') from exc
        finally:
            self.gate.release()

    def prune(self):
        # A small bounded derived cache. No owner media paths are enumerated here.
        if not self.prune_lock.acquire(blocking=False):
            return
        try:
            self.last_prune = time.monotonic()
            entries = sorted(((p.stat().st_mtime, p.stat().st_size, p) for p in self.directory.glob('*.jpg')), reverse=True)
            total = 0
            for i, (_, size, p) in enumerate(entries):
                total += size
                if i >= 1024 or total > 64 * 1024 * 1024:
                    p.unlink(missing_ok=True)
        finally:
            self.prune_lock.release()
