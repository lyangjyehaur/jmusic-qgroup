#!/usr/bin/env python3
"""Small, dependency-free activity board. Python 3.9+, SQLite, same-origin JSON API."""
import hashlib
import base64
import binascii
import json
import logging
import os
import re
import secrets
import sqlite3
import struct
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from qgroup_core import storage, roster, audit, events, billing, conditions, permissions, management, attendance, lifecycle, settlements, finance, identity, i18n, media, payment_codes, qq_oauth, accounts, admin, privacy, bot_outbox, time_polls
from qgroup_core.events import event_values, end_time, has_ended
from qgroup_core.common import APIError, now, string, date_value
from qgroup_core.billing import money, settlement_values, qr_image, serialize_settlement

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('KANBAN_DB', ROOT / 'data' / 'kanban.sqlite3'))
COOKIE = 'kanban_session'
SECURE = os.environ.get('KANBAN_SECURE_COOKIE', '0') == '1'
ORIGIN = os.environ.get('KANBAN_ORIGIN', '')
LIMITS = defaultdict(deque)
LIMIT_LOCK = threading.Lock()
CATEGORIES = {'约K', '聚餐', '运动', '出游', '游戏', '其他'}


def require_agreement(event,data):
    if (event['fee_policy'] or event['conditions_version']>1) and (type(data.get('conditions_version')) is not int or data['conditions_version']!=event['conditions_version']):
        raise APIError('请刷新页面，查看最新安排与费用规则后再报名',409)


def draft_scope(user):
    return hashlib.sha256(('kanban-drafts-v1:'+user['id']).encode()).hexdigest()


def connect():
    return storage.connect(DB)


def initialize():
    storage.initialize(DB)
    privacy.recover(DB)


def serialize(db, event, viewer):
    result = dict(event)
    result['bot_enabled'] = bool(event['bot_enabled'])
    result.pop('owner_id')
    result['ends_at'] = end_time(event).isoformat(timespec='seconds') if event['duration_hours'] else None
    result['is_owner'] = event['owner_id'] == viewer
    result['removal_blocker'] = events.removal_blocker(db,event) if result['is_owner'] else ''
    result['can_remove'] = result['is_owner'] and event['status']!='deleted' and not result['removal_blocker']
    result['bot_feature_enabled'] = bot_outbox.enabled()
    if permissions.has(db,event,viewer,'settlement'):
        result['bot_delivery'] = [dict(r, state='simulated' if r['simulated_at'] or r['last_error']=='dry-run' else r['status'])
            for r in db.execute('''SELECT id,kind,status,attempts,last_error,created_at,sent_at,simulated_at,
                json_extract(payload_json,'$._settlement_image.kind') AS payment_kind
                FROM bot_outbox WHERE event_id=? AND channel='group' AND (? OR kind='settlement_updated') ORDER BY id DESC LIMIT 12''', (event['id'],result['is_owner']))]
    result['has_ended'] = has_ended(event)
    scopes = permissions.scopes(db,event,viewer)
    settled = bool(db.execute('SELECT 1 FROM settlements WHERE event_id=?',(event['id'],)).fetchone())
    result['phase'] = lifecycle.phase(event)
    result['estimated_over'] = lifecycle.estimated_over(event)
    terminal = event['lifecycle'] in ('ended','cancelled')
    result['can_settle'] = 'settlement' in scopes and terminal
    result['can_finish'] = 'schedule' in scopes and not terminal and event['lifecycle']!='draft' and not event['archived_at']
    result['can_assist_schedule'] = not result['is_owner'] and permissions.can_assist_schedule(db,event,viewer) and not settled
    result['can_edit_schedule'] = ('schedule' in scopes or result['can_assist_schedule']) and not terminal and not event['archived_at'] and not settled
    result['can_manage_roster'] = 'roster' in scopes and not terminal and event['lifecycle']!='draft' and not event['archived_at'] and not settled
    result['can_attendance'] = 'attendance' in scopes and result['phase'] in ('ongoing','ended','cancelled') and not event['archived_at']
    result['can_onsite'] = {'roster','attendance'} <= scopes and result['phase'] in ('ongoing','ended') and not event['archived_at'] and not settled
    result['is_cohost'] = bool(scopes) and not result['is_owner']
    result['management_scopes'] = sorted(scopes)
    result['owner_name'] = db.execute('SELECT nickname FROM users WHERE id=?', (event['owner_id'],)).fetchone()[0]
    result.update(roster.serialize(db,event,viewer))
    result['claim_invitations']=identity.claims_visible(db,event,viewer)
    result['minimum_met'] = result['confirmed_count']>=event['minimum_participants']
    result['pending_confirmation_count'] = sum(p['confirmation_state']=='pending' for p in result['participants'])
    result['declined_confirmation_count'] = sum(p['confirmation_state']=='declined' for p in result['participants'])
    result['conditions'] = conditions.current(db,event)
    result['cohosts'] = management.visible_roles(db,event)
    result['pending_management'] = management.pending(db,event,viewer)
    result['attendance_roster'] = attendance.serialize(db,event) if 'attendance' in scopes else []
    result['draft_join_owner'] = bool(event['draft_join_owner']) if result['is_owner'] else None
    result['can_join'] = roster.is_open(event)
    result['withdrawal_deadline'] = event['withdrawal_deadline'] or event['deadline']
    result['protocol_version'] = 2
    result['share_token'] = event['invite_token'] if result['is_owner'] and event['visibility']=='invitation' else None
    result.pop('invite_token',None)
    result['queue_blocked'] = result['waiting_count'] > 0
    bill = db.execute('''SELECT total_cents,headcount,note,updated_at,length(qr_image) AS qr_size,
        (SELECT MAX(version) FROM settlement_history WHERE event_id=settlements.event_id) AS version
        FROM settlements WHERE event_id=?''', (event['id'],)).fetchone()
    result['settlement'] = None
    if bill:
        result['settlement'] = settlements.decorate(db,event['id'],bill)
        if result['settlement']['mode']=='detailed' and viewer:
            key=settlements.account_key(event['id'],viewer)
            owned=finance.my_keys(db,event,viewer)
            matches=[p['amount_cents'] for p in result['settlement']['detail']['payers'] if p['id'] in owned]
            result['my_payable_cents']=sum(matches) if matches else None
    financial=finance.summary(db,event,viewer)
    result['finance']={k:v for k,v in financial.items() if k not in ('balances','custodians','last_seq')}
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'Kanban'
    timeout = 20

    def log_message(self, fmt, *args):
        message = fmt % args
        message = re.sub(r'/(?:account-links|claims)/[A-Za-z0-9_-]{32}', '/identity/[redacted]',message)
        message = re.sub(r'/invitations/[A-Za-z0-9_-]+', '/invitations/[redacted]', message)
        message = re.sub(r'([?&](?:invite|attendee_invite|management_invite|claim|account_link)=)[^&\s"]+', r'\1[redacted]', message)
        message = re.sub(r'([?&](?:code|state|access_token|client_secret)=)[^&\s"]+', r'\1[redacted]', message)
        message = re.sub(r'(/auth/qq/callback)\?[^\s"]*', r'\1?[redacted]', message)
        logging.info('%s %s', self.address_string(), message)

    def reply(self, data, status=200, cookie=None, content_type='application/json; charset=utf-8', admin_cookie=None):
        locale=i18n.language(self.headers.get('Accept-Language'))
        body = json.dumps(i18n.payload(data,locale), ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Language', 'zh-Hans' if locale=='hans' else 'zh-Hant')
        self.send_header('Vary','Accept-Language')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store' if self.path.startswith(('/api/','/auth/')) else 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://u.danndann.cn; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://qlogo.cn https://*.qlogo.cn; connect-src 'self' https://u.danndann.cn; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if cookie is not None:
            self.send_header('Set-Cookie', '%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%s%s' % (COOKIE, cookie,31536000 if cookie else 0, '; Secure' if SECURE else ''))
        if admin_cookie is not None:
            self.send_header('Set-Cookie','%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%s%s'%(admin.COOKIE,admin_cookie,3600 if admin_cookie else 0,'; Secure' if SECURE else ''))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def identity(self, db, create=False):
        try:
            jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
            token = jar[COOKIE].value if COOKIE in jar else ''
        except cookies.CookieError:
            token = ''
        user = db.execute('SELECT u.* FROM users u JOIN browser_sessions s ON s.user_id=u.id WHERE s.token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone() if token else None
        if user or not create:
            return user, None
        return None,accounts.ensure_visitor(db,hashlib.sha256(token.encode()).hexdigest() if token else '')

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise APIError('请求格式不正确', 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            path=urlparse(self.path).path
            maximum = 9*1024*1024 if path.endswith(('/settlement/detailed','/settlement/preview')) else 3*1024*1024 if path.endswith('/settlement') or path=='/api/payment-codes' else 65536
            if not 0 < length <= maximum:
                raise APIError('请求内容过大或为空', 413)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeDecodeError):
            raise APIError('请求格式不正确')

    def check_write(self):
        origin = self.headers.get('Origin')
        expected = ORIGIN or ('http://' + self.headers.get('Host', ''))
        if origin and origin != expected:
            raise APIError('请从活动看板页面操作', 403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError('请从活动看板页面操作', 403)
        # The only public endpoint is the reverse proxy, which supplies a real IP.
        ip = self.headers.get('X-Real-IP', self.client_address[0]) if self.client_address[0] in ('127.0.0.1', '::1') else self.client_address[0]
        with LIMIT_LOCK:
            stamp = time.monotonic()
            if len(LIMITS) > 10000:
                for key in list(LIMITS):
                    if not LIMITS[key] or LIMITS[key][-1] < stamp - 60:
                        del LIMITS[key]
            bucket = LIMITS[ip]
            while bucket and bucket[0] < stamp - 60:
                bucket.popleft()
            if len(bucket) >= 90:
                raise APIError('操作有点频繁，请稍后再试', 429)
            bucket.append(stamp)

    def get_event(self, db, uid, viewer, allow_deleted=False):
        event = db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
        if not event or not roster.can_access(db,event,viewer) or (event['status']=='deleted' and not allow_deleted):
            raise APIError('活动不存在、已移除或需要邀请链接',404)
        return event

    def read_request(self, path):
        if path==qq_oauth.CALLBACK:
            try:query=parse_qs(urlparse(self.path).query,keep_blank_values=True,max_num_fields=20)
            except ValueError:raise APIError('QQ 回调参数过多，请重新登录')
            if not query or self.command=='HEAD':
                locale=i18n.language(self.headers.get('Accept-Language'))
                message=i18n.text('这是 QQ 登录回调地址，请从看板发起 QQ 登录。',locale)
                back=i18n.text('返回群聚看板',locale)
                return self.reply(('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 登录</title>  <script defer src="/analytics.js?v=20261109-umami2"></script>  <script async src="https://u.danndann.cn/script.js" data-website-id="5244d326-3db9-4499-9c7a-6e3568b296cd" data-domains="kanban.danndann.cn" data-auto-track="false" data-exclude-search="true" data-exclude-hash="true"></script><p>'+message+'</p><a href="/">'+back+'</a></html>').encode(),content_type='text/html; charset=utf-8')
            with connect() as db:
                user,_=self.identity(db)
                if not user and not accounts.visitor_exists(db,identity.session_hash(self.headers)):raise APIError('请在发起 QQ 登录的原浏览器重新操作',401)
            qq_oauth.callback(connect,user,identity.session_hash(self.headers),query)
            self.send_response(303)
            self.send_header('Location','/?qq=return')
            self.send_header('Cache-Control','no-store')
            self.send_header('Referrer-Policy','no-referrer')
            self.send_header('Content-Length','0')
            self.end_headers()
            return
        if path=='/api/health':
            with connect() as db:
                db.execute('SELECT 1').fetchone()
            return self.reply({'ok':True,'protocol_version':2})
        assets = {'/privacy':('privacy.html','text/html; charset=utf-8'),'/contact':('contact.html','text/html; charset=utf-8'),'/admin':('admin.html','text/html; charset=utf-8'),'/admin.js':('admin.js','text/javascript; charset=utf-8'),'/analytics.js':('analytics.js','text/javascript; charset=utf-8'),'/qq-login.png':('qq-login.png','image/png'),'/payment-codes.js':('payment-codes.js','text/javascript; charset=utf-8'),'/i18n.js':('i18n.js','text/javascript; charset=utf-8'),'/':('index.html','text/html; charset=utf-8'),'/guide.html':('guide.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript; charset=utf-8'),'/activity.js':('activity.js','text/javascript; charset=utf-8'),
            '/identity.js':('identity.js','text/javascript; charset=utf-8'),'/storage.js':('storage.js','text/javascript; charset=utf-8'),'/experience.js':('experience.js','text/javascript; charset=utf-8'),'/finance.js':('finance.js','text/javascript; charset=utf-8'),'/settlements.js':('settlements.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8'),'/client.js':('client.js','text/javascript; charset=utf-8'),'/roster.js':('roster.js','text/javascript; charset=utf-8'),'/favicon.svg':('favicon.svg','image/svg+xml')}
        assets['/time-polls.js']=('time-polls.js','text/javascript; charset=utf-8')
        if path in assets:
            filename, content_type = assets[path]
            locale=i18n.language(self.headers.get('Accept-Language'))
            source=ROOT/'public'
            if filename.endswith(('.html','.js')):source=source/'locales'/locale
            return self.reply((source/filename).read_bytes(),content_type=content_type)
        with connect() as db:
            user, token = self.identity(db,create=path=='/api/me')
            viewer = user['id'] if user else None
            if path=='/api/me':
                session=hashlib.sha256(token.encode()).hexdigest() if token else identity.session_hash(self.headers)
                result=dict(authenticated=bool(user),nickname=user['nickname'] if user else '',protocol_version=2,
                    draft_scope=draft_scope(user) if user else accounts.visitor_scope(session),qq=qq_oauth.summary(db,user),
                    allow_name_registration=accounts.settings(db)['allow_name_registration'],providers=accounts.providers(),
                    identities=accounts.linked(db,user['id']) if user else [])
                result.update(privacy_version=privacy.VERSION,privacy_accepted=privacy.accepted(db,user))
                db.commit()
                return self.reply(result,cookie=token)
            if path=='/api/admin/session':return self.reply(admin.view(db,self.headers))
            if path=='/api/admin/users':
                try:query=parse_qs(urlparse(self.path).query,keep_blank_values=True,max_num_fields=10)
                except ValueError:raise APIError('用户查询条件不正确')
                return self.reply(admin.users(db,self.headers,query))
            if path=='/api/admin/bot-settings':return self.reply(admin.bot_view(db,self.headers))
            if path in ('/api/account/qq/status','/api/auth/qq/status'):
                if not user and not accounts.visitor_exists(db,identity.session_hash(self.headers)):raise APIError('请刷新页面后重试',401)
                return self.reply(qq_oauth.status(db,user,identity.session_hash(self.headers)))
            if path=='/api/payment-codes':
                if not user:raise APIError('请先设置称呼',401)
                return self.reply({'codes':payment_codes.library(db,viewer)})
            library_image=re.fullmatch(r'/api/payment-codes/([a-f0-9]{16})/image',path)
            if library_image:
                if not user:raise APIError('请先设置称呼',401)
                code=payment_codes.owned(db,viewer,library_image[1])
                return self.reply(media.read(db,code['digest']),content_type='image/png')
            if path=='/api/account':
                if not user:raise APIError('请刷新页面后重试',401)
                session=identity.session_hash(self.headers)
                return self.reply(dict(accounts=identity.accounts(db,user,session),devices=identity.devices(db,user,session),qq=qq_oauth.summary(db,user),
                    history=[dict(action=r['action'],created_at=r['created_at']) for r in db.execute('SELECT * FROM account_audit WHERE user_id=? ORDER BY id DESC LIMIT 50',(viewer,))]))
            account_link=re.fullmatch(r'/api/account-links/([A-Za-z0-9_-]{32})',path)
            if account_link:
                row=identity.link_view(db,account_link[1])
                return self.reply(dict(nickname=row['nickname'],expires_at=row['expires_at']))
            if path.startswith('/api/requests/'):
                key=path.removeprefix('/api/requests/')
                if not re.fullmatch(r'[A-Za-z0-9_-]{16,100}',key):raise APIError('请求标识不正确')
                if not user:
                    session=identity.session_hash(self.headers)
                    if not accounts.visitor_exists(db,session):raise APIError('请刷新页面后重试',401)
                    if self.headers.get('X-Kanban-Identity')!=accounts.visitor_scope(session):raise APIError('浏览器身份已改变，请刷新页面',409)
                    row=db.execute('SELECT response_json FROM auth_requests WHERE token_hash=? AND request_key=?',(session,key)).fetchone()
                    return self.reply(dict(committed=bool(row),**({'result':json.loads(row[0])} if row else {})))
                supplied=self.headers.get('X-Kanban-Identity')
                if supplied and supplied!=draft_scope(user):raise APIError('浏览器身份已改变，请刷新后使用当前身份操作',409)
                row=db.execute('SELECT response_json FROM request_results WHERE user_id=? AND request_key=?',(viewer,key)).fetchone()
                if not row:return self.reply({'committed':False})
                result=json.loads(row[0])
                # Re-evaluate access and roles: a cached owner response must not survive a handover.
                if isinstance(result,dict) and result.get('id') and 'starts_at' in result:
                    result=serialize(db,self.get_event(db,result['id'],viewer),viewer)
                elif isinstance(result,dict) and result.get('time_poll'):
                    result=time_polls.serialize(db,time_polls.get(db,result['id']),viewer)
                elif isinstance(result,dict) and 'nickname' in result:
                    result={'nickname':user['nickname'],'draft_scope':draft_scope(user)}
                return self.reply({'committed':True,'result':result})
            if path=='/api/notifications':
                if not user:return self.reply({'notifications':[],'unread_count':0})
                messages = db.execute('''SELECT n.id,n.event_id,n.kind,n.message,n.created_at,n.read_at
                    FROM notifications n JOIN events e ON e.id=n.event_id
                    WHERE n.user_id=? AND e.status!='deleted' ORDER BY n.id DESC LIMIT 100''',(viewer,)).fetchall()
                unread = db.execute('''SELECT count(*) FROM notifications n JOIN events e ON e.id=n.event_id
                    WHERE n.user_id=? AND n.read_at IS NULL AND e.status!='deleted' ''',(viewer,)).fetchone()[0]
                return self.reply({'notifications':[dict(row) for row in messages],'unread_count':unread})
            if path=='/api/events':
                found = db.execute("SELECT * FROM events WHERE status!='deleted' ORDER BY starts_at").fetchall()
                polls=db.execute('''SELECT * FROM time_polls WHERE status!='deleted' AND (status IN ('open','closed') OR owner_id=?
                    OR EXISTS(SELECT 1 FROM time_poll_ballots b WHERE b.poll_id=time_polls.id AND b.user_id=?))
                    ORDER BY created_at DESC''',(viewer,viewer)).fetchall()
                return self.reply({'events':[serialize(db,e,viewer) for e in found if roster.can_access(db,e,viewer)],
                    'time_polls':[time_polls.serialize(db,p,viewer) for p in polls]})
            poll_match=re.fullmatch(r'/api/time-polls/([a-f0-9]{16})',path)
            if poll_match:
                return self.reply(time_polls.serialize(db,time_polls.get(db,poll_match[1]),viewer))
            match = re.fullmatch(r'/api/events/([a-f0-9]{16})(.*)',path)
            if not match:
                raise APIError('页面不存在',404)
            uid, suffix = match.groups()
            claim=re.fullmatch(r'/claims/([A-Za-z0-9_-]{32})',suffix)
            if claim:
                event=db.execute("SELECT * FROM events WHERE id=? AND status!='deleted'",(uid,)).fetchone()
                if not event:raise APIError('活动不存在',404)
                return self.reply(identity.claim_view(db,event,user,claim[1]))
            role_invitation = re.fullmatch(r'/management/invitations/([A-Za-z0-9_-]{32})',suffix)
            if role_invitation:
                event=db.execute("SELECT * FROM events WHERE id=? AND status!='deleted'",(uid,)).fetchone()
                if not event:raise APIError('活动不存在',404)
                invitation=management.lookup(db,event,role_invitation[1])
                if invitation['recipient_id'] and invitation['recipient_id']!=viewer:
                    raise APIError('请使用受邀者原有浏览器打开这份交接邀请',403)
                return self.reply(dict(event_id=uid,title=event['title'],owner_name=db.execute('SELECT nickname FROM users WHERE id=?',(event['owner_id'],)).fetchone()[0],
                    kind=invitation['kind'],target_name=invitation['target_name'],permissions=json.loads(invitation['permissions_json']),
                    expires_at=invitation['expires_at'],base_revision=event['revision']))
            invitation = re.fullmatch(r'/invitations/([A-Za-z0-9_-]{32})',suffix)
            if invitation:
                event = db.execute("SELECT * FROM events WHERE id=? AND status!='deleted'",(uid,)).fetchone()
                if not event:
                    raise APIError('活动不存在或已移除',404)
                person = roster.invitation(db,event,invitation[1])
                return self.reply({'event_id':uid,'title':event['title'],'starts_at':event['starts_at'],
                    'location':event['location'],'name':person['name'],'base_revision':event['revision'],
                    'conditions':conditions.current(db,event),'timezone':event['timezone']})
            event = self.get_event(db,uid,viewer)
            if not suffix:
                return self.reply(serialize(db,event,viewer))
            if suffix=='/finance':
                query=parse_qs(urlparse(self.path).query)
                values=[query.get(key,[''])[0] for key in ('before','before_report')]
                if any(v and not re.fullmatch(r'[1-9][0-9]{0,17}',v) for v in values):raise APIError('账本页码不正确')
                return self.reply(finance.view(db,event,viewer,*[int(v) if v else None for v in values]))
            if suffix=='/settlement/roster':
                return self.reply(settlements.context(db,event,user or {'id':None}))
            receipt=re.fullmatch(r'/settlement/history/([1-9][0-9]*)/receipts/([a-f0-9]{16})',suffix)
            if receipt:
                raw=media.receipt(db,uid,receipt[1],receipt[2])
                if not raw:raise APIError('消费凭证不存在',404)
                return self.reply(raw,content_type='image/png')
            if suffix=='/conditions':
                found=db.execute('SELECT version,snapshot_json,summary,actor_name,created_at FROM event_conditions WHERE event_id=? ORDER BY version DESC',(uid,)).fetchall()
                return self.reply({'versions':[dict(version=r[0],arrangement=json.loads(r[1]),summary=r[2],actor_name=r[3],created_at=r[4]) for r in found]})
            if suffix=='/history':
                raw_before = parse_qs(urlparse(self.path).query).get('before',[''])[0]
                if raw_before and not re.fullmatch(r'[0-9]{1,18}',raw_before):
                    raise APIError('历史页码不正确')
                cutoff = int(raw_before) if raw_before else 2**63-1
                found = db.execute('''SELECT id,version,actor_name,action,before_json,after_json,reason,created_at
                    FROM event_audit WHERE event_id=? AND id<? ORDER BY id DESC LIMIT 51''',(uid,cutoff)).fetchall()
                entries = [dict(id=r['id'],version=r['version'],actor_name=r['actor_name'],action=r['action'],
                    before=json.loads(r['before_json']),after=json.loads(r['after_json']),reason=r['reason'],created_at=r['created_at']) for r in found[:50]]
                return self.reply({'entries':entries,'next_before':entries[-1]['id'] if len(found)>50 else None})
            code_image=re.fullmatch(r'/settlement/history/([1-9][0-9]*)/payment-codes/(wechat|alipay|other)',suffix)
            if code_image:
                code=db.execute('SELECT digest FROM settlement_code_images WHERE event_id=? AND version=? AND kind=?',(uid,code_image[1],code_image[2])).fetchone()
                if not code:raise APIError('收款码不存在',404)
                return self.reply(media.read(db,code[0]),content_type='image/png')
            history = re.fullmatch(r'/settlement/history(?:/([1-9][0-9]*)/payment-code)?',suffix)
            if history:
                if history[1]:
                    codes=payment_codes.existing(db,uid,int(history[1]))
                    if not codes:raise APIError('收款码不存在',404)
                    return self.reply(codes[0][1],content_type='image/png')
                found = db.execute('''SELECT version,total_cents,headcount,note,updated_at,length(qr_image) AS qr_size,
                    actor_name,kind,changed_fields FROM settlement_history WHERE event_id=? ORDER BY version DESC''',(uid,)).fetchall()
                return self.reply({'revisions':[dict(settlements.decorate(db,uid,r),actor_name=r['actor_name'],kind=r['kind'],changed_fields=json.loads(r['changed_fields'])) for r in found]})
            if suffix=='/payment-code':
                codes=payment_codes.existing(db,uid,settlements.latest_version(db,uid))
                if not codes:raise APIError('收款码不存在',404)
                return self.reply(codes[0][1],content_type='image/png')
            raise APIError('页面不存在',404)

    def auth_write(self,path,data):
        if self.command!='POST':raise APIError('登录操作不支持此请求方式',405)
        key=self.headers.get('Idempotency-Key','')
        if self.headers.get('X-Kanban-Version')!='2' or not re.fullmatch(r'[A-Za-z0-9_-]{16,100}',key):raise APIError('页面版本已更新，请刷新后重试',409)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            user,_=self.identity(db)
            session=identity.session_hash(self.headers)
            if not user and not accounts.visitor_exists(db,session):raise APIError('请刷新页面后重新登录',401)
            scope=draft_scope(user) if user else accounts.visitor_scope(session)
            supplied=self.headers.get('X-Kanban-Identity')
            if supplied and supplied!=scope:raise APIError('浏览器身份已改变，请刷新后使用当前身份操作',409)
            signature=hashlib.sha256((path+' '+json.dumps(data,sort_keys=True,ensure_ascii=False)).encode()).hexdigest()
            previous=db.execute('SELECT * FROM auth_requests WHERE token_hash=? AND request_key=?',(session,key)).fetchone()
            if previous:
                if signature!=previous['signature']:raise APIError('同一请求标识不能用于不同内容',409)
                return self.reply(json.loads(previous['response_json']))
            cookie=None
            if path in ('/api/auth/logout','/api/auth/close'):
                if not user:raise APIError('请先登录后再操作',401)
                if path.endswith('/close'):
                    result=privacy.close(db,user,data)
                else:result=privacy.logout(db,session)
                db.commit()
                if path.endswith('/close'):privacy.prune(DB)
                return self.reply(result,cookie='')
            if path=='/api/register':
                if user:raise APIError('当前已经登录，请在个人资料修改称呼',409)
                result,cookie=accounts.register_name(db,session,data)
            elif path.endswith('/start'):result=qq_oauth.start(db,user,session,data)
            else:result,cookie=qq_oauth.finish(db,user,session,data)
            db.execute('INSERT INTO auth_requests VALUES(?,?,?,?,?)',(session,key,signature,json.dumps(result,ensure_ascii=False),now()))
            db.commit()
            return self.reply(result,cookie=cookie)

    def write_request(self, path):
        self.check_write()
        data = self.body()
        if path.startswith('/api/admin/'):
            if self.command!='POST':raise APIError('管理操作不支持此请求方式',405)
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                result,cookie=admin.login(db,data) if path=='/api/admin/login' and self.command=='POST' else admin.command(db,self.headers,path,data)
                db.commit()
                logout_account=result.pop('logout_account',False)
                return self.reply(result,admin_cookie=cookie,cookie='' if logout_account else None)
        if path in ('/api/auth/logout','/api/auth/close','/api/register','/api/auth/qq/start','/api/auth/qq/finish','/api/account/qq/start','/api/account/qq/finish'):
            return self.auth_write(path,data)
        modern = self.headers.get('X-Kanban-Version')=='2'
        request_key = self.headers.get('Idempotency-Key')
        if request_key is not None and not re.fullmatch(r'[A-Za-z0-9_-]{16,100}',request_key):
            raise APIError('请求标识不正确')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            user, _ = self.identity(db)
            if not user:
                raise APIError('页面身分已过期，请刷新后重试',401)
            supplied=self.headers.get('X-Kanban-Identity')
            if supplied and supplied!=draft_scope(user):raise APIError('浏览器身份已改变，请刷新后使用当前身份操作',409)
            match = re.fullmatch(r'/api/events/([a-f0-9]{16})(.*)',path)
            event, suffix = None, ''
            if match:
                uid, suffix = match.groups()
                if suffix=='/access' or re.fullmatch(r'/(?:management/)?invitations/[A-Za-z0-9_-]{32}/accept',suffix) or re.fullmatch(r'/claims/[A-Za-z0-9_-]{32}/request',suffix):
                    event = db.execute("SELECT * FROM events WHERE id=? AND status!='deleted'",(uid,)).fetchone()
                    if not event:
                        raise APIError('活动不存在或已移除',404)
                    if suffix!='/access' and not roster.can_access(db,event,user['id']):
                        if suffix.startswith('/claims/'):
                            identity.claim_lookup(db,event,suffix.split('/')[2])
                        elif suffix.startswith('/management/'):
                            management.lookup(db,event,suffix.split('/')[3])
                        else:roster.invitation(db,event,suffix.split('/')[2])
                else:
                    event = self.get_event(db,uid,user['id'],allow_deleted=True)
                    if event['status']=='deleted' and event['owner_id']!=user['id']:
                        raise APIError('活动已移除',404)
            new_route = suffix.startswith(('/claims','/finance','/roster','/attendees','/invitations','/management','/attendance','/onsite','/settlement/detailed','/settlement/preview')) or path=='/api/notifications/read' or path.startswith(('/api/account/','/api/payment-codes','/api/time-polls'))
            if path.startswith('/api/time-polls') and not modern:
                raise APIError('页面版本已更新，请刷新后重试',409)
            if event and not suffix and self.command=='PATCH' and 'title' in data and data.get('action') is None and event['owner_id']!=user['id'] and permissions.can_assist_schedule(db,event,user['id']):
                if not modern or not request_key:raise APIError('管理员协助编辑请刷新页面后重试',409)
            if suffix.startswith('/finance') and not modern:raise APIError('页面版本已更新，请刷新后重试',409)
            if (modern or new_route) and not request_key:
                raise APIError('页面版本已更新，请刷新后重试',409)
            signature = hashlib.sha256((self.command+' '+path+' '+json.dumps(data,sort_keys=True,ensure_ascii=False)).encode()).hexdigest()
            if request_key:
                previous = db.execute('SELECT * FROM request_results WHERE user_id=? AND request_key=?',(user['id'],request_key)).fetchone()
                if previous:
                    if previous['signature']!=signature:
                        raise APIError('这份投票已创建，请从看板查看原投票' if path=='/api/time-polls' and data.get('client_intent') else '这份草稿对应的活动已创建，请从活动进入编辑' if path=='/api/events' and data.get('client_intent') else '同一请求标识不能用于不同内容',409)
                    result=json.loads(previous['response_json'])
                    # Preserve the business result without re-executing; refresh visibility and roles.
                    if isinstance(result,dict) and result.get('id') and 'starts_at' in result:
                        cached_event=self.get_event(db,result['id'],user['id'])
                        result=serialize(db,cached_event,user['id'])
                    elif isinstance(result,dict) and result.get('time_poll'):
                        result=time_polls.serialize(db,time_polls.get(db,result['id']),user['id'])
                    return self.reply(result,previous['response_status'])
            if event and event['status']=='deleted':
                raise APIError('活动已移除',404)
            status = 200
            response_cookie = None
            if path.startswith('/api/time-polls'):
                if not user['nickname']:raise APIError('请先设置称呼')
                poll_match=re.fullmatch(r'/api/time-polls/([a-f0-9]{16})(/votes)?',path)
                if path=='/api/time-polls' and self.command=='POST':
                    poll=time_polls.create(db,user,data);status=201
                elif poll_match:
                    poll=time_polls.get(db,poll_match[1])
                    if poll_match[2]=='/votes' and self.command=='PUT':time_polls.vote(db,poll,user,data)
                    elif not poll_match[2] and self.command=='PATCH':time_polls.manage(db,poll,user,data)
                    else:raise APIError('不支持的时间投票操作',405)
                    poll=db.execute('SELECT * FROM time_polls WHERE id=?',(poll['id'],)).fetchone()
                else:raise APIError('时间投票不存在',404)
                result=({'id':poll['id'],'status':'deleted'} if poll['status']=='deleted'
                        else time_polls.serialize(db,poll,user['id']))
            elif self.command=='POST' and path=='/api/payment-codes':
                if not user['nickname']:raise APIError('请先设置称呼')
                result=payment_codes.create(db,user,data);status=201
            elif self.command=='DELETE' and re.fullmatch(r'/api/payment-codes/[a-f0-9]{16}',path):
                result=payment_codes.archive(db,user,path.split('/')[3])
            elif self.command=='POST' and path.startswith('/api/account/'):
                result=identity.account_command(db,user,identity.session_hash(self.headers),path,data)
            elif self.command=='POST' and path=='/api/profile':
                nickname = string(data,'nickname',24)
                if nickname!=user['nickname']:
                    affected = db.execute("SELECT DISTINCT event_id FROM attendees WHERE user_id=? AND status!='withdrawn'",(user['id'],)).fetchall()
                    snapshots = {r[0]:roster.snapshot(db,r[0]) for r in affected}
                    db.execute('UPDATE users SET nickname=? WHERE id=?',(nickname,user['id']))
                    for uid,before in snapshots.items():
                        linked = db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
                        roster.record(db,linked,user,'nickname_changed',before)
                result = {'nickname':nickname,'draft_scope':draft_scope(user)}
            elif self.command=='POST' and path=='/api/notifications/read':
                ids = data.get('ids')
                if not isinstance(ids,list) or len(ids)>100 or any(type(uid) is not int for uid in ids):
                    raise APIError('消息格式不正确')
                for uid in ids:
                    db.execute('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?',(now(),uid,user['id']))
                result = {'ok':True}
            elif event and suffix=='/access' and self.command=='POST':
                supplied = string(data,'invite_token',100)
                if not event['invite_token'] or not secrets.compare_digest(supplied,event['invite_token']):
                    raise APIError('邀请链接无效',403)
                roster.grant(db,event['id'],user['id'])
                result = {'ok':True}
            else:
                if not user['nickname']:
                    raise APIError('先告诉大家怎么称呼你吧')
                legacy = not modern and (not suffix or suffix in ('/registration','/settlement'))
                # Time-bound compatibility; old endpoints delegate to the same rules and audit path.
                if legacy and now() >= '2026-12-09T00:00:00+00:00':
                    raise APIError('页面版本已更新，请刷新后重试',409)
                if self.command=='POST' and path=='/api/events':
                    uid = events.create(db,user,data)
                    event = db.execute('SELECT * FROM events WHERE id=?',(uid,)).fetchone()
                    status = 201
                elif not event:
                    raise APIError('操作不存在',404)
                elif suffix=='/roster/preview' and self.command=='POST':
                    return self.reply(roster.preview(db,event,user,data))
                else:
                    if modern or new_route:
                        audit.require_revision(event,data)
                    if suffix.startswith('/claims') and self.command=='POST':
                        identity.claim_command(db,event,user,suffix,data)
                    elif suffix=='/finance/preview' and self.command=='POST':
                        return self.reply(finance.preview(db,event,user,data))
                    elif suffix=='/finance' and self.command=='POST':
                        finance.save(db,event,user,data)
                    elif suffix=='/settlement/preview' and self.command=='POST':
                        return self.reply(settlements.preview(db,event,user,data))
                    elif suffix=='/settlement/detailed' and self.command=='PUT':
                        settlements.save(db,event,user,data)
                    elif suffix=='/roster/parties' and self.command=='POST':
                        roster.add_party(db,event,user,data)
                    elif suffix=='/roster/invitations' and self.command=='POST':
                        roster.invite(db,event,user,data)
                    elif re.fullmatch(r'/invitations/[A-Za-z0-9_-]{32}/accept',suffix) and self.command=='POST':
                        require_agreement(event,data)
                        roster.accept_invitation(db,event,user,suffix.split('/')[2],data)
                    elif re.fullmatch(r'/attendees/[a-f0-9]{16}/conditions',suffix) and self.command=='PATCH':
                        conditions.respond(db,event,user,suffix.split('/')[2],data)
                    elif suffix=='/management/invitations' and self.command=='POST':
                        management.invite(db,event,user,data)
                    elif re.fullmatch(r'/management/invitations/[A-Za-z0-9_-]{32}/accept',suffix) and self.command=='POST':
                        management.accept(db,event,user,suffix.split('/')[3],data)
                    elif re.fullmatch(r'/management/invitations/[a-f0-9]{16}',suffix) and self.command=='DELETE':
                        management.revoke_invitation(db,event,user,suffix.split('/')[3],data)
                    elif re.fullmatch(r'/management/roles/[a-f0-9]{16}',suffix) and self.command=='DELETE':
                        management.revoke_role(db,event,user,suffix.split('/')[3],data)
                    elif re.fullmatch(r'/attendance/[a-f0-9]{16}',suffix) and self.command=='PATCH':
                        attendance.change(db,event,user,suffix.split('/')[2],data)
                    elif suffix=='/onsite' and self.command=='POST':
                        attendance.onsite(db,event,user,data)
                    elif re.fullmatch(r'/attendees/[a-f0-9]{16}(?:/withdrawal)?',suffix):
                        attendee_id = suffix.split('/')[2]
                        if suffix.endswith('/withdrawal') and self.command=='PATCH':
                            if data.get('decision') not in ('approve','reject'):
                                raise APIError('请选择同意或拒绝退出')
                            roster.withdraw(db,event,user,attendee_id,data,decision=data.get('decision'))
                        elif self.command=='PATCH' and not suffix.endswith('/withdrawal'):
                            roster.change_person(db,event,user,attendee_id,data)
                        elif self.command=='DELETE' and not suffix.endswith('/withdrawal'):
                            roster.withdraw(db,event,user,attendee_id,data)
                        else:
                            raise APIError('操作不存在',405)
                    elif suffix=='/registration':
                        person = db.execute("SELECT * FROM attendees WHERE event_id=? AND user_id=? AND status!='withdrawn'",(event['id'],user['id'])).fetchone()
                        if self.command=='PUT':
                            if person:
                                roster.change_person(db,event,user,person['id'],{'note':data.get('note','')})
                            else:
                                require_agreement(event,data)
                                roster.add_party(db,event,user,{'people':[{'is_self':True,'note':data.get('note','')}]},require_preview=False)
                        elif self.command=='DELETE':
                            if person:
                                roster.withdraw(db,event,user,person['id'],data)
                        else:
                            raise APIError('操作不存在',405)
                    elif suffix=='/settlement' and self.command=='PUT':
                        if modern and 'base_version' not in data:
                            raise APIError('请刷新结算后重试',409)
                        billing.save(db,event,user,data)
                    elif not suffix and self.command=='PATCH':
                        events.patch(db,event,user,data)
                    else:
                        raise APIError('操作不存在',404)
                event = db.execute('SELECT * FROM events WHERE id=?',(event['id'],)).fetchone()
                result = ({'id':event['id'],'status':'deleted'} if event['status']=='deleted' else
                          serialize(db,event,user['id']) if roster.can_access(db,event,user['id']) else {'ok':True,'claim_pending':True})
            if request_key:
                db.execute('INSERT INTO request_results VALUES(?,?,?,?,?,?)',
                    (user['id'],request_key,signature,json.dumps(result,ensure_ascii=False),status,now()))
            db.commit()
            return self.reply(result,status,cookie=response_cookie)

    def handle_request(self):
        path = urlparse(self.path).path
        try:
            if self.command in ('GET','HEAD'):
                return self.read_request(path)
            return self.write_request(path)
        except APIError as exc:
            self.reply({'error':exc.message},exc.status)
        except (BrokenPipeError,ConnectionResetError):
            pass
        except Exception:
            logging.exception('Request failed')
            self.reply({'error':'暂时无法完成操作，请稍后重试'},500)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    initialize()
    server = ThreadingHTTPServer((os.environ.get('KANBAN_HOST', '127.0.0.1'), int(os.environ.get('KANBAN_PORT', '8791'))), Handler)
    server.daemon_threads = True
    logging.info('Kanban listening on %s:%s', *server.server_address)
    server.serve_forever()
