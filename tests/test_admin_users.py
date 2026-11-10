"""Account administrator grants, current-session authority, and user directory boundaries."""
import hashlib
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import server
from deploy.verify_migration import verify
from qgroup_core import accounts, storage
from test_roster import ModernClient


class AdminUserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join()

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        server.DB=Path(self.tmp.name)/'admin.sqlite3';server.initialize();server.LIMITS.clear()
        self.key='user-management-test-key-'+'x'*32
        env=mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':hashlib.sha256(self.key.encode()).hexdigest()})
        env.start();self.addCleanup(env.stop)
        self.manager=ModernClient(self.base)
        self.member=ModernClient(self.base).identify('成员甲')
        self.other=ModernClient(self.base).identify('成员乙')
        with server.connect() as db:
            self.uid=db.execute("SELECT id FROM users WHERE nickname='成员甲'").fetchone()[0]
            self.other_uid=db.execute("SELECT id FROM users WHERE nickname='成员乙'").fetchone()[0]
        self.assertEqual(self.manager.request('/api/admin/login','POST',dict(key=self.key))[0],200)
        self.info=self.manager.request('/api/admin/session')[1]

    def role(self,uid,value,revision=0,client=None,csrf=None,**extra):
        return (client or self.manager).request('/api/admin/users','POST',
            dict(user_id=uid,is_admin=value,base_revision=revision,**extra),
            headers={'X-Kanban-Admin':csrf or self.info['csrf']})

    def test_directory_and_role_writes_require_admin_and_csrf(self):
        guest=ModernClient(self.base)
        for client in (guest,self.member):
            self.assertEqual(client.request('/api/admin/users')[0],401)
            self.assertEqual(self.role(self.other_uid,True,client=client)[0],401)
        self.assertEqual(self.manager.request('/api/admin/users','POST',dict(user_id=self.uid,is_admin=True,base_revision=0))[0],403)
        self.assertEqual(self.member.request('/api/profile','POST',dict(nickname='管理员',is_admin=True))[0],200)
        self.assertEqual(self.member.request('/api/admin/session')[0],401)
        status,_=self.manager.request('/api/admin/users','POST',dict(user_id=self.uid,is_admin=True,base_revision=0),
            headers={'X-Kanban-Admin':self.info['csrf'],'Origin':'https://evil.test'})
        self.assertEqual(status,403)

    def test_directory_search_pagination_and_no_credentials(self):
        with server.connect() as db:
            db.execute("INSERT INTO external_identities VALUES('qq','private-app','private-openid',?,'绑定昵称','now')",(self.uid,))
            for i in range(23):accounts.create(db,'分页账号%02d'%i)
        status,info=self.manager.request('/api/admin/users');self.assertEqual(status,200)
        self.assertEqual(info['total'],25);self.assertEqual(len(info['users']),20)
        page=self.manager.request('/api/admin/users?offset=20')[1]
        self.assertEqual(len(page['users']),5)
        self.assertFalse({u['id'] for u in info['users']}&{u['id'] for u in page['users']})
        from urllib.parse import urlencode
        for search in ('绑定昵称','成员甲',self.uid):
            result=self.manager.request('/api/admin/users?'+urlencode(dict(search=search)))[1]
            self.assertEqual([u['id'] for u in result['users']],[self.uid])
            self.assertEqual(result['users'][0]['identities'],[dict(provider='qq',display_name='绑定昵称',unionid_bound=False)])
            self.assertNotIn('private-openid',str(result));self.assertNotIn('private-app',str(result))
            self.assertNotIn('token_hash',str(result))
        self.assertEqual(self.manager.request('/api/admin/users?search=%25')[1]['total'],0)
        for query in ('offset=-1','offset=nope','search='+'x'*101):
            self.assertEqual(self.manager.request('/api/admin/users?'+query)[0],400)

    def test_unionid_status_filters_use_the_exact_provider_identity(self):
        with server.connect() as db:
            db.execute("INSERT INTO external_identities VALUES('qq','app-a','same-subject',?,'甲QQ','now')",(self.uid,))
            db.execute("INSERT INTO external_identities VALUES('qq','app-b','same-subject',?,'乙QQ','now')",(self.other_uid,))
            db.execute("INSERT INTO external_unionids VALUES('qq','app-a','same-subject','private-unionid','now')")
            unbound=accounts.create(db,'未绑定QQ')
        for query,expected in [('bound',[self.uid]),('missing',[self.other_uid]),('unbound',[unbound])]:
            status,result=self.manager.request('/api/admin/users?unionid='+query)
            self.assertEqual(status,200);self.assertEqual([u['id'] for u in result['users']],expected)
            self.assertNotIn('private-unionid',str(result));self.assertNotIn('same-subject',str(result))
            if query!='unbound':self.assertEqual(result['users'][0]['identities'][0]['unionid_bound'],query=='bound')
        self.assertEqual(self.manager.request('/api/admin/users?unionid=invalid')[0],400)
        self.assertEqual(self.manager.request('/api/admin/users?unionid=missing&search='+self.uid)[1]['total'],0)

    def test_grant_allows_keyless_access_and_survives_initialization(self):
        self.assertEqual(self.role(self.uid,True)[0],200)
        server.initialize()
        with mock.patch.dict(os.environ,{'KANBAN_ADMIN_KEY_HASH':''}):
            status,info=self.member.request('/api/admin/session');self.assertEqual(status,200)
            self.assertEqual(info['auth_method'],'account');self.assertEqual(info['current_user_id'],self.uid)
            self.assertEqual(self.member.request('/api/admin/bot-settings')[0],200)
            self.assertEqual(self.role(self.other_uid,True,client=self.member,csrf=info['csrf'])[0],200)
            status,_=self.member.request('/api/admin/settings','POST',dict(allow_name_registration=False,base_revision=info['settings']['revision']),headers={'X-Kanban-Admin':info['csrf']})
            self.assertEqual(status,200)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM admin_sessions').fetchone()[0],1)
            actor=db.execute('SELECT actor_ref FROM admin_role_history WHERE user_id=?',(self.other_uid,)).fetchone()[0]
            self.assertEqual(actor,'account:'+self.uid)

    def test_revocation_blocks_every_device_and_old_grant_csrf(self):
        self.role(self.uid,True)
        with server.connect() as db:token=accounts.authenticate(db,'',self.uid)
        second=ModernClient(self.base);headers={'Cookie':'kanban_session='+token}
        self.assertEqual(second.request('/api/admin/session',headers=headers)[0],200)
        old=self.member.request('/api/admin/session')[1]
        self.assertEqual(self.role(self.uid,False,1)[0],200)
        self.assertEqual(self.member.request('/api/admin/session')[0],401)
        self.assertEqual(second.request('/api/admin/users',headers=headers)[0],401)
        self.assertEqual(self.role(self.other_uid,True,client=self.member,csrf=old['csrf'])[0],401)
        self.assertEqual(self.role(self.uid,True,2)[0],200)
        self.assertEqual(self.role(self.other_uid,True,client=self.member,csrf=old['csrf'])[0],403)
        self.assertNotEqual(old['csrf'],self.member.request('/api/admin/session')[1]['csrf'])

    def test_current_account_switch_and_logout_remove_authority(self):
        self.role(self.uid,True);self.role(self.other_uid,True)
        old=self.member.request('/api/admin/session')[1]
        with server.connect() as db:
            db.execute('INSERT OR IGNORE INTO browser_accounts SELECT token_hash,?,created_at FROM browser_sessions WHERE user_id=?',(self.other_uid,self.uid))
        scope=next(a['scope'] for a in self.member.request('/api/account')[1]['accounts'] if a['nickname']=='成员乙')
        self.assertEqual(self.member.request('/api/account/switch','POST',dict(scope=scope))[0],200)
        self.assertEqual(self.role(self.uid,False,1,client=self.member,csrf=old['csrf'])[0],403)
        current=self.member.request('/api/admin/session')[1]
        self.assertEqual(current['current_user_id'],self.other_uid)
        self.assertEqual(self.member.request('/api/admin/login','POST',dict(key=self.key))[0],200)
        self.assertEqual(self.member.request('/api/admin/logout','POST',{},headers={'X-Kanban-Admin':current['csrf']})[0],200)
        self.assertEqual(self.member.request('/api/admin/session')[0],401)
        self.assertFalse(self.member.request('/api/me')[1]['authenticated'])
        self.assertEqual(self.other.request('/api/admin/session')[0],200)

    def test_self_revocation_conflicts_and_validation(self):
        self.role(self.uid,True)
        info=self.member.request('/api/admin/session')[1]
        self.assertEqual(self.role(self.uid,False,1,client=self.member,csrf=info['csrf'])[0],403)
        self.assertEqual(self.role(self.uid,False)[0],409)
        for value,revision in [('true',1),(True,True),(False,'1')]:
            self.assertEqual(self.role(self.uid,value,revision)[0],400)
        self.assertEqual(self.role('missing',True)[0],404)
        self.assertEqual(self.role(self.uid,False,1)[0],200)

    def test_audit_failure_rolls_back_role_and_history_is_immutable(self):
        with server.connect() as db:db.execute("CREATE TRIGGER fail_role_audit BEFORE INSERT ON admin_role_history BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertLogs(level='ERROR'):self.assertEqual(self.role(self.uid,True)[0],500)
        self.assertEqual(self.member.request('/api/admin/session')[0],401)
        with server.connect() as db:
            self.assertIsNone(db.execute('SELECT * FROM user_admin_roles WHERE user_id=?',(self.uid,)).fetchone())
            db.execute('DROP TRIGGER fail_role_audit')
        self.role(self.uid,True)
        with server.connect() as db:
            for sql in ('UPDATE admin_role_history SET after_value=0','DELETE FROM admin_role_history'):
                with self.assertRaises(sqlite3.IntegrityError):db.execute(sql)

    def test_closed_account_is_revoked_hidden_and_cannot_be_granted_again(self):
        self.role(self.uid,True)
        self.assertEqual(self.member.request('/api/auth/close','POST',dict(confirm_close=True))[0],200)
        self.assertEqual(self.role(self.uid,True,2)[0],404)
        self.assertNotIn(self.uid,[u['id'] for u in self.manager.request('/api/admin/users')[1]['users']])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT is_admin FROM user_admin_roles WHERE user_id=?',(self.uid,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT actor_ref FROM admin_role_history ORDER BY id DESC LIMIT 1').fetchone()[0],'account_closure')

    def test_schema_13_upgrade_preserves_data_and_is_repeatable(self):
        source=Path(self.tmp.name)/'v13.sqlite3';destination=Path(self.tmp.name)/'v14.sqlite3'
        with server.connect() as db,sqlite3.connect(source) as copy:db.backup(copy)
        with sqlite3.connect(source) as db:
            db.execute('DROP TABLE admin_role_history');db.execute('DROP TABLE user_admin_roles')
            db.execute('DELETE FROM schema_migrations WHERE version=14')
        verify(source,destination)
        with storage.connect(destination) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM user_admin_roles').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0],14)


if __name__=='__main__':unittest.main()
