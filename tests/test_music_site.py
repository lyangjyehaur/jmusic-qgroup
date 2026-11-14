"""Real gateway/service requests with synthetic legacy records and mocked QQ."""
import copy
import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

import server
from music_site import service
from music_site.identity_store import Store, Rejected
from qgroup_core import accounts
from test_roster import ModernClient
from test_qq_oauth import NoRedirect


class MusicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.previous_db = server.DB
        cls.music = service.ThreadingHTTPServer(('127.0.0.1',0), service.Handler)
        cls.board = server.ThreadingHTTPServer(('127.0.0.1',0), server.Handler)
        cls.threads = [threading.Thread(target=s.serve_forever,daemon=True) for s in (cls.music,cls.board)]
        for thread in cls.threads: thread.start()
        cls.base = 'http://127.0.0.1:%s' % cls.board.server_address[1]

    @classmethod
    def tearDownClass(cls):
        for http in (cls.music,cls.board): http.shutdown(); http.server_close()
        for thread in cls.threads: thread.join()
        server.DB = cls.previous_db
        cls.tmp.cleanup()

    def setUp(self):
        self.folder = Path(self.tmp.name)/self._testMethodName
        self.folder.mkdir()
        server.DB = self.folder/'board.sqlite3'
        server.initialize(); server.LIMITS.clear()
        self.origin = 'https://example.test'
        self.key = 'music-proxy-test-' + 'x'*40
        self.env = mock.patch.dict(os.environ, {
            'KANBAN_MUSIC_PROXY_KEY': self.key, 'KANBAN_MUSIC_PORT': str(self.music.server_address[1]),
            'KANBAN_SECURE_COOKIE':'0', 'KANBAN_ORIGIN':self.origin,
            'KANBAN_QQ_APP_ID':'12345', 'KANBAN_QQ_APP_KEY':'test-secret',
            'KANBAN_QQ_REDIRECT_URI':self.origin+'/auth/qq/callback'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.addCleanup(mock.patch.stopall)
        self.previous_origin = service.ORIGIN; service.ORIGIN = self.origin
        self.addCleanup(setattr, service, 'ORIGIN', self.previous_origin)
        self.board_origin = server.ORIGIN; server.ORIGIN = self.origin
        self.addCleanup(setattr, server, 'ORIGIN', self.board_origin)
        self.previous_data = copy.deepcopy(service.upstream.data)
        self.addCleanup(setattr, service.upstream, 'data', self.previous_data)
        service.upstream.DATA_FILE = str(self.folder/'data.json')
        service.upstream.BACKUP_DIR = str(self.folder/'backups')
        service.upstream.data = {
            'members': {qq:{'qq':qq,'name':'legacy-'+qq,'pinHash':service.upstream.hash_pin('123456'),
                            'selection':[],'created':[],'consent':True,'note':'private-'+qq}
                        for qq in ('10001','10002')},
            'entries':{'e1':{'id':'e1','text':'Artist','category':'歌手','kind':'sub','createdBy':'10001'}},
            'settings':{},'shouts':[],'shoutHistory':[],'trend':[]}
        service.STORE = Store(self.folder/'identity.sqlite3')
        self.client = ModernClient(self.base)
        self.client.request('/api/me')

    def request(self, path, method='GET', body=None, client=None, headers=None):
        return (client or self.client).request(path,method,body,{'Origin':self.origin,**(headers or {})})

    def legacy(self, qq='10001', client=None, pin='123456'):
        return self.request('/music/api/join','POST',{'qq':qq,'pin':pin,'consent':True},client)

    def authorize(self, client=None, subject='A'*32):
        client = client or self.client
        client.request('/api/me')
        status,result = client.request('/api/auth/qq/start','POST',{
            'mode':'login','confirm':True,'return_path':'/music/',
            'accept_privacy':True,'privacy_version':server.privacy.VERSION})
        self.assertEqual(status,200,result)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(result['authorize_url']).query)['state'][0]
        processor = next(h for h in client.opener.handlers if isinstance(h,urllib.request.HTTPCookieProcessor))
        client.opener = urllib.request.build_opener(NoRedirect(), processor)
        with mock.patch.object(server.qq_oauth,'exchange',return_value=(subject,'official user','', '')):
            try: response = client.opener.open(self.base+'/auth/qq/callback?'+urllib.parse.urlencode({'state':state,'code':'TEST'}))
            except urllib.error.HTTPError as error: response = error
            self.assertEqual(response.code,303); response.close()
        ready = client.request('/api/auth/qq/status')[1]
        status,result = client.request('/api/auth/qq/finish','POST',{'attempt_id':ready['attempt_id'],'confirm':True})
        self.assertEqual(status,200,result)
        self.assertEqual(result['return_path'],'/music/')
        return client.request('/api/me')[1]

    def complete(self, client=None):
        return self.request('/music/api/link/complete','POST',{},client)

    def test_legacy_login_preserves_data_and_enforces_ownership(self):
        self.assertEqual(self.request('/music/api/me?qq=10001')[0],401)
        self.assertEqual(self.legacy(pin='000000')[0],403)
        self.assertEqual(self.legacy()[0],200)
        self.assertEqual(self.request('/music/api/me?qq=10002')[1]['member']['qq'],'10001')
        self.assertEqual(self.request('/music/api/selection','POST',{'qq':'10002','selection':[]})[0],403)
        status,result = self.request('/music/api/selection','POST',{'selection':[{'id':'e1','level':4}]})
        self.assertEqual(status,200,result)
        self.assertEqual(service.upstream.data['members']['10001']['selection'],[{'id':'e1','level':4}])
        self.assertEqual(service.upstream.data['members']['10002']['selection'],[])

    def test_full_legacy_to_qq_flow_and_future_login(self):
        self.assertEqual(self.legacy()[0],200)
        self.assertEqual(self.request('/music/api/link/start','POST',{})[0],200)
        self.assertEqual(self.complete()[0],401)
        self.authorize()
        status,result = self.complete(); self.assertEqual(status,200,result)
        linked = service.STORE.link_for_qq('10001')
        self.assertEqual(linked['openid'],'A'*32)
        self.assertEqual(linked['app_id'],'12345')
        self.assertEqual(service.upstream.data['members']['10001']['boardUserId'],linked['user_id'])
        self.assertEqual(self.request('/music/api/session')[1]['linked'],True)
        self.assertEqual(self.complete()[0],401)
        fresh = ModernClient(self.base)
        self.assertEqual(self.legacy(client=fresh)[0],409)
        self.authorize(fresh)
        self.assertEqual(self.request('/music/api/me',client=fresh)[1]['member']['qq'],'10001')

    def test_existing_board_account_is_reused_without_data_merge(self):
        self.authorize()
        with server.connect() as db:
            uid = db.execute('SELECT user_id FROM external_identities').fetchone()[0]
            db.execute("UPDATE users SET nickname='existing member' WHERE id=?", (uid,))
        self.assertEqual(self.legacy()[0],200)
        self.request('/music/api/link/start','POST',{})
        self.authorize()
        self.assertEqual(self.complete()[0],200)
        self.assertEqual(service.STORE.link_for_qq('10001')['user_id'],uid)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT nickname FROM users WHERE id=?',(uid,)).fetchone()[0],'existing member')

    def test_reviewed_manual_mapping_needs_no_legacy_login(self):
        self.authorize()
        with server.connect() as db:
            uid = db.execute('SELECT user_id FROM external_identities').fetchone()[0]
        service.STORE.import_prelinks([{'qq':'10001','user_id':uid}])
        status,result=self.request('/music/api/me')
        self.assertEqual(status,200,result)
        self.assertEqual(result['member']['qq'],'10001')
        self.assertEqual(self.request('/music/api/session')[1]['linked'],True)
        self.assertEqual(service.STORE.link_for_qq('10001')['source'],'admin_board_user_id')
        fresh=ModernClient(self.base)
        self.assertEqual(self.legacy(client=fresh)[0],409)
        self.authorize(fresh)
        self.assertEqual(self.request('/music/api/me',client=fresh)[1]['member']['qq'],'10001')

    def test_prelinked_user_cannot_be_overwritten_by_another_legacy_claim(self):
        self.authorize()
        with server.connect() as db:
            uid=db.execute('SELECT user_id FROM external_identities').fetchone()[0]
        service.STORE.import_prelinks([{'qq':'10001','user_id':uid}])
        other=ModernClient(self.base);other.request('/api/me')
        self.legacy('10002',other);self.request('/music/api/link/start','POST',{},other)
        self.authorize(other)
        self.assertEqual(self.complete(other)[0],409)
        self.assertIsNone(service.STORE.link_for_qq('10002'))

    def test_another_browser_oauth_cannot_complete_legacy_claim(self):
        self.legacy(); self.request('/music/api/link/start','POST',{})
        other = ModernClient(self.base); self.authorize(other)
        self.assertEqual(self.complete(other)[0],401)
        self.assertEqual(self.complete()[0],401)
        self.assertIsNone(service.STORE.link_for_qq('10001'))

    def test_existing_oauth_login_without_fresh_authorization_cannot_claim(self):
        self.authorize(); self.legacy(); self.request('/music/api/link/start','POST',{})
        self.assertEqual(self.complete()[0],401)
        self.assertIsNone(service.STORE.link_for_qq('10001'))

    def test_conflicting_profile_is_not_overwritten(self):
        self.legacy(); self.request('/music/api/link/start','POST',{}); self.authorize(); self.complete()
        other = ModernClient(self.base); other.request('/api/me')
        self.assertEqual(self.legacy('10002',other)[0],200)
        self.request('/music/api/link/start','POST',{},other); self.authorize(other)
        self.assertEqual(self.complete(other)[0],409)
        self.assertIsNone(service.STORE.link_for_qq('10002'))

    def test_expired_claim_and_replayed_oauth_are_rejected(self):
        self.legacy(); self.request('/music/api/link/start','POST',{}); self.authorize()
        with service.STORE.connect() as db: db.execute('UPDATE sessions SET pending_until=?',(time.time()-1,))
        self.assertEqual(self.complete()[0],401)
        self.assertIsNone(service.STORE.link_for_qq('10001'))

    def test_unknown_or_pinless_profiles_cannot_be_claimed_or_registered(self):
        service.upstream.data['members']['10002'].pop('pinHash')
        self.assertEqual(self.legacy('10002')[0],403)
        self.assertEqual(self.legacy('10003')[0],403)
        self.assertEqual(len(service.upstream.data['members']),2)

    def test_bruteforce_limit_persists_in_private_store(self):
        for _ in range(8): self.assertEqual(self.legacy(pin='000000')[0],403)
        service.STORE = Store(self.folder/'identity.sqlite3')
        self.assertEqual(self.legacy()[0],429)

    def test_board_routes_untouched_and_gateway_fails_closed(self):
        with mock.patch.dict(os.environ,{'KANBAN_MUSIC_PROXY_KEY':''}):
            self.assertEqual(self.request('/music/api/health')[0],404)
            self.assertEqual(self.client.request('/api/health')[0],200)
        self.assertEqual(self.request('/music/api/health')[0],200)
        for path in ('/music/../api/me','/music/%2e%2e/api/me','/music//api/me'):
            self.assertEqual(self.request(path)[0],400,path)
        self.assertEqual(self.request('/music/api/selection','POST',{},headers={'Origin':'https://evil.test'})[0],403)
        self.assertEqual(self.request('/music/api/admin/login','POST',{})[0],401)

    def test_public_cannot_forge_proxy_identity(self):
        self.assertEqual(self.request('/music/api/me',headers={'X-Music-Identity':'forged','X-Music-Proxy-Key':self.key})[0],401)
        try: response = urllib.request.urlopen('http://127.0.0.1:%d/api/health'%self.music.server_address[1])
        except urllib.error.HTTPError as error: response = error
        self.assertEqual(response.code,403); response.close()

    def test_static_scope_and_server_cookie_do_not_touch_board(self):
        self.legacy()
        cookies = next(h.cookiejar for h in self.client.opener.handlers if isinstance(h,urllib.request.HTTPCookieProcessor))
        music = next(c for c in cookies if c.name=='music_session')
        self.assertEqual(music.path,'/music/'); self.assertTrue(music.has_nonstandard_attr('HttpOnly'))
        for path in ('/music/','/music/app.js','/music/link.js','/music/sw.js','/app.js'):
            with self.client.opener.open(self.base+path) as response:
                self.assertEqual(response.code,200)
                body=response.read().decode()
                if path=='/music/app.js':
                    self.assertNotIn("fetch('/api/",body)
                    self.assertNotIn('name: r.member.name, pin',body)
                if path=='/music/sw.js':
                    self.assertIn("k.startsWith('qgroup-music-')",body)
                    self.assertNotIn('Service-Worker-Allowed',response.headers)
                if path=='/app.js': self.assertNotIn('musicLinkStatus',body)

    def test_return_destination_remains_strict(self):
        self.assertEqual(accounts.return_path('/music/'),'/music/')
        for path in ('/music/?next=evil','/music//','//evil.test','https://evil.test/music/','/music/../'):
            with self.assertRaises(server.APIError): accounts.return_path(path)
