#!/usr/bin/env python3
"""Rehearse any supported upgrade twice on an isolated copy; preserve every old value."""
import argparse
import hashlib
import tarfile
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qgroup_core import storage, roster, media


def quoted(name):
    return '"'+name.replace('"','""')+'"'


def snapshot(db):
    result={}
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        columns=[r[1] for r in db.execute('PRAGMA table_info('+quoted(table)+')')]
        rows=[tuple(row) for row in db.execute('SELECT '+','.join(map(quoted,columns))+' FROM '+quoted(table))]
        result[table]=(columns,rows)
    return result


def preserved(db,before):
    for table,(columns,rows) in before.items():
        actual=[tuple(r) for r in db.execute('SELECT '+','.join(map(quoted,columns))+' FROM '+quoted(table))]
        # Original rows must all survive byte-for-byte. Only migration bookkeeping can grow.
        if table=='schema_migrations':
            if not set(rows).issubset(set(actual)):
                raise AssertionError('Migration history changed')
        elif sorted(rows,key=repr)!=sorted(actual,key=repr):
            raise AssertionError('Original data changed: '+table)


def verify(source,destination):
    if source.resolve()==destination.resolve() or destination.exists():
        raise ValueError('Destination must be a new, isolated database path')
    original=sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)
    try:
        before=snapshot(original)
        with sqlite3.connect(destination) as copy:
            original.backup(copy)
    finally:
        original.close()
    storage.initialize(destination)
    with storage.connect(destination) as db:
        # Rehearsals/restores must carry immutable files as well as the SQL rows.
        # Accept either the original store or a paired daily backup archive.
        for digest,size in db.execute('SELECT digest,size FROM image_assets').fetchall():
            original_file=media.asset_path(source.parent/'images',digest)
            if original_file.exists():raw=original_file.read_bytes()
            else:
                with tarfile.open(source.with_suffix('.images.tar.gz')) as archive:
                    item=archive.extractfile('images/'+digest[:2]+'/'+digest+'.png')
                    if item is None:raise AssertionError('Backup image missing')
                    raw=item.read()
            if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=digest:raise AssertionError('Backup image corrupted')
            media.put(db,raw)
        preserved(db,before)
        first=snapshot(db)
    storage.initialize(destination)
    with storage.connect(destination) as db:
        # The second run cannot add or alter even migration-generated rows.
        preserved(db,first)
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise AssertionError('SQLite integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise AssertionError('Foreign key check failed')
        for user in db.execute('SELECT * FROM users'):
            session=db.execute('SELECT user_id FROM browser_sessions WHERE token_hash=?',(user['token_hash'],)).fetchone()
            if 'browser_accounts' not in before and (not session or session[0]!=user['id']):
                raise AssertionError('Original browser identity not preserved')
        if 'attendees' not in before:
            # Only pre-P1 sources derive their present roster from registrations.
            for event in db.execute('SELECT * FROM events').fetchall():
                legacy=db.execute('SELECT * FROM registrations WHERE event_id=? ORDER BY id',(event['id'],)).fetchall()
                migrated=[p for p in roster.rows(db,event['id']) if p['legacy_registration_id'] is not None]
                if len(legacy)!=len(migrated):raise AssertionError('Registration count changed')
                for index,(old,new) in enumerate(zip(legacy,migrated)):
                    status='confirmed' if event['capacity']==0 or index<event['capacity'] else 'waiting'
                    if (old['id'],old['user_id'],old['note'],old['created_at'],status)!=(new['legacy_registration_id'],new['user_id'],new['note'],new['created_at'],new['status']):
                        raise AssertionError('Legacy registration identity, order or allocation changed')
        if 'lifecycle' not in before.get('events',([],[]))[0]:
            if db.execute("SELECT 1 FROM events WHERE actual_started_at IS NOT NULL OR actual_ended_at IS NOT NULL OR timezone IS NOT NULL OR fee_policy!='' LIMIT 1").fetchone():
                raise AssertionError('Migration invented historical times or fee terms')
        versions={r[0] for r in db.execute('SELECT version FROM schema_migrations')}
        if not set(range(1,15)).issubset(versions):raise AssertionError('Migration versions missing')
        if 12 not in versions:raise AssertionError('UnionID migration missing')
    return {table:len(rows) for table,(_,rows) in before.items()}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('destination',type=Path)
    args=parser.parse_args()
    print('Migration rehearsal passed; preserved rows:',verify(args.source,args.destination))
