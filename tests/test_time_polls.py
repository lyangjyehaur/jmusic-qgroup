import concurrent.futures
import json
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
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


def date_poll_data(zone='Asia/Taipei'):
    today=datetime.now(ZoneInfo(zone)).date()
    return dict(poll_data(),time_mode='date',timezone=zone,
        deadline=datetime.combine(today+timedelta(days=1),time(20),ZoneInfo(zone)).isoformat(),
        options=[dict(date=(today+timedelta(days=d)).isoformat()) for d in (3,4,5)])


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

    def date_poll(self,**changes):
        with storage.connect(self.path) as db:
            self.poll_id=time_polls.create(db,self.owner,dict(date_poll_data(),**changes))['id']
        return self.view()

    def date_decision(self,**changes):
        p=self.view();start=datetime.fromisoformat(p['options'][0]['date']+'T23:30:00').replace(tzinfo=ZoneInfo(p['timezone'])).astimezone(timezone.utc).isoformat()
        return dict(action='finalize',base_revision=p['revision'],base_vote_revision=p['vote_revision'],option_id=p['options'][0]['id'],
            starts_at=start,duration_hours=2,registration_deadline=start,accept_terms=True,reason='已核对时间',**changes)

    def test_date_only_has_no_synthetic_start_time_or_duration(self):
        p=self.date_poll()
        self.assertEqual(p['time_mode'],'date');self.assertIsNone(p['duration_hours'])
        self.assertEqual([o['date'] for o in p['options']],[o['date'] for o in date_poll_data()['options']])
        self.assertTrue(all(o['starts_at'] is None and o['ends_at'] is None for o in p['options']))
        self.vote(self.voter,['yes','maybe','no'])
        self.assertEqual(self.view()['respondent_count'],1)
        self.assertEqual([o['yes'] for o in self.view()['options']],[1,0,0])

    def test_many_date_and_exact_choices_support_revising_votes_and_finalization(self):
        for mode in ('date','exact'):
            with self.subTest(mode=mode):
                data=date_poll_data() if mode=='date' else poll_data()
                first=datetime.fromisoformat(data['options'][0]['date'] if mode=='date' else data['options'][0]['starts_at'])
                data['options']=[dict(date=(first+timedelta(days=i*2)).date().isoformat()) if mode=='date' else
                                 dict(starts_at=(first+timedelta(hours=i)).isoformat()) for i in range(40)]
                with storage.connect(self.path) as db:self.poll_id=time_polls.create(db,self.owner,data)['id']
                p=self.view();self.assertEqual(len(p['options']),40)
                self.vote(self.voter,['maybe']*39+['yes'])
                self.vote(self.voter,['no']*39+['yes'])
                p=self.view(self.voter['id']);last=p['options'][-1]
                self.assertEqual(len(p['my_choices']),40);self.assertEqual(p['respondent_count'],1)
                self.assertEqual(p['my_choices'][p['options'][0]['id']],'no')
                start=last['date']+'T19:30:00+08:00' if mode=='date' else last['starts_at']
                decision=dict(action='finalize',base_revision=p['revision'],base_vote_revision=p['vote_revision'],
                    option_id=last['id'],registration_deadline=start,accept_terms=True,reason='已确认安排')
                if mode=='date':decision.update(starts_at=start,duration_hours=2)
                self.manage(decision)
                finalized=self.view();self.assertEqual(finalized['status'],'finalized')
                self.assertEqual(finalized['selected_option_id'],last['id']);self.assertEqual(len(finalized['options']),40)
                with storage.connect(self.path) as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM attendees WHERE event_id=?',(finalized['event_id'],)).fetchone()[0],1)

    def test_date_finalization_requires_explicit_time_within_selected_date(self):
        p=self.date_poll();valid=self.date_decision()
        for field in ('starts_at','duration_hours'):
            data=dict(valid);data.pop(field)
            with self.subTest(field=field),self.assertRaises(APIError):self.manage(data)
        other_day=datetime.fromisoformat(valid['starts_at'])+timedelta(days=1)
        for changes in (dict(starts_at=other_day.isoformat()),dict(duration_hours=True),dict(duration_hours=25),dict(duration_hours=0)):
            with self.subTest(changes=changes),self.assertRaises(APIError):self.manage(dict(valid,**changes))
        with storage.connect(self.path) as db:self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],0)
        self.vote(self.voter,['yes','no','maybe'])
        with self.assertRaises(APIError):self.manage(valid)  # A stale decision cannot finalize newer ballots.
        self.manage(self.date_decision());p=self.view()
        self.assertEqual(p['status'],'finalized');self.assertEqual(p['options'][0]['date'],date_poll_data()['options'][0]['date'])
        self.assertIsNone(p['options'][0]['starts_at'])
        self.assertEqual(datetime.fromisoformat(p['event_time']['ends_at'])-datetime.fromisoformat(p['event_time']['starts_at']),timedelta(hours=2))
        self.assertNotEqual(datetime.fromisoformat(p['event_time']['ends_at']).astimezone(ZoneInfo(p['timezone'])).date().isoformat(),p['options'][0]['date'])
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attendees WHERE event_id=?',(p['event_id'],)).fetchone()[0],1)

    def test_date_validation_uses_local_midnight_and_rejects_mixed_payloads(self):
        data=date_poll_data();first=time_polls.date_start(data['options'][0]['date'],data['timezone'])
        for changes in (dict(time_mode='other'),dict(options=[data['options'][0]]*2),dict(options=[dict(date='2030-02-30'),data['options'][1]]),
                        dict(options=poll_data()['options']),dict(deadline=first),dict(timezone=None)):
            with self.subTest(changes=changes),storage.connect(self.path) as db:
                with self.assertRaises(APIError):time_polls.create(db,self.owner,dict(data,**changes))
        p=self.date_poll(timezone='America/New_York',**{k:v for k,v in date_poll_data('America/New_York').items() if k not in ('timezone',)})
        self.assertEqual(p['options'][0]['date'],date_poll_data('America/New_York')['options'][0]['date'])
        start=time_polls.date_start('2030-03-10','America/New_York');end=time_polls.date_start('2030-03-11','America/New_York')
        self.assertEqual(datetime.fromisoformat(end)-datetime.fromisoformat(start),timedelta(hours=23))
        self.assertEqual(time_polls.option_date(dict(starts_at=start),'America/New_York'),'2030-03-10')

    def test_schema_17_preserves_exact_poll_values_and_retries_failed_18(self):
        from deploy.verify_migration import verify
        source=Path(self.tmp.name)/'schema17.sqlite3'
        with mock.patch.object(time_polls,'migrate_date_choices',lambda db:None):storage.initialize(source)
        with storage.connect(source) as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?)',('old','old-hash','旧发起者',now()))
            db.execute("INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,created_at) VALUES('old-poll','old','旧投票','其他','原地点','','Asia/Taipei',2,6,0,'',?,?)",(poll_data()['deadline'],now()))
            for i,option in enumerate(poll_data()['options']):db.execute('INSERT INTO time_poll_options VALUES(?,?,?,?)',('old-'+str(i),'old-poll',i,option['starts_at']))
            db.execute("CREATE TRIGGER reject_v18 BEFORE INSERT ON schema_migrations WHEN NEW.version=18 BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):storage.initialize(source)
        with storage.connect(source) as db:
            self.assertNotIn('time_mode',[r['name'] for r in db.execute('PRAGMA table_info(time_polls)')])
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0],17)
            db.execute('DROP TRIGGER reject_v18')
        target=Path(self.tmp.name)/'upgraded.sqlite3';verify(source,target)
        with storage.connect(target) as db:
            poll=time_polls.get(db,'old-poll');self.assertEqual(poll['time_mode'],'exact')
            view=time_polls.serialize(db,poll,None)
            self.assertEqual(view['duration_hours'],2)
            self.assertTrue(all(o['starts_at'] and o['ends_at'] for o in view['options']))

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
