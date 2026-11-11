"""Committed registration facts create one public announcement per operation."""
import json
import threading
import unittest
from unittest import mock

import server
from qgroup_core import bot_markdown, bot_outbox, bot_settings, events, roster, storage
from qgroup_core.common import APIError, now
from qgroup_bot.worker import OutboxWorker
from test_bot_markdown_broadcast import Fixture
from test_roster import ModernClient


class SignupNotificationTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.event_id = self.event(capacity=1)

    def signup(self, db, people, **changes):
        event = self.latest_event(db)
        data = dict(people=[dict(name=name, note='不要公开的备注') for name in people],
                    accept_partial=True, base_revision=event['revision'], **changes)
        preview = roster.preview(db, event, self.user, data)
        roster.add_party(db, event, self.user, dict(data, **preview))

    def notifications(self):
        return [r for r in self.rows() if r['kind'] == 'registration_added']

    def test_party_queues_once_with_new_names_and_totals_in_both_formats(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['正式甲', '候补乙'])
        rows = self.notifications()
        self.assertEqual(len(rows), 1)
        payload = json.loads(rows[0]['payload_json'])
        for text in (payload['text'], payload['markdown_text']):
            self.assertIn('本次正式报名（1 人）：正式甲', text)
            self.assertIn('本次候补（1 人）：候补乙', text)
            self.assertIn('当前正式报名 1 人，候补 1 人', text)
            self.assertIn('距开始：', text)
            self.assertNotIn('不要公开的备注', text)
            self.assertIsNone(bot_markdown.content_problem(text, ('example.test',)))
        self.assertNotIn('payer_kind', json.dumps(payload))
        self.assertNotIn('attendee_ids', json.dumps(payload))

    def test_preview_invalid_submission_and_rolled_back_signup_never_leave_a_message(self):
        with storage.connect(self.path) as db:
            roster.preview(db, self.latest_event(db), self.user, dict(people=[dict(name='预览者')]))
            with self.assertRaises(APIError):
                roster.add_party(db, self.latest_event(db), self.user, dict(people=[dict(name='未确认者')]))
        self.assertEqual(self.notifications(), [])
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with storage.connect(self.path) as db:
                self.signup(db, ['回滚者'])
                self.assertEqual(db.execute("SELECT count(*) FROM bot_outbox WHERE kind='registration_added'").fetchone()[0], 1)
                raise RuntimeError('rollback')
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attendees').fetchone()[0], 0)

    def test_replayed_audit_hook_deduplicates_the_same_registration(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['甲'])
            entry = db.execute("SELECT * FROM event_audit WHERE event_id=? AND action='signup'", (self.event_id,)).fetchone()
            for _ in range(2):
                bot_outbox.on_append(db, self.latest_event(db), self.user, 'signup',
                                     json.loads(entry['before_json']), json.loads(entry['after_json']))
        self.assertEqual(len(self.notifications()), 1)

    def test_event_and_global_policy_switches_are_honoured(self):
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET bot_enabled=0 WHERE id=?', (self.event_id,))
            self.signup(db, ['不同步'])
            db.execute('UPDATE events SET bot_enabled=1 WHERE id=?', (self.event_id,))
            current = bot_settings.read(db)
            policy = current['config']
            policy['broadcast_kinds'].remove('registration_added')
            bot_settings.save(db, dict(base_revision=current['revision'], config=policy), 'test-admin')
            self.signup(db, ['关闭类型'])
            # Saving an old, explicit selection must not silently enable a new type.
            self.assertNotIn('registration_added', bot_settings.read(db)['config']['broadcast_kinds'])
            current = bot_settings.read(db)
            policy = current['config']
            policy['broadcast_kinds'].append('registration_added')
            policy['enabled'] = False
            bot_settings.save(db, dict(base_revision=current['revision'], config=policy), 'test-admin')
            self.signup(db, ['关闭全局'])
        self.assertEqual(self.notifications(), [])

    def test_invitation_and_draft_events_do_not_broadcast(self):
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET visibility='invitation',bot_enabled=0 WHERE id=?", (self.event_id,))
            self.signup(db, ['私有报名'])
            db.execute("UPDATE events SET lifecycle='draft' WHERE id=?", (self.event_id,))
            with self.assertRaises(APIError):
                self.signup(db, ['草稿报名'])
        self.assertEqual(self.notifications(), [])

    def test_tentative_only_announces_when_confirmed_and_does_not_announce_edits(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['先待确认'], intent='tentative')
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            person = roster.rows(db, self.event_id)[0]
            roster.change_person(db, self.latest_event(db), self.user, person['id'], dict(action='confirm'))
            roster.change_person(db, self.latest_event(db), self.user, person['id'], dict(action='edit', name='改称呼'))
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('本次正式报名（1 人）：先待确认', json.loads(self.notifications()[0]['payload_json'])['text'])

    def test_invite_creation_is_silent_acceptance_announces_once(self):
        with storage.connect(self.path) as db:
            roster.invite(db, self.latest_event(db), self.user,
                          dict(people=[dict(name='旧邀请称呼')], reason='补报名'))
            token = roster.rows(db, self.event_id)[0]['invitation_token']
            db.execute("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('u2','hash2','接受者',?)", (now(),))
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            roster.accept_invitation(db, self.latest_event(db), dict(id='u2', nickname='接受者'), token, {})
        self.assertEqual(len(self.notifications()), 1)
        text = json.loads(self.notifications()[0]['payload_json'])['text']
        self.assertIn('本次正式报名（1 人）：接受者', text)
        self.assertNotIn('旧邀请称呼', text)

    def test_automatic_owner_registration_is_in_publication_without_a_second_message(self):
        self.event_id = self.event(join_owner=True)
        with storage.connect(self.path) as db:
            publication = db.execute("SELECT payload_json FROM bot_outbox WHERE event_id=? AND kind='activity_published'", (self.event_id,)).fetchone()
            self.assertIn('正式报名（1 人）：发起人', json.loads(publication[0])['text'])
        self.assertEqual(self.notifications(), [])
        self.event_id = self.event(lifecycle='draft')
        with storage.connect(self.path) as db:
            event = self.latest_event(db)
            events.patch(db, event, self.user, dict(action='publish', base_revision=event['revision']))
        self.assertEqual(self.notifications(), [])

    def test_existing_waitlist_promotions_are_not_mislabelled_as_new_signups(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['原正式', '原候补'])
            db.execute("DELETE FROM bot_outbox WHERE kind='registration_added'")
            db.execute('UPDATE events SET capacity=2 WHERE id=?', (self.event_id,))
            self.signup(db, ['新候补'])
        text = json.loads(self.notifications()[0]['payload_json'])['text']
        self.assertIn('本次候补（1 人）：新候补', text)
        self.assertIn('当前正式报名 2 人，候补 1 人', text)
        self.assertNotIn('原候补', text)

    def test_long_untrusted_names_are_bounded_and_delivery_keeps_the_snapshot(self):
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET capacity=0 WHERE id=?', (self.event_id,))
            self.signup(db, ['**甲** [乙](https://x.t)'] + ['参加者%02d' % n for n in range(19)])
            db.execute("UPDATE attendees SET name='后来改名',status='withdrawn' WHERE event_id=?", (self.event_id,))
            db.execute("DELETE FROM bot_outbox WHERE kind!='registration_added'")
        original = self.notifications()[0]['payload_json']
        payload = json.loads(original)
        for text in (payload['text'], payload['markdown_text']):
            self.assertIn('本次正式报名（20 人）：甲 乙', text)
            self.assertIn('其余 10 人请到活动页查看', text)
            self.assertNotIn('https://x.t', text)
            self.assertLessEqual(len(text), 4000)
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN='1'), api)
        self.assertEqual(worker.poll_once()['sent'], 1)
        text = api.post.call_args.args[1]['markdown']['content']
        self.assertIn('本次正式报名（20 人）：甲 乙', text)
        self.assertNotIn('后来改名', text)
        self.assertEqual(self.notifications()[0]['payload_json'], original)


class SignupHTTPReplayTests(Fixture, unittest.TestCase):
    def test_repeated_http_submission_creates_one_registration_announcement(self):
        original_db = server.DB
        server.DB = self.path
        self.addCleanup(setattr, server, 'DB', original_db)
        server.LIMITS.clear()
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        client = ModernClient('http://127.0.0.1:%d' % http.server_address[1]).identify('HTTP参加者')
        self.event_id = self.event()
        path = '/api/events/' + self.event_id + '/roster'
        body = dict(people=[dict(is_self=True)])
        code, preview = client.request(path + '/preview', 'POST', body)
        self.assertEqual(code, 200)
        body.update(preview)
        for _ in range(2):
            code, result = client.request(path + '/parties', 'POST', body,
                                          headers={'Idempotency-Key': 'same-signup-request'})
            self.assertEqual(code, 200, result)
        rows = [r for r in self.rows() if r['kind'] == 'registration_added']
        self.assertEqual(len(rows), 1)
