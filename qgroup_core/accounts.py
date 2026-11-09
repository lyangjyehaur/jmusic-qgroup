"""Site accounts and provider identities are independent of visitor sessions."""
import hashlib
import secrets
from urllib.parse import urlsplit
from . import identity
from .common import APIError, now, string


def visitor_scope(session):
    return hashlib.sha256(('kanban-visitor-v1:'+session).encode()).hexdigest()


def visitor_exists(db, session):
    return bool(session and db.execute('SELECT 1 FROM visitor_sessions WHERE token_hash=? AND expires_at>?', (session,now())).fetchone())


def ensure_visitor(db, session):
    if visitor_exists(db,session):return None
    token=secrets.token_urlsafe(32)
    db.execute('DELETE FROM visitor_sessions WHERE expires_at<=?',(now(),))
    db.execute('DELETE FROM auth_requests WHERE created_at<?',(identity.expires(-1440),))
    db.execute('INSERT INTO visitor_sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),identity.expires(1440),now()))
    return token


def settings(db):
    row=db.execute('SELECT allow_name_registration,revision FROM site_settings WHERE id=1').fetchone()
    return dict(allow_name_registration=bool(row[0]),revision=row[1])


def providers():
    # New providers add their own OAuth adapter. Never present an unimplemented
    # WeChat button or confuse app-specific OpenIDs from different providers.
    from . import qq_oauth
    return [dict(id='qq',name='QQ',enabled=bool(qq_oauth.config()))]


def create(db, nickname):
    uid=secrets.token_hex(16)
    db.execute('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)',
               (uid,secrets.token_hex(32),nickname,now()))
    return uid


def authenticate(db, session, uid, previous=None):
    """Rotate the cookie; preserve independent existing account grants."""
    token=secrets.token_urlsafe(32);new_hash=hashlib.sha256(token.encode()).hexdigest()
    db.execute('INSERT INTO browser_sessions VALUES(?,?,?)',(new_hash,uid,now()))
    db.execute('INSERT INTO browser_accounts SELECT ?,user_id,created_at FROM browser_accounts WHERE token_hash=?',(new_hash,session))
    for allowed in {uid,previous}-{None}:
        db.execute('INSERT OR IGNORE INTO browser_accounts VALUES(?,?,?)',(new_hash,allowed,now()))
    db.execute('DELETE FROM browser_sessions WHERE token_hash=?',(session,))
    db.execute('DELETE FROM visitor_sessions WHERE token_hash=?',(session,))
    return token


def register_name(db,session,data):
    from . import privacy
    if not settings(db)['allow_name_registration']:
        raise APIError('免第三方登录注册未开放，请使用 QQ 登录',403)
    if not visitor_exists(db,session):raise APIError('请刷新页面后重新注册',401)
    nickname=string(data,'nickname',24)
    if data.get('confirm') is not True:raise APIError('请确认创建免第三方登录账号')
    privacy.require_consent(data)
    uid=create(db,nickname)
    privacy.consent(db,uid)
    token=authenticate(db,session,uid)
    identity.account_log(db,{'id':uid},'name_registered',{})
    return dict(ok=True),token


def return_path(value):
    if value is None:return '/'
    if not isinstance(value,str) or len(value)>4096 or '\\' in value or any(ord(c)<32 for c in value):raise APIError('返回地址不正确')
    parsed=urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.path!='/' or parsed.fragment:raise APIError('返回地址不正确')
    return value


def external(db,provider,client_id,subject):
    return db.execute('SELECT * FROM external_identities WHERE provider=? AND client_id=? AND subject=?',
                      (provider,client_id,subject)).fetchone()


def linked(db,uid):
    return [dict(provider=r['provider'],display_name=r['display_name']) for r in db.execute(
        'SELECT provider,display_name FROM external_identities WHERE user_id=? ORDER BY provider,client_id',(uid,))]
