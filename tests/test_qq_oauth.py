"""Isolated OAuth HTTP tests: provider mocked, real sessions and database transactions."""
import concurrent.futures
import hashlib
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import server
from test_roster import ModernClient
from qgroup_core import qq_oauth, storage
from qgroup_core.common import APIError
from deploy.verify_migration import verify


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class QQTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB = Path(cls.tmp.name) / 'qq.sqlite3'
        server.initialize()
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d' % cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.thread.join(); cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.env = mock.patch.dict(os.environ, dict(KANBAN_QQ_APP_ID='12345', KANBAN_QQ_APP_KEY='test-secret-never-persist',
            KANBAN_ORIGIN='https://kanban.example.test', KANBAN_QQ_REDIRECT_URI='https://kanban.example.test/auth/qq/callback'))
        self.env.start(); self.addCleanup(self.env.stop)
        self.owner = ModernClient(self.base).identify('后台後臺同名')
        self.other = ModernClient(self.base).identify('后台後臺同名')
        for client in (self.owner, self.other):
            cookies = next(h for h in client.opener.handlers if isinstance(h, urllib.request.HTTPCookieProcessor))
            client.opener = urllib.request.build_opener(NoRedirect(), cookies)
        self.openid = os.urandom(16).hex().upper()
        self.provider = mock.patch.object(qq_oauth, 'graph', side_effect=self.graph)
        self.graph_mock = self.provider.start(); self.addCleanup(self.provider.stop)

    def graph(self, path, params):
        if path == '/oauth2.0/token':
            self.assertEqual(params['client_secret'], 'test-secret-never-persist')
            self.assertEqual(params['redirect_uri'], 'https://kanban.example.test/auth/qq/callback')
            return dict(access_token='A' * 32)
        if path == '/oauth2.0/me':return dict(client_id='12345', openid=self.openid)
        if path == '/user/get_user_info':return dict(ret=0, nickname='QQ 后台後臺')
        self.fail(path)

    def begin(self, client=None, mode='bind'):
        client = client or self.owner
        status, value = client.request('/api/account/qq/start', 'POST', dict(mode=mode, confirm=True))
        self.assertEqual(status, 200, value)
        parsed = urllib.parse.urlsplit(value['authorize_url'])
        self.assertEqual(parsed.scheme+'://'+parsed.netloc, 'https://graph.qq.com')
        params = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(params['scope'], ['get_user_info'])
        self.assertNotIn('client_secret', params)
        return params['state'][0]

    def callback(self, state, client=None, **params):
        client = client or self.owner
        url = self.base + qq_oauth.CALLBACK + '?' + urllib.parse.urlencode(dict(state=state, code='TESTCODE', **params))
        try:response = client.opener.open(url)
        except urllib.error.HTTPError as exc:response = exc
        return response, response.read()

    def ready(self, client=None, mode='bind'):
        client = client or self.owner
        state = self.begin(client, mode)
        response, body = self.callback(state, client)
        self.assertEqual(response.code, 303, body[:300])
        self.assertEqual(response.headers['Location'], '/?qq=return')
        status, value = client.request('/api/account/qq/status')
        self.assertEqual(status, 200, value); self.assertEqual(value['status'], 'verified', value)
        return value

    def finish(self, ready, client=None, **extra):
        return (client or self.owner).request('/api/account/qq/finish', 'POST', dict({'attempt_id':ready['attempt_id'], 'confirm':True}, **extra))

    def test_provider_avatar_is_persisted_and_returned_with_qq_nickname(self):
        def graph(path,params):
            if path=='/user/get_user_info':return dict(ret=0,nickname='QQ 头像测试',figureurl_qq_2='http://thirdqq.qlogo.cn/qqapp/1/2/100')
            return self.graph(path,params)
        with mock.patch.object(qq_oauth,'graph',side_effect=graph):ready=self.ready()
        self.assertEqual(ready['avatar_url'],'https://thirdqq.qlogo.cn/qqapp/1/2/100')
        self.assertEqual(self.finish(ready)[0],200)
        qq=self.owner.request('/api/me')[1]['qq']
        self.assertEqual(qq['nickname'],'QQ 头像测试');self.assertEqual(qq['avatar_url'],ready['avatar_url'])

    def test_callback_has_help_without_auth_and_does_not_create_identity(self):
        with storage.connect(server.DB) as db:before = db.execute('SELECT count(*) FROM users').fetchone()[0]
        with urllib.request.urlopen(self.base+qq_oauth.CALLBACK) as response:
            self.assertEqual(response.status, 200)
            self.assertIn('QQ', response.read().decode()); self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertIsNone(response.headers.get('Set-Cookie'))
        with storage.connect(server.DB) as db:self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0], before)

    def test_requires_config_confirmation_and_same_origin(self):
        with mock.patch.dict(os.environ, dict(KANBAN_QQ_APP_KEY='')):
            self.assertFalse(self.owner.request('/api/me')[1]['qq']['enabled'])
            self.assertEqual(self.owner.request('/api/account/qq/start', 'POST', dict(mode='bind', confirm=True))[0], 503)
        with mock.patch.dict(os.environ, dict(KANBAN_QQ_REDIRECT_URI='https://evil.test/auth/qq/callback')):
            self.assertIsNone(qq_oauth.config())
        self.assertEqual(self.owner.request('/api/account/qq/start', 'POST', dict(mode='bind', confirm=False))[0], 400)
        self.assertEqual(self.owner.request('/api/account/qq/start', 'POST', dict(mode='bind', confirm=True), headers={'Origin':'https://evil.test'})[0], 403)

    def test_bind_keeps_identity_data_and_requires_confirmation_rotates_cookie(self):
        before = self.owner.request('/api/me')[1]
        start = (datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        status, event = self.owner.request('/api/events', 'POST', dict(title='OAuth 数据保全',category='约K',location='测试',starts_at=start,deadline=start,capacity=0,duration_hours=3))
        self.assertEqual(status, 201)
        with storage.connect(server.DB) as db:
            tables = ['events','attendees','event_audit','event_conditions','settlements','settlement_history','finance_entries','finance_reports']
            snapshot = {t:[tuple(r) for r in db.execute('SELECT * FROM '+t)] for t in tables}
        ready = self.ready()
        self.assertFalse(self.owner.request('/api/me')[1]['qq']['bound'])
        self.assertEqual(self.finish(ready, confirm=False)[0], 400)
        old_cookie = next(h.cookiejar for h in self.owner.opener.handlers if isinstance(h, urllib.request.HTTPCookieProcessor))
        cookie = next(iter(old_cookie)).value
        self.assertEqual(self.finish(ready)[0], 200)
        after = self.owner.request('/api/me')[1]
        self.assertEqual(after['draft_scope'], before['draft_scope'])
        self.assertEqual(after['nickname'], before['nickname'])
        self.assertEqual(after['qq'], dict(enabled=True,bound=True,nickname='QQ 后台後臺',avatar_url='',unionid_bound=False,needs_reauth=True))
        self.assertNotEqual(next(iter(old_cookie)).value, cookie)
        with storage.connect(server.DB) as db:
            self.assertIsNone(db.execute('SELECT * FROM browser_sessions WHERE token_hash=?', (hashlib.sha256(cookie.encode()).hexdigest(),)).fetchone())
            self.assertEqual({t:[tuple(r) for r in db.execute('SELECT * FROM '+t)] for t in tables}, snapshot)
        self.assertEqual(self.finish(ready)[0], 409)

    def test_login_preserves_old_account_and_same_name_does_not_merge(self):
        original = self.owner.request('/api/me')[1]['draft_scope']
        other_scope = self.other.request('/api/me')[1]['draft_scope']
        self.assertEqual(self.finish(self.ready())[0], 200)
        ready = self.ready(self.other, 'login')
        self.assertEqual(self.other.request('/api/me')[1]['draft_scope'], other_scope)
        self.assertEqual(self.finish(ready, self.other)[0], 200)
        self.assertEqual(self.other.request('/api/me')[1]['draft_scope'], original)
        accounts = self.other.request('/api/account')[1]['accounts']
        self.assertEqual({a['scope'] for a in accounts}, {original,other_scope})
        self.assertEqual(self.other.request('/api/account/switch','POST',dict(scope=other_scope))[0],200)
        self.assertEqual(self.other.request('/api/me')[1]['draft_scope'],other_scope)
        self.assertFalse(self.other.request('/api/me')[1]['qq']['bound'])

    def test_new_qq_login_creates_separate_account_then_can_return_to_original(self):
        before = self.owner.request('/api/me')[1]['draft_scope']
        self.assertEqual(self.finish(self.ready(mode='login'))[0], 200)
        me = self.owner.request('/api/me')[1]
        self.assertNotEqual(me['draft_scope'], before); self.assertEqual(me['nickname'], 'QQ 后台後臺')
        self.assertEqual(self.owner.request('/api/account/switch','POST',dict(scope=before))[0], 200)
        self.assertEqual(self.owner.request('/api/me')[1]['draft_scope'], before)

    def test_bound_other_account_conflict_and_no_replacement(self):
        self.assertEqual(self.finish(self.ready())[0],200)
        ready = self.ready(self.other)
        self.assertTrue(ready['conflict']); self.assertEqual(self.finish(ready,self.other)[0],409)
        self.assertFalse(self.other.request('/api/me')[1]['qq']['bound'])
        self.openid = 'F'*32
        self.assertEqual(self.finish(self.ready())[0],409)
        self.assertTrue(self.owner.request('/api/me')[1]['qq']['bound'])

    def test_state_replay_wrong_browser_and_newer_attempt(self):
        state = self.begin()
        self.assertEqual(self.callback(state,self.other)[0].code,409)
        self.assertEqual(self.graph_mock.call_count,0)
        self.assertEqual(self.callback(state)[0].code,303)
        self.assertEqual(self.callback(state)[0].code,409)
        self.assertEqual(self.graph_mock.call_count,3)
        old = self.begin(); self.begin()
        self.assertEqual(self.callback(old)[0].code,409)
        self.assertEqual(self.callback('bad')[0].code,400)

    def test_expired_state_and_changed_identity_reject_without_provider_call(self):
        state = self.begin()
        with storage.connect(server.DB) as db:db.execute("UPDATE login_attempts SET expires_at='2000-01-01' WHERE id=?",(hashlib.sha256(state.encode()).hexdigest(),))
        self.assertEqual(self.callback(state)[0].code,409)
        state = self.begin()
        with storage.connect(server.DB) as db:
            jar = next(h.cookiejar for h in self.other.opener.handlers if isinstance(h, urllib.request.HTTPCookieProcessor))
            target = db.execute('SELECT user_id FROM browser_sessions WHERE token_hash=?',
                (hashlib.sha256(next(iter(jar)).value.encode()).hexdigest(),)).fetchone()[0]
            db.execute('UPDATE browser_sessions SET user_id=? WHERE token_hash IN (SELECT token_hash FROM login_attempts WHERE id=?)',(target,hashlib.sha256(state.encode()).hexdigest()))
        self.assertEqual(self.callback(state)[0].code,409)
        self.assertEqual(self.graph_mock.call_count,0)

    def test_provider_cancel_failure_client_mismatch_and_partial_profile_never_bind(self):
        state = self.begin()
        self.assertEqual(self.callback(state,error='access_denied')[0].code,303)
        self.assertEqual(self.owner.request('/api/account/qq/status')[1]['status'],'failed')
        self.assertEqual(self.graph_mock.call_count,0)
        for side_effect in [APIError('provider unavailable',502),
                [dict(access_token='A'*32),dict(client_id='99999',openid=self.openid)],
                [dict(access_token='A'*32),dict(client_id='12345',openid=self.openid),dict(ret=1002,msg='denied')]]:
            self.graph_mock.side_effect=side_effect
            state = self.begin();self.assertEqual(self.callback(state)[0].code,303)
            self.assertEqual(self.owner.request('/api/account/qq/status')[1]['status'],'failed')
            self.assertFalse(self.owner.request('/api/me')[1]['qq']['bound'])
        self.assertEqual(self.finish(dict(attempt_id=hashlib.sha256(state.encode()).hexdigest()))[0],409)

    def test_parallel_callback_exchanges_only_once(self):
        state = self.begin()
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            codes = list(pool.map(lambda _:self.callback(state)[0].code,range(2)))
        self.assertEqual(sorted(codes),[303,409]);self.assertEqual(self.graph_mock.call_count,3)

    def test_authorization_not_shared_by_account_switch_or_revoked_device(self):
        ready = self.ready()
        self.assertEqual(self.finish(ready,self.other)[0],409)
        with storage.connect(server.DB) as db:db.execute("UPDATE login_attempts SET expires_at='2000-01-01' WHERE id=?",(ready['attempt_id'],))
        self.assertEqual(self.finish(ready)[0],409)

    def test_audit_failure_rolls_back_binding_and_session_rotation(self):
        ready = self.ready();before = self.owner.request('/api/me')[1]
        with mock.patch.object(server.identity,'account_log',side_effect=APIError('audit unavailable',503)):
            self.assertEqual(self.finish(ready)[0],503)
        self.assertFalse(self.owner.request('/api/me')[1]['qq']['bound'])
        self.assertEqual(self.owner.request('/api/me')[1]['draft_scope'],before['draft_scope'])
        self.assertEqual(self.owner.request('/api/account/qq/status')[1]['status'],'verified')
        self.assertEqual(self.finish(ready)[0],200)

    def test_logs_and_database_do_not_contain_key_code_or_token(self):
        state = self.begin()
        with self.assertLogs(level='INFO') as messages:self.assertEqual(self.callback(state)[0].code,303)
        log=' '.join(messages.output)
        self.assertNotIn(state,log);self.assertNotIn('TESTCODE',log)
        with storage.connect(server.DB) as db:dump='\n'.join(db.iterdump())
        for secret in ['test-secret-never-persist','TESTCODE','A'*32]:self.assertNotIn(secret,dump)
        info=self.owner.request('/api/account/qq/status')[1]
        self.assertNotIn('openid',info);self.assertNotIn('access_token',info)

    def test_migration_preserves_every_old_value_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'source.sqlite3';copy=Path(folder)/'copy.sqlite3'
            with sqlite3.connect(server.DB) as db,sqlite3.connect(source) as out:db.backup(out)
            with sqlite3.connect(source) as db:
                db.execute('DROP TABLE qq_accounts');db.execute('DROP TABLE qq_attempts');db.execute('DELETE FROM schema_migrations WHERE version=7')
            verify(source,copy)
            with storage.connect(copy) as db:self.assertEqual(db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0],15)


class GraphTests(unittest.TestCase):
    def test_network_error_is_sanitized_and_redirects_are_not_followed(self):
        with mock.patch.object(qq_oauth.request,'build_opener') as opener:
            opener.return_value.open.side_effect=urllib.error.URLError('secret-in-url')
            with self.assertRaises(APIError) as problem:qq_oauth.graph('/oauth2.0/token',dict(client_secret='very-secret'))
            self.assertNotIn('secret',problem.exception.message)
            self.assertIsInstance(opener.call_args.args[0],qq_oauth.NoRedirect)
        self.assertIsNone(qq_oauth.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.test'))

    def test_invalid_json_error_payload_and_oversized_response_rejected(self):
        for raw in [b'invalid',b'[]',b'{"error":1001,"error_description":"secret"}',b'{"ret":1002}',b' '*65537]:
            with self.subTest(raw=raw[:30]),mock.patch.object(qq_oauth.request,'build_opener') as opener:
                opener.return_value.open.return_value.__enter__.return_value.read.return_value=raw
                with self.assertRaises(APIError):qq_oauth.graph('/test',{})
