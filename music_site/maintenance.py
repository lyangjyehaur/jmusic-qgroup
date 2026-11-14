"""Private paired backups and offline deletion with a durable replay ledger."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

from .identity_store import Store


def service_lock(folder):
    lock=open(Path(folder)/'.service.lock','a')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('Stop the music container before offline maintenance') from None
    return lock


def replay(folder, store):
    folder=Path(folder)
    ledger=folder/'erasures.jsonl'
    if not ledger.exists(): return
    erased={json.loads(line)['qq'] for line in ledger.read_text().splitlines() if line.strip()}
    data=json.loads((folder/'data.json').read_text())
    for qq in erased: data['members'].pop(qq,None)
    for entry in data['entries'].values():
        if str(entry.get('createdBy') or '') in erased: entry['createdBy']=''
    for key in ('shouts','shoutHistory'):
        data[key]=[item for item in data.get(key,[]) if str(item.get('qq') or '') not in erased]
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        for qq in erased:
            for table in ('links','prelinks','sessions'):
                db.execute('DELETE FROM '+table+' WHERE qq=?',(qq,))
    temporary=folder/'data.json.tmp'
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=1));temporary.chmod(0o600)
    os.replace(temporary,folder/'data.json')


def backup_pair(folder, store):
    folder=Path(folder);root=folder/'paired-backups'
    root.mkdir(mode=0o700,exist_ok=True)
    stamp=time.strftime('%Y%m%d-%H%M%S',time.gmtime())
    temporary=root/('.'+stamp+'.tmp')
    if temporary.exists(): shutil.rmtree(temporary)
    temporary.mkdir(mode=0o700)
    shutil.copyfile(folder/'data.json',temporary/'data.json')
    with store.connect() as source, sqlite3.connect(temporary/'identity.sqlite3') as target:
        source.backup(target)
    if (folder/'erasures.jsonl').exists(): shutil.copyfile(folder/'erasures.jsonl',temporary/'erasures.jsonl')
    for path in temporary.iterdir(): path.chmod(0o600)
    target=root/stamp
    if target.exists(): shutil.rmtree(target)
    os.replace(temporary,target)
    backups=sorted(path for path in root.iterdir() if path.is_dir() and not path.name.startswith('.'))
    for index,path in enumerate(backups):
        if index<len(backups)-30 or path.stat().st_mtime<time.time()-14*86400: shutil.rmtree(path)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['erase'])
    parser.add_argument('--folder',default='/data')
    parser.add_argument('--qq',required=True)
    args=parser.parse_args()
    folder=Path(args.folder)
    lock=service_lock(folder)
    try:
        store=Store(folder/'identity.sqlite3')
        with open(folder/'erasures.jsonl','a') as ledger:
            os.chmod(ledger.name,0o600)
            ledger.write(json.dumps({'qq':args.qq,'erased_at':time.time()})+'\n')
            ledger.flush();os.fsync(ledger.fileno())
        replay(folder,store)
        print('Deletion recorded and replayed. Keep the ledger when restoring backups.')
    finally:
        lock.close()


if __name__=='__main__': main()
