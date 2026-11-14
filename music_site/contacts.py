"""Self-reported lookup/contact numbers never grant ownership of a profile."""
import re
import sqlite3
import time

from .identity_store import Rejected


def normalize(value):
    if not isinstance(value,str):raise Rejected('QQ 号格式不正确',400)
    value=value.strip()
    if value and not re.fullmatch(r'[1-9][0-9]{3,11}',value):
        raise Rejected('QQ 号需为 4–12 位数字，或留空',400)
    return value


def number(data, mid):
    return mid if re.fullmatch(r'[0-9]{4,12}',mid) else data['members'].get(mid,{}).get('contactQQ','')


def validate(data, store, mid, value):
    value=normalize(value)
    if re.fullmatch(r'[0-9]{4,12}',mid) and value!=mid:
        raise Rejected('旧站 QQ 是原资料的查询标识，更正请联系管理员',409)
    if value:
        if any(other!=mid and (other==value or number(data,other)==value) for other in data['members']):
            raise Rejected('此 QQ 号已有成分资料，请用旧口令找回或联系管理员，不能直接认领或覆盖',409)
        with store.connect() as db:
            if db.execute('SELECT 1 FROM profile_contacts WHERE number=? AND qq!=?',(value,mid)).fetchone():
                raise Rejected('此 QQ 号已被其他成分使用，请联系管理员核对',409)
    return value


def save(data, store, mid, value):
    value=validate(data,store,mid,value)
    if re.fullmatch(r'[0-9]{4,12}',mid):return
    try:
        with store.connect() as db:
            db.execute('INSERT INTO profile_contacts VALUES(?,?,?) ON CONFLICT(qq) DO UPDATE SET number=excluded.number,updated=excluded.updated',
                       (mid,value,time.time()))
    except sqlite3.IntegrityError:
        raise Rejected('此 QQ 号已被其他成分使用，请联系管理员核对',409) from None
    project(data,store)


def project(data, store):
    with store.connect() as db:
        for row in db.execute('SELECT qq,number FROM profile_contacts'):
            if row['qq'] in data['members']:data['members'][row['qq']]['contactQQ']=row['number']


def resolve(data, value):
    if value in data['members']:return value
    return next((mid for mid in data['members'] if value and number(data,mid)==value),value)


def payload(data, value):
    if isinstance(value,list):return [payload(data,item) for item in value]
    if not isinstance(value,dict):return value
    result={key:payload(data,item) for key,item in value.items()}
    mid=value.get('qq')
    if isinstance(mid,str) and mid in data['members']:
        result['contactQQ']=number(data,mid)
        result['contactQQSource']='legacy' if re.fullmatch(r'[0-9]{4,12}',mid) else 'self_reported' if result['contactQQ'] else ''
    return result
