"""Optional UnionID backfill preserves existing accounts and private identifiers."""
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest import mock

import server
import test_qq_oauth as oauth_tests
from qgroup_core import privacy,storage,unionids
from qgroup_core.common import APIError,now
from deploy.verify_migration import verify,snapshot


class UnionIDTests(unittest.TestCase):
    setUpClass=classmethod(oauth_tests.QQTests.setUpClass.__func__)
    tearDownClass=classmethod(oauth_tests.QQTests.tearDownClass.__func__)
    begin=oauth_tests.QQTests.begin
    callback=oauth_tests.QQTests.callback
    ready=oauth_tests.QQTests.ready
    finish=oauth_tests.QQTests.finish

    def setUp(self):
        self.union_value='UID_fixture_private_union_identifier'
        oauth_tests.QQTests.setUp(self)

    def graph(self,path,params):
        if path=='/oauth2.0/me':
            self.assertEqual(params.get('unionid'),1)
            return dict(client_id='12345',openid=self.openid,unionid=self.union_value)
        return oauth_tests.QQTests.graph(self,path,params)

    def stored(self,openid=None):
        with storage.connect(server.DB) as db:
            row=db.execute("SELECT union_id FROM external_unionids WHERE provider='qq' AND client_id='12345' AND subject=?",
                           (openid or self.openid,)).fetchone()
            return row[0] if row else None

    def test_existing_identity_backfills_without_new_account_or_business_changes(self):
        self.union_value=None
        self.assertEqual(self.finish(self.ready())[0],200)
        original=self.owner.request('/api/me')[1]['draft_scope']
        start=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        self.assertEqual(self.owner.request('/api/events','POST',dict(title='原有活动',category='约K',location='测试',
            starts_at=start,deadline=start,capacity=0,duration_hours=3))[0],201)
        tables=['events','attendees','roster_parties','event_audit','event_conditions','settlements',
                'settlement_history','finance_entries','finance_reports']
        with storage.connect(server.DB) as db:
            before={table:[tuple(r) for r in db.execute('SELECT * FROM '+table)] for table in tables}
            users=db.execute('SELECT count(*) FROM users').fetchone()[0]
        self.assertIsNone(self.stored())
        self.union_value='UID_fixture_private_union_identifier'
        ready=self.ready(mode='login')
        status,result=self.finish(ready)
        self.assertEqual(status,200,result)
        self.assertFalse(result['new_account'])
        self.assertEqual(self.owner.request('/api/me')[1]['draft_scope'],original)
        self.assertEqual(self.stored(),self.union_value)
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],users)
            self.assertEqual({table:[tuple(r) for r in db.execute('SELECT * FROM '+table)] for table in tables},before)

    def test_unionid_is_not_exposed_before_confirmation_or_in_public_responses(self):
        ready=self.ready()
        self.assertIsNone(self.stored())
        self.assertNotIn(self.union_value,json.dumps(ready))
        self.assertEqual(self.finish(ready,confirm=False)[0],400)
        self.assertIsNone(self.stored())
        self.assertEqual(self.finish(ready)[0],200)
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT union_id FROM login_attempts WHERE id=?',(ready['attempt_id'],)).fetchone()[0],'')
        for path in ['/api/me','/api/account','/api/events','/api/account/qq/status']:
            response=self.owner.request(path)[1]
            self.assertNotIn(self.union_value,json.dumps(response))
            self.assertNotIn('union_id',json.dumps(response))

    def test_missing_or_invalid_value_does_not_clear_previous_unionid(self):
        expected=self.union_value
        self.assertEqual(self.finish(self.ready())[0],200)
        for value in [None,'',{},'UID contains spaces','bad\r\nvalue','x'*257]:
            with self.subTest(value=value):
                self.union_value=value
                self.assertEqual(self.finish(self.ready())[0],200)
                self.assertEqual(self.stored(),expected)

    def test_conflicting_value_is_preserved_and_logged_without_raw_identifiers(self):
        expected=self.union_value
        self.assertEqual(self.finish(self.ready())[0],200)
        self.union_value='UID_unexpected_different_value'
        with self.assertLogs(level='INFO') as logs:
            self.assertEqual(self.finish(self.ready())[0],200)
        self.assertEqual(self.stored(),expected)
        text=' '.join(logs.output)
        self.assertIn('conflict_preserved',text)
        for private in [expected,self.union_value,self.openid,'TESTCODE','A'*32,'test-secret-never-persist']:
            self.assertNotIn(private,text)

    def test_optional_unionid_request_failure_falls_back_to_original_login(self):
        def provider(path,params):
            if path=='/oauth2.0/me':
                if params.get('unionid')==1:raise APIError('fixture provider failure',502)
                self.assertNotIn('unionid',params)
                return dict(client_id='12345',openid=self.openid)
            return oauth_tests.QQTests.graph(self,path,params)
        with mock.patch.object(server.qq_oauth,'graph',side_effect=provider):
            with self.assertLogs(level='INFO') as logs:
                self.assertEqual(self.finish(self.ready())[0],200)
        self.assertIsNone(self.stored())
        self.assertTrue(self.owner.request('/api/me')[1]['qq']['bound'])
        self.assertIn('status=fallback',' '.join(logs.output))

    def test_same_unionid_never_merges_different_openid_accounts(self):
        self.assertEqual(self.finish(self.ready())[0],200)
        original=self.owner.request('/api/me')[1]['draft_scope']
        first_openid=self.openid
        self.openid='F'*32
        self.assertEqual(self.finish(self.ready(self.other,'login'),self.other)[0],200)
        self.assertNotEqual(self.other.request('/api/me')[1]['draft_scope'],original)
        self.assertEqual(self.stored(first_openid),self.stored())

    def test_account_erasure_removes_unionid_with_external_identity(self):
        self.assertEqual(self.finish(self.ready())[0],200)
        with storage.connect(server.DB) as db:
            uid=db.execute("SELECT user_id FROM external_identities WHERE provider='qq' AND subject=?",(self.openid,)).fetchone()[0]
            privacy.erase(db,uid,'fixture-request',now())
            self.assertIsNone(db.execute("SELECT 1 FROM external_unionids WHERE subject=?",(self.openid,)).fetchone())
            self.assertFalse(db.execute('PRAGMA foreign_key_check').fetchall())

    def test_success_logs_only_presence_and_backfill_status(self):
        with self.assertLogs(level='INFO') as logs:
            self.assertEqual(self.finish(self.ready())[0],200)
        text=' '.join(logs.output)
        self.assertIn('qq_unionid_fetch status=received',text)
        self.assertIn('qq_unionid_link status=backfill_staged',text)
        for private in [self.union_value,self.openid,'TESTCODE','A'*32,'test-secret-never-persist']:
            self.assertNotIn(private,text)

    def test_migration_preserves_old_values_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'before.sqlite3';destination=Path(folder)/'after.sqlite3'
            with storage.connect(server.DB) as db,sqlite3.connect(source) as out:db.backup(out)
            with sqlite3.connect(source) as db:
                db.execute('DROP TABLE external_unionids')
                db.execute('ALTER TABLE login_attempts DROP COLUMN union_id')
                db.execute('DELETE FROM schema_migrations WHERE version=12')
            verify(source,destination)
            with storage.connect(destination) as db:
                self.assertEqual(db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0],12)
                self.assertEqual(db.execute('SELECT count(*) FROM external_unionids').fetchone()[0],0)
                self.assertTrue(all(r[0]=='' for r in db.execute('SELECT union_id FROM login_attempts')))
                first=snapshot(db)
            storage.initialize(destination)
            with storage.connect(destination) as db:self.assertEqual(snapshot(db),first)
