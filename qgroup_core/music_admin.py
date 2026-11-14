"""Private music management bridge; board administrator auth stays on the board."""
import base64
import http.client
import json
import os

from . import admin
from .common import APIError


def request(access, body):
    key=os.environ.get('KANBAN_MUSIC_PROXY_KEY','')
    if len(key)<32:raise APIError('成分站尚未开放',404)
    actor='account:'+access['user_id'] if access['user_id'] else 'credential:'+access['digest']
    context=base64.urlsafe_b64encode(json.dumps({'admin_actor':actor}).encode()).decode()
    connection=http.client.HTTPConnection('127.0.0.1',int(os.environ.get('KANBAN_MUSIC_PORT','8788')),timeout=8)
    try:
        connection.request('POST','/api/internal/admin-links',body=json.dumps(body).encode(),headers={
            'X-Music-Proxy-Key':key,'X-Music-Identity':context,'Content-Type':'application/json',
            'Origin':os.environ.get('KANBAN_ORIGIN','https://kanban.danndann.cn')})
        response=connection.getresponse();raw=response.read(1024*1024+1)
        if len(raw)>1024*1024:raise ValueError()
        result=json.loads(raw)
        if not isinstance(result,dict):raise ValueError()
        if response.status!=200:raise APIError(result.get('error','成分站操作失败'),response.status)
        return result
    except (OSError,ValueError,http.client.HTTPException):
        raise APIError('成分站暂时无法连接，请稍后重试',503) from None
    finally:connection.close()


def view(db, headers):
    result=request(admin.authority(db,headers),{'action':'list'})
    for member in result['members']:
        uid=member['user_id']
        row=db.execute('''SELECT nickname FROM users WHERE id=?
            AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=?)''',(uid,uid)).fetchone() if uid else None
        member['board_name']=row['nickname'] if row else ''
        member['board_active']=bool(row)
    for item in result['history']:
        actor=item.pop('actor')
        row=db.execute('SELECT nickname FROM users WHERE id=?',(actor.removeprefix('account:'),)).fetchone() if actor.startswith('account:') else None
        item['actor_name']=row['nickname'] if row else '管理员'
    return result


def change(db,access,data):
    qq=data.get('qq');uid=data.get('user_id');revision=data.get('base_revision')
    if not all(isinstance(value,str) for value in (qq,uid,revision)) or len(qq)>12 or len(uid)>100 or len(revision)!=64:
        raise APIError('成分站关联格式不正确')
    if uid and not db.execute('''SELECT 1 FROM users WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=?)''',(uid,uid)).fetchone():
        raise APIError('账号不存在或已注销',404)
    return request(access,dict(action='change',qq=qq,user_id=uid,base_revision=revision))
