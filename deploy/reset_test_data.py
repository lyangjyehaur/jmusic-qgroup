#!/usr/bin/env python3
"""Archive an explicitly disposable pre-launch dataset while the service is stopped.

Does not initialize/migrate as root. The service creates the fresh database on
its next start. Retains the old SQLite, WAL, SHM and paired images for recovery.
"""
import argparse
from pathlib import Path
import shutil
import socket


def archive_test_data(database,destination,port=8791):
    database=database.resolve();destination=destination.resolve()
    if destination.exists() or destination==database.parent or database.parent in destination.parents:
        raise ValueError('Archive must be a new directory outside the live state directory')
    with socket.socket() as connection:
        connection.settimeout(1)
        if connection.connect_ex(('127.0.0.1',port))==0:
            raise RuntimeError('Stop the application before archiving test data')
    if not database.is_file():raise ValueError('Test database does not exist')
    sources=[p for p in [database,Path(str(database)+'-wal'),Path(str(database)+'-shm'),database.parent/'images'] if p.exists()]
    destination.mkdir(parents=True,mode=0o700)
    moved=[]
    try:
        for source in sources:
            shutil.move(str(source),str(destination/source.name));moved.append(source)
    except Exception:
        for source in reversed(moved):shutil.move(str(destination/source.name),str(source))
        raise
    return [source.name for source in moved]


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True)
    parser.add_argument('--confirm-test-data',action='store_true',required=True)
    args=parser.parse_args()
    print('Archived test dataset:',archive_test_data(args.database,args.archive))
