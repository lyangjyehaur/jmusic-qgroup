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
from music_site import admin_links, administration
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

    def music_admin(self):
        key='music-admin-test-'+'a'*40
        env=mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':hashlib.sha256(key.encode()).hexdigest()})
        env.start();self.addCleanup(env.stop)
        manager=ModernClient(self.base)
        self.assertEqual(self.request('/api/admin/login','POST',{'key':key},manager)[0],200)
        csrf=self.request('/api/admin/session',client=manager)[1]['csrf']
        service.upstream.save()
        return manager,csrf

    def music_rows(self, manager):
        status,result=self.request('/api/admin/music-links',client=manager)
        self.assertEqual(status,200,result)
        return {m['qq']:m for m in result['members']}

    def music_change(self,manager,csrf,row,uid):
        return self.request('/api/admin/music-links','POST',
                            dict(qq=row['qq'],user_id=uid,base_revision=row['revision']),manager,
                            {'X-Kanban-Admin':csrf})

    def test_admin_links_require_current_authority_csrf_and_private_bridge(self):
        manager,csrf=self.music_admin()
        for path in ('/api/admin/music-links','/music/api/internal/admin-links'):
            self.assertIn(self.request(path)[0],(401,404))
        data=dict(qq='10001',user_id='',base_revision='x'*64)
        for headers in ({},{'X-Kanban-Admin':'wrong'},{'X-Kanban-Admin':csrf,'Origin':'https://evil.test'}):
            self.assertEqual(self.request('/api/admin/music-links','POST',data,manager,headers)[0],403)
        forged={'X-Music-Proxy-Key':self.key,'X-Music-Identity':'eyJhZG1pbl9hY3RvciI6ImZvcmdlZCJ9'}
        for client in (manager,self.client):
            self.assertEqual(self.request('/music/api/internal/admin-links','POST',{'action':'list'},client,forged)[0],403)
        with mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':'rotated'}):
            self.assertEqual(self.request('/api/admin/music-links',client=manager)[0],401)

    def test_admin_list_excludes_private_credentials_and_member_notes(self):
        manager,csrf=self.music_admin();self.authorize()
        with server.connect() as db:uid=db.execute('SELECT id FROM users').fetchone()[0]
        service.STORE.import_prelinks([dict(qq='10001',user_id=uid)])
        self.assertEqual(self.request('/music/api/me')[0],200)
        rows=self.music_rows(manager)
        self.assertEqual(rows['10001']['status'],'oauth')
        self.assertEqual(rows['10001']['board_name'],'official user')
        for private in ('private-10001','pinHash','openid','app_id','A'*32,self.key):
            self.assertNotIn(private,json.dumps(rows))

    def test_admin_bind_and_unlink_remove_both_maps_and_revoke_old_access(self):
        manager,csrf=self.music_admin();self.authorize()
        with server.connect() as db:uid=db.execute('SELECT id FROM users').fetchone()[0]
        row=self.music_rows(manager)['10001']
        self.assertEqual(self.music_change(manager,csrf,row,uid)[0],200)
        self.assertEqual(self.request('/music/api/me')[1]['member']['qq'],'10001')
        self.assertEqual(self.music_rows(manager)['10001']['status'],'oauth')
        service.STORE.new_session('10001')
        row=self.music_rows(manager)['10001']
        self.assertEqual(self.music_change(manager,csrf,row,'')[0],200)
        self.assertIsNone(service.STORE.link_for_qq('10001'))
        with service.STORE.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions WHERE qq=?',('10001',)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM link_audit').fetchone()[0],2)
        self.assertEqual(self.request('/music/api/me')[0],401)
        self.assertEqual(self.request('/music/api/selection','POST',{'selection':[]})[0],401)
        self.assertEqual(service.upstream.data['members']['10001']['boardUserId'],'')
        self.assertEqual(service.upstream.data['members']['10001']['note'],'private-10001')
        # An old JSON projection cannot resurrect a deliberate unlink.
        service.upstream.data['members']['10001']['boardUserId']=uid
        with mock.patch.object(service,'LEGACY_BOARD_MAP',return_value={uid:'10001'}):
            self.assertNotIn(uid,service.board_member_map())
        admin_links.projection(service.upstream.data,service.STORE)
        self.assertEqual(service.upstream.data['members']['10001']['boardUserId'],'')
        self.assertEqual(self.legacy()[0],200)

    def test_admin_edit_rejects_conflicting_closed_targets_and_stale_oauth_rows(self):
        manager,csrf=self.music_admin();self.authorize()
        with server.connect() as db:uid=db.execute('SELECT id FROM users').fetchone()[0]
        rows=self.music_rows(manager)
        self.assertEqual(self.music_change(manager,csrf,rows['10001'],'missing')[0],404)
        self.assertEqual(self.music_change(manager,csrf,rows['10001'],uid)[0],200)
        self.assertEqual(self.music_change(manager,csrf,rows['10002'],uid)[0],409)
        prelinked=self.music_rows(manager)['10001']
        self.request('/music/api/me')  # Promotes the prelink through QQ identity.
        self.assertEqual(self.music_change(manager,csrf,prelinked,'')[0],409)
        current=self.music_rows(manager)['10001']
        self.assertEqual(self.music_change(manager,csrf,current,'')[0],200)
        self.assertEqual(self.music_change(manager,csrf,rows['10002'],uid)[0],200)
        self.assertEqual(self.music_rows(manager)['10002']['status'],'prelinked')
        self.assertEqual(self.request('/api/auth/close','POST',dict(confirm_close=True))[0],200)
        current=self.music_rows(manager)['10002']
        self.assertFalse(current['board_active'])
        self.assertEqual(self.music_change(manager,csrf,current,uid)[0],404)

    def test_admin_audit_failure_rolls_back_and_projection_replays_after_restart(self):
        manager,csrf=self.music_admin();self.authorize()
        with server.connect() as db:uid=db.execute('SELECT id FROM users').fetchone()[0]
        row=self.music_rows(manager)['10001']
        import sqlite3
        with service.STORE.connect() as db:
            db.execute("CREATE TRIGGER fail_link_audit BEFORE INSERT ON link_audit BEGIN SELECT RAISE(ABORT,'test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            service.STORE.admin_change('10001',uid,row['revision'],'test')
        self.assertIsNone(service.STORE.link_for_qq('10001'))
        with service.STORE.connect() as db:db.execute('DROP TRIGGER fail_link_audit')
        # A failed projection write does not undo the authoritative decision;
        # startup replay repairs it from the committed store.
        service.STORE.admin_change('10001',uid,row['revision'],'test')
        service.STORE=Store(self.folder/'identity.sqlite3')
        admin_links.projection(service.upstream.data,service.STORE)
        self.assertEqual(service.upstream.data['members']['10001']['boardUserId'],uid)

    def test_account_admin_can_manage_links_and_revocation_is_immediate(self):
        manager,csrf=self.music_admin();self.authorize()
        with server.connect() as db:
            uid=db.execute('SELECT id FROM users').fetchone()[0]
            db.execute("INSERT INTO user_admin_roles VALUES(?,1,1,'now')",(uid,))
        account_csrf=self.request('/api/admin/session')[1]['csrf']
        row=self.music_rows(self.client)['10001']
        self.assertEqual(self.music_change(self.client,account_csrf,row,uid)[0],200)
        with server.connect() as db:db.execute('UPDATE user_admin_roles SET is_admin=0 WHERE user_id=?',(uid,))
        self.assertEqual(self.request('/api/admin/music-links')[0],401)
        self.assertEqual(self.music_change(self.client,account_csrf,row,'')[0],401)

    def test_full_admin_uses_board_authority_without_music_membership(self):
        manager,csrf=self.music_admin()
        self.assertEqual(self.request('/music/api/admin/session',client=manager)[1]['csrf'],csrf)
        self.assertEqual(self.request('/music/api/admin/state',client=manager)[1]['memberCount'],2)
        data={}
        self.assertEqual(self.request('/music/api/admin/members','POST',data,manager)[0],403)
        self.assertEqual(self.request('/music/api/admin/members','POST',data,manager,{'X-Kanban-Admin':csrf})[1]['total'],2)
        for path in ('/music/api/admin/session','/music/api/admin/state','/music/api/admin/backups','/music/api/export'):
            self.assertEqual(self.request(path)[0],401,path)
        with mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':'revoked'}):
            self.assertEqual(self.request('/music/api/admin/state',client=manager)[0],401)
        self.assertEqual(self.request('/music/api/admin/login','POST',{'password':'jpadmin'},manager,{'X-Kanban-Admin':csrf})[0],404)

    def test_full_admin_entry_edits_merges_and_deletion_preserve_consistent_selections(self):
        manager,csrf=self.music_admin();headers={'X-Kanban-Admin':csrf}
        def post(action,body):
            status,result=self.request('/music/api/admin/'+action,'POST',body,manager,headers)
            self.assertEqual(status,200,result);return result
        added=post('create',dict(text='new-artist',category='其他',kind='sub'))['entry']['id']
        post('edit',dict(entryId=added,text='edited-artist'))
        service.upstream.data['members']['10001']['selection']=[dict(id='e1',level=4),dict(id=added,level=1)]
        service.upstream.save()
        post('merge',dict(fromId='e1',toId=added))
        self.assertNotIn('e1',service.upstream.data['entries'])
        self.assertEqual(service.upstream.data['members']['10001']['selection'],[dict(id=added,level=4)])
        post('delete',dict(entryId=added))
        self.assertEqual(service.upstream.data['members']['10001']['selection'],[])
        post('pin',dict(qq='10002',pin='987654'))
        self.assertEqual(self.legacy('10002',pin='987654')[0],200)

    def test_full_admin_member_erasure_cleans_identity_and_historical_exports(self):
        manager,csrf=self.music_admin();headers={'X-Kanban-Admin':csrf}
        service.STORE.import_prelinks([dict(qq='10001',user_id='synthetic-user')])
        service.STORE.new_session('10001')
        service.upstream.data['shouts']=[dict(qq='10001',id='s1',createdAt=int(time.time()),text='private shout')]
        service.upstream.save()
        self.assertEqual(self.request('/music/api/admin/member/delete','POST',dict(qq='10001',confirm='wrong'),manager,headers)[0],400)
        self.assertEqual(self.request('/music/api/admin/member/delete','POST',dict(qq='10001',confirm='DELETE'),manager,headers)[0],200)
        self.assertIsNone(service.STORE.link_for_qq('10001'))
        self.assertNotIn('10001',service.upstream.data['members'])
        self.assertEqual(service.upstream.data['shouts'],[])
        self.assertEqual(service.upstream.data['entries']['e1']['createdBy'],'')
        backups=self.request('/music/api/admin/backups',client=manager)[1]['backups']
        self.assertTrue(backups)
        for path in ('/music/api/export','/music/api/admin/backup?name='+backups[0]['name']):
            status,result=self.request(path,client=manager)
            self.assertEqual(status,200,result)
            self.assertNotIn('10001',result['members'])
            self.assertNotIn('adminPasswordHash',result['settings'])
        self.assertEqual(self.request('/music/api/admin/backup?name=../identity.sqlite3',client=manager)[0],400)
        self.assertEqual(self.request('/music/api/admin/reset','POST',dict(confirm='RESET'),manager,headers)[0],200)
        self.assertEqual(service.upstream.data['members'],{})
        self.assertEqual(service.upstream.data['entries'],{})

    def test_full_admin_wallpapers_are_persistent_bounded_and_in_paired_backups(self):
        import base64
        from test_api import test_png
        from music_site.maintenance import backup_pair
        names=('WALLS_DIR','WALLS_MANIFEST','WALL_MAX_BYTES','WALL_EXTS')
        old={name:getattr(service.upstream,name) for name in names}
        for name,value in old.items():self.addCleanup(setattr,service.upstream,name,value)
        administration.configure_walls(self.folder)
        manager,csrf=self.music_admin();headers={'X-Kanban-Admin':csrf}
        data='data:image/png;base64,'+base64.b64encode(test_png()).decode()
        status,result=self.request('/music/api/admin/wall/upload','POST',dict(name='test wallpaper',data=data),manager,headers)
        self.assertEqual(status,200,result)
        src=result['walls']['items'][0]['src']
        with urllib.request.urlopen(self.base+'/music'+src) as response:
            self.assertEqual(response.status,200)
            self.assertEqual(response.headers.get_content_type(),'image/png')
        administration.configure_walls(self.folder)
        self.assertEqual(service.upstream.walls_payload()['items'][0]['src'],src)
        backup_pair(self.folder,service.STORE)
        self.assertTrue(any((p/'walls'/src.rsplit('/',1)[-1]).exists() for p in (self.folder/'paired-backups').iterdir()))
        for value in ('data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,bm90IGFuIGltYWdl'):
            self.assertEqual(self.request('/music/api/admin/wall/upload','POST',dict(data=value),manager,headers)[0],400)
        status,_=self.request('/music/api/admin/wall/upload','POST',dict(data='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+b'x'*(2*1024*1024)).decode()),manager,headers)
        self.assertEqual(status,400)

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

    def test_other_members_private_gender_and_note_stay_private(self):
        self.legacy()
        service.upstream.data['members']['10002'].update(gender='private gender',genderPublic=False)
        service.upstream.data['members']['10001'].update(gender='own gender',genderPublic=False)
        with mock.patch.object(service.Handler,'note_allowed',return_value=False):
            result=self.request('/music/api/member?qq=10002&me=10002')[1]
            self.assertEqual(result['member']['gender'],'')
            self.assertEqual(result['member']['note'],'')
            compared=self.request('/music/api/compare?qq=10002&me=10002')[1]
            self.assertEqual(compared['other']['note'],'')
            self.assertEqual(compared['otherNote'],'')
        self.assertEqual(self.request('/music/api/me')[1]['member']['gender'],'own gender')
        service.upstream.data['members']['10002']['genderPublic']=True
        self.assertEqual(self.request('/music/api/member?qq=10002')[1]['member']['gender'],'private gender')

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
