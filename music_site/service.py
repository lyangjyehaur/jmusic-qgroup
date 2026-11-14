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
from . import admin_links, administration

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

    def require_admin(self, body):
        return bool(self.context().get('admin_actor'))

    def api_admin_wall_upload(self,body):
        import base64
        match=re.fullmatch(r'data:image/(png|jpeg|jpg|webp);base64,(.+)',str(body.get('data') or ''),re.S)
        if not match:raise Rejected('壁纸只支持 PNG、JPG 或 WebP',400)
        try:blob=base64.b64decode(match[2],validate=True)
        except ValueError:raise Rejected('图片数据损坏',400) from None
        valid={'png':blob.startswith(b'\x89PNG\r\n\x1a\n'),'jpeg':blob.startswith(b'\xff\xd8\xff'),
               'jpg':blob.startswith(b'\xff\xd8\xff'),'webp':blob.startswith(b'RIFF') and blob[8:12]==b'WEBP'}
        if not valid[match[1]]:raise Rejected('图片格式与内容不一致',400)
        return super().api_admin_wall_upload(body)

    def serve_static(self,path):
        if path=='/admin':path='/admin.html'
        if path.startswith('/walls/'):
            name=path[len('/walls/'):]
            if not re.fullmatch(r'[A-Za-z0-9_.-]+',name) or name.startswith('.'):
                return self.send_text('not found',404)
            source=Path(upstream.WALLS_DIR)/name
            if not source.is_file():return self.send_text('not found',404)
            payload=source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type',upstream.CTYPES.get(source.suffix.lower(),'application/octet-stream'))
            self.send_header('Content-Length',str(len(payload)));self.send_header('Cache-Control','no-cache')
            self.end_headers();self.wfile.write(payload)
            return
        return super().serve_static(path)

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
        if linked and linked in upstream.data['members']:
            return linked
        session = STORE.session(self.token())
        # Once connected, a short legacy PIN cannot act as an alternative login.
        if session and session['qq'] in upstream.data['members'] and not STORE.link_for_qq(session['qq']):
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
            if path.startswith('/api/admin/') or path=='/api/export':
                if not context.get('admin_actor'):raise Rejected('请先登录看板管理后台',401)
                folder=Path(upstream.DATA_FILE).parent
                with upstream._lock:
                    if path=='/api/admin/session':return self.send_json(dict(authenticated=True,csrf=context.get('admin_csrf','')))
                    if path=='/api/admin/state':return self.send_json(dict(entries=upstream.entries_payload(),memberCount=len(upstream.data['members'])))
                    if path=='/api/admin/backups':
                        root=folder/'paired-backups'
                        return self.send_json(dict(backups=[dict(name=p.name,size=(p/'data.json').stat().st_size) for p in sorted(root.iterdir(),reverse=True) if re.fullmatch(r'[0-9]{8}-[0-9]{6}',p.name) and (p/'data.json').is_file()]) if root.exists() else dict(backups=[]))
                    if path in ('/api/export','/api/admin/backup'):
                        name=parse_qs(parsed.query).get('name',[''])[0] if path.endswith('/backup') else None
                        return self.send_download('music-data-'+(name or time.strftime('%Y%m%d-%H%M%S'))+'.json',administration.snapshot(folder,name))
                    raise Rejected('操作不存在',404)
            qq = self.current_qq(context)
            if path == '/api/session':
                session = STORE.session(self.token())
                return self.send_json({'authenticated': bool(qq), 'linked': bool(STORE.linked_qq(context)),
                                       'board_authenticated': bool(context.get('user_id')),
                                       'board_name': context.get('nickname',''),
                                       'qq_connected': bool(context.get('openid')),
                                       'legacy': bool(session and qq), 'pending': bool(session and session['pending_until']>time.time()),
                                       'qq': qq, 'name': upstream.data['members'].get(qq, {}).get('name', '')})
            if path.startswith('/api/admin'):
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
            path = urlsplit(self.path).path
            if (self.headers.get('Origin') != ORIGIN
                    or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                    or self.headers.get_content_type() != 'application/json'):
                raise Rejected('请从成分站页面操作', 403)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                limit=3*1024*1024 if path=='/api/admin/wall/upload' and context.get('admin_actor') else 65536
                if not 0 < length <= limit:
                    raise ValueError()
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise Rejected('请求格式不正确', 400) from None
            if path.startswith('/api/admin/'):
                if not context.get('admin_actor'):raise Rejected('请先登录看板管理后台',401)
                routes={'create':self.api_admin_create,'edit':self.api_admin_edit,'delete':self.api_admin_delete,
                    'merge':self.api_admin_merge,'pin':self.api_admin_pin,'members':self.api_admin_members,
                    'shout/list':self.api_admin_shout_list,'shout/delete':self.api_admin_shout_delete,
                    'walls':self.api_admin_walls,'wall/upload':self.api_admin_wall_upload,
                    'wall/delete':self.api_admin_wall_delete,'wall/config':self.api_admin_wall_config,
                    'wall/toggle':self.api_admin_wall_toggle,'wall/move':self.api_admin_wall_move}
                suffix=path[len('/api/admin/'):]
                with upstream._lock:
                    if suffix=='member/board':raise Rejected('请在看板管理后台的成分站关联中修改实际关联',409)
                    if suffix in ('member/delete','reset'):
                        backup_pair(Path(upstream.DATA_FILE).parent,STORE)
                        return self.send_json(administration.erase(Path(upstream.DATA_FILE).parent,STORE,body,reset=suffix=='reset'))
                    fn=routes.get(suffix)
                    if not fn:raise Rejected('操作不存在',404)
                    if suffix not in ('members','shout/list','walls'):backup_pair(Path(upstream.DATA_FILE).parent,STORE)
                    return fn(body)
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
                        raise Rejected('此成分已关联看板，请使用对应看板账号登录；无法登录请联系管理员', 409)
                    if STORE.linked_qq(context):
                        raise Rejected('当前看板账号已有成分，请联系管理员核对并迁移，原资料不会覆盖',409)
                    token = STORE.new_session(qq)
                    STORE.logout(self.token())
                    return self.json_reply({'member':upstream.member_payload(member), 'entries':upstream.entries_payload(),
                                            'memberCount':len(upstream.data['members']), 'categories':upstream.CATEGORIES}, token=token)
            if path == '/api/logout':
                STORE.logout(self.token())
                return self.json_reply({'ok':True}, token='')
            if path == '/api/profile/create':
                if not context.get('user_id'):raise Rejected('请先登录看板或使用 QQ 登录',401)
                if body.get('consent') is not True or body.get('confirm_new') is not True:
                    raise Rejected('请确认建立空白成分；有旧资料请先找回旧账号',400)
                name=upstream.clean_text(body.get('name',context.get('nickname','')),upstream.MAX_NAME_LEN)
                if not name:raise Rejected('请输入成分昵称',400)
                with upstream._lock:
                    STORE.recover_profiles(upstream.data)
                    linked=STORE.linked_qq(context)
                    if linked:
                        admin_links.projection(upstream.data,STORE)
                        upstream.save()
                        return self.send_json({'ok':True,'existing':True})
                    if self.current_qq(context):raise Rejected('已登录旧成分，请先连接 QQ 登录，保留原资料',409)
                    # Do not create around a mapping whose OAuth identity no longer matches.
                    with STORE.connect() as db:
                        if db.execute('SELECT 1 FROM links WHERE user_id=?',(context['user_id'],)).fetchone():
                            raise Rejected('当前账号的成分关联需要核对，请联系管理员',409)
                    if upstream.find_member_by_name(name):raise Rejected('此成分昵称已被使用，请换一个昵称；如是你的旧成分请先找回',409)
                    backup_pair(Path(upstream.DATA_FILE).parent,STORE)
                    STORE.create_profile(context,name)
                    STORE.recover_profiles(upstream.data)
                    admin_links.projection(upstream.data,STORE)
                    upstream.save()
                    return self.send_json({'ok':True,'existing':False})
            if path == '/api/link/start':
                STORE.begin(self.token(), context)
                return self.send_json({'ok':True})
            if path == '/api/link/cancel':
                with STORE.connect() as db:
                    db.execute("UPDATE sessions SET source_session='',pending_until=0 WHERE token_hash=?",(STORE.digest(self.token()),))
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
    administration.configure_walls(folder)
    replay(folder, STORE)
    upstream.load()
    STORE.recover_profiles(upstream.data)
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
