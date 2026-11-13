import concurrent.futures
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

import server
from qgroup_core import privacy, storage, time_polls
from qgroup_core.common import APIError, now
from test_roster import ModernClient


def poll_data():
    moment = datetime.now(timezone.utc)
    return dict(title='周末聚餐选时间',category='聚餐',location='市中心餐厅',description='预计每人 100 元',
        timezone='Asia/Taipei',duration_hours=2,capacity=6,minimum_participants=2,
        deadline=(moment+timedelta(days=1)).isoformat(),
        options=[dict(starts_at=(moment+timedelta(days=d)).isoformat()) for d in (2,3,4)])


class TimePollTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/'polls.sqlite3'
        storage.initialize(self.path)
        self.owner=dict(id='owner',nickname='发起者')
        self.voter=dict(id='voter',nickname='参加者')
        self.other=dict(id='other',nickname='另一个人')
        with storage.connect(self.path) as db:
            for user in (self.owner,self.voter,self.other):
                db.execute('INSERT INTO users VALUES(?,?,?,?)',(user['id'],user['id'],user['nickname'],now()))
            self.poll_id=time_polls.create(db,self.owner,poll_data())['id']

    def tearDown(self):
        self.tmp.cleanup()

    def view(self,viewer='owner'):
        with storage.connect(self.path) as db:
            return time_polls.serialize(db,time_polls.get(db,self.poll_id),viewer)

    def vote(self,user,values):
        with storage.connect(self.path) as db:
            poll=time_polls.get(db,self.poll_id)
            time_polls.vote(db,poll,user,dict(base_revision=poll['revision'],choices=[
                dict(option_id=o['id'],choice=v) for o,v in zip(time_polls.options(db,poll),values)]))

    def decision(self,**extra):
        p=self.view()
        return dict(action='finalize',base_revision=p['revision'],base_vote_revision=p['vote_revision'],
            option_id=p['options'][0]['id'],registration_deadline=p['options'][0]['starts_at'],
            reason='先按现有人数举行',accept_terms=True,**extra)

    def manage(self,data,user=None):
        with storage.connect(self.path) as db:
            time_polls.manage(db,time_polls.get(db,self.poll_id),user or self.owner,data)

    def test_poll_is_not_an_event_and_voting_never_reserves_a_place(self):
        self.vote(self.voter,['yes','maybe','no'])
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM attendees').fetchone()[0],0)
        p=self.view()
        self.assertEqual(p['respondent_count'],1)
        self.assertEqual([o['yes'] for o in p['options']],[1,0,0])
        self.assertEqual([o['maybe'] for o in p['options']],[0,1,0])
        self.assertEqual([o['no'] for o in p['options']],[0,0,1])

    def test_changed_votes_replace_previous_choices_without_double_counting(self):
        self.vote(self.voter,['yes','yes','no'])
        self.vote(self.voter,['no','maybe','yes'])
        p=self.view()
        self.assertEqual(p['respondent_count'],1)
        self.assertEqual([o['yes'] for o in p['options']],[0,0,1])
        self.assertEqual(len(p['respondents']),1)

    def test_other_voters_do_not_make_a_ballot_revision_stale(self):
        self.vote(self.voter,['yes']*3)
        self.vote(self.other,['no']*3)
        self.assertEqual(self.view()['respondent_count'],2)
        self.assertEqual(self.view()['revision'],1)

    def test_closed_vote_can_be_reopened_without_losing_choices(self):
        self.vote(self.voter,['yes']*3)
        self.manage(dict(action='close',base_revision=1))
        with self.assertRaises(APIError) as caught:self.vote(self.other,['yes']*3)
        self.assertEqual(caught.exception.status,409)
        self.manage(dict(action='extend',base_revision=2,deadline=poll_data()['deadline']))
        self.assertEqual(self.view()['respondent_count'],1)
        self.vote(self.other,['yes']*3)
        self.assertEqual(self.view()['respondent_count'],2)

    def test_deadline_boundary_rejects_votes_without_silently_publishing(self):
        deadline=self.view()['deadline']
        with mock.patch('qgroup_core.time_polls.now',return_value=deadline):
            self.assertEqual(self.view()['status'],'closed')
            with self.assertRaises(APIError):self.vote(self.voter,['yes']*3)
        self.assertIsNone(self.view()['event_id'])

    def test_participant_names_and_other_ballots_are_only_visible_to_owner(self):
        self.vote(self.voter,['yes','no','maybe'])
        for viewer in (None,'other','voter'):
            p=self.view(viewer)
            self.assertNotIn('respondents',p)
            self.assertNotIn('history',p)
            self.assertNotIn('owner_id',p)
        self.assertEqual(self.view('other')['my_choices'],{})
        self.assertEqual(len(self.view('voter')['my_choices']),3)
        self.assertEqual(self.view()['respondents'][0]['name'],'参加者')

    def test_candidates_deadlines_and_preferences_are_validated(self):
        for change in (dict(options=[]),dict(options=poll_data()['options'][:1]),
                       dict(options=[poll_data()['options'][0]]*2),dict(duration_hours=True),
                       dict(timezone='invalid'),dict(visibility='invitation'),
                       dict(deadline=poll_data()['options'][0]['starts_at']),dict(capacity=-1)):
            with self.subTest(change=change),storage.connect(self.path) as db:
                with self.assertRaises(APIError):time_polls.create(db,self.owner,{**poll_data(),**change})
        for values in (['yes'],['yes','bad','no']):
            with self.subTest(values=values):
                with self.assertRaises(APIError):self.vote(self.voter,values)
        self.assertEqual(self.view()['respondent_count'],0)

    def test_finalizing_preserves_settings_only_registers_owner_and_notifies_voters(self):
        self.vote(self.voter,['yes','no','maybe'])
        self.manage(self.decision())
        p=self.view()
        self.assertEqual(p['status'],'finalized')
        with storage.connect(self.path) as db:
            event=db.execute('SELECT * FROM events WHERE id=?',(p['event_id'],)).fetchone()
            self.assertEqual(event['starts_at'],p['options'][0]['starts_at'])
            self.assertEqual(event['capacity'],6)
            self.assertEqual(event['minimum_participants'],2)
            self.assertEqual(event['timezone'],'Asia/Taipei')
            self.assertEqual(event['bot_enabled'],1)
            self.assertEqual([r[0] for r in db.execute('SELECT user_id FROM attendees')],['owner'])
            self.assertEqual(db.execute("SELECT count(*) FROM notifications WHERE kind='time_poll_finalized' AND user_id='voter'").fetchone()[0],1)
        with self.assertRaises(APIError):self.vote(self.other,['yes']*3)
        with self.assertRaises(APIError):self.manage(self.decision())

    def test_owner_must_acknowledge_and_explain_a_lower_rank_or_low_support(self):
        self.vote(self.voter,['no','yes','yes'])
        data=self.decision();data['reason']=''
        with self.assertRaises(APIError):self.manage(data)
        data=self.decision();data['accept_terms']=False
        with self.assertRaises(APIError):self.manage(data)
        with self.assertRaises(APIError) as caught:self.manage(self.decision(),self.other)
        self.assertEqual(caught.exception.status,403)

    def test_new_votes_require_owner_to_review_before_finalizing(self):
        data=self.decision()
        self.vote(self.other,['yes']*3)
        with self.assertRaises(APIError) as caught:self.manage(data)
        self.assertEqual(caught.exception.status,409)
        self.assertIsNone(self.view()['event_id'])

    def test_concurrent_decisions_create_only_one_event(self):
        data=self.decision()
        def decide():
            try:
                with storage.connect(self.path) as db:
                    db.execute('BEGIN IMMEDIATE')
                    time_polls.manage(db,time_polls.get(db,self.poll_id),self.owner,data)
                return 200
            except APIError as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(lambda _:decide(),range(2))),[200,409])
        with storage.connect(self.path) as db:self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],1)

    def test_notification_failure_rolls_back_event_and_decision_together(self):
        self.vote(self.voter,['yes']*3)
        with mock.patch('qgroup_core.time_polls.audit.notify',side_effect=RuntimeError('test')):
            with self.assertRaises(RuntimeError):self.manage(self.decision())
        self.assertIsNone(self.view()['event_id'])
        with storage.connect(self.path) as db:self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_cancellation_and_account_closure_remove_private_ballots(self):
        self.vote(self.voter,['yes']*3)
        self.manage(self.decision())
        with storage.connect(self.path) as db:
            result=privacy.close(db,self.voter,dict(confirm_close=True))
            self.assertEqual(result['status'],'completed')
            self.assertEqual(db.execute('SELECT count(*) FROM time_poll_votes').fetchone()[0],0)
        # Published aggregate results remain frozen without retaining identity.
        self.assertEqual(self.view()['respondent_count'],1)
        self.assertEqual(self.view()['options'][0]['yes'],1)

    def test_owner_cannot_close_account_while_a_poll_awaits_decision(self):
        with storage.connect(self.path) as db:
            with self.assertRaises(APIError):privacy.close(db,self.owner,dict(confirm_close=True))
        self.manage(dict(action='cancel',base_revision=1,reason='这周先不约'))
        self.assertEqual(self.view()['status'],'cancelled')
        with self.assertRaises(APIError):self.manage(self.decision())

    def test_erasing_a_ballot_invalidates_an_unconfirmed_decision(self):
        self.vote(self.voter,['yes']*3)
        decision=self.decision()
        with storage.connect(self.path) as db:
            privacy.erase(db,self.voter['id'],'erase-voter',now())
        self.assertEqual(self.view()['respondent_count'],0)
        with self.assertRaises(APIError) as caught:self.manage(decision)
        self.assertEqual(caught.exception.status,409)

    def test_repeatable_migration_preserves_pre_poll_database(self):
        from deploy.verify_migration import verify
        source=Path(self.tmp.name)/'schema15.sqlite3'
        with mock.patch.object(time_polls,'migrate',lambda db:None):
            storage.initialize(source)
        with storage.connect(source) as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?)',('legacy','legacy-hash','旧用户',now()))
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0],15)
        verify(source,Path(self.tmp.name)/'migrated.sqlite3')


class TimePollHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.old_db=server.DB
        server.DB=Path(self.tmp.name)/'http.sqlite3'
        server.initialize();server.LIMITS.clear()
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:%d'%self.http.server_address[1]
        self.owner=ModernClient(self.base).identify('发起者')
        self.voter=ModernClient(self.base).identify('群友')
        self.guest=ModernClient(self.base)

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join()
        server.DB=self.old_db;self.tmp.cleanup()

    def test_create_vote_finalize_and_replay_refresh_the_current_view(self):
        key=uuid.uuid4().hex
        status,p=self.owner.request('/api/time-polls','POST',poll_data(),{'Idempotency-Key':key})
        self.assertEqual(status,201,p)
        url='/api/time-polls/'+p['id']
        choices=[dict(option_id=o['id'],choice='yes') for o in p['options']]
        vote_key=uuid.uuid4().hex
        body=dict(base_revision=p['revision'],choices=choices)
        self.assertEqual(self.voter.request(url+'/votes','PUT',body,{'Idempotency-Key':vote_key})[0],200)
        status,p=self.owner.request(url)
        decision=dict(action='finalize',base_revision=p['revision'],base_vote_revision=p['vote_revision'],
            option_id=p['options'][0]['id'],registration_deadline=p['options'][0]['starts_at'],accept_terms=True,reason='先按一人意向成团')
        decision_key=uuid.uuid4().hex
        status,final=self.owner.request(url,'PATCH',decision,{'Idempotency-Key':decision_key})
        self.assertEqual(status,200,final)
        self.assertEqual(self.owner.request(url,'PATCH',decision,{'Idempotency-Key':decision_key})[1]['event_id'],final['event_id'])
        self.assertEqual(self.voter.request(url+'/votes','PUT',body,{'Idempotency-Key':vote_key})[1]['status'],'finalized')
        recovered=self.owner.request('/api/requests/'+key)[1]['result']
        self.assertEqual(recovered['status'],'finalized')
        listing=self.voter.request('/api/events')[1]
        self.assertEqual(len(listing['events']),1)
        self.assertEqual(listing['events'][0]['my_attendees'],[])
        self.assertEqual(listing['time_polls'][0]['id'],p['id'])
        guest=self.guest.request(url)[1]
        self.assertNotIn('respondents',guest)
        self.assertEqual(guest['my_choices'],{})

    def test_remove_hides_votes_and_links_but_preserves_history_and_recovery(self):
        status,p=self.owner.request('/api/time-polls','POST',poll_data())
        self.assertEqual(status,201)
        url='/api/time-polls/'+p['id']
        vote=dict(base_revision=p['revision'],choices=[dict(option_id=o['id'],choice='yes') for o in p['options']])
        self.assertEqual(self.voter.request(url+'/votes','PUT',vote)[0],200)
        self.assertEqual(self.voter.request(url,'PATCH',dict(action='remove',base_revision=p['revision']))[0],403)
        self.assertFalse(self.voter.request(url)[1]['can_remove'])
        key=uuid.uuid4().hex;data=dict(action='remove',base_revision=p['revision'])
        status,result=self.owner.request(url,'PATCH',data,{'Idempotency-Key':key})
        self.assertEqual((status,result),(200,dict(id=p['id'],status='deleted')))
        self.assertEqual(self.owner.request(url,'PATCH',data,{'Idempotency-Key':key}),(status,result))
        self.assertEqual(self.owner.request('/api/requests/'+key)[1]['result'],result)
        for client in (self.owner,self.voter,self.guest):
            self.assertEqual(client.request(url)[0],404)
            self.assertEqual(client.request('/api/events')[1]['time_polls'],[])
        self.assertEqual(self.voter.request(url+'/votes','PUT',vote)[0],404)
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM time_poll_votes WHERE poll_id=?',(p['id'],)).fetchone()[0],3)
            self.assertEqual(db.execute("SELECT count(*) FROM time_poll_history WHERE poll_id=? AND action='remove'",(p['id'],)).fetchone()[0],1)

    def test_cancelled_and_finalized_polls_can_be_removed_independently(self):
        for action in ('cancel','finalize'):
            with self.subTest(action=action):
                _,p=self.owner.request('/api/time-polls','POST',poll_data())
                url='/api/time-polls/'+p['id']
                data=dict(action=action,base_revision=p['revision'],reason='测试清理')
                if action=='finalize':data.update(base_vote_revision=p['vote_revision'],option_id=p['options'][0]['id'],registration_deadline=p['options'][0]['starts_at'],accept_terms=True)
                status,p=self.owner.request(url,'PATCH',data);self.assertEqual(status,200,p)
                self.assertTrue(p['can_remove'])
                self.assertEqual(self.owner.request(url,'PATCH',dict(action='remove',base_revision=1))[0],409)
                self.assertEqual(self.owner.request(url,'PATCH',dict(action='remove',base_revision=p['revision']))[0],200)
                if action=='finalize':
                    event_url='/api/events/'+p['event_id']
                    status,e=self.owner.request(event_url);self.assertEqual(status,200)
                    self.assertTrue(e['can_remove'])
                    self.assertEqual(self.owner.request(event_url,'PATCH',dict(action='remove',base_revision=e['revision']))[0],200)

    def test_removed_formal_event_no_longer_has_a_dead_poll_link(self):
        _,p=self.owner.request('/api/time-polls','POST',poll_data())
        url='/api/time-polls/'+p['id']
        data=dict(action='finalize',base_revision=p['revision'],base_vote_revision=p['vote_revision'],option_id=p['options'][0]['id'],registration_deadline=p['options'][0]['starts_at'],accept_terms=True,reason='测试')
        status,p=self.owner.request(url,'PATCH',data);self.assertEqual(status,200,p)
        event_url='/api/events/'+p['event_id'];_,e=self.owner.request(event_url)
        self.assertEqual(self.owner.request(event_url,'PATCH',dict(action='remove',base_revision=e['revision']))[0],200)
        status,p=self.owner.request(url)
        self.assertEqual(status,200);self.assertTrue(p['event_deleted']);self.assertIsNone(p['event_id'])

    def test_writes_require_login_protocol_and_idempotency_key(self):
        self.assertEqual(self.guest.request('/api/time-polls','POST',poll_data())[0],401)
        self.assertEqual(self.owner.request('/api/time-polls','POST',poll_data(),{'X-Kanban-Version':'1'})[0],409)
        self.assertEqual(self.owner.request('/api/time-polls','POST',poll_data(),{'Idempotency-Key':''})[0],400)


if __name__=='__main__':unittest.main()
