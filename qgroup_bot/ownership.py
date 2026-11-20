"""Local delivery-owner protocol shared with the native TypeScript entry point.

The persistent lock file is never removed or stolen. SQLite releases its OS
lock on close/crash; a different data directory/host is outside this protocol.
"""
import os
import sqlite3
import stat
from pathlib import Path
import threading

_active = set()
_active_inodes = set()
_guard = threading.Lock()


class BotPendingReview(RuntimeError):
    pass


class BotOwnership:
    def __init__(self, database):
        self.database = Path(database).resolve(strict=True)
        source = self.database.stat()
        if not stat.S_ISREG(source.st_mode) or source.st_nlink != 1:
            raise RuntimeError('Invalid bot database file')
        self.source_identity = (source.st_dev, source.st_ino)
        self.path = self.database.parent / '.bot-owner.sqlite3'
        self.identities = set()
        self.db = None
        with _guard:
            if str(self.path) in _active or self.source_identity in _active_inodes:
                raise RuntimeError('Bot ownership already held in this process')
            _active.add(str(self.path))
            _active_inodes.add(self.source_identity)
            self.identities.add(self.source_identity)
        try:
            self._acquire()
        except Exception:
            with _guard:
                _active.discard(str(self.path))
                _active_inodes.difference_update(self.identities)
            raise

    def _acquire(self):
        def metadata(path):
            try:
                return path.lstat()
            except FileNotFoundError:
                return None

        with _guard:
            # Keep creation/close and inode reservation under the same guard;
            # another thread must not acquire a newly created alias meanwhile.
            saved = metadata(self.path)
            if saved is None:
                try:
                    # O_EXCL guarantees a new inode. Existing SQLite/owner
                    # files are checked with metadata only.
                    fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                                 getattr(os, 'O_NOFOLLOW', 0), 0o600)
                    try:
                        saved = os.fstat(fd)
                    finally:
                        os.close(fd)
                except FileExistsError:
                    saved = metadata(self.path)
            if (saved is None or not stat.S_ISREG(saved.st_mode) or
                    saved.st_nlink != 1 or stat.S_IMODE(saved.st_mode) != 0o600 or
                    (saved.st_dev, saved.st_ino) in _active_inodes):
                raise RuntimeError('Invalid bot owner file')
            for suffix in ('-journal', '-wal', '-shm'):
                sidecar = metadata(Path(str(self.path) + suffix))
                if sidecar is not None and (not stat.S_ISREG(sidecar.st_mode) or
                        sidecar.st_nlink != 1 or
                        (sidecar.st_dev, sidecar.st_ino) in _active_inodes):
                    raise RuntimeError('Invalid bot owner sidecar')
            self.identity = (saved.st_dev, saved.st_ino)
            _active_inodes.add(self.identity)
            self.identities.add(self.identity)
        self.db = sqlite3.connect(str(self.path), timeout=0, isolation_level=None)
        try:
            self.db.execute('PRAGMA busy_timeout=0')
            self.db.execute('PRAGMA journal_mode=DELETE')
            self.db.execute('BEGIN EXCLUSIVE')
            self.check()
        except Exception:
            self.db.close()
            self.db = None
            with _guard:
                _active.discard(str(self.path))
                _active_inodes.difference_update(self.identities)
            raise RuntimeError('Bot ownership unavailable; another delivery owner or unsafe lock file') from None

    def check(self):
        if self.db is None:
            raise RuntimeError('Bot ownership closed')
        source = self.database.lstat()
        if (not stat.S_ISREG(source.st_mode) or source.st_nlink != 1 or
                (source.st_dev, source.st_ino) != self.source_identity):
            raise RuntimeError('Bot database file replaced')
        saved = self.path.lstat()
        if (not stat.S_ISREG(saved.st_mode) or saved.st_nlink != 1 or
                (saved.st_dev, saved.st_ino) != self.identity):
            raise RuntimeError('Bot ownership file replaced')

    def check_pending(self):
        # Unknown prior sending work must not be reclaimed automatically after
        # a crash or runtime switch. Keep all rows/attempts/cursors for review.
        with sqlite3.connect(self.database) as db:
            if db.execute("SELECT 1 FROM bot_outbox WHERE status='sending' LIMIT 1").fetchone():
                raise BotPendingReview('存在未核對的 sending 工作，請先離線核對投遞結果')

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
            with _guard:
                _active.discard(str(self.path))
                _active_inodes.difference_update(self.identities)
