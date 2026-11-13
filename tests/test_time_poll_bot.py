import json
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from deploy.verify_migration import verify
from qgroup_core import bot_outbox, bot_settings, events, storage, time_polls
from qgroup_core.common import APIError, now
from qgroup_bot.config import Config
from qgroup_bot.worker import OutboxWorker
from test_bot_outbox import BotOutboxFixture
from test_time_polls import poll_data


class TimePollBotTests(BotOutboxFixture, unittest.TestCase):
    def create_poll(self,**changes):
        with storage.connect(self.path) as db:
            p=time_polls.create(db,self.user,dict(poll_data(),**changes))
            self.poll_id=p['id']
            return time_polls.serialize(db,p,self.user['id'])

    def worker(self,dry=False):
        api=mock.Mock()
        api.post.return_value=(True,0,{'id':'sent'})
        with mock.patch.dict('os.environ',{'QQBOT_APP_ID':'test','QQBOT_APP_SECRET':'test',
                                         'KANBAN_BOT_DRY_RUN':'1' if dry else '0'}):
            return OutboxWorker(Config(),api)

    def manage(self,action,**values):
        with storage.connect(self.path) as db:
            p=time_polls.get(db,self.poll_id)
            time_polls.manage(db,p,self.user,dict(action=action,base_revision=p['revision'],**values))

    def test_publish_enqueues_once_with_candidate_times_and_no_event_or_roster(self):
        p=self.create_poll()
        with storage.connect(self.path) as db:
            self.assertFalse(bot_outbox.announce_poll(db,time_polls.get(db,p['id'])))
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM attendees').fetchone()[0],0)
        self.assertEqual(len(self.rows()),1)
        row=self.rows()[0]
        self.assertIsNone(row['event_id'])
        self.assertEqual(row['poll_id'],p['id'])
        text=json.loads(row['payload_json'])['text']
        for phrase in ['活动时间投票','1. ','2. ','3. ','投票截止','投票不占名额','https://example.test/?poll='+p['id']]:
            self.assertIn(phrase,text)
        self.assertNotIn('发起者昵称不应外泄',text)
        self.assertEqual(p['bot_delivery'][0]['state'],'pending')
        with storage.connect(self.path) as db:
            self.assertNotIn('bot_delivery',time_polls.serialize(db,time_polls.get(db,p['id']),None))
        worker=self.worker()
        self.assertEqual(worker.poll_once()['sent'],1)
        worker.api.post.assert_called_once()
        self.assertIn('/groups/GROUP_OPENID_TEST/messages',worker.api.post.call_args.args[0])
        self.assertEqual(worker.poll_once()['claimed'],0)

    def test_disabled_owner_or_global_policy_or_kind_does_not_enqueue(self):
        self.create_poll(bot_enabled=False)
        self.assertEqual(self.rows(),[])
        with mock.patch.dict('os.environ',{'KANBAN_BOT_ENABLED':'0'}):self.create_poll()
        self.assertEqual(self.rows(),[])
        with mock.patch.dict('os.environ',{'KANBAN_BOT_BROADCAST_KINDS':'activity_published'}):self.create_poll()
        self.assertEqual(self.rows(),[])
        with self.assertRaises(APIError):self.create_poll(bot_enabled='true')

    def test_dry_run_and_explicit_retry_do_not_repeat_the_poll(self):
        self.create_poll()
        worker=self.worker(dry=True)
        self.assertEqual(worker.poll_once()['simulated'],1)
        worker.api.post.assert_not_called()
        self.manage('bot_retry',outbox_id=self.rows()[0]['id'])
        with self.assertRaises(APIError):self.manage('bot_retry',outbox_id=self.rows()[0]['id'])
        self.assertEqual(self.worker().poll_once()['sent'],1)
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM time_polls').fetchone()[0],1)

    def test_cancel_close_and_opt_out_fence_an_already_claimed_message(self):
        for action,values in [('cancel',dict(reason='取消')) ,('close',{}),('bot_sync',dict(bot_enabled=False))]:
            with self.subTest(action=action):
                self.create_poll()
                worker=self.worker();row=worker.claim()[0]
                self.manage(action,**values)
                self.assertEqual(worker.deliver(row),'skipped')
                worker.api.post.assert_not_called()

    def test_deadline_and_policy_are_rechecked_at_send_time(self):
        self.create_poll()
        with storage.connect(self.path) as db:
            db.execute("UPDATE time_polls SET deadline='2000-01-01T00:00:00+00:00' WHERE id=?",(self.poll_id,))
        worker=self.worker();self.assertEqual(worker.poll_once()['skipped'],1)
        worker.api.post.assert_not_called()
        self.create_poll()
        with storage.connect(self.path) as db:
            current=bot_settings.read(db)
            bot_settings.save(db,dict(base_revision=current['revision'],config=dict(current['config'],broadcast_kinds=[])),'admin')
        self.assertEqual(worker.poll_once()['claimed'],0)

    def test_latest_deadline_and_template_are_used_without_revealing_ballots(self):
        p=self.create_poll()
        with storage.connect(self.path) as db:
            current=bot_settings.read(db)
            bot_settings.save(db,dict(base_revision=current['revision'],config=dict(current['config'],
                templates={'time_poll_published':'选时间 {title}\n{deadline}\n{url}'})),'admin')
            poll=time_polls.get(db,p['id'])
            new_deadline=p['options'][0]['starts_at']
            db.execute('UPDATE time_polls SET deadline=? WHERE id=?',(new_deadline,p['id']))
            time_polls.vote(db,poll,self.user,dict(base_revision=poll['revision'],choices=[
                dict(option_id=o['id'],choice='yes') for o in p['options']]))
        worker=self.worker();self.assertEqual(worker.poll_once()['sent'],1)
        text=worker.api.post.call_args.args[1]['content']
        self.assertTrue(text.startswith('选时间 '))
        self.assertIn(bot_outbox.local_time(new_deadline,p['timezone']),text)
        self.assertNotIn('发起者昵称不应外泄',text)
        self.assertEqual(len(self.rows()),1)  # Votes never broadcast.

    def test_finalization_skips_old_poll_invite_and_announces_normal_event(self):
        p=self.create_poll()
        self.manage('finalize',base_vote_revision=p['vote_revision'],accept_terms=True,reason='先举行',
            option_id=p['options'][0]['id'],registration_deadline=p['options'][0]['starts_at'])
        rows=self.rows()
        self.assertEqual(rows[0]['status'],'skipped')
        notices=[r for r in rows if r['kind']=='activity_published']
        self.assertEqual(len(notices),1)
        self.assertIsNone(notices[0]['poll_id'])
        self.assertIn('?event=',json.loads(notices[0]['payload_json'])['text'])
        self.assertEqual(self.worker().poll_once()['sent'],1)

    def test_notify_failure_does_not_lose_poll_and_owner_can_enable_again(self):
        with mock.patch.object(bot_outbox,'announce_poll',side_effect=RuntimeError('injected')):
            with self.assertLogs(level='ERROR'):p=self.create_poll()
        self.assertEqual(self.rows(),[])
        self.manage('bot_sync',bot_enabled=False)
        self.manage('bot_sync',bot_enabled=True)
        self.assertEqual(len(self.rows()),1)
        with storage.connect(self.path) as db:
            self.assertEqual(time_polls.get(db,p['id'])['status'],'open')

    def test_remove_fences_claimed_poll_jobs(self):
        self.create_poll()
        worker=self.worker();claimed=worker.claim()[0]
        self.manage('remove')
        self.assertEqual(worker.deliver(claimed),'skipped')
        worker.api.post.assert_not_called()
        self.assertEqual(self.rows()[0]['status'],'skipped')
        self.assertEqual(worker.poll_once()['claimed'],0)

    def test_remove_unused_event_fences_all_pending_notifications(self):
        event_id=self.create_event()
        worker=self.worker();claimed=worker.claim()[0]
        with storage.connect(self.path) as db:
            event=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            events.patch(db,event,self.user,dict(action='remove',base_revision=event['revision']))
        self.assertEqual(worker.deliver(claimed),'skipped')
        worker.api.post.assert_not_called()
        self.assertEqual({r['status'] for r in self.rows()},{'skipped'})

    def test_migration_preserves_existing_delivery_fences_and_sequences(self):
        source=Path(self.tmp.name)/'schema16.sqlite3'
        target=Path(self.tmp.name)/'schema17.sqlite3'
        with mock.patch.object(time_polls,'migrate_notifications',lambda db:None):storage.initialize(source)
        with storage.connect(source) as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?)',('old','hash','旧发起者',now()))
            event_id=events.create(db,dict(id='old',nickname='旧发起者'),dict(self.data,bot_enabled=False))
            db.execute('''INSERT INTO bot_outbox(id,event_id,kind,dedupe_key,payload_json,status,attempts,created_at,claim_token)
                VALUES(100,?,'activity_published','old','{}','sending',2,?,'old-fence')''',(event_id,now()))
            db.execute('''INSERT INTO bot_outbox(id,event_id,kind,dedupe_key,payload_json,created_at)
                VALUES(200,?,'activity_published','deleted','{}',?)''',(event_id,now()))
            db.execute('DELETE FROM bot_outbox WHERE id=200')
        verify(source,target)
        with storage.connect(target) as db:
            row=db.execute('SELECT * FROM bot_outbox WHERE id=100').fetchone()
            self.assertEqual((row['attempts'],row['claim_token'],row['status']),(2,'old-fence','sending'))
            self.assertIsNone(row['poll_id'])
            self.assertEqual(db.execute("SELECT seq FROM sqlite_sequence WHERE name='bot_outbox'").fetchone()[0],200)
            with self.assertRaises(sqlite3.IntegrityError):db.execute("UPDATE bot_outbox SET payload_json='changed'")
            with self.assertRaises(sqlite3.IntegrityError):db.execute("UPDATE bot_outbox SET poll_id='bad',event_id=NULL")

    def test_migration_failure_rolls_back_and_retries(self):
        source=Path(self.tmp.name)/'rollback16.sqlite3'
        with mock.patch.object(time_polls,'migrate_notifications',lambda db:None):storage.initialize(source)
        with storage.connect(source) as db:
            db.execute("CREATE TRIGGER reject_v17 BEFORE INSERT ON schema_migrations WHEN NEW.version=17 BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):storage.initialize(source)
        with storage.connect(source) as db:
            self.assertNotIn('poll_id',[r['name'] for r in db.execute('PRAGMA table_info(bot_outbox)')])
            self.assertNotIn('bot_enabled',[r['name'] for r in db.execute('PRAGMA table_info(time_polls)')])
            db.execute('DROP TRIGGER reject_v17')
        storage.initialize(source)
