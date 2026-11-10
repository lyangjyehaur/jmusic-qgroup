"""Separate administrator sessions; member accounts never imply admin access."""
import hashlib
import os
import secrets
from http import cookies
from . import accounts,identity,bot_settings
from .common import APIError,now

COOKIE='kanban_admin'


def session_hash(headers):
    try:
        jar=cookies.SimpleCookie(headers.get('Cookie',''))
        return hashlib.sha256(jar[COOKIE].value.encode()).hexdigest() if COOKIE in jar else ''
    except cookies.CookieError:return ''


def session(db,headers):
    digest=session_hash(headers)
    row=db.execute('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?',(digest,now())).fetchone()
    if not row:raise APIError('请先登录管理后台',401)
    # Rotating the configured credential revokes old admin sessions immediately.
    configured=os.environ.get('KANBAN_ADMIN_KEY_HASH','')
    if not configured or not secrets.compare_digest(row['credential_hash'],configured):raise APIError('管理凭证已变更，请重新登录',401)
    return digest


def csrf(digest):return hashlib.sha256(('kanban-admin-v1:'+digest).encode()).hexdigest()


def view(db,headers):
    from . import privacy
    digest=session(db,headers)
    return dict(authenticated=True,csrf=csrf(digest),settings=accounts.settings(db),providers=accounts.providers(),privacy_requests=privacy.queue(db),bot=bot_settings.view(db))


def bot_view(db,headers):
    session(db,headers)
    return bot_settings.view(db)


def login(db,data):
    configured=os.environ.get('KANBAN_ADMIN_KEY_HASH','')
    supplied=data.get('key')
    if not configured or not isinstance(supplied,str) or not 32<=len(supplied)<=256 or not secrets.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(),configured):
        raise APIError('管理凭证不正确',401)
    token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
    db.execute('DELETE FROM admin_sessions WHERE expires_at<=?',(now(),))
    db.execute('INSERT INTO admin_sessions VALUES(?,?,?,?)',(digest,configured,identity.expires(60),now()))
    return dict(ok=True),token


def command(db,headers,path,data):
    digest=session(db,headers)
    if not secrets.compare_digest(headers.get('X-Kanban-Admin',''),csrf(digest)):raise APIError('管理页面已过期，请刷新后重试',403)
    if path=='/api/admin/logout':
        db.execute('DELETE FROM admin_sessions WHERE token_hash=?',(digest,))
        return dict(ok=True),''
    if path=='/api/admin/privacy-review':
        from . import privacy
        return privacy.review(db,data),None
    if path=='/api/admin/bot-preview':
        return bot_settings.preview(db,data),None
    if path in ('/api/admin/bot-settings','/api/admin/bot-revert'):
        return bot_settings.save(db,data,digest,revert=path.endswith('bot-revert')),None
    if path!='/api/admin/settings':raise APIError('管理操作不存在',404)
    value=data.get('allow_name_registration');revision=data.get('base_revision')
    if type(value) is not bool or type(revision) is not int:raise APIError('注册设置格式不正确')
    current=accounts.settings(db)
    if revision!=current['revision']:raise APIError('注册设置已被其他管理页面修改，请刷新后重试',409)
    if current['allow_name_registration']!=value:
        db.execute('UPDATE site_settings SET allow_name_registration=?,revision=revision+1 WHERE id=1',(int(value),))
        db.execute('INSERT INTO admin_audit(action,before_value,after_value,created_at) VALUES(?,?,?,?)',
                   ('name_registration',int(current['allow_name_registration']),int(value),now()))
    return dict(ok=True,settings=accounts.settings(db)),None
