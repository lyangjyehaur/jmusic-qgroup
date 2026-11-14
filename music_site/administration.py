"""Legacy management functions with board authority and durable music storage."""
import copy
import json
import os
from pathlib import Path
import re
import shutil

from . import upstream
from .identity_store import Rejected
from .maintenance import record_erasures, replay, sanitize


def configure_walls(folder):
    target=Path(folder)/'walls'
    if not target.exists():
        temporary=Path(folder)/'.walls-init'
        if temporary.exists():shutil.rmtree(temporary)
        shutil.copytree(Path(upstream.PUBLIC)/'walls',temporary)
        for path in temporary.rglob('*'):path.chmod(0o700 if path.is_dir() else 0o600)
        temporary.chmod(0o700);os.replace(temporary,target)
    upstream.WALLS_DIR=str(target)
    upstream.WALLS_MANIFEST=str(target/'manifest.json')
    upstream.WALL_MAX_BYTES=2*1024*1024
    upstream.WALL_EXTS={'png':'png','jpeg':'jpg','jpg':'jpg','webp':'webp'}


def snapshot(folder, name=None):
    folder=Path(folder)
    if name is None:
        data=copy.deepcopy(upstream.data)
    else:
        if not re.fullmatch(r'[0-9]{8}-[0-9]{6}',name):raise Rejected('备份名称不正确',400)
        source=folder/'paired-backups'/name/'data.json'
        if not source.is_file():raise Rejected('备份不存在',404)
        data=json.loads(source.read_text())
    ledger=folder/'erasures.jsonl'
    if ledger.exists():sanitize(data,{json.loads(line)['qq'] for line in ledger.read_text().splitlines() if line.strip()})
    data.get('settings',{}).pop('adminPasswordHash',None)
    return data


def erase(folder, store, body, reset=False):
    qq=body.get('qq')
    if body.get('confirm')!=('RESET' if reset else 'DELETE'):raise Rejected('请先输入确认文字',400)
    if not reset and (not isinstance(qq,str) or qq not in upstream.data['members']):raise Rejected('成分会员不存在',404)
    name=upstream.data['members'].get(qq,{}).get('name','')
    record_erasures(folder,list(upstream.data['members']) if reset else [qq])
    replay(folder,store);upstream.load()
    if reset:upstream.data.update(entries={},members={},shouts=[],shoutHistory=[],trend=[])
    upstream.save()
    return dict(ok=True,qq=qq,deletedName=name,total=len(upstream.data['members']))
