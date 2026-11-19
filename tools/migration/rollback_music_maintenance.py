"""Explicit authority-aware offline maintenance for a private old music copy.

The original maintenance CLI writes its local ledger directly. Use this entry
when rehearsing with an authority; it never imports the HTTP service or starts
workers. Authority custody and fixed-image acceptance remain separate gates.
"""
import argparse
from contextlib import closing, contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat
import sqlite3
import sys

from music_site import maintenance
from music_site.identity_store import Store
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_history_runtime import _directory, _file, _json, KEY


class _ExistingStore(Store):
    def __init__(self, path):
        self.path = path

    def connect(self):
        db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        return db


@contextmanager
def _service_exclusion(folder, sqlite_identities):
    """Use the original service's flock inode, with private file validation."""
    identity = _directory(folder)
    path = folder / '.service.lock'
    if not path.exists() and not path.is_symlink():
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    else:
        before = path.lstat()
        if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1 or before.st_uid != os.getuid()
                or before.st_size != 0 or (before.st_dev, before.st_ino) in sqlite_identities):
            raise ValueError('Unsafe service lock')
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        held = os.fstat(fd)
        if (held.st_dev, held.st_ino) != (before.st_dev, before.st_ino):
            os.close(fd)
            raise ValueError('Service lock replaced before acquisition')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held = os.fstat(fd)

        def guard():
            current = path.lstat()
            if (_directory(folder) != identity or not stat.S_ISREG(current.st_mode)
                    or stat.S_IMODE(current.st_mode) != 0o600 or current.st_nlink != 1
                    or current.st_uid != os.getuid() or current.st_size != 0
                    or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino)):
                raise ValueError('Service exclusion changed')
        guard()
        yield guard
        guard()
    finally:
        os.close(fd)


def maintain_legacy_music_erasures(command, folder, authority_root, manifest_sha256, qq=None):
    if command not in ('erase', 'recover') or (command == 'erase' and (not isinstance(qq, str) or not KEY.fullmatch(qq))) or (command == 'recover' and qq is not None):
        raise ValueError('Explicit command and valid erasure key required')
    folder = Path(folder)
    if not folder.is_absolute():
        raise ValueError('Canonical private service folder required')
    _directory(folder)
    database = folder / 'identity.sqlite3'
    # lstat only: never open a second raw descriptor for SQLite while a process
    # holds SQLite locks. Store initialization is skipped for this existing copy.
    info = database.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.getuid() or info.st_nlink != 1 or database.resolve() != database):
        raise ValueError('Existing private identity database required')
    with closing(ErasureAuthority(authority_root, manifest_sha256,
            {'music': folder / 'erasures.jsonl'}, sqlite_files=[database])) as authority:
        authority.snapshot()  # Invalid authority must not create or migrate service data.
        with _service_exclusion(folder, authority.sqlite_identities) as service_guard:
            data, _ = _file(folder / 'data.json')
            value = _json(data)
            if not isinstance(value, dict) or not isinstance(value.get('members'), dict) or not isinstance(value.get('entries'), dict) or any(not isinstance(row, dict) for row in value['entries'].values()) or any(not isinstance(value.get(key, []), list) or any(not isinstance(row, dict) for row in value.get(key, [])) for key in ('shouts', 'shoutHistory')):
                raise ValueError('Original music replay input required')
            store = _ExistingStore(database)
            with closing(store.connect()) as db:
                if db.execute('PRAGMA integrity_check').fetchall()[0][0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
                    raise ValueError('Identity integrity rejected')
                for table in ('links', 'prelinks', 'sessions', 'link_overrides', 'link_audit', 'native_profiles', 'profile_contacts', 'entry_intents'):
                    db.execute('SELECT qq FROM ' + table + ' LIMIT 0')
            service_guard()
            authority.recover('music')
            with authority.guard('music'):
                service_guard()
                maintenance.replay(folder, store)
                service_guard()
            if command == 'erase':
                authority.record('music', (json.dumps({'qq': qq, 'erased_at': maintenance.time.time()}) + '\n').encode())
                with authority.guard('music'):
                    service_guard()
                    maintenance.replay(folder, store)
                    service_guard()
            head, _ = authority.snapshot()
            return dict(status='completed_private_music_' + command, records=head['sequence'], rollbackEligible=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['erase', 'recover'])
    parser.add_argument('--folder', required=True)
    parser.add_argument('--authority', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--qq')
    args = parser.parse_args()
    try:
        result = maintain_legacy_music_erasures(args.command, args.folder, args.authority, args.manifest_sha256, args.qq)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception:
        print('Private music maintenance rejected. Keep services stopped, preserve authority and service files, then recover before retrying.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
