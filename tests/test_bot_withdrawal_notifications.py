"""Public announcements describe committed withdrawals and actual promotions."""
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import server
from qgroup_core import bot_markdown, bot_outbox, bot_settings, events, roster, storage
from qgroup_core.common import APIError, now
from qgroup_bot.worker import OutboxWorker
from test_bot_markdown_broadcast import Fixture
from test_roster import ModernClient


class WithdrawalNotificationTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.event_id = self.event(capacity=1)
        self.manager = dict(id='u2', nickname='报名管理人')
        with storage.connect(self.path) as db:
            db.execute('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)',
                       ('u2', 'hash2', self.manager['nickname'], now()))

    def signup(self, db, names, user=None, **extra):
        user = user or self.user
        event = self.latest_event(db)
        data = dict(people=[dict(name=name, note='私有报名备注') for name in names],
                    accept_partial=True, base_revision=event['revision'], **extra)
        roster.add_party(db, event, user, dict(data, **roster.preview(db, event, user, data)))
        return roster.rows(db, self.event_id)

    def change_event(self, db, **extra):
        event = self.latest_event(db)
        data = {key: event[key] for key in ('title','category','location','starts_at','deadline',
                                          'capacity','description','duration_hours')}
        data.update(reason='调整安排', base_revision=event['revision'], **extra)
        events.patch(db, event, self.user, data)

    def notifications(self):
        return [r for r in self.rows() if r['kind'] == 'registration_changed']

    def text(self):
        rows = self.notifications()
        self.assertEqual(len(rows), 1)
        return json.loads(rows[0]['payload_json'])['text']

    def expire_withdrawal(self, db):
        db.execute('UPDATE events SET withdrawal_deadline=? WHERE id=?',
                   ((datetime.now(timezone.utc)-timedelta(hours=1)).isoformat(), self.event_id))

    def test_confirmed_withdrawal_and_promotion_are_one_public_message(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['退出甲', '递补乙'])
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], dict(reason='私有退出原因'))
        payload = json.loads(self.notifications()[0]['payload_json'])
        self.assertEqual(len(self.notifications()), 1)
        for text in (payload['text'], payload['markdown_text']):
            self.assertIn('本次退出（1 人）：退出甲', text)
            self.assertIn('递补为正式（1 人）：递补乙', text)
            self.assertIn('当前正式报名 1 人，候补 0 人', text)
            self.assertIn('距开始：', text)
            self.assertIsNone(bot_markdown.content_problem(text, ('example.test',)))
        for private in ('私有退出原因', '私有报名备注', 'payer_kind', 'withdrawal_reason', 'attendee_ids'):
            self.assertNotIn(private, json.dumps(payload, ensure_ascii=False))

    def test_waitlist_can_withdraw_after_withdrawal_deadline_without_promotion(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['保留正式', '退出候补'])
            self.expire_withdrawal(db)
            roster.withdraw(db, self.latest_event(db), self.user, people[1]['id'], {})
        text = self.text()
        self.assertIn('本次退出（1 人）：退出候补', text)
        self.assertIn('递补为正式（0 人）：暂无', text)
        self.assertNotIn('保留正式', text)

    def test_pending_and_rejected_late_withdrawals_keep_the_seat_and_are_silent(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['尚未退出'], user=self.manager)
            self.expire_withdrawal(db)
            roster.withdraw(db, self.latest_event(db), self.manager, people[0]['id'], dict(reason='私人申请'))
            self.assertEqual(db.execute("SELECT status FROM attendees WHERE id=?", (people[0]['id'],)).fetchone()[0], 'confirmed')
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], dict(reason='私人审批'), decision='reject')
        self.assertEqual(self.notifications(), [])

    def test_approved_late_withdrawal_announces_final_result_with_promotion(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['获准退出', '下一位'], user=self.manager)
            self.expire_withdrawal(db)
            roster.withdraw(db, self.latest_event(db), self.manager, people[0]['id'], dict(reason='私人申请'))
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], dict(reason='同意原因'), decision='approve')
        text = self.text()
        self.assertIn('本次退出（1 人）：获准退出', text)
        self.assertIn('递补为正式（1 人）：下一位', text)
        self.assertNotIn('同意原因', text)

    def test_owner_removal_announces_but_unauthorised_attempt_does_not(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['被撤销者'], user=self.manager)
            with self.assertRaises(APIError):
                roster.withdraw(db, self.latest_event(db), dict(id='unrelated', nickname='外人'), people[0]['id'], {})
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], dict(reason='私人管理原因'))
        self.assertIn('本次退出（1 人）：被撤销者', self.text())
        self.assertNotIn('私人管理原因', self.text())

    def test_tentative_and_unaccepted_invite_cancellation_are_silent(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['原本待确认'], intent='tentative')
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], {})
            roster.invite(db, self.latest_event(db), self.user, dict(people=[dict(name='仅受邀')], reason='邀请'))
            invited = next(p for p in roster.rows(db, self.event_id) if p['status']=='invited')
            roster.withdraw(db, self.latest_event(db), self.user, invited['id'], {})
        self.assertEqual(self.notifications(), [])

    def test_event_cancellation_is_not_misreported_as_individual_withdrawals(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['保留历史名单'])
            event = self.latest_event(db)
            events.patch(db, event, self.user, dict(action='cancel', reason='活动取消', base_revision=event['revision']))
        self.assertEqual(self.notifications(), [])
        self.assertEqual(sum(r['kind']=='event_cancelled' for r in self.rows()), 1)

    def test_capacity_increase_announces_a_standalone_promotion(self):
        with storage.connect(self.path) as db:
            self.signup(db, ['原正式', '增加名额后递补'])
            self.change_event(db, capacity=2)
        text = self.text()
        self.assertIn('本次退出（0 人）：暂无', text)
        self.assertIn('递补为正式（1 人）：增加名额后递补', text)
        self.assertNotIn('原正式', text)
        self.assertIn('当前正式报名 2 人，候补 0 人', text)

    def test_paused_event_preserves_waitlist_until_registration_resumes(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['暂停后退出', '恢复后递补'])
            event = self.latest_event(db)
            events.patch(db, event, self.user, dict(action='pause', base_revision=event['revision']))
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], {})
        self.assertIn('递补为正式（0 人）：暂无', self.text())
        with storage.connect(self.path) as db:
            db.execute("DELETE FROM bot_outbox WHERE kind='registration_changed'")
            event = self.latest_event(db)
            events.patch(db, event, self.user, dict(action='resume', base_revision=event['revision']))
        self.assertIn('递补为正式（1 人）：恢复后递补', self.text())

    def test_splitting_a_together_party_announces_only_the_people_promoted(self):
        with storage.connect(self.path) as db:
            self.change_event(db, capacity=2)
            self.signup(db, ['已占一位'])
            people = self.signup(db, ['拆组后递补', '仍然候补'], queue_mode='together')
            roster.change_person(db, self.latest_event(db), self.user, people[1]['id'], dict(action='split'))
        text = self.text()
        self.assertIn('递补为正式（1 人）：拆组后递补', text)
        self.assertNotIn('仍然候补', text)
        self.assertIn('当前正式报名 2 人，候补 1 人', text)

    def test_rollback_repeated_audit_hook_and_repeated_withdrawal_do_not_duplicate(self):
        with storage.connect(self.path) as db:
            people = self.signup(db, ['甲'])
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with storage.connect(self.path) as db:
                roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], {})
                raise RuntimeError('rollback')
        self.assertEqual(self.notifications(), [])
        with storage.connect(self.path) as db:
            roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], {})
            entry = db.execute("SELECT * FROM event_audit WHERE event_id=? AND action='withdraw'", (self.event_id,)).fetchone()
            bot_outbox.on_append(db, self.latest_event(db), self.user, 'withdraw',
                                 json.loads(entry['before_json']), json.loads(entry['after_json']))
            with self.assertRaises(APIError):
                roster.withdraw(db, self.latest_event(db), self.user, people[0]['id'], {})
        self.assertEqual(len(self.notifications()), 1)

    def test_public_sync_and_policy_controls_are_preserved(self):
        for mode in ('private', 'event_off', 'global_off', 'kind_off'):
            with self.subTest(mode=mode), storage.connect(self.path) as db:
                # Each case starts with a successful registration, then disables sharing.
                db.execute("UPDATE events SET visibility='public',bot_enabled=1 WHERE id=?", (self.event_id,))
                current = bot_settings.read(db)
                policy = current['config']
                policy['enabled'] = True
                if 'registration_changed' not in policy['broadcast_kinds']:
                    policy['broadcast_kinds'].append('registration_changed')
                bot_settings.save(db, dict(base_revision=current['revision'], config=policy), 'test-admin')
                people = self.signup(db, ['关闭后退出'])
                person = people[-1]
                if mode == 'private':
                    db.execute("UPDATE events SET visibility='invitation',bot_enabled=0 WHERE id=?", (self.event_id,))
                elif mode == 'event_off':
                    db.execute('UPDATE events SET bot_enabled=0 WHERE id=?', (self.event_id,))
                else:
                    current = bot_settings.read(db)
                    policy = current['config']
                    if mode == 'global_off':
                        policy['enabled'] = False
                    else:
                        policy['broadcast_kinds'].remove('registration_changed')
                    bot_settings.save(db, dict(base_revision=current['revision'], config=policy), 'test-admin')
                roster.withdraw(db, self.latest_event(db), self.user, person['id'], {})
        self.assertEqual(self.notifications(), [])

    def test_long_promotion_list_is_safe_bounded_and_frozen_until_delivery(self):
        with storage.connect(self.path) as db:
            self.change_event(db, capacity=20)
            first = self.signup(db, ['**甲** [乙](https://x.t)'])[0]
            self.signup(db, ['候补%02d' % i for i in range(20)], queue_mode='together')
            roster.withdraw(db, self.latest_event(db), self.user, first['id'], dict(reason='私有原因'))
            db.execute("UPDATE attendees SET name='后来的称呼' WHERE event_id=?", (self.event_id,))
            db.execute("DELETE FROM bot_outbox WHERE kind!='registration_changed'")
        original = self.notifications()[0]['payload_json']
        for text in (json.loads(original)['text'], json.loads(original)['markdown_text']):
            self.assertIn('本次退出（1 人）：甲 乙', text)
            self.assertIn('递补为正式（20 人）：', text)
            self.assertIn('其余 10 人请到活动页查看', text)
            self.assertNotIn('https://x.t', text)
            self.assertNotIn('私有原因', text)
            self.assertLessEqual(len(text), 4000)
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id':'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN='1'), api)
        self.assertEqual(worker.poll_once()['sent'], 1)
        text = api.post.call_args.args[1]['markdown']['content']
        self.assertIn('本次退出（1 人）：甲 乙', text)
        self.assertNotIn('后来的称呼', text)
        self.assertEqual(self.notifications()[0]['payload_json'], original)

    def test_repeated_http_delete_produces_one_notification(self):
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
        client = ModernClient('http://127.0.0.1:%d' % http.server_address[1]).identify('HTTP退出者')
        path = '/api/events/' + self.event_id
        body = dict(people=[dict(is_self=True)])
        code, preview = client.request(path+'/roster/preview', 'POST', body)
        self.assertEqual(code, 200)
        code, result = client.request(path+'/roster/parties', 'POST', dict(body, **preview))
        self.assertEqual(code, 200)
        person = result['my_registration']
        request = dict(base_revision=result['revision'])
        for _ in range(2):
            code, result = client.request(path+'/attendees/'+person['id'], 'DELETE', request,
                                          headers={'Idempotency-Key':'same-withdrawal-request'})
            self.assertEqual(code, 200, result)
        self.assertEqual(len(self.notifications()), 1)
