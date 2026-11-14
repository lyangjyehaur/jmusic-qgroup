"""Optional /music/ gateway. No changes to board data or OAuth credentials."""
import base64
import hashlib
import http.client
import json
import os
import re
from http.cookies import SimpleCookie, CookieError
from urllib.parse import urlsplit

from . import identity, qq_oauth
from .common import APIError, now


def serve(handler, connect):
    secret = os.environ.get('KANBAN_MUSIC_PROXY_KEY', '')
    if len(secret) < 32:
        raise APIError('成分站尚未开放', 404)
    parsed = urlsplit(handler.path)
    if parsed.path == '/music':
        handler.send_response(308)
        handler.send_header('Location', '/music/')
        handler.send_header('Content-Length', '0')
        handler.end_headers()
        return
    if (len(handler.path) > 8192 or not re.fullmatch(r'/music/[A-Za-z0-9_./-]*', parsed.path)
            or '..' in parsed.path or '//' in parsed.path):
        raise APIError('成分站路径不正确', 400)
    if handler.command not in ('GET', 'HEAD', 'POST'):
        raise APIError('成分站不支持此操作', 405)
    body = None
    if handler.command == 'POST':
        handler.check_write()
        if handler.headers.get_content_type() != 'application/json':
            raise APIError('请求格式不正确', 415)
        try:
            length = int(handler.headers.get('Content-Length', '0'))
        except ValueError:
            raise APIError('请求格式不正确') from None
        if not 0 < length <= 65536:
            raise APIError('请求内容过大或为空', 413)
        body = handler.rfile.read(length)
    context = {'session': identity.session_hash(handler.headers)}
    with connect() as db:
        user, _ = handler.identity(db)
        settings = qq_oauth.config()
        if user:
            context['user_id'] = user['id']
        if user and settings:
            external = db.execute("SELECT client_id,subject FROM external_identities WHERE provider='qq' AND client_id=? AND user_id=?",
                                  (settings['app_id'], user['id'])).fetchone()
            if external:
                context.update(user_id=user['id'], app_id=external['client_id'], openid=external['subject'])
                # The legacy session must precede this exact, completed QQ login.
                attempt = db.execute("""SELECT id,token_hash FROM login_attempts WHERE provider='qq'
                    AND app_id=? AND openid=? AND status='used' AND expires_at>?
                    AND return_path='/music/' ORDER BY created_at DESC,rowid DESC LIMIT 1""",
                    (external['client_id'], external['subject'], now())).fetchone()
                if attempt:
                    context.update(oauth_attempt=attempt['id'], oauth_source=attempt['token_hash'])
    headers = {'X-Music-Proxy-Key': secret,
               'X-Music-Identity': base64.urlsafe_b64encode(json.dumps(context).encode()).decode(),
               'X-Real-IP': handler.headers.get('X-Real-IP', handler.client_address[0])
                   if handler.client_address[0] in ('127.0.0.1', '::1') else handler.client_address[0]}
    # Never pass board/admin cookies, client-supplied identity, or bearer credentials.
    try:
        jar = SimpleCookie(handler.headers.get('Cookie', ''))
        if 'music_session' in jar:
            headers['Cookie'] = 'music_session=' + jar['music_session'].value
    except CookieError:
        pass
    for key in ('Accept', 'Content-Type', 'If-None-Match', 'Accept-Encoding', 'Origin', 'Sec-Fetch-Site'):
        if handler.headers.get(key):
            headers[key] = handler.headers[key]
    upstream = http.client.HTTPConnection('127.0.0.1', int(os.environ.get('KANBAN_MUSIC_PORT', '8788')), timeout=8)
    try:
        path = parsed.path[len('/music'):] + ('?' + parsed.query if parsed.query else '')
        upstream.request(handler.command, path, body=body, headers=headers)
        response = upstream.getresponse()
        payload = response.read(4 * 1024 * 1024 + 1)
        if len(payload) > 4 * 1024 * 1024:
            raise OSError('upstream response limit')
        handler.send_response(response.status)
        allowed = {'content-type', 'content-encoding', 'etag', 'vary', 'cache-control', 'content-security-policy',
                   'x-content-type-options', 'referrer-policy', 'x-frame-options'}
        for key, value in response.getheaders():
            if key.lower() in allowed:
                handler.send_header(key, value)
            elif key.lower() == 'set-cookie' and value.startswith('music_session='):
                handler.send_header(key, value)
        handler.send_header('Content-Length', str(len(payload)))
        handler.end_headers()
        if handler.command != 'HEAD':
            handler.wfile.write(payload)
    except (OSError, http.client.HTTPException):
        raise APIError('成分站暂时无法连接，请稍后重试', 503) from None
    finally:
        upstream.close()
