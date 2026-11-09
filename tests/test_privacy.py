"""Consent/closure security over HTTP and durable erasure after backup restore."""
import base64
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest import mock
from datetime import datetime,timedelta,timezone
import server
from test_roster import ModernClient
from test_api import test_png
from qgroup_core import privacy,accounts,qq_oauth,storage,media,identity
from deploy.backup import backup


class PrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'state'/'test.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.env=mock.patch.dict(os.environ,dict(KANBAN_QQ_APP_ID='12345',KANBAN_QQ_APP_KEY='secret',KANBAN_ORIGIN='https://example.test',KANBAN_QQ_REDIRECT_URI='https://example.test/auth/qq/callback',KANBAN_ADMIN_KEY_HASH=hashlib.sha256(b'privacy-admin-key-01234567890123456789').hexdigest()))
        self.env.start();self.addCleanup(self.env.stop)
        self.member=ModernClient(self.base).identify('待删除的个人称呼')
        self.guest=ModernClient(self.base);self.guest.request('/api/me')
        self.session=self.cookie(self.member);self.session_hash=hashlib.sha256(self.session.encode()).hexdigest()
        with server.connect() as db:self.uid=db.execute('SELECT user_id FROM browser_sessions WHERE token_hash=?',(self.session_hash,)).fetchone()[0]

    def cookie(self,client):
        jar=next(h.cookiejar for h in client.opener.handlers if isinstance(h,urllib.request.HTTPCookieProcessor))
        return next(c.value for c in jar if c.name=='kanban_session')

    def request_data(self,**extra):return dict(accept_privacy=True,privacy_version=privacy.VERSION,confirm=True,**extra)

    def close(self):return self.member.request('/api/auth/close','POST',dict(confirm_close=True))

    def test_consent_required_for_both_registration_routes_before_provider_data(self):
        for extra in [{},{'accept_privacy':False,'privacy_version':privacy.VERSION},{'accept_privacy':True,'privacy_version':'old'}]:
            self.assertEqual(self.guest.request('/api/auth/qq/start','POST',dict(mode='login',confirm=True,**extra))[0],400)
            self.assertEqual(self.guest.request('/api/register','POST',dict(nickname='临时',confirm=True,**extra))[0],400)
        status,result=self.guest.request('/api/auth/qq/start','POST',self.request_data(mode='login'))
        self.assertEqual(status,200,result)
        with server.connect() as db:
            row=db.execute('SELECT privacy_version FROM login_attempts WHERE token_hash=?',(hashlib.sha256(self.cookie(self.guest).encode()).hexdigest(),)).fetchone()
            self.assertEqual(row[0],privacy.VERSION)
        self.assertTrue(self.member.request('/api/me')[1]['privacy_accepted'])

    def test_verified_legacy_attempt_cannot_skip_policy_consent(self):
        self.assertEqual(self.member.request('/api/auth/qq/start','POST',dict(mode='bind',confirm=True))[0],200)
        with server.connect() as db:
            row=db.execute('SELECT id FROM login_attempts WHERE token_hash=?',(self.session_hash,)).fetchone()
            db.execute("UPDATE login_attempts SET status='verified',privacy_version='',openid=?,nickname='QQ测试' WHERE id=?",('A'*32,row['id']))
        status,result=self.member.request('/api/auth/qq/finish','POST',dict(attempt_id=row['id'],confirm=True))
        self.assertEqual(status,409,result)
        self.assertFalse(self.member.request('/api/me')[1]['qq']['bound'])

    def test_old_consent_requires_new_acceptance(self):
        with server.connect() as db:db.execute("UPDATE privacy_consents SET version='old' WHERE user_id=?",(self.uid,))
        self.assertFalse(self.member.request('/api/me')[1]['privacy_accepted'])
        self.assertEqual(self.member.request('/api/auth/qq/start','POST',dict(mode='bind',confirm=True))[0],400)
        self.assertEqual(self.member.request('/api/auth/qq/start','POST',self.request_data(mode='bind'))[0],200)

    def test_logout_clears_all_current_browser_grants_and_prevents_cookie_replay(self):
        with server.connect() as db:
            other=accounts.create(db,'另一个账号');db.execute('INSERT INTO browser_accounts VALUES(?,?,?)',(self.session_hash,other,'now'))
        self.assertEqual(self.member.request('/api/auth/logout','POST',{})[0],200)
        status,me=self.member.request('/api/me');self.assertFalse(me['authenticated'])
        self.assertEqual(self.guest.request('/api/profile','POST',dict(nickname='replay'),headers={'Cookie':'kanban_session='+self.session})[0],401)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM browser_accounts WHERE token_hash=?',(self.session_hash,)).fetchone()[0],0)
            self.assertIsNotNone(db.execute('SELECT 1 FROM users WHERE id=?',(other,)).fetchone())

    def test_close_removes_provider_private_images_and_all_device_grants(self):
        image=test_png(b'\x12\x34\x56');digest=hashlib.sha256(image).hexdigest()
        self.assertEqual(self.member.request('/api/payment-codes','POST',dict(kind='wechat',name='私人',image=base64.b64encode(image).decode()))[0],201)
        other_token='other-browser-for-privacy-test'
        with server.connect() as db:
            db.execute("INSERT INTO external_identities VALUES('qq','12345','PRIVATE-OPENID',?,'QQ真实昵称','now')",(self.uid,))
            db.execute("INSERT INTO external_profiles VALUES('qq','12345',?,'https://q.qlogo.cn/avatar')",(self.uid,))
            db.execute('INSERT INTO browser_sessions VALUES(?,?,?)',(hashlib.sha256(other_token.encode()).hexdigest(),self.uid,'now'))
        status,result=self.close();self.assertEqual(status,200,result);self.assertEqual(result['status'],'completed')
        self.assertFalse(self.member.request('/api/me')[1]['authenticated'])
        self.assertEqual(self.guest.request('/api/profile','POST',dict(nickname='replay'),headers={'Cookie':'kanban_session='+other_token})[0],401)
        with server.connect() as db:
            for table in ('external_identities','external_profiles','privacy_consents','user_payment_codes','browser_accounts'):
                self.assertEqual(db.execute('SELECT count(*) FROM '+table+' WHERE user_id=?',(self.uid,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT nickname FROM users WHERE id=?',(self.uid,)).fetchone()[0],'已注销用户')
            self.assertIsNone(db.execute('SELECT 1 FROM image_assets WHERE digest=?',(digest,)).fetchone())
            self.assertFalse(media.asset_path(media.root(db),digest).exists())
        ledger=server.DB.with_suffix('.erasures.jsonl');self.assertNotIn('PRIVATE-OPENID',ledger.read_text());self.assertEqual(ledger.stat().st_mode&0o777,0o600)

    def test_shared_images_are_preserved_and_request_remains_open(self):
        with server.connect() as db:
            second=accounts.create(db,'其他参与者')
            raw=test_png(b'\x23\x45\x67');digest=media.put(db,raw)
            db.execute("INSERT INTO user_payment_codes VALUES('privacy1',?,'wechat','自己的码',?,'now',NULL)",(self.uid,digest))
            db.execute("INSERT INTO user_payment_codes VALUES('privacy2',?,'wechat','另一人的码',?,'now',NULL)",(second,digest))
        self.assertEqual(self.close()[0],200)
        with server.connect() as db:self.assertEqual(media.read(db,digest),raw)

    def test_active_owner_cannot_orphan_activity_and_shared_history_is_not_falsely_deleted(self):
        start=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        status,event=self.member.request('/api/events','POST',dict(title='共同记录',category='聚餐',location='测试',starts_at=start,deadline=start,capacity=0,duration_hours=2))
        self.assertEqual(status,201,event);self.assertEqual(self.close()[0],409)
        self.assertEqual(self.member.request('/api/events/'+event['id'],'PATCH',dict(action='finish',base_revision=event['revision']))[0],200)
        with server.connect() as db:
            before={t:[tuple(r) for r in db.execute('SELECT * FROM '+t+' WHERE event_id=?',(event['id'],))] for t in ('event_audit','event_conditions','attendees')}
        status,result=self.close();self.assertEqual(status,200,result);self.assertEqual(result['status'],'shared_review')
        with server.connect() as db:
            self.assertEqual(before,{t:[tuple(r) for r in db.execute('SELECT * FROM '+t+' WHERE event_id=?',(event['id'],))] for t in before})
            privacy.review(db,dict(request_id=result['request_id'],note='已收到，正在核对共同记录',status='completed'))
            self.assertEqual(db.execute('SELECT status FROM privacy_requests WHERE id=?',(result['request_id'],)).fetchone()[0],'shared_review')

    def test_restore_reapplies_deletion_intents_before_serving(self):
        with tempfile.TemporaryDirectory() as folder:
            old=Path(folder)/'before.sqlite3'
            with server.connect() as db,sqlite3.connect(old) as copy:db.backup(copy)
            self.assertEqual(self.close()[0],200)
            shutil.copy2(server.DB.with_suffix('.erasures.jsonl'),old.with_suffix('.erasures.jsonl'))
            privacy.recover(old)
            with storage.connect(old) as db:
                self.assertIsNone(db.execute('SELECT 1 FROM browser_sessions WHERE user_id=?',(self.uid,)).fetchone())
                self.assertEqual(db.execute('SELECT nickname FROM users WHERE id=?',(self.uid,)).fetchone()[0],'已注销用户')
            privacy.recover(old)

    def test_admin_only_queue_and_csrf_protected_review(self):
        result=self.close()[1];admin=ModernClient(self.base)
        self.assertEqual(admin.request('/api/admin/session')[0],401)
        self.assertEqual(admin.request('/api/admin/login','POST',dict(key='privacy-admin-key-01234567890123456789'))[0],200)
        info=admin.request('/api/admin/session')[1];self.assertTrue(any(r['id']==result['request_id'] for r in info['privacy_requests']))
        self.assertEqual(admin.request('/api/admin/privacy-review','POST',dict(request_id=result['request_id'],note='已核对'))[0],403)
        self.assertEqual(admin.request('/api/admin/privacy-review','POST',dict(request_id=result['request_id'],note='已核对'),headers={'X-Kanban-Admin':info['csrf']})[0],200)

    def test_avatar_allowlist_upgrades_http_and_rejects_untrusted_sources(self):
        self.assertEqual(qq_oauth.avatar('http://thirdqq.qlogo.cn/qqapp/1/2/100'),'https://thirdqq.qlogo.cn/qqapp/1/2/100')
        for url in ['https://qlogo.cn.evil.test/a','https://evil.test/a','https://qlogo.cn@evil.test/a','https://qlogo.cn:443/a','data:image/png;base64,abc','https://qlogo.cn/a\n']:
            self.assertEqual(qq_oauth.avatar(url),'',url)

    def test_closure_requires_confirmation_and_rejects_stale_or_cross_origin(self):
        self.assertEqual(self.member.request('/api/auth/close','POST',{})[0],400)
        self.assertEqual(self.member.request('/api/auth/close','POST',dict(confirm_close=True),headers={'Origin':'https://evil.test'})[0],403)
        self.assertEqual(self.member.request('/api/auth/close','POST',dict(confirm_close=True),headers={'X-Kanban-Identity':'stale'})[0],409)
        self.assertTrue(self.member.request('/api/me')[1]['authenticated'])

    def test_backup_expires_by_age_as_well_as_count(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder);old=target/'kanban-old.sqlite3';old.write_bytes(b'old');companion=old.with_suffix('.images.tar.gz');companion.write_bytes(b'old')
            os.utime(old,(1,1));backup(server.DB,target)
            self.assertFalse(old.exists());self.assertFalse(companion.exists())
            ledger=server.DB.with_suffix('.erasures.jsonl')
            if ledger.exists():self.assertEqual((target/'privacy-erasures.jsonl').read_bytes(),ledger.read_bytes())

    def test_public_policies_and_contact_do_not_require_login(self):
        for route in ['/privacy','/contact']:
            with urllib.request.urlopen(self.base+route) as response:
                text=response.read().decode();self.assertIn(privacy.CONTACT,text);self.assertIn('渝ICP备16002872号-1',text)
                self.assertIsNone(response.headers.get('Set-Cookie'))
