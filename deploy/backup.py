#!/usr/bin/env python3
"""Consistent SQLite snapshot plus the immutable image files it references.

A completed pair is kanban-STAMP.sqlite3 + kanban-STAMP.images.tar.gz.
The database appears last, only after both files have been written successfully.
Legacy snapshots with no external assets remain usable on their own.
"""
from contextlib import closing
import hashlib
import io
import os
import sqlite3
import tarfile
import time
from datetime import datetime,timezone
from pathlib import Path


def backup(source,folder):
    folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    stem='kanban-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    target=folder/(stem+'.sqlite3');images=folder/(stem+'.images.tar.gz')
    temp=folder/(stem+'.sqlite3.tmp');archive=folder/(stem+'.images.tar.gz.tmp')
    try:
        with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as src,closing(sqlite3.connect(temp)) as dst:
            src.backup(dst)
            assert dst.execute('PRAGMA journal_mode=DELETE').fetchone()[0]=='delete'
            if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity check failed')
            assets=dst.execute('SELECT digest,size FROM image_assets').fetchall() if dst.execute("SELECT 1 FROM sqlite_master WHERE name='image_assets'").fetchone() else []
        with tarfile.open(archive,'w:gz',compresslevel=1) as bundle:
            for digest,size in assets:
                if len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):raise RuntimeError('Invalid asset index')
                relative=Path('images')/digest[:2]/(digest+'.png');path=source.parent/relative
                raw=path.read_bytes()
                if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('Backup image integrity check failed')
                info=tarfile.TarInfo(str(relative));info.size=len(raw);info.mode=0o600
                bundle.addfile(info,io.BytesIO(raw))
        temp.chmod(0o600);archive.chmod(0o600)
        for path in (temp,archive):
            with path.open('rb') as stream:os.fsync(stream.fileno())
        os.replace(archive,images);os.replace(temp,target)
        ledger=source.with_suffix('.erasures.jsonl')
        if ledger.exists():
            ledger_temp=folder/'privacy-erasures.jsonl.tmp'
            with ledger_temp.open('wb') as stream:
                stream.write(ledger.read_bytes());stream.flush();os.fsync(stream.fileno())
            ledger_temp.chmod(0o600)
            os.replace(ledger_temp,folder/'privacy-erasures.jsonl')
        descriptor=os.open(str(folder),os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
        ordered=sorted(folder.glob('kanban-*.sqlite3'),reverse=True)
        expired=[p for index,p in enumerate(ordered) if index>=14 or p.stat().st_mtime<time.time()-14*86400]
        for old in expired:
            companion=old.with_suffix('.images.tar.gz')
            old.unlink()
            if companion.exists():companion.unlink()
        return target,images,len(assets)
    finally:
        for path in (temp,Path(str(temp)+'-wal'),Path(str(temp)+'-shm'),archive):
            if path.exists():path.unlink()


if __name__=='__main__':
    source=Path('/var/lib/qgroup/kanban.sqlite3')
    for _ in range(20):
        if source.exists():break
        time.sleep(0.5)
    print('Saved database, images, asset count:',*backup(source,Path('/var/backups/qgroup')))
