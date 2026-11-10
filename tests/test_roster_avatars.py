"""QQ avatars decorate current rosters without changing identity or history."""
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import server
from test_roster import ModernClient
from qgroup_core import roster


class RosterAvatarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB = Path(cls.tmp.name) / 'avatars.sqlite3'
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
        env = mock.patch.dict(os.environ, KANBAN_QQ_APP_ID='12345', KANBAN_QQ_APP_KEY='fixture',
            KANBAN_ORIGIN='https://kanban.example.test',
            KANBAN_QQ_REDIRECT_URI='https://kanban.example.test/auth/qq/callback')
        env.start(); self.addCleanup(env.stop)
        self.owner = ModernClient(self.base).identify('群内称呼')
        self.claimant = ModernClient(self.base).identify('朋友本人')
        self.outsider = ModernClient(self.base).identify('旁观者')
        start = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        status, event = self.owner.request('/api/events', 'POST', dict(title='头像验收',category='约K',
            location='测试店',starts_at=start,deadline=start,duration_hours=3,capacity=0,description=''))
        self.assertEqual(status, 201, event)
        self.url = '/api/events/' + event['id']
        self.event_id = event['id']
        with server.connect() as db:
            self.uid = db.execute('SELECT owner_id FROM events WHERE id=?',(self.event_id,)).fetchone()[0]
            self.claimant_uid = db.execute("SELECT id FROM users WHERE nickname='朋友本人' ORDER BY rowid DESC").fetchone()[0]

    def profile(self, uid, url, provider='qq', app='12345', linked=True):
        with server.connect() as db:
            if linked:
                db.execute('INSERT OR REPLACE INTO external_identities VALUES(?,?,?,?,?,?)',
                    (provider,app,'private-subject-'+uid,uid,'QQ 昵称','now'))
            db.execute('INSERT OR REPLACE INTO external_profiles VALUES(?,?,?,?)',(provider,app,uid,url))

    def fresh(self, client=None):
        status, event = (client or self.owner).request(self.url)
        self.assertEqual(status, 200, event)
        return event

    def add_guest(self):
        data = dict(people=[dict(name='代报朋友')],base_revision=self.fresh()['revision'])
        status, preview = self.owner.request(self.url+'/roster/preview','POST',data)
        self.assertEqual(status,200,preview)
        status, event = self.owner.request(self.url+'/roster/parties','POST',{**data,**preview})
        self.assertEqual(status,200,event)
        return next(p for p in event['participants'] if p['is_guest'])

    def test_self_avatar_is_current_and_guest_never_inherits_manager_photo(self):
        self.profile(self.uid,'http://thirdqq.qlogo.cn/qqapp/1/owner/100')
        self.add_guest()
        event = self.fresh(self.outsider)
        owner = next(p for p in event['participants'] if not p['is_guest'])
        guest = next(p for p in event['participants'] if p['is_guest'])
        self.assertEqual(owner['nickname'],'群内称呼')
        self.assertEqual(owner['avatar_url'],'https://thirdqq.qlogo.cn/qqapp/1/owner/100')
        self.assertEqual(guest['avatar_url'],'')
        self.assertNotIn('private-subject-',json.dumps(event))
        self.assertNotIn('external_profiles',json.dumps(event))

    def test_claim_switches_to_attendee_own_photo_and_keeps_payment(self):
        self.profile(self.uid,'https://thirdqq.qlogo.cn/owner')
        self.profile(self.claimant_uid,'https://thirdqq.qlogo.cn/claimant')
        person = self.add_guest()
        status, event = self.owner.request(self.url+'/claims','POST',dict(attendee_id=person['id'],
            reason='本人核对',base_revision=self.fresh()['revision']))
        self.assertEqual(status,200,event)
        claim = next(c for c in event['claim_invitations'] if c['attendee_id']==person['id'])
        status, info = self.claimant.request(self.url+'/claims/'+claim['token'])
        self.assertEqual(status,200,info)
        status, result = self.claimant.request(self.url+'/claims/'+claim['token']+'/request','POST',
            dict(base_revision=info['base_revision'],confirm_identity=True,keep_payment=True))
        self.assertEqual(status,200,result)
        status, event = self.owner.request(self.url+'/claims/'+claim['id'],'POST',dict(
            base_revision=self.fresh()['revision'],decision='approve',confirm_person=True,reason='当面确认'))
        self.assertEqual(status,200,event)
        claimed = next(p for p in event['participants'] if p['id']==person['id'])
        self.assertEqual(claimed['avatar_url'],'https://thirdqq.qlogo.cn/claimant')
        self.assertEqual(claimed['payer_name'],person['payer_name'])
        self.assertFalse(claimed['is_guest'])

    def test_unlinked_foreign_provider_foreign_app_and_unsafe_urls_do_not_show(self):
        for url, provider, app, linked in [
            ('https://thirdqq.qlogo.cn/orphan','qq','12345',False),
            ('https://thirdqq.qlogo.cn/foreign','qq','99999',True),
            ('https://thirdqq.qlogo.cn/other','other','12345',True),
            ('https://evil.example/avatar','qq','12345',True),
            ('javascript:alert(1)','qq','12345',True),
        ]:
            with self.subTest(url=url):
                self.profile(self.uid,url,provider,app,linked)
                self.assertEqual(self.fresh()['my_registration']['avatar_url'],'')
        self.profile(self.uid,'https://thirdqq.qlogo.cn/valid')
        with mock.patch.dict(os.environ, KANBAN_QQ_APP_KEY=''):
            self.assertEqual(self.fresh()['my_registration']['avatar_url'],'')

    def test_anonymous_viewer_does_not_treat_unclaimed_guests_as_self(self):
        self.add_guest()
        status, event = ModernClient(self.base).request(self.url)
        self.assertEqual(status,200,event)
        self.assertIsNone(event['my_registration'])
        self.assertTrue(all(not p['is_me'] for p in event['participants']))
        self.assertEqual(event['my_attendees'],[])

    def test_invitation_permissions_and_history_are_unchanged(self):
        with server.connect() as db:
            db.execute("UPDATE events SET visibility='invitation' WHERE id=?",(self.event_id,))
            before = roster.snapshot(db,self.event_id)
            audits = db.execute('SELECT count(*) FROM event_audit WHERE event_id=?',(self.event_id,)).fetchone()[0]
        self.profile(self.uid,'https://thirdqq.qlogo.cn/first')
        self.assertEqual(self.outsider.request(self.url)[0],404)
        self.assertNotIn(self.event_id,json.dumps(self.outsider.request('/api/events')[1]))
        self.assertEqual(self.fresh()['my_registration']['avatar_url'],'https://thirdqq.qlogo.cn/first')
        self.profile(self.uid,'https://thirdqq.qlogo.cn/updated')
        self.assertEqual(self.fresh()['my_registration']['avatar_url'],'https://thirdqq.qlogo.cn/updated')
        with server.connect() as db:
            self.assertEqual(roster.snapshot(db,self.event_id),before)
            self.assertEqual(db.execute('SELECT count(*) FROM event_audit WHERE event_id=?',(self.event_id,)).fetchone()[0],audits)
        self.assertNotIn('avatar_url',json.dumps(self.owner.request(self.url+'/history')[1]))
