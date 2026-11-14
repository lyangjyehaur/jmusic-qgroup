"""Run the pinned music site behind the board's optional /music/ gateway."""
import base64
import hmac
import json
import os
import re
import threading
import time
from http.cookies import SimpleCookie, CookieError
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from . import upstream
from .identity_store import Store, Rejected
from .maintenance import service_lock, replay, backup_pair
from . import admin_links

STORE = None
ORIGIN = os.environ.get('KANBAN_ORIGIN', 'https://kanban.danndann.cn')
LEGACY_BOARD_MAP = upstream.board_member_map


def board_member_map():
    result = LEGACY_BOARD_MAP()
    with STORE.connect() as db:
        overridden={row['qq'] for row in db.execute('SELECT qq FROM link_overrides')}
        result={uid:qq for uid,qq in result.items() if qq not in overridden}
        for table in ('prelinks', 'links'):
            for row in db.execute('SELECT qq,user_id FROM '+table):
                if row['qq'] in upstream.data['members']:
                    result[row['user_id']] = row['qq']
    return result


class Handler(upstream.Handler):
    timeout = 15

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        super().end_headers()

    def context(self):
        key = os.environ.get('KANBAN_MUSIC_PROXY_KEY', '')
        if len(key) < 32 or not hmac.compare_digest(self.headers.get('X-Music-Proxy-Key', ''), key):
            raise Rejected('此服务仅接受看板入口', 403)
        try:
            context = json.loads(base64.urlsafe_b64decode(self.headers.get('X-Music-Identity', '')))
            if not isinstance(context, dict):
                raise ValueError()
            return context
        except (ValueError, TypeError):
            raise Rejected('登录状态无效', 403) from None

    def token(self):
        try:
            jar = SimpleCookie(self.headers.get('Cookie', ''))
            return jar['music_session'].value if 'music_session' in jar else ''
        except CookieError:
            return ''

    def current_qq(self, context):
        linked = STORE.linked_qq(context)
        if linked:
            return linked
        session = STORE.session(self.token())
        # Once connected, a short legacy PIN cannot act as an alternative login.
        if session and not STORE.link_for_qq(session['qq']):
            return session['qq']
        return ''

    def json_reply(self, value, status=200, token=None):
        if token is None:
            return self.send_json(value, status)
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        secure = '; Secure' if os.environ.get('KANBAN_SECURE_COOKIE', '1') == '1' else ''
        self.send_header('Set-Cookie', 'music_session=%s; Path=/music/; HttpOnly; SameSite=Lax; Max-Age=%s%s' % (token, 3600 if token else 0, secure))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        # Avoid running mutable upstream GET code for HEAD requests.
        try:
            self.context()
            self.send_response(200 if urlsplit(self.path).path in ('/','/api/health') else 405)
            self.send_header('Content-Length', '0')
            self.end_headers()
        except Rejected as exc:
            self.send_response(exc.status); self.send_header('Content-Length', '0'); self.end_headers()

    def do_GET(self):
        try:
            context = self.context()
            parsed = urlsplit(self.path)
            path = parsed.path
            qq = self.current_qq(context)
            if path == '/api/session':
                session = STORE.session(self.token())
                return self.send_json({'authenticated': bool(qq), 'linked': bool(STORE.linked_qq(context)),
                                       'qq_connected': bool(context.get('openid')),
                                       'legacy': bool(session and qq), 'pending': bool(session and session['pending_until']>time.time()),
                                       'qq': qq, 'name': upstream.data['members'].get(qq, {}).get('name', '')})
            if path.startswith('/api/admin') or path == '/api/export' or path.startswith('/admin'):
                return self.send_json({'error':'此副本暂不开放旧管理后台'}, 403)
            if path.startswith('/api/') and path != '/api/health':
                if not qq:
                    return self.send_json({'error': '请先登录成分站'}, 401)
                query = parse_qs(parsed.query)
                if path in ('/api/me', '/api/matches', '/api/shouts'):
                    query['qq'] = [qq]
                if path in ('/api/member', '/api/compare'):
                    query['me'] = [qq]
                self.path = path + '?' + urlencode(query, doseq=True)
            return super().do_GET()
        except Rejected as exc:
            return self.send_json({'error': exc.message}, exc.status)

    def do_POST(self):
        try:
            context = self.context()
            if (self.headers.get('Origin') != ORIGIN
                    or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                    or self.headers.get_content_type() != 'application/json'):
                raise Rejected('请从成分站页面操作', 403)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    raise ValueError()
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise Rejected('请求格式不正确', 400) from None
            path = urlsplit(self.path).path
            if path == '/api/internal/admin-links':
                actor=context.get('admin_actor')
                if not isinstance(actor,str) or not actor:
                    raise Rejected('此操作仅供看板管理员使用',403)
                with upstream._lock:
                    if body.get('action')=='list':
                        return self.send_json(admin_links.view(upstream.data,STORE))
                    if body.get('action')!='change':raise Rejected('操作不存在',404)
                    backup_pair(Path(upstream.DATA_FILE).parent,STORE)
                    result=admin_links.change(upstream.data,STORE,body,actor)
                    upstream.save()
                    return self.send_json(dict(ok=True,**result))
            if path == '/api/join':
                qq, pin = str(body.get('qq', '')).strip(), str(body.get('pin', '')).strip()
                if not re.fullmatch(r'\d{4,12}', qq) or not re.fullmatch(r'\d{4,6}', pin):
                    raise Rejected('请输入旧站 QQ 号与原来的 4–6 位口令', 400)
                STORE.login_allowed(qq, self.headers.get('X-Real-IP', self.client_address[0]))
                with upstream._lock:
                    if body.get('consent') is not True:
                        raise Rejected('请确认旧站资料的使用说明', 400)
                    member = upstream.data['members'].get(qq)
                    if not member or not member.get('pinHash') or not upstream.pin_ok(pin, member['pinHash']):
                        raise Rejected('旧账号或口令不正确；忘记口令请联系管理员', 403)
                    if STORE.link_for_qq(qq):
                        raise Rejected('此账号已经连接 QQ，请使用 QQ 登录', 409)
                    token = STORE.new_session(qq)
                    STORE.logout(self.token())
                    return self.json_reply({'member':upstream.member_payload(member), 'entries':upstream.entries_payload(),
                                            'memberCount':len(upstream.data['members']), 'categories':upstream.CATEGORIES}, token=token)
            if path == '/api/logout':
                STORE.logout(self.token())
                return self.json_reply({'ok':True}, token='')
            if path == '/api/link/start':
                STORE.begin(self.token(), context)
                return self.send_json({'ok':True})
            if path == '/api/link/complete':
                # The authoritative mapping is already committed; the old board
                # field is only a compatibility projection for activity matching.
                with upstream._lock:
                    qq = STORE.complete(self.token(), context)
                    upstream.data['members'][qq]['boardUserId'] = context['user_id']
                    upstream.save()
                return self.json_reply({'ok':True}, token='')
            routes = {'/api/selection':self.api_selection, '/api/note':self.api_note, '/api/gender':self.api_gender,
                      '/api/entry':self.api_create_entry, '/api/entry/update':self.api_update_entry,
                      '/api/entry/delete':self.api_delete_entry, '/api/shout':self.api_shout,
                      '/api/room/preview':self.api_room_preview, '/api/room/split':self.api_room_split,
                      '/api/room/recalc':self.api_room_recalc, '/api/qgroup/split':self.api_qgroup_split,
                      '/api/qgroup/rooms':self.api_qgroup_rooms}
            fn = routes.get(path)
            with upstream._lock:
                qq = self.current_qq(context)
                if not qq:raise Rejected('请先登录成分站',401)
                if not fn:raise Rejected('操作不存在',404)
                if 'qq' in body and str(body['qq']) != qq:
                    raise Rejected('不能修改其他人的成分',403)
                body['qq'] = qq
                return fn(body)
        except Rejected as exc:
            return self.send_json({'error':exc.message}, exc.status)


def main():
    global STORE
    folder = Path(os.environ.get('JPM_DATA', '/data/data.json')).parent
    upstream.DATA_FILE = str(folder/'data.json')
    upstream.BACKUP_DIR = str(folder/'backups')
    if not Path(upstream.DATA_FILE).is_file():
        raise RuntimeError('An explicit legacy data snapshot is required')
    os.umask(0o077)
    lock = service_lock(folder)
    STORE = Store(folder/'identity.sqlite3')
    replay(folder, STORE)
    upstream.load()
    upstream.board_member_map = board_member_map
    admin_links.projection(upstream.data,STORE)
    last_backup = [0.0]
    def paired_backup(force=False):
        if force or time.time()-last_backup[0] >= 3600:
            backup_pair(folder, STORE)
            last_backup[0] = time.time()
    upstream.write_backup = paired_backup
    upstream.trend_snapshot(force=True)
    threading.Thread(target=upstream.trend_loop, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('JPM_PORT','8788'))), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
