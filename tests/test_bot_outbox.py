"""bot_outbox: same-transaction queueing, de-duplication, privacy, delivery state."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from qgroup_core import audit, bot_outbox, events, storage
from qgroup_core.common import now
from qgroup_bot.config import Config
from qgroup_bot.worker import OutboxWorker


class BotOutboxFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'bot.sqlite3'
        storage.initialize(self.path)
        self.env = mock.patch.dict(os.environ, {
            'KANBAN_BOT_ENABLED': '1',
            'KANBAN_BOT_BASE_URL': 'https://example.test',
            'KANBAN_DB': str(self.path),
            'KANBAN_BOT_GROUP': 'GROUP_OPENID_TEST',
            'KANBAN_BOT_DRY_RUN': '1',
        })
        self.env.start()
        with storage.connect(self.path) as db:
            db.execute('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)',
                       ('u1', 'hash1', '发起者昵称不应外泄', now()))
        self.user = {'id': 'u1', 'nickname': '发起者昵称不应外泄'}
        self.start = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec='seconds')
        self.data = dict(title='测试活动', category='约K', location='某KTV',
                         starts_at=self.start, deadline=self.start, capacity=0,
                         description='', duration_hours=3, join_owner=False, bot_enabled=True)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def create_event(self, lifecycle='scheduled'):
        with storage.connect(self.path) as db:
            self.event_id = events.create(db, self.user,
                                          dict(self.data, lifecycle=lifecycle))
        return self.event_id

    def rows(self, where='', args=()):
        with storage.connect(self.path) as db:
            return [dict(row) for row in db.execute(
                'SELECT * FROM bot_outbox ' + where + ' ORDER BY id', args)]

    def due_rows(self, count):
        """Queue due broadcasts; reminder version checks have separate coverage."""
        with storage.connect(self.path) as db:
            db.execute('DELETE FROM bot_outbox WHERE due_at IS NOT NULL')
            for index in range(count):
                self.assertTrue(bot_outbox.enqueue(
                    db, self.event_id, 'activity_published', '活动消息 %d' % index,
                    due_at=now()))


class BotOutboxTests(BotOutboxFixture, unittest.TestCase):
    def test_migration_10_applied(self):
        with storage.connect(self.path) as db:
            versions = [row[0] for row in db.execute(
                'SELECT version FROM schema_migrations ORDER BY version')]
        self.assertTrue(set(range(1,11))|{12} <= set(versions))
        storage.initialize(self.path)  # idempotent
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute(
                'SELECT count(*) FROM schema_migrations WHERE version=10').fetchone()[0], 1)

    def test_disabled_by_default_keeps_old_behaviour(self):
        with mock.patch.dict(os.environ, {'KANBAN_BOT_ENABLED': '0'}):
            event_id = self.create_event()
            with storage.connect(self.path) as db:
                audit.notify(db, 'u1', event_id, 'conditions_changed', '站内通知')
                self.assertEqual(db.execute(
                    'SELECT count(*) FROM notifications').fetchone()[0], 1)
            self.assertEqual(self.rows(), [])

    def test_publish_queues_card_and_two_scheduled_reminders(self):
        event_id = self.create_event()
        kinds = [row['kind'] for row in self.rows()]
        self.assertIn('activity_published', kinds)
        self.assertIn('deadline_reminder', kinds)
        self.assertIn('estimated_over_reminder', kinds)
        card = next(row for row in self.rows() if row['kind'] == 'activity_published')
        self.assertIsNone(card['due_at'])
        payload = json.loads(card['payload_json'])
        self.assertIn('https://example.test/?event=' + event_id, payload['text'])
        self.assertIn('测试活动', payload['text'])
        reminders = [row for row in self.rows() if row['due_at']]
        self.assertEqual(len(reminders), 2)
        self.assertTrue(all(row['due_at'] > now() for row in reminders))

    def test_draft_is_silent_until_publish(self):
        event_id = self.create_event('draft')
        self.assertEqual(self.rows(), [])
        with storage.connect(self.path) as db:
            event = db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()
            events.patch(db, event, self.user,
                         dict(action='publish', base_revision=event['revision']))
        self.assertIn('activity_published', [row['kind'] for row in self.rows()])

    def test_same_fact_is_queued_once(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            for _ in range(5):
                audit.notify(db, 'u1', event_id, 'conditions_changed',
                             '测试活动：时间已变更，请确认本人及代报名单的安排')
        self.assertEqual(len([r for r in self.rows() if r['kind'] == 'conditions_changed']), 1)

    def test_new_fact_produces_a_new_row(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            audit.notify(db, 'u1', event_id, 'conditions_changed', '第一次变更')
            db.execute("UPDATE events SET change_summary='时间已变更',conditions_version=2 WHERE id=?",
                       (event_id,))
            audit.notify(db, 'u1', event_id, 'conditions_changed', '第二次变更')
        self.assertEqual(len([r for r in self.rows() if r['kind'] == 'conditions_changed']), 2)

    def test_group_text_is_de_identified(self):
        self.create_event()
        for row in self.rows():
            text = json.loads(row['payload_json'])['text']
            self.assertNotIn(self.user['nickname'], text)
            self.assertNotIn('u1', text)
            self.assertNotIn('应付', text.replace('每人应付与付款归属已发布', ''))

    def test_personal_notifications_are_not_group_broadcasts(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            audit.notify(db, 'u1', event_id, 'withdrawal_request',
                         '某群友 申请退出：私人理由')
        self.assertFalse([r for r in self.rows() if r['kind'] == 'withdrawal_request'])

    def test_personal_queue_opt_in_is_de_identified_and_unbound(self):
        event_id = self.create_event()
        with mock.patch.dict(os.environ, {'KANBAN_BOT_PERSONAL_QUEUE': '1'}):
            with storage.connect(self.path) as db:
                audit.notify(db, 'u1', event_id, 'withdrawal_request',
                             '某群友 申请退出：私人理由')
        rows = [r for r in self.rows() if r['kind'] == 'withdrawal_request']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['channel'], 'private')
        self.assertEqual(rows[0]['target'], '')
        self.assertNotIn('某群友', json.loads(rows[0]['payload_json'])['text'])

    def test_rollback_removes_notification_and_outbox_together(self):
        event_id = self.create_event()
        with self.assertRaises(RuntimeError):
            with storage.connect(self.path) as db:
                db.execute('BEGIN IMMEDIATE')
                audit.notify(db, 'u1', event_id, 'conditions_changed', '会被回滚')
                raise RuntimeError('simulated failure')
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute(
                "SELECT count(*) FROM notifications WHERE kind='conditions_changed'").fetchone()[0], 0)
        self.assertFalse([r for r in self.rows() if r['kind'] == 'conditions_changed'])

    def test_payload_immutable_but_delivery_state_mutable(self):
        self.create_event()
        row = self.rows()[0]
        with storage.connect(self.path) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE bot_outbox SET payload_json='{}' WHERE id=?", (row['id'],))
        with storage.connect(self.path) as db:
            db.execute("UPDATE bot_outbox SET status='sent',sent_at=? WHERE id=?",
                       (now(), row['id']))
        self.assertEqual(self.rows('WHERE id=?', (row['id'],))[0]['status'], 'sent')

    def test_settlement_has_one_owner_even_with_two_hooks(self):
        """settlements.save calls both audit.append and audit.notify."""
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            db.execute('''INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,
                qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
                VALUES(?,1,10000,3,'',NULL,?,'u1','发起者','detailed_published','[]')''',
                (event_id, now()))
            db.execute('INSERT INTO settlements VALUES(?,?,?,?,?,?)',
                       (event_id, 10000, 3, None, '', now()))
            event = db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()
            audit.append(db, event, self.user, 'settlement_saved', {}, {'version': 1})
            audit.notify(db, 'u1', event_id, 'settlement_updated',
                         '测试活动 已发布逐人结算第 1 版，请查看应付与付款归属')
        rows = [r for r in self.rows() if r['kind'] == 'settlement_updated']
        self.assertEqual(len(rows), 1)
        self.assertIn('第 1 版', json.loads(rows[0]['payload_json'])['text'])

    def test_broadcast_kinds_are_operator_configurable(self):
        with mock.patch.dict(os.environ, {
                'KANBAN_BOT_BROADCAST_KINDS': 'activity_published'}):
            self.create_event()
        self.assertEqual([r['kind'] for r in self.rows()], ['activity_published'])

    def test_bot_hook_failure_never_breaks_a_business_write(self):
        """An outbox exception must not roll back a registration or an audit row."""
        with mock.patch('qgroup_core.audit.logging.exception'), \
                mock.patch.object(bot_outbox, 'on_append',
                                  side_effect=RuntimeError('compose exploded')):
            event_id = self.create_event()
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events WHERE id=?',
                                        (event_id,)).fetchone()[0], 1)
            self.assertGreaterEqual(
                db.execute('SELECT count(*) FROM event_audit').fetchone()[0], 1)
        with mock.patch('qgroup_core.audit.logging.exception'), \
                mock.patch.object(bot_outbox, 'on_notify',
                                  side_effect=RuntimeError('enqueue exploded')):
            with storage.connect(self.path) as db:
                audit.notify(db, 'u1', event_id, 'conditions_changed', '站内通知仍要保存')
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute(
                "SELECT count(*) FROM notifications WHERE kind='conditions_changed' "
                "AND message='站内通知仍要保存'").fetchone()[0], 1)

    def test_money_formats_refunds_without_shifting_the_decimal(self):
        self.assertEqual(bot_outbox.money(12345), '123.45')
        self.assertEqual(bot_outbox.money(-50), '-0.50')
        self.assertEqual(bot_outbox.money(-12345), '-123.45')

    def test_naive_event_time_is_interpreted_in_the_event_zone(self):
        naive = '2026-11-10T20:00:00'
        self.assertEqual(bot_outbox.local_time(naive, 'Asia/Taipei'), '2026-11-10 20:00')
        self.assertEqual(bot_outbox.local_time(naive, 'UTC'), '2026-11-10 20:00')

    def test_event_url_encodes_query_values(self):
        url = bot_outbox.event_url('abc123', q='a b&c')
        self.assertIn('event=abc123', url)
        self.assertIn('q=a+b%26c', url)


class WorkerTests(BotOutboxFixture, unittest.TestCase):
    def config(self, **overrides):
        values = dict(KANBAN_BOT_ENABLED='1', KANBAN_BOT_BASE_URL='https://example.test',
                      KANBAN_DB=str(self.path), KANBAN_BOT_GROUP='GROUP_OPENID_TEST',
                      KANBAN_BOT_DRY_RUN='1', QQBOT_APP_ID='x', QQBOT_APP_SECRET='y')
        values.update(overrides)
        with mock.patch.dict(os.environ, values):
            return Config()

    def test_dry_run_records_simulation_without_claiming_a_real_delivery(self):
        self.create_event()
        self.due_rows(2)
        api = mock.Mock()
        worker = OutboxWorker(self.config(), api)
        result = worker.poll_once()
        self.assertEqual(result['claimed'], 3)
        self.assertEqual(result['sent'], 0)
        self.assertEqual(result['simulated'], 3)
        api.post.assert_not_called()
        self.assertEqual(set(r['status'] for r in self.rows()), {'skipped'})
        self.assertTrue(all(r['simulated_at'] and not r['sent_at'] for r in self.rows()))
        self.assertTrue(all(r['last_error'] == 'dry-run' for r in self.rows()))

    def test_api_failure_retries_without_touching_business_tables(self):
        self.create_event()
        self.due_rows(2)
        api = mock.Mock()
        api.post.return_value = (False, 40034105, {})
        config = self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MAX_ATTEMPTS='3')
        worker = OutboxWorker(config, api)
        worker.poll_once()
        rows = self.rows()
        self.assertTrue(all(r['status'] == 'pending' for r in rows))
        self.assertTrue(all(r['attempts'] == 1 for r in rows))
        self.assertTrue(all('40034105' in r['last_error'] for r in rows))
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0], 1)

    def test_event_archived_skips_pending_reminders(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            db.execute('DELETE FROM bot_outbox WHERE due_at IS NOT NULL')
            db.execute("UPDATE events SET archived_at=? WHERE id=?", (now(), event_id))
        with storage.connect(self.path) as db:
            self.assertTrue(bot_outbox.enqueue(
                db, event_id, 'deadline_reminder', '报名即将截止', due_at=now()))
        worker = OutboxWorker(self.config(), mock.Mock())
        worker.poll_once()
        row = next(r for r in self.rows() if r['kind'] == 'deadline_reminder')
        self.assertEqual(row['status'], 'skipped')
        self.assertIn('归档', row['last_error'])

    def test_empty_text_payload_is_never_sent(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            db.execute('''INSERT INTO bot_outbox
                (event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)''',
                (event_id, 'activity_published', 'blank', 'group', '',
                 json.dumps({'text': '   ', 'msg_type': 0}), None, 'pending', now()))
        api = mock.Mock()
        api.post.return_value = (True, 0, {})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0'), api)
        worker.poll_once()
        self.assertFalse(any(call.args[1].get('content') == '   '
                             for call in api.post.call_args_list))
        row = self.rows("WHERE dedupe_key='blank'")[0]
        self.assertEqual(row['status'], 'failed')
        self.assertIn('空', row['last_error'])

    def test_rich_media_without_content_is_never_sent(self):
        event_id = self.create_event()
        with storage.connect(self.path) as db:
            db.execute('''INSERT INTO bot_outbox
                (event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)''',
                (event_id, 'settlement_updated', 'blank-media', 'group', '',
                 json.dumps({'msg_type': 7}), None, 'pending', now()))
        api = mock.Mock()
        api.post.return_value = (True, 0, {})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0'), api)
        worker.poll_once()
        self.assertFalse(any(call.args[1].get('msg_type') == 7
                             for call in api.post.call_args_list))
        self.assertEqual(self.rows("WHERE dedupe_key='blank-media'")[0]['status'], 'failed')

    def test_api_exception_is_bounded_and_does_not_stop_the_batch(self):
        self.create_event();self.due_rows(1)
        api=mock.Mock();api.post.side_effect=[RuntimeError('token unavailable'),(True,0,{})]
        worker=OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0',KANBAN_BOT_MAX_ATTEMPTS='2'),api)
        worker.poll_once()
        rows=self.rows()
        self.assertEqual(sorted(r['status'] for r in rows),['pending','sent'])
        failed=next(r for r in rows if r['status']=='pending')
        self.assertEqual(failed['attempts'],1)
        self.assertGreater(failed['retry_at'],now())
        self.assertEqual(worker.poll_once()['claimed'],0)
        api.post.side_effect=RuntimeError('still unavailable')
        with mock.patch('qgroup_bot.worker.now',return_value=failed['retry_at']):
            worker.poll_once()
        failed=self.rows('WHERE id=?',(failed['id'],))[0]
        self.assertEqual((failed['status'],failed['attempts']),('failed',2))

    def test_send_time_checks_prevent_private_or_disabled_broadcasts(self):
        for field,value in [('visibility','invitation'),('bot_enabled',0)]:
            event_id=self.create_event()
            with storage.connect(self.path) as db:
                db.execute('UPDATE events SET '+field+'=? WHERE id=?',(value,event_id))
            api=mock.Mock()
            worker=OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0'),api)
            worker.poll_once()
            api.post.assert_not_called()

    def test_old_claim_cannot_send_or_overwrite_a_reclaimed_row(self):
        self.create_event()
        api=mock.Mock();api.post.return_value=(True,0,{})
        worker=OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0'),api)
        old=worker.claim()[0]
        with storage.connect(self.path) as db:
            db.execute("UPDATE bot_outbox SET claimed_at='2000-01-01T00:00:00+00:00' WHERE id=?",(old['id'],))
        new=worker.claim()[0]
        self.assertNotEqual(old['claim_token'],new['claim_token'])
        self.assertEqual(worker.deliver(old),'skipped')
        api.post.assert_not_called()
        self.assertEqual(worker.deliver(new),'sent')

    def test_rescheduling_replaces_reminders_even_without_attendees(self):
        event_id=self.create_event()
        old=[r for r in self.rows() if r['due_at']]
        with storage.connect(self.path) as db:
            e=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            shifted=(datetime.fromisoformat(self.start)+timedelta(days=2)).isoformat(timespec='seconds')
            events.patch(db,e,self.user,dict(self.data,starts_at=shifted,deadline=shifted,reason='改期'))
        rows=self.rows()
        self.assertTrue(all(next(r for r in rows if r['id']==o['id'])['status']=='skipped' for o in old))
        self.assertEqual(len([r for r in rows if r['due_at'] and r['status']=='pending']),2)
        self.assertEqual(len([r for r in rows if r['kind']=='conditions_changed']),1)

    def test_reschedule_back_to_original_time_restores_invalidated_reminders(self):
        event_id=self.create_event()
        original_due={r['due_at'] for r in self.rows() if r['due_at']}
        shifted=(datetime.fromisoformat(self.start)+timedelta(days=2)).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            for start in (shifted,self.start):
                e=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
                events.patch(db,e,self.user,dict(self.data,starts_at=start,deadline=start,reason='调整安排'))
            e=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            events.patch(db,e,self.user,dict(self.data,reason='重复保存'))
        pending=[r for r in self.rows() if r['due_at'] and r['status']=='pending']
        self.assertEqual(len(pending),2)
        self.assertEqual({r['due_at'] for r in pending},original_due)

    def test_due_reminder_uses_current_counts_and_preserves_its_intent(self):
        from qgroup_core import roster
        event_id=self.create_event()
        reminder=next(r for r in self.rows() if r['kind']=='deadline_reminder')
        with storage.connect(self.path) as db:
            e=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            roster.add_party(db,e,self.user,{'people':[{'is_self':True}]},require_preview=False)
        api=mock.Mock();api.post.return_value=(True,0,{})
        worker=OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0'),api)
        with mock.patch('qgroup_bot.worker.now',return_value=reminder['due_at']):
            worker.poll_once()
        row=self.rows('WHERE id=?',(reminder['id'],))[0]
        self.assertEqual(row['status'],'sent')
        self.assertIn('正式报名 1 人',json.loads(row['delivered_payload_json'])['content'])
        self.assertEqual(row['payload_json'],reminder['payload_json'])

    def test_callback_keeps_the_event_and_personal_rows_keep_the_recipient(self):
        with mock.patch.dict(os.environ,{'KANBAN_BOT_KEYBOARD':'1','KANBAN_BOT_PERSONAL_QUEUE':'1'}):
            event_id=self.create_event()
            with storage.connect(self.path) as db:
                audit.notify(db,'u1',event_id,'withdrawal_request','private reason')
        card=next(r for r in self.rows() if r['kind']=='activity_published')
        buttons=json.loads(card['payload_json'])['keyboard']['content']['rows']
        callbacks=[b['action']['data'] for r in buttons for b in r['buttons'] if b['action']['type']==1]
        self.assertTrue(all(text.endswith(event_id) for text in callbacks))
        row=next(r for r in self.rows() if r['channel']=='private')
        self.assertEqual(row['recipient_user_id'],'u1')

    def test_sharing_is_opt_in_and_cannot_be_enabled_for_private_events(self):
        from qgroup_core.common import APIError
        with storage.connect(self.path) as db:
            event_id=events.create(db,self.user,dict(self.data,bot_enabled=False))
            self.assertFalse(db.execute('SELECT 1 FROM bot_outbox WHERE event_id=?',(event_id,)).fetchone())
            with self.assertRaises(APIError):
                events.create(db,self.user,dict(self.data,visibility='invitation'))

    def test_manual_retry_is_a_new_delivery_and_cannot_duplicate_a_pending_one(self):
        from qgroup_core.common import APIError
        event_id=self.create_event()
        worker=OutboxWorker(self.config(),mock.Mock());worker.poll_once()
        original=next(r for r in self.rows() if r['kind']=='activity_published')
        with storage.connect(self.path) as db:
            event=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            new_id=bot_outbox.retry(db,event,original['id'])
            with self.assertRaises(APIError):
                bot_outbox.retry(db,event,original['id'])
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0],1)
        new=self.rows('WHERE id=?',(new_id,))[0]
        self.assertEqual(new['status'],'pending')
        self.assertEqual(new['payload_json'],original['payload_json'])
        self.assertEqual(self.rows('WHERE id=?',(original['id'],))[0]['status'],'skipped')

    def test_disable_cancels_queued_messages_and_nonowners_cannot_change_sharing(self):
        from qgroup_core.common import APIError
        event_id=self.create_event()
        with storage.connect(self.path) as db:
            event=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            with self.assertRaises(APIError):
                events.patch(db,event,{'id':'not-owner','nickname':'test'},dict(action='bot_sync',bot_enabled=False))
            events.patch(db,event,self.user,dict(action='bot_sync',bot_enabled=False))
        self.assertTrue(all(r['status']=='skipped' for r in self.rows()))

    def test_v10_migration_preserves_existing_data_and_defaults_to_no_sharing(self):
        from deploy.verify_migration import verify
        self.create_event()
        source=Path(self.tmp.name)/'v10.sqlite3';target=Path(self.tmp.name)/'v11.sqlite3'
        with sqlite3.connect(self.path) as db,sqlite3.connect(source) as copy:
            db.backup(copy)
        with sqlite3.connect(source) as db:
            db.execute('ALTER TABLE events DROP COLUMN bot_enabled')
            for column in ('retry_at','simulated_at','delivered_payload_json','claim_token','recipient_user_id'):
                db.execute('ALTER TABLE bot_outbox DROP COLUMN '+column)
            db.execute('DELETE FROM schema_migrations WHERE version=11')
        verify(source,target)
        with storage.connect(target) as db:
            self.assertEqual(db.execute('SELECT bot_enabled FROM events').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0],15)


if __name__ == '__main__':
    unittest.main()
