import concurrent.futures
import base64
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

import server
from test_api import Client, test_png


class ModernClient(Client):
    def request(self,path,method='GET',data=None,headers=None):
        supplied = {'X-Kanban-Version':'2'}
        if data is not None:
            supplied['Idempotency-Key'] = uuid.uuid4().hex
        supplied.update(headers or {})
        return super().request(path,method,data,supplied)


class RosterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB = Path(cls.tmp.name)/'roster.sqlite3'
        server.initialize()
        cls.http = server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d' % cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.thread.join(); cls.tmp.cleanup()

    def setUp(self):
        server.LIMITS.clear()
        self.owner = ModernClient(self.base).identify('发起者')
        self.manager = ModernClient(self.base).identify('小明')
        self.visitor = ModernClient(self.base).identify('访客')
        start = datetime.now(timezone.utc)+timedelta(days=2)
        self.data = dict(title='约K',category='约K',location='测试店',starts_at=start.isoformat(),
            deadline=(start-timedelta(hours=1)).isoformat(),duration_hours=3,capacity=3,description='',join_owner=False)
        status,self.event = self.owner.request('/api/events','POST',self.data)
        self.assertEqual(status,201)
        self.url = '/api/events/'+self.event['id']

    def event_for(self,client=None):
        status,result = (client or self.owner).request(self.url)
        self.assertEqual(status,200)
        return result

    def preview(self,client,people,**extra):
        data = {'people':people,'queue_mode':'individual','intent':'registered',**extra}
        status,result = client.request(self.url+'/roster/preview','POST',data)
        self.assertEqual(status,200,result)
        return data,result

    def signup(self,client,people,**extra):
        data,preview = self.preview(client,people,**extra)
        status,result = client.request(self.url+'/roster/parties','POST',{**data,**preview,'accept_partial':True})
        self.assertEqual(status,200,result)
        return result

    def act(self,client,person,method='PATCH',**data):
        current = self.event_for(client)
        return client.request(self.url+'/attendees/'+person['id'],method,{'base_revision':current['revision'],**data})

    def past_exit_deadline(self):
        past = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        with sqlite3.connect(str(server.DB)) as db:
            db.execute('UPDATE events SET withdrawal_deadline=? WHERE id=?',(past,self.event['id']))

    def test_owner_can_join_at_creation_or_only_organize(self):
        self.assertEqual(self.event['confirmed_count'],0)
        status,result = self.owner.request('/api/events','POST',{**self.data,'join_owner':True})
        self.assertEqual(status,201)
        self.assertEqual(result['confirmed_count'],1)
        self.assertTrue(result['my_registration']['is_me'])
        self.assertEqual(len(self.owner.request('/api/events/'+result['id']+'/history')[1]['entries']),2)

    def test_default_creation_registers_owner_once_and_counts_the_place(self):
        data={key:value for key,value in self.data.items() if key!='join_owner'}
        data['capacity']=1
        key='owner-default-'+self.event['id']
        status,result=self.owner.request('/api/events','POST',data,headers={'Idempotency-Key':key})
        self.assertEqual(status,201)
        self.assertEqual(result['confirmed_count'],1)
        self.assertEqual(len(result['participants']),1)
        self.assertTrue(result['my_registration']['is_me'])
        self.assertEqual(result['my_registration']['status'],'confirmed')
        status,replayed=self.owner.request('/api/events','POST',data,headers={'Idempotency-Key':key})
        self.assertEqual(status,201)
        self.assertEqual(replayed['id'],result['id'])
        self.assertEqual(len(replayed['participants']),1)
        self.url='/api/events/'+result['id']
        joined=self.signup(self.manager,[{'is_self':True}])
        self.assertEqual(joined['confirmed_count'],1)
        self.assertEqual(joined['waiting_count'],1)

    def test_proxy_people_count_as_people_and_keep_payer_assignment(self):
        result = self.signup(self.manager,[{'name':'朋友甲'},{'name':'朋友乙','payer_kind':'self'}])
        self.assertEqual(result['confirmed_count'],2)
        self.assertIsNone(result['my_registration'])
        self.assertEqual(len(result['my_attendees']),2)
        self.assertEqual([p['payer_name'] for p in result['participants']],['小明','朋友乙'])
        self.assertTrue(all(p['managed_by_me'] for p in result['participants']))
        stranger = self.event_for(self.visitor)
        self.assertTrue(all(not p['can_manage'] for p in stranger['participants']))

    def test_partial_waitlist_needs_explicit_acceptance_and_fresh_preview(self):
        self.signup(self.owner,[{'is_self':True},{'name':'朋友一'}])
        data,preview = self.preview(self.manager,[{'name':'同行甲'},{'name':'同行乙'}])
        self.assertEqual([p['status'] for p in preview['allocation']],['confirmed','waiting'])
        self.assertEqual(self.manager.request(self.url+'/roster/parties','POST',{**data,**preview})[0],409)
        self.assertEqual(self.event_for()['confirmed_count'],2)
        result = self.manager.request(self.url+'/roster/parties','POST',{**data,**preview,'accept_partial':True})
        self.assertEqual(result[0],200)
        self.assertEqual(result[1]['confirmed_count'],3)
        self.assertEqual(result[1]['waiting_count'],1)

    def test_preview_rejects_modified_body_and_racing_signup(self):
        data,preview = self.preview(self.manager,[{'name':'预览的朋友'}])
        self.assertEqual(self.manager.request(self.url+'/roster/parties','POST',{**data,**preview,'people':[{'name':'偷换的朋友'}]})[0],409)
        self.signup(self.visitor,[{'is_self':True}])
        self.assertEqual(self.manager.request(self.url+'/roster/parties','POST',{**data,**preview})[0],409)
        self.assertEqual(self.event_for()['confirmed_count'],1)

    def test_together_waitlist_blocks_overtaking_and_can_split(self):
        self.signup(self.owner,[{'is_self':True},{'name':'朋友一'}])
        result = self.signup(self.manager,[{'name':'同行甲'},{'name':'同行乙'}],queue_mode='together')
        self.assertEqual(result['confirmed_count'],2)
        self.assertEqual(result['waiting_count'],2)
        late = self.signup(self.visitor,[{'is_self':True}])
        self.assertEqual(late['my_registration']['status'],'waiting')
        person = next(p for p in result['participants'] if p['managed_by_me'])
        status,split = self.act(self.manager,person,action='split')
        self.assertEqual(status,200)
        self.assertEqual(split['confirmed_count'],3)
        self.assertEqual(self.event_for(self.visitor)['my_registration']['status'],'waiting')

    def test_adding_guests_does_not_take_existing_places_or_queue_priority(self):
        first = self.signup(self.manager,[{'is_self':True}])
        self.signup(self.owner,[{'is_self':True},{'name':'朋友一'}])
        waiter = self.signup(self.visitor,[{'is_self':True}])
        result = self.signup(self.manager,[{'name':'后来同行'}])
        self.assertEqual(result['my_registration']['status'],'confirmed')
        self.assertEqual(self.act(self.manager,first['my_registration'],'DELETE')[0],200)
        self.assertEqual(self.event_for(self.visitor)['my_registration']['status'],'confirmed')
        guest = next(p for p in self.event_for(self.manager)['participants'] if p['nickname']=='后来同行')
        self.assertEqual(guest['status'],'waiting')

    def test_tentative_does_not_hold_seats_and_confirmation_joins_new_queue(self):
        pending = self.signup(self.manager,[{'is_self':True},{'name':'待确认同行'}],intent='tentative',queue_mode='together')
        self.assertEqual(pending['confirmed_count'],0)
        self.assertEqual(pending['tentative_count'],2)
        self.signup(self.owner,[{'is_self':True},{'name':'已确认同行'}])
        status,result = self.act(self.manager,pending['my_registration'],action='confirm')
        self.assertEqual(status,200)
        self.assertEqual(result['confirmed_count'],2)
        self.assertEqual(result['waiting_count'],2)
        self.assertEqual(result['tentative_count'],0)

    def test_unrelated_person_cannot_edit_withdraw_or_claim_by_same_name(self):
        result = self.signup(self.manager,[{'name':'同名'},{'name':'同名'}])
        self.assertEqual(len({p['id'] for p in result['participants']}),2)
        target = result['participants'][0]
        self.assertEqual(self.act(self.visitor,target,name='改名',note='')[0],403)
        self.assertEqual(self.act(self.visitor,target,'DELETE')[0],403)
        self.assertEqual(self.act(self.owner,target,'DELETE')[0],400)
        self.assertEqual(self.act(self.owner,target,'DELETE',reason='重复报名，已与代报者核对')[0],200)
        notifications = self.manager.request('/api/notifications')[1]['notifications']
        self.assertEqual(notifications[0]['kind'],'removed')

    def test_capacity_cannot_silently_demote_confirmed_people(self):
        self.signup(self.manager,[{'name':'甲'},{'name':'乙'},{'name':'丙'}])
        event = self.event_for()
        status,_ = self.owner.request(self.url,'PATCH',{**self.data,'capacity':2,'base_revision':event['revision']})
        self.assertEqual(status,409)
        self.assertEqual(self.event_for()['confirmed_count'],3)

    def test_late_withdrawal_needs_reason_and_owner_decision(self):
        result = self.signup(self.manager,[{'is_self':True}])
        self.past_exit_deadline()
        self.assertEqual(self.act(self.manager,result['my_registration'],'DELETE')[0],400)
        status,pending = self.act(self.manager,result['my_registration'],'DELETE',reason='临时有事')
        self.assertEqual(status,200)
        self.assertEqual(pending['confirmed_count'],1)
        self.assertTrue(pending['my_registration']['withdrawal_requested'])
        url = self.url+'/attendees/'+result['my_registration']['id']+'/withdrawal'
        revision = self.event_for()['revision']
        self.assertEqual(self.manager.request(url,'PATCH',{'base_revision':revision,'decision':'approve','reason':'自己批准'})[0],403)
        self.assertEqual(self.owner.request(url,'PATCH',{'base_revision':revision,'reason':'缺少决定'})[0],400)
        status,approved = self.owner.request(url,'PATCH',{'base_revision':revision,'decision':'approve','reason':'已确认，可退出'})
        self.assertEqual(status,200)
        self.assertEqual(approved['confirmed_count'],0)
        self.assertIsNone(self.event_for(self.manager)['my_registration'])

    def test_rejecting_withdrawal_keeps_seat_and_audit_reason(self):
        result = self.signup(self.manager,[{'is_self':True}])
        self.past_exit_deadline()
        self.act(self.manager,result['my_registration'],'DELETE',reason='想退出')
        url = self.url+'/attendees/'+result['my_registration']['id']+'/withdrawal'
        status,_ = self.owner.request(url,'PATCH',{'base_revision':self.event_for()['revision'],'decision':'reject','reason':'请先联系确认订金处理'})
        self.assertEqual(status,200)
        current = self.event_for(self.manager)
        self.assertEqual(current['confirmed_count'],1)
        self.assertFalse(current['my_registration']['withdrawal_requested'])
        entries = self.manager.request(self.url+'/history')[1]['entries']
        self.assertEqual(entries[0]['action'],'withdrawal_reject')
        self.assertIn('订金',entries[0]['reason'])

    def test_waiter_can_withdraw_after_exit_deadline_without_owner_approval(self):
        self.signup(self.owner,[{'is_self':True},{'name':'甲'},{'name':'乙'}])
        result = self.signup(self.manager,[{'is_self':True}])
        self.past_exit_deadline()
        status,updated = self.act(self.manager,result['my_registration'],'DELETE')
        self.assertEqual(status,200)
        self.assertEqual(updated['waiting_count'],0)

    def test_promotions_create_owned_notifications_and_can_be_marked_read(self):
        full = self.signup(self.owner,[{'is_self':True},{'name':'甲'},{'name':'乙'}])
        self.signup(self.manager,[{'is_self':True}])
        self.act(self.owner,full['participants'][0],'DELETE')
        result = self.manager.request('/api/notifications')[1]
        self.assertEqual(result['unread_count'],1)
        uid = result['notifications'][0]['id']
        self.visitor.request('/api/notifications/read','POST',{'ids':[uid]})
        self.assertEqual(self.manager.request('/api/notifications')[1]['unread_count'],1)
        self.manager.request('/api/notifications/read','POST',{'ids':[uid]})
        self.assertEqual(self.manager.request('/api/notifications')[1]['unread_count'],0)

    def test_invitation_visibility_covers_lists_history_and_payment_images(self):
        current = self.event_for()
        status,private = self.owner.request(self.url,'PATCH',{**self.data,'visibility':'invitation','base_revision':current['revision']})
        self.assertEqual(status,200)
        self.assertEqual(self.visitor.request(self.url)[0],404)
        self.assertNotIn(self.event['id'],[e['id'] for e in self.visitor.request('/api/events')[1]['events']])
        for suffix in ['/history','/settlement/history','/payment-code','/settlement/history/1/payment-code']:
            self.assertEqual(self.visitor.request(self.url+suffix)[0],404)
        self.assertEqual(self.visitor.request(self.url+'/access','POST',{'invite_token':'wrong'})[0],403)
        self.assertEqual(self.visitor.request(self.url+'/access','POST',{'invite_token':private['share_token']})[0],200)
        viewed = self.event_for(self.visitor)
        self.assertIsNone(viewed['share_token'])
        self.assertNotIn('invite_token',viewed)
        self.assertEqual(self.visitor.request(self.url+'/history')[0],200)

    def test_late_invitation_does_not_reserve_place_and_requires_recipient_acceptance(self):
        past = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        with sqlite3.connect(str(server.DB)) as db:
            db.execute('UPDATE events SET deadline=? WHERE id=?',(past,self.event['id']))
        revision = self.event_for()['revision']
        self.assertEqual(self.visitor.request(self.url+'/roster/invitations','POST',{'base_revision':revision,'people':[{'name':'受邀者'}],'reason':'补位'})[0],403)
        status,result = self.owner.request(self.url+'/roster/invitations','POST',{'base_revision':revision,'people':[{'name':'受邀者'}],'reason':'与受邀者联系后补报名'})
        self.assertEqual(status,200)
        self.assertEqual(result['confirmed_count'],0)
        token = result['pending_invitations'][0]['invitation_token']
        self.assertEqual(self.event_for(self.visitor)['pending_invitations'],[])
        info = self.visitor.request(self.url+'/invitations/'+token)[1]
        body = {'base_revision':info['base_revision']}
        key = uuid.uuid4().hex
        path = self.url+'/invitations/'+token+'/accept'
        status,accepted = self.visitor.request(path,'POST',body,{'Idempotency-Key':key})
        self.assertEqual(status,200)
        self.assertEqual(accepted['confirmed_count'],1)
        self.assertTrue(accepted['my_registration']['is_me'])
        self.assertEqual(self.visitor.request(path,'POST',body,{'Idempotency-Key':key})[0],200)
        self.assertEqual(self.manager.request(self.url+'/invitations/'+token)[0],404)

    def test_private_payment_images_require_access_even_with_known_urls(self):
        current = self.event_for()
        status,private = self.owner.request(self.url,'PATCH',{**self.data,'visibility':'invitation','base_revision':current['revision']})
        self.assertEqual(status,200)
        status,ended = self.owner.request(self.url,'PATCH',{'status':'finished','base_revision':private['revision']})
        self.assertEqual(status,200)
        status,bill = self.owner.request(self.url+'/settlement','PUT',{'base_revision':ended['revision'],
            'base_version':0,'total_amount':'12.00','headcount':1,'qr_image':base64.b64encode(test_png()).decode()})
        self.assertEqual(status,200)
        anonymous = ModernClient(self.base)
        for suffix in ['/payment-code','/settlement/history/1/payment-code']:
            self.assertEqual(anonymous.request(self.url+suffix)[0],404)
            self.assertEqual(self.visitor.request(self.url+suffix)[0],404)
        self.visitor.request(self.url+'/access','POST',{'invite_token':private['share_token']})
        for suffix in ['/payment-code','/settlement/history/1/payment-code']:
            with self.visitor.opener.open(self.base+self.url+suffix) as response:
                self.assertEqual(response.read(),test_png())
        public_json = json.dumps(self.event_for(self.visitor),ensure_ascii=False)
        history_json = json.dumps(self.visitor.request(self.url+'/history')[1],ensure_ascii=False)
        self.assertNotIn(private['share_token'],public_json+history_json)

    def test_full_invitation_requires_waitlist_consent_and_cannot_duplicate_self(self):
        self.signup(self.owner,[{'is_self':True},{'name':'甲'},{'name':'乙'}])
        status,invited = self.owner.request(self.url+'/roster/invitations','POST',{
            'base_revision':self.event_for()['revision'],'people':[{'name':'补报名一'},{'name':'补报名二'}],'reason':'补报名'})
        self.assertEqual(status,200)
        first,second = [p['invitation_token'] for p in invited['pending_invitations']]
        path = self.url+'/invitations/'+first+'/accept'
        body = {'base_revision':invited['revision']}
        self.assertEqual(self.visitor.request(path,'POST',body)[0],409)
        status,accepted = self.visitor.request(path,'POST',{**body,'accept_waiting':True})
        self.assertEqual(status,200)
        self.assertEqual(accepted['my_registration']['status'],'waiting')
        self.assertEqual(self.visitor.request(self.url+'/invitations/'+second+'/accept','POST',{
            'base_revision':accepted['revision'],'accept_waiting':True})[0],409)

    def test_bill_defaults_include_confirmed_guests_but_not_waiting_or_tentative(self):
        self.signup(self.manager,[{'name':'甲'},{'name':'乙'},{'name':'丙'},{'name':'候补'}])
        self.signup(self.visitor,[{'is_self':True}],intent='tentative')
        status,ended = self.owner.request(self.url,'PATCH',{'base_revision':self.event_for()['revision'],'status':'finished'})
        self.assertEqual(status,200)
        status,result = self.owner.request(self.url+'/settlement','PUT',{'base_revision':ended['revision'],
            'base_version':0,'total_amount':'90.00'})
        self.assertEqual(status,200)
        self.assertEqual(result['settlement']['headcount'],3)
        self.assertEqual(result['settlement']['per_person_amount'],'30.00')
        revision = result['revision']
        status,repeated = self.owner.request(self.url+'/settlement','PUT',{'base_revision':revision,
            'base_version':1,'total_amount':'90.00'})
        self.assertEqual(status,200)
        self.assertEqual(repeated['revision'],revision)
        self.assertEqual(repeated['settlement']['version'],1)

    def test_legacy_registration_obeys_new_group_cutoff_and_settlement_rules(self):
        full = self.signup(self.owner,[{'is_self':True},{'name':'甲'}])
        self.signup(self.manager,[{'name':'整组一'},{'name':'整组二'}],queue_mode='together')
        legacy_headers = {'X-Kanban-Version':'1'}
        status,waiting = self.visitor.request(self.url+'/registration','PUT',{},legacy_headers)
        self.assertEqual(status,200)
        self.assertEqual(waiting['my_registration']['status'],'waiting')
        self.past_exit_deadline()
        self.assertEqual(self.owner.request(self.url+'/registration','DELETE',{},legacy_headers)[0],400)
        self.assertEqual(self.event_for()['confirmed_count'],2)
        with sqlite3.connect(str(server.DB)) as db:
            db.execute('UPDATE events SET deadline=? WHERE id=?',('2000-01-01T00:00:00+00:00',self.event['id']))
        self.assertEqual(self.visitor.request(self.url+'/registration','PUT',{'note':'截止后改备注'},legacy_headers)[0],409)
        ended = self.owner.request(self.url,'PATCH',{'base_revision':self.event_for()['revision'],'status':'finished'})[1]
        self.owner.request(self.url+'/settlement','PUT',{'base_revision':ended['revision'],'base_version':0,'total_amount':'10.00'})
        self.assertEqual(self.visitor.request(self.url+'/registration','DELETE',{},legacy_headers)[0],409)

    def test_concurrent_identical_create_request_creates_one_event(self):
        key = uuid.uuid4().hex
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.owner.request,'/api/events','POST',self.data,{'Idempotency-Key':key}) for _ in range(2)]
            results = [f.result() for f in futures]
        self.assertEqual(results[0],results[1])
        self.assertEqual(results[0][0],201)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events WHERE id=?',(results[0][1]['id'],)).fetchone()[0],1)

    def test_idempotency_and_versions_prevent_duplicate_party_and_overwrite(self):
        data,preview = self.preview(self.manager,[{'name':'同行'}])
        body = {**data,**preview}
        key = uuid.uuid4().hex
        path = self.url+'/roster/parties'
        first = self.manager.request(path,'POST',body,{'Idempotency-Key':key})
        repeated = self.manager.request(path,'POST',body,{'Idempotency-Key':key})
        self.assertEqual(first,repeated)
        self.assertEqual(self.event_for()['confirmed_count'],1)
        self.assertEqual(self.manager.request(path,'POST',{**body,'accept_partial':True},{'Idempotency-Key':key})[0],409)
        self.assertEqual(self.manager.request(path,'POST',body)[0],409)

    def test_concurrent_previews_commit_only_one_matching_event_revision(self):
        data_a,preview_a = self.preview(self.manager,[{'name':'甲'}])
        data_b,preview_b = self.preview(self.visitor,[{'name':'乙'}])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(client.request,self.url+'/roster/parties','POST',{**data,**preview})
                for client,data,preview in [(self.manager,data_a,preview_a),(self.visitor,data_b,preview_b)]]
            results = [f.result() for f in futures]
        self.assertEqual(sorted(status for status,_ in results),[200,409])
        self.assertEqual(self.event_for()['confirmed_count'],1)

    def test_failed_audit_write_rolls_back_signup_and_request_cache(self):
        data,preview = self.preview(self.manager,[{'name':'不应保存'}])
        key = uuid.uuid4().hex
        with sqlite3.connect(str(server.DB)) as db:
            db.execute("CREATE TRIGGER reject_event_audit BEFORE INSERT ON event_audit BEGIN SELECT RAISE(ABORT,'test failure'); END")
        try:
            with self.assertLogs(level='ERROR'):
                self.assertEqual(self.manager.request(self.url+'/roster/parties','POST',{**data,**preview},{'Idempotency-Key':key})[0],500)
            self.assertEqual(self.event_for()['confirmed_count'],0)
            with sqlite3.connect(str(server.DB)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM request_results WHERE request_key=?',(key,)).fetchone()[0],0)
        finally:
            with sqlite3.connect(str(server.DB)) as db:
                db.execute('DROP TRIGGER reject_event_audit')
        self.assertEqual(self.manager.request(self.url+'/roster/parties','POST',{**data,**preview},{'Idempotency-Key':key})[0],200)

    def test_history_is_append_only_and_does_not_expose_credentials(self):
        self.signup(self.manager,[{'name':'朋友'}])
        result = self.manager.request(self.url+'/history')[1]
        raw = json.dumps(result)
        self.assertNotIn('token',raw)
        self.assertNotIn('actor_id',raw)
        with sqlite3.connect(str(server.DB)) as db:
            for sql in ['UPDATE event_audit SET reason=\'tamper\' WHERE event_id=?','DELETE FROM event_audit WHERE event_id=?']:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql,(self.event['id'],))

    def test_nickname_change_is_logged_but_does_not_merge_people(self):
        self.signup(self.manager,[{'is_self':True},{'name':'新名字'}])
        self.assertEqual(self.manager.request('/api/profile','POST',{'nickname':'新名字'})[0],200)
        event = self.event_for(self.manager)
        self.assertEqual(len(event['participants']),2)
        self.assertEqual(len({p['id'] for p in event['participants']}),2)
        self.assertEqual(self.owner.request(self.url+'/history')[1]['entries'][0]['action'],'nickname_changed')


class RosterMigrationTests(unittest.TestCase):
    def test_failed_migration_rolls_back_schema_and_can_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'migration.sqlite3'
            with mock.patch.object(server.storage,'migrate_roster',lambda db:None):
                server.storage.initialize(path)
            original_migrate = server.storage.migrate_roster
            def fail_after_schema(db):
                original_migrate(db)
                raise RuntimeError('injected migration failure')
            with mock.patch.object(server.storage,'migrate_roster',fail_after_schema):
                with self.assertRaises(RuntimeError):
                    server.storage.initialize(path)
            with server.storage.connect(path) as db:
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertNotIn('attendees',tables)
                self.assertNotIn('schema_migrations',tables)
                self.assertNotIn('revision',{r['name'] for r in db.execute('PRAGMA table_info(events)')})
            server.storage.initialize(path)
            with server.storage.connect(path) as db:
                self.assertEqual(db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0],17)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')

    def test_legacy_roster_sessions_and_bill_survive_repeatable_migration(self):
        previous = server.DB
        with tempfile.TemporaryDirectory() as folder:
            server.DB = Path(folder)/'legacy.sqlite3'
            try:
                # Bootstrap just the previous release's schema, before the v2 migration runs.
                original_migrate = server.storage.migrate_roster
                server.storage.migrate_roster = lambda db:None
                try:server.initialize()
                finally:server.storage.migrate_roster = original_migrate
                token_hash = hashlib.sha256(b'original-browser-token').hexdigest()
                with sqlite3.connect(str(server.DB)) as db:
                    db.execute('INSERT INTO users VALUES(?,?,?,?)',('owner',token_hash,'旧发起者','2026-01-01'))
                    db.execute('INSERT INTO users VALUES(?,?,?,?)',('friend','friend-token','旧朋友','2026-01-01'))
                    db.execute('''INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,duration_hours)
                        VALUES('0123456789abcdef','owner','旧活动','约K','旧店','2099-01-01T00:00:00+00:00','2099-01-01T00:00:00+00:00',1,'','open','2026-01-01',3)''')
                    for uid,note in [('owner','原备注'),('friend','原候补')]:
                        db.execute("INSERT INTO registrations(event_id,user_id,note,created_at) VALUES('0123456789abcdef',?,?,'2026-01-01')",(uid,note))
                    db.execute("INSERT INTO settlements VALUES('0123456789abcdef',10001,7,?,'2026-01-02','原结算备注')",(test_png(),))
                    old = db.execute('SELECT * FROM registrations ORDER BY id').fetchall()
                server.initialize();server.initialize()
                with server.connect() as db:
                    people = server.roster.rows(db,'0123456789abcdef')
                    self.assertEqual([(p['nickname'],p['note'],p['status']) for p in people],
                        [('旧发起者','原备注','confirmed'),('旧朋友','原候补','waiting')])
                    self.assertEqual([tuple(r) for r in db.execute('SELECT * FROM registrations ORDER BY id')],old)
                    self.assertEqual(db.execute('SELECT user_id FROM browser_sessions WHERE token_hash=?',(token_hash,)).fetchone()[0],'owner')
                    self.assertEqual(tuple(db.execute('SELECT total_cents,headcount,qr_image,note FROM settlements').fetchone()),(10001,7,test_png(),'原结算备注'))
                    self.assertEqual(db.execute('SELECT count(*) FROM settlement_history').fetchone()[0],1)
                    self.assertEqual(db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0],17)
                    self.assertFalse(db.execute('PRAGMA foreign_key_check').fetchall())
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute("DELETE FROM registrations")
            finally:
                server.DB = previous


if __name__=='__main__':
    unittest.main()
