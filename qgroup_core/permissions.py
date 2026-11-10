"""Explicit event scopes; settlement authority is separately accepted."""
import json
from .common import APIError

SCOPES = {'schedule','roster','attendance','settlement'}


def scopes(db,event,viewer):
    if not viewer:
        return set()
    if event['owner_id']==viewer:
        return SCOPES | {'owner'}
    row=db.execute('SELECT permissions_json FROM event_roles WHERE event_id=? AND user_id=?',(event['id'],viewer)).fetchone()
    return set(json.loads(row[0])) if row else set()


def has(db,event,viewer,scope):
    return scope in scopes(db,event,viewer)


def can_assist_schedule(db,event,viewer):
    """Named site admins may help edit published arrangements, not gain cohost scopes."""
    if not viewer or event['lifecycle'] not in ('scheduled','ongoing') or event['archived_at']:
        return False
    return bool(db.execute('''SELECT 1 FROM user_admin_roles r WHERE r.user_id=? AND r.is_admin=1
        AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=r.user_id)''',(viewer,)).fetchone())


def require(db,event,viewer,scope):
    if not has(db,event,viewer,scope):
        raise APIError('没有这项活动管理权限',403)
