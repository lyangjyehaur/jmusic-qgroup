"""QQ server-side OAuth. Verify first; explicitly bind or switch in a second step.

Access tokens and App Key never enter the browser or database. OpenID is scoped
to the app; a QQ nickname is display data, never proof of another account.
"""
import hashlib
import json
import os
import re
import secrets
from urllib import request, error
from urllib.parse import urlencode, urlsplit

from . import identity, accounts, privacy
from .common import APIError, now

CALLBACK = '/auth/qq/callback'
GRAPH = 'https://graph.qq.com'


def config():
    app_id = os.environ.get('KANBAN_QQ_APP_ID', '').strip()
    key = os.environ.get('KANBAN_QQ_APP_KEY', '').strip()
    origin = os.environ.get('KANBAN_ORIGIN', '').rstrip('/')
    redirect = os.environ.get('KANBAN_QQ_REDIRECT_URI', origin + CALLBACK)
    site = urlsplit(origin)
    if (not re.fullmatch(r'[0-9]+', app_id) or not key or
            not site.hostname or site.username or site.password or site.path or
            site.query or site.fragment or
            (site.scheme != 'https' and not (site.scheme == 'http' and site.hostname in ('localhost', '127.0.0.1'))) or
            redirect != origin + CALLBACK):
        return None
    return dict(app_id=app_id, key=key, redirect=redirect)


def required():
    value = config()
    if not value:
        raise APIError('QQ 登录尚未配置，请继续使用原浏览器或设备连接', 503)
    return value


def summary(db, user):
    settings = config()
    bound = db.execute("SELECT display_name AS nickname FROM external_identities WHERE provider='qq' AND user_id=? AND client_id=?",
                       (user['id'], settings['app_id'])).fetchone() if settings and user else None
    profile=db.execute("SELECT avatar_url FROM external_profiles WHERE provider='qq' AND client_id=? AND user_id=?",(settings['app_id'],user['id'])).fetchone() if bound else None
    return dict(enabled=bool(settings), bound=bool(bound), nickname=bound['nickname'] if bound else '',avatar_url=avatar(profile[0]) if profile else '')


def start(db, user, session, data):
    settings = required()
    mode = data.get('mode')
    if mode not in ('bind', 'login') or data.get('confirm') is not True:
        raise APIError('请选择并确认绑定当前账号或使用 QQ 登录')
    if mode=='bind' and not user:raise APIError('请先登录后再绑定第三方账号',401)
    destination=accounts.return_path(data.get('return_path'))
    if not privacy.accepted(db,user):privacy.require_consent(data)
    state = secrets.token_urlsafe(32)
    # New attempts supersede earlier tabs on this device. Keep failures briefly
    # for a useful return message, then remove expired authorization metadata.
    db.execute('DELETE FROM login_attempts WHERE expires_at<=?', (now(),))
    db.execute("UPDATE login_attempts SET status='failed' WHERE token_hash=? AND status IN ('pending','exchanging','verified')", (session,))
    db.execute('''INSERT INTO login_attempts
        (id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,return_path,privacy_version)
        VALUES(?,?,?,'qq',?,?,'pending',?,?,?,?)''',
        (hashlib.sha256(state.encode()).hexdigest(), session, user['id'] if user else None, settings['app_id'], mode, identity.expires(10), now(),destination,privacy.VERSION))
    return dict(authorize_url=GRAPH + '/oauth2.0/authorize?' + urlencode(dict(
        response_type='code', client_id=settings['app_id'], redirect_uri=settings['redirect'],
        state=state, scope='get_user_info')))


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def graph(path, parameters):
    # Never follow a redirect carrying credentials; never surface remote errors
    # or exception URLs (which include the App Key / access token).
    try:
        req = request.Request(GRAPH + path + '?' + urlencode(parameters), headers={'Accept': 'application/json'})
        with request.build_opener(NoRedirect()).open(req, timeout=8) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        value = json.loads(raw.decode('utf-8'))
        if not isinstance(value, dict) or 'error' in value or ('ret' in value and value['ret'] != 0):
            raise ValueError()
        return value
    except (error.URLError, OSError, ValueError, UnicodeError):
        raise APIError('QQ 授权暂时未能完成，可能受应用审核或接口权限限制，请稍后重新尝试', 502) from None


def avatar(value):
    if not isinstance(value,str) or len(value)>2048 or any(ord(c)<32 for c in value):return ''
    try:
        parsed=urlsplit(value)
        host=parsed.hostname or ''
        if parsed.scheme not in ('http','https') or parsed.username or parsed.password or parsed.port or parsed.fragment or not (host=='qlogo.cn' or host.endswith('.qlogo.cn')):return ''
        return parsed._replace(scheme='https').geturl()
    except ValueError:return ''


def exchange(settings, code):
    token = graph('/oauth2.0/token', dict(grant_type='authorization_code', client_id=settings['app_id'],
        client_secret=settings['key'], code=code, redirect_uri=settings['redirect'], fmt='json'))
    access = token.get('access_token')
    if not isinstance(access, str) or not re.fullmatch(r'[a-fA-F0-9]{32}|[a-fA-F0-9]{36}', access):
        raise APIError('QQ 授权令牌无效，请重新登录', 502)
    subject = graph('/oauth2.0/me', dict(access_token=access, fmt='json'))
    openid = subject.get('openid')
    if str(subject.get('client_id')) != settings['app_id'] or not isinstance(openid, str) or not re.fullmatch(r'[a-fA-F0-9]{32}|[a-fA-F0-9]{36}', openid):
        raise APIError('QQ 授权身份不匹配，请重新登录', 502)
    profile = graph('/user/get_user_info', dict(access_token=access, oauth_consumer_key=settings['app_id'], openid=openid))
    nickname = profile.get('nickname')
    if profile.get('ret') != 0 or not isinstance(nickname, str) or not nickname.strip() or len(nickname) > 200:
        raise APIError('QQ 用户资料暂时无法读取，请重新登录', 502)
    return openid.upper(), nickname.strip(), avatar(profile.get('figureurl_qq_2')) or avatar(profile.get('figureurl_qq_1'))


def claim_callback(db, user, session, query):
    settings = required()
    values = query.get('state', [])
    if len(values) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{43}', values[0]):
        raise APIError('QQ 授权已失效，请从看板重新发起登录', 400)
    attempt = db.execute('''SELECT * FROM login_attempts WHERE id=? AND token_hash=? AND user_id IS ? AND provider='qq'
        AND app_id=? AND status='pending' AND expires_at>?''',
        (hashlib.sha256(values[0].encode()).hexdigest(), session, user['id'] if user else None, settings['app_id'], now())).fetchone()
    if not attempt:
        raise APIError('QQ 授权已失效、使用或浏览器账号已改变，请重新登录', 409)
    db.execute("UPDATE login_attempts SET status='exchanging' WHERE id=?", (attempt['id'],))
    return attempt, settings


def callback(connect, user, session, query):
    # Consume before network I/O; replay cannot trigger another token exchange.
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        attempt, settings = claim_callback(db, user, session, query)
    try:
        codes = query.get('code', [])
        if 'error' in query or len(codes) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,512}', codes[0]):
            raise APIError('QQ 授权未完成或已取消，请重新尝试')
        openid, nickname, avatar_url = exchange(settings, codes[0])
    except APIError:
        with connect() as db:
            db.execute("UPDATE login_attempts SET status='failed' WHERE id=? AND status='exchanging'", (attempt['id'],))
        return
    with connect() as db:
        # A newer authorization or changed account invalidates this result.
        db.execute("""UPDATE login_attempts SET status='verified',openid=?,nickname=?,avatar_url=?
            WHERE id=? AND status='exchanging' AND expires_at>?
            AND (EXISTS(SELECT 1 FROM browser_sessions WHERE token_hash=? AND user_id IS ?) OR EXISTS(SELECT 1 FROM visitor_sessions WHERE token_hash=? AND expires_at>?))""",
            (openid, nickname, avatar_url, attempt['id'], now(), session, user['id'] if user else None,session,now()))


def status(db, user, session):
    settings = required()
    row = db.execute('''SELECT * FROM login_attempts WHERE token_hash=? AND user_id IS ? AND provider='qq' AND app_id=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1''', (session, user['id'] if user else None, settings['app_id'])).fetchone()
    if not row or row['expires_at'] <= now():
        return dict(status='expired')
    if row['status'] != 'verified':
        return dict(status=row['status'])
    target = db.execute("SELECT u.id,u.nickname FROM external_identities q JOIN users u ON u.id=q.user_id WHERE q.provider='qq' AND q.client_id=? AND q.subject=?",
                        (row['app_id'], row['openid'])).fetchone()
    return dict(status='verified', attempt_id=row['id'], mode=row['mode'], qq_nickname=row['nickname'],avatar_url=avatar(row['avatar_url']),
                current_nickname=user['nickname'] if user else '', target_nickname=target['nickname'] if target else '',
                existing_account=bool(target),
                conflict=bool(row['mode'] == 'bind' and target and target['id'] != (user['id'] if user else None)))


def finish(db, user, session, data):
    settings = required()
    if data.get('confirm') is not True:
        raise APIError('请确认 QQ 身份及账号操作')
    if not isinstance(data.get('attempt_id'), str) or not re.fullmatch(r'[a-f0-9]{64}', data['attempt_id']):
        raise APIError('QQ 授权结果标识不正确')
    row = db.execute('''SELECT * FROM login_attempts WHERE id=? AND token_hash=? AND user_id IS ? AND provider='qq' AND app_id=?
        AND status='verified' AND expires_at>?''',
        (data.get('attempt_id'), session, user['id'] if user else None, settings['app_id'], now())).fetchone()
    if not row:
        raise APIError('QQ 授权结果已失效或使用，请重新登录', 409)
    if row['privacy_version']!=privacy.VERSION:raise APIError('隐私政策已更新，请重新发起 QQ 登录',409)
    target = db.execute("SELECT user_id FROM external_identities WHERE provider='qq' AND client_id=? AND subject=?", (row['app_id'], row['openid'])).fetchone()
    uid = target['user_id'] if target else None
    if row['mode'] == 'bind':
        if not user:raise APIError('请先登录后再绑定第三方账号',401)
        if uid and uid != user['id']:
            raise APIError('这个 QQ 已绑定其他账号，请使用 QQ 登录；原报名与款项不会合并', 409)
        bound = db.execute("SELECT subject AS openid FROM external_identities WHERE provider='qq' AND client_id=? AND user_id=?", (row['app_id'], user['id'])).fetchone()
        if bound and bound['openid'] != row['openid']:
            raise APIError('当前账号已绑定另一个 QQ，不能直接替换', 409)
        uid = user['id']
    elif not uid:
        uid = accounts.create(db,row['nickname'][:24])
    if not target:
        db.execute("INSERT INTO external_identities VALUES('qq',?,?,?,?,?)", (row['app_id'], row['openid'], uid, row['nickname'], now()))
    else:
        db.execute("UPDATE external_identities SET display_name=? WHERE provider='qq' AND client_id=? AND subject=?", (row['nickname'], row['app_id'], row['openid']))
    db.execute("INSERT OR REPLACE INTO external_profiles VALUES('qq',?,?,?)",(row['app_id'],uid,avatar(row['avatar_url'])))
    privacy.consent(db,uid)
    token=accounts.authenticate(db,session,uid,user['id'] if user else None)
    db.execute("UPDATE login_attempts SET status='used' WHERE id=?", (row['id'],))
    identity.account_log(db, {'id': uid}, 'qq_bound' if row['mode'] == 'bind' else 'qq_login', dict(previous_scope=identity.scope(user['id']) if user else None))
    return dict(ok=True, switched=not user or uid != user['id'],new_account=not target and row['mode']=='login',return_path=row['return_path']), token
