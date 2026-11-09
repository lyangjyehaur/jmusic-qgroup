"""Cohost scopes do not grant financial or ownership privileges."""
import json
from .common import APIError

SCOPES = {'schedule','roster','attendance'}


def scopes(db,event,viewer):
    if not viewer:
        return set()
    if event['owner_id']==viewer:
        return SCOPES | {'owner'}
    row=db.execute('SELECT permissions_json FROM event_roles WHERE event_id=? AND user_id=?',(event['id'],viewer)).fetchone()
    return set(json.loads(row[0])) if row else set()


def has(db,event,viewer,scope):
    return scope in scopes(db,event,viewer)


def require(db,event,viewer,scope):
    if not has(db,event,viewer,scope):
        raise APIError('没有这项活动管理权限',403)
