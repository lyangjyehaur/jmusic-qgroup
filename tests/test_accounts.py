"""Registration policy, isolated admin authority, and guest OAuth account creation."""
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

import server
from test_roster import ModernClient
from test_qq_oauth import NoRedirect
from qgroup_core import accounts,qq_oauth,storage
from qgroup_core.common import APIError
from deploy.verify_migration import verify


class AccountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'accounts.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.key='administrator-test-key-'+'a'*32
        self.env=mock.patch.dict(os.environ,dict(KANBAN_ADMIN_KEY_HASH=hashlib.sha256(self.key.encode()).hexdigest(),
            KANBAN_QQ_APP_ID='12345',KANBAN_QQ_APP_KEY='secret',KANBAN_ORIGIN='https://example.test',KANBAN_QQ_REDIRECT_URI='https://example.test/auth/qq/callback'))
        self.env.start();self.addCleanup(self.env.stop)
        with server.connect() as db:db.execute('UPDATE site_settings SET allow_name_registration=0,revision=revision+1 WHERE id=1')
        self.guest=ModernClient(self.base);self.other=ModernClient(self.base);self.manager=ModernClient(self.base)
        self.guest.request('/api/me');self.other.request('/api/me')

    def count(self):
        with server.connect() as db:return db.execute('SELECT count(*) FROM users').fetchone()[0]

    def admin(self):
        status,result=self.manager.request('/api/admin/login','POST',dict(key=self.key));self.assertEqual(status,200,result)
        return self.manager.request('/api/admin/session')[1]

    def setting(self,value,session=None,**extra):
        session=session or self.manager.request('/api/admin/session')[1]
        return self.manager.request('/api/admin/settings','POST',dict({'allow_name_registration':value,'base_revision':session['settings']['revision']},**extra),headers={'X-Kanban-Admin':session['csrf']})

    def register(self,client=None,**extra):
        return (client or self.guest).request('/api/register','POST',dict({'nickname':'测试称呼','confirm':True,'accept_privacy':True,'privacy_version':'2026-11-09'},**extra))

    def test_fresh_install_is_closed_and_browsing_creates_no_account(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'new.sqlite3';storage.initialize(path)
            with storage.connect(path) as db:self.assertFalse(accounts.settings(db)['allow_name_registration'])
        before=self.count()
        for _ in range(3):
            status,me=self.guest.request('/api/me');self.assertEqual(status,200);self.assertFalse(me['authenticated'])
            self.assertFalse(me['allow_name_registration']);self.assertEqual(me['nickname'],'')
            self.assertEqual(self.guest.request('/api/events')[0],200)
            self.assertEqual(self.guest.request('/api/notifications')[1],dict(notifications=[],unread_count=0))
        self.assertEqual(self.count(),before)

    def test_closed_registration_cannot_be_bypassed_by_profile_or_forged_fields(self):
        before=self.count()
        self.assertEqual(self.register()[0],403)
        self.assertEqual(self.register(allow_name_registration=True,provider='qq',openid='A'*32)[0],403)
        for route,data in [('/api/profile',dict(nickname='fake')),('/api/events',dict(title='fake')),('/api/account/link',dict(authorize_device=True))]:
            self.assertEqual(self.guest.request(route,'POST',data)[0],401)
        self.assertEqual(self.count(),before)

    def test_only_admin_credential_can_change_policy_and_csrf_is_required(self):
        self.assertEqual(self.guest.request('/api/admin/session')[0],401)
        self.assertEqual(self.guest.request('/api/admin/settings','POST',dict(allow_name_registration=True,base_revision=0))[0],401)
        self.assertEqual(self.manager.request('/api/admin/login','POST',dict(key='wrong-key'*8))[0],401)
        info=self.admin()
        self.assertEqual(self.manager.request('/api/admin/settings','POST',dict(allow_name_registration=True,base_revision=info['settings']['revision']))[0],403)
        status,result=self.setting(True,info);self.assertEqual(status,200,result)
        self.assertTrue(self.guest.request('/api/me')[1]['allow_name_registration'])
        self.assertEqual(self.setting(False,info)[0],409)
        self.assertEqual(self.setting('yes')[0],400)

    def test_open_registration_then_close_preserves_existing_account(self):
        self.admin();self.assertEqual(self.setting(True)[0],200)
        before=self.count();self.assertEqual(self.register(confirm=False)[0],400)
        self.assertEqual(self.register()[0],200);self.assertEqual(self.count(),before+1)
        me=self.guest.request('/api/me')[1];self.assertTrue(me['authenticated']);self.assertEqual(me['nickname'],'测试称呼')
        self.assertEqual(self.setting(False)[0],200)
        self.assertEqual(self.register(self.other)[0],403)
        self.assertEqual(self.guest.request('/api/profile','POST',dict(nickname='新群内称呼'))[0],200)
        self.assertEqual(self.guest.request('/api/me')[1]['draft_scope'],me['draft_scope'])
        self.assertEqual(self.register()[0],409)
        with server.connect() as db:
            self.assertFalse(accounts.settings(db)['allow_name_registration'])
            self.assertEqual(db.execute("SELECT count(*) FROM admin_audit WHERE action='name_registration'").fetchone()[0]>0,True)

    def test_member_cannot_become_admin_and_admin_cannot_create_member_implicitly(self):
        before=self.count();self.admin();self.assertEqual(self.count(),before)
        self.setting(True);self.register();self.assertEqual(self.guest.request('/api/admin/session')[0],401)
        self.assertEqual(self.guest.request('/api/profile','POST',dict(nickname='管理员',is_admin=True))[0],200)
        self.assertEqual(self.guest.request('/api/admin/session')[0],401)

    def test_admin_logout_expiration_key_rotation_and_cross_origin_rejected(self):
        info=self.admin()
        self.assertEqual(self.manager.request('/api/admin/settings','POST',dict(allow_name_registration=True,base_revision=info['settings']['revision']),headers={'X-Kanban-Admin':info['csrf'],'Origin':'https://evil.test'})[0],403)
        self.assertEqual(self.manager.request('/api/admin/logout','POST',{},headers={'X-Kanban-Admin':info['csrf']})[0],200)
        self.assertEqual(self.manager.request('/api/admin/session')[0],401)
        self.admin()
        with mock.patch.dict(os.environ,dict(KANBAN_ADMIN_KEY_HASH='0'*64)):
            self.assertEqual(self.manager.request('/api/admin/session')[0],401)
        with server.connect() as db:db.execute("UPDATE admin_sessions SET expires_at='2000-01-01'")
        self.assertEqual(self.manager.request('/api/admin/session')[0],401)

    def test_admin_write_and_audit_are_atomic(self):
        info=self.admin()
        with server.connect() as db:db.execute("CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'injected'); END")
        try:
            with self.assertLogs(level='ERROR'):self.assertEqual(self.setting(True,info)[0],500)
            self.assertFalse(self.guest.request('/api/me')[1]['allow_name_registration'])
        finally:
            with server.connect() as db:db.execute('DROP TRIGGER fail_admin_audit')

    def test_policy_persists_through_initialization(self):
        self.admin();self.setting(True);server.initialize()
        self.assertTrue(self.guest.request('/api/me')[1]['allow_name_registration'])
        self.setting(False);server.initialize();self.assertFalse(self.guest.request('/api/me')[1]['allow_name_registration'])

    def ready_qq(self):
        me=self.guest.request('/api/me')[1]
        status,result=self.guest.request('/api/auth/qq/start','POST',dict(mode='login',confirm=True,accept_privacy=True,privacy_version='2026-11-09',return_path='/?event=example'))
        self.assertEqual(status,200,result)
        state=urllib.parse.parse_qs(urllib.parse.urlsplit(result['authorize_url']).query)['state'][0]
        processor=next(h for h in self.guest.opener.handlers if isinstance(h,urllib.request.HTTPCookieProcessor))
        self.guest.opener=urllib.request.build_opener(NoRedirect(),processor)
        responses=[dict(access_token='A'*32),dict(client_id='12345',openid=os.urandom(16).hex()),dict(ret=0,nickname='第三方用户')]
        with mock.patch.object(qq_oauth,'graph',side_effect=responses):
            try:response=self.guest.opener.open(self.base+'/auth/qq/callback?'+urllib.parse.urlencode(dict(state=state,code='TESTCODE')))
            except urllib.error.HTTPError as exc:response=exc
            self.assertEqual(response.code,303);response.close()
        ready=self.guest.request('/api/auth/qq/status')[1];self.assertEqual(ready['status'],'verified')
        return ready

    def test_guest_qq_first_login_works_when_name_registration_is_closed(self):
        before=self.count();ready=self.ready_qq();self.assertEqual(self.count(),before)
        self.assertEqual(self.guest.request('/api/auth/qq/finish','POST',dict(attempt_id=ready['attempt_id'],confirm=False))[0],400)
        status,result=self.guest.request('/api/auth/qq/finish','POST',dict(attempt_id=ready['attempt_id'],confirm=True))
        self.assertEqual(status,200,result);self.assertEqual(result['return_path'],'/?event=example')
        self.assertEqual(self.count(),before+1)
        me=self.guest.request('/api/me')[1];self.assertTrue(me['authenticated']);self.assertTrue(me['qq']['bound'])
        self.assertEqual(me['identities'],[dict(provider='qq',display_name='第三方用户')])
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM external_identities WHERE provider='qq' AND display_name='第三方用户'").fetchone()[0]>0,True)
        self.assertFalse(me['allow_name_registration'])

    def test_guest_cannot_bind_or_forge_verified_identity(self):
        before=self.count()
        self.assertEqual(self.guest.request('/api/auth/qq/start','POST',dict(mode='bind',confirm=True))[0],401)
        self.assertEqual(self.guest.request('/api/auth/qq/finish','POST',dict(attempt_id='a'*64,confirm=True,openid='A'*32))[0],409)
        self.assertEqual(self.count(),before)

    def test_qq_result_cannot_be_used_by_other_guest(self):
        ready=self.ready_qq()
        self.assertEqual(self.other.request('/api/auth/qq/finish','POST',dict(attempt_id=ready['attempt_id'],confirm=True))[0],409)
        self.assertFalse(self.other.request('/api/me')[1]['authenticated'])

    def test_oauth_return_path_does_not_allow_external_redirect(self):
        for path in ['https://evil.test','//evil.test','/\\evil.test','/admin','/?x=1\nLocation: https://evil.test']:
            self.assertEqual(self.guest.request('/api/auth/qq/start','POST',dict(mode='login',confirm=True,accept_privacy=True,privacy_version='2026-11-09',return_path=path))[0],400,path)

    def test_identity_namespace_reserves_wechat_without_sharing_qq_subjects(self):
        with server.connect() as db:
            a=accounts.create(db,'甲');b=accounts.create(db,'乙')
            db.execute("INSERT INTO external_identities VALUES('qq','same-app','same-subject',?,'甲','now')",(a,))
            db.execute("INSERT INTO external_identities VALUES('wechat','same-app','same-subject',?,'乙','now')",(b,))
            self.assertEqual(accounts.external(db,'qq','same-app','same-subject')['user_id'],a)
            self.assertEqual(accounts.external(db,'wechat','same-app','same-subject')['user_id'],b)
            with self.assertRaises(sqlite3.IntegrityError):db.execute("INSERT INTO external_identities VALUES('qq','same-app','same-subject',?,'乙','now')",(b,))

    def test_migration_copies_existing_qq_and_keeps_old_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'v7.sqlite3';destination=Path(folder)/'v8.sqlite3'
            with server.connect() as db,sqlite3.connect(source) as out:db.backup(out)
            with sqlite3.connect(source) as db:
                for table in ['external_profiles','privacy_consents','privacy_requests','external_identities','visitor_sessions','login_attempts','auth_requests','site_settings','admin_sessions','admin_audit']:db.execute('DROP TABLE '+table)
                db.execute('DELETE FROM schema_migrations WHERE version>=8')
                uid=accounts.create(db,'旧QQ账号')
                db.execute("INSERT INTO qq_accounts VALUES('app','subject',?,'旧账号','old')",(uid,))
            verify(source,destination)
            with storage.connect(destination) as db:
                self.assertEqual(accounts.external(db,'qq','app','subject')['user_id'],uid)
                self.assertFalse(accounts.settings(db)['allow_name_registration'])
