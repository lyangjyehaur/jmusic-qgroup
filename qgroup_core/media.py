"""Private immutable content-addressed files. Database rows contain metadata only.

Files are durable before a reference commits, and are never removed in-place.
A rolled-back write may leave an unreachable file; it cannot expose an image or
break a committed reference. Backups copy only assets in their SQLite snapshot.
"""
import hashlib
import os
import re
import tempfile
from pathlib import Path
from .common import APIError,now


def root(db):
    path=next(row[2] for row in db.execute('PRAGMA database_list') if row[1]=='main')
    if not path:raise RuntimeError('Image storage requires a file-backed database')
    return Path(path).parent/'images'


def asset_path(folder,digest):
    if not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest):raise APIError('图片引用不正确')
    return folder/digest[:2]/(digest+'.png')


def put(db,raw):
    folder=root(db);folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    digest=hashlib.sha256(raw).hexdigest();target=asset_path(folder,digest)
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.exists():
        if target.read_bytes()!=raw:raise RuntimeError('Image storage integrity failure')
    else:
        fd,name=tempfile.mkstemp(prefix='.upload-',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(name,target)
            for parent in (target.parent,folder,folder.parent):
                directory=os.open(str(parent),os.O_RDONLY)
                try:os.fsync(directory)
                finally:os.close(directory)
        finally:
            if os.path.exists(name):os.unlink(name)
    db.execute('INSERT OR IGNORE INTO image_assets VALUES(?,?,?,?)',(digest,len(raw),'image/png',now()))
    return digest


def read(db,digest):
    if not db.execute('SELECT 1 FROM image_assets WHERE digest=?',(digest,)).fetchone():raise APIError('图片不存在',404)
    try:raw=asset_path(root(db),digest).read_bytes()
    except FileNotFoundError:raise APIError('图片暂时无法读取，请稍后重试',503)
    if hashlib.sha256(raw).hexdigest()!=digest:raise APIError('图片暂时无法读取，请稍后重试',503)
    return raw


def receipt(db,event_id,version,item_id):
    row=db.execute('SELECT digest FROM settlement_receipt_images WHERE event_id=? AND version=? AND item_id=?',(event_id,version,item_id)).fetchone()
    if row:return read(db,row[0])
    old=db.execute('SELECT image FROM settlement_receipts WHERE event_id=? AND version=? AND item_id=?',(event_id,version,item_id)).fetchone()
    return old[0] if old else None
