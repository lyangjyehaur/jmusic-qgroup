"""Public registration names in queries and frozen / refreshed broadcasts."""
import json
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timedelta
from unittest import mock

from qgroup_core import bot_markdown, bot_outbox, bot_settings, bot_views, storage
from qgroup_core.common import now
from qgroup_bot.replies import answer, answer_markdown, read_db
from qgroup_bot.worker import OutboxWorker
from test_bot_markdown_broadcast import Fixture


class RosterMessageTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.event_id = self.event()

    def person(self, db, name, status='confirmed', *, user_id=None,
               event_id=None, party_id=None, **fields):
        identity = uuid.uuid4().hex
        db.execute('''INSERT INTO attendees
            (id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,
             created_at,updated_at,withdrawal_requested,confirmation_state)
            VALUES(?,?,'u1',?,?,?,'不要公开的备注','manager',?,?,?,?,?)''',
            (identity, event_id or self.event_id, user_id, party_id, name, status,
             now(), now(), fields.get('withdrawal_requested', 0),
             fields.get('confirmation_state', 'confirmed')))
        return identity

    def test_statuses_names_and_queue_order_match_public_roster(self):
        with storage.connect(self.path) as db:
            for party in ('first', 'second'):
                db.execute('''INSERT INTO roster_parties
                    (id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,'u1','individual',?)''',
                    (party, self.event_id, now()))
            self.person(db, '后组先写入', party_id='second')
            self.person(db, '同名', party_id='first', withdrawal_requested=1,
                        confirmation_state='pending')
            self.person(db, '同名', party_id='first', confirmation_state='declined')
            self.person(db, '旧名字', user_id='u1', party_id='first')
            self.person(db, '候补甲', 'waiting', party_id='first')
            for status in ('tentative', 'invited', 'withdrawn'):
                self.person(db, '隐藏' + status, status, party_id='first')
            lines = bot_views.roster_lines(db, self.latest_event(db))
        self.assertEqual(lines, ['正式报名（4 人）：同名、同名、发起人、后组先写入', '候补（1 人）：候补甲'])

    def test_query_scope_and_plain_markdown_agreement(self):
        with storage.connect(self.path) as db:
            self.person(db, '公开甲')
            self.person(db, '候补乙', 'waiting')
            db.execute('UPDATE events SET bot_enabled=0 WHERE id=?', (self.event_id,))
        with closing(read_db(self.path)) as db:
            for command in ('活动', '报名', '名额'):
                for rich in (False, True):
                    with self.subTest(command=command, rich=rich):
                        text = answer_markdown(db, command) if rich else answer(db, command)[0]
                        self.assertEqual(text.count('正式报名（1 人）：公开甲'), 1)
                        self.assertEqual(text.count('候补（1 人）：候补乙'), 1)
                        self.assertNotIn('不要公开的备注', text)
                        self.assertNotIn('manager', text)
                        self.assertIsNone(bot_markdown.content_problem(text, ('example.test',)))
            for command in ('待办', '结算', '我的', '管理', '出席'):
                self.assertNotIn('公开甲', answer(db, command)[0])
                self.assertNotIn('公开甲', answer_markdown(db, command))

    def test_private_draft_deleted_and_other_event_names_are_excluded(self):
        with storage.connect(self.path) as db:
            self.person(db, '独有名字')
            event = dict(self.latest_event(db))
            for change in ({'visibility': 'invite'}, {'lifecycle': 'draft'}, {'status': 'deleted'}):
                self.assertEqual(bot_views.roster_lines(db, dict(event, **change)), [])
        other = self.event('另一场')
        with storage.connect(self.path) as db:
            self.person(db, '别场名字', event_id=other)
        with closing(read_db(self.path)) as db:
            for rich in (False, True):
                query = answer_markdown if rich else lambda *a: answer(*a)[0]
                selection = query(db, '活动')
                self.assertNotIn('独有名字', selection)
                self.assertNotIn('别场名字', selection)
                selected = query(db, '活动', self.event_id[:8])
                self.assertIn('独有名字', selected)
                self.assertNotIn('别场名字', selected)
            with storage.connect(self.path) as writer:
                writer.execute("UPDATE events SET visibility='invite' WHERE id=?", (self.event_id,))
            self.assertNotIn('独有名字', answer(db, '活动', self.event_id[:8])[0])
            self.assertIsNone(answer_markdown(db, '活动', self.event_id[:8]))

    def test_untrusted_names_cannot_add_markdown_mentions_or_urls(self):
        with storage.connect(self.path) as db:
            self.person(db, '**甲**\n#标题 [乙](https://evil.test)')
            self.person(db, '<qqbot-at-everyone /> <@!account-id> @everyone')
            self.person(db, 'HTTPS://evil.test/phishing')
            self.person(db, '丙@丁')
            lines = bot_views.roster_lines(db, self.latest_event(db))
        text = '\n'.join(lines)
        self.assertIn('甲 标题 乙', text)
        self.assertIn('丙丁', text)
        self.assertEqual(text.count('未填写称呼'), 2)
        for forbidden in ('evil.test', '@', '<', '*', '#', 'account-id', 'everyone'):
            self.assertNotIn(forbidden, text)
        with closing(read_db(self.path)) as db:
            self.assertIsNone(bot_markdown.content_problem(answer_markdown(db, '报名'), ('example.test',)))

    def test_long_rosters_keep_totals_and_count_the_remainder(self):
        with storage.connect(self.path) as db:
            for status in ('confirmed', 'waiting'):
                for index in range(13):
                    self.person(db, '%s%02d' % (status, index) + '长' * 40, status)
            lines = bot_views.roster_lines(db, self.latest_event(db))
        for line in lines:
            self.assertIn('（13 人）', line)
            self.assertIn('其余 3 人请到活动页查看', line)
            self.assertNotIn('10长', line)
        with closing(read_db(self.path)) as db:
            for command in ('活动', '报名', '名额'):
                self.assertLessEqual(len(answer(db, command)[0]), 4000)
                self.assertLessEqual(len(answer_markdown(db, command)), 4000)

    def test_optional_roster_never_displaces_required_content(self):
        lines = ['正式报名（1 人）：' + '甲' * 24, '候补（0 人）：暂无']
        for rich in (False, True):
            full = bot_views.with_roster('必需内容' + 'a' * 3965, lines, markdown=rich)
            self.assertIn('必需内容', full)
            self.assertIn('请到活动页查看完整名单', full)
            self.assertLessEqual(len(full), 4000)
            baseline = '必需内容' + 'a' * 3996
            self.assertEqual(bot_views.with_roster(baseline, lines, markdown=rich), baseline)

    def test_broadcast_scope_templates_and_legacy_contexts(self):
        with storage.connect(self.path) as db:
            self.person(db, '正式甲')
            self.person(db, '候补乙', 'waiting')
            config = bot_settings.read(db)['config']
            for kind in bot_outbox.DEFAULT_BROADCAST:
                config['templates'] = {kind: '{heading}\n{url}', kind + '@md': '## 提醒\n[查看]({url})'}
                plain, _, context = bot_outbox.build_message(db, self.latest_event(db), kind, config=config)
                for text in (plain, context['_markdown']):
                    self.assertEqual('正式甲' in text, kind in bot_outbox.ROSTER_KINDS)
                    self.assertEqual('候补乙' in text, kind in bot_outbox.ROSTER_KINDS)
                context.pop('_roster_lines', None)
                for rich in (False, True):
                    self.assertNotIn('正式甲', bot_outbox.render_message(config, kind, context, markdown=rich))

    def send(self, rich):
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN=str(int(rich))), api)
        self.assertEqual(worker.poll_once()['sent'], 1)
        body = api.post.call_args.args[1]
        self.assertEqual(body['msg_type'], 2 if rich else 0)
        return body['markdown']['content'] if rich else body['content']

    def test_regular_broadcast_keeps_frozen_names_statuses_and_counts(self):
        with storage.connect(self.path) as db:
            person = self.person(db, '入队名字')
            plain, buttons, context = bot_outbox.build_message(db, self.latest_event(db), 'formation_confirmed')
            db.execute("UPDATE attendees SET name='后来名字',status='waiting' WHERE id=?", (person,))
        for rich in (False, True):
            with storage.connect(self.path) as db:
                db.execute('DELETE FROM bot_outbox')
                bot_outbox.enqueue(db, self.event_id, 'formation_confirmed', plain,
                                   buttons=buttons, template_context=context)
            intent = self.rows()[0]['payload_json']
            text = self.send(rich)
            self.assertIn('正式报名（1 人）：入队名字', text)
            self.assertIn('候补（0 人）：暂无', text)
            self.assertNotIn('后来名字', text)
            self.assertEqual(self.rows()[0]['payload_json'], intent)

    def test_initial_publication_includes_automatic_owner_registration(self):
        owner_event = self.event('自动报名活动', join_owner=True)
        with storage.connect(self.path) as db:
            row = db.execute("SELECT payload_json FROM bot_outbox WHERE event_id=? AND kind='activity_published'",
                             (owner_event,)).fetchone()
            payload = json.loads(row['payload_json'])
            self.assertIn('正式报名（1 人）：发起人', payload['text'])
            self.assertIn('正式报名（1 人）：发起人', payload['markdown_text'])
            self.assertEqual(payload['_template_context']['confirmed'], '1')
            first = db.execute('SELECT action FROM event_audit WHERE event_id=? ORDER BY version LIMIT 1',
                               (owner_event,)).fetchone()[0]
            self.assertEqual(first, 'event_created')

    def test_deadline_reminder_uses_current_roster_at_delivery(self):
        for rich in (False, True):
            with storage.connect(self.path) as db:
                db.execute('DELETE FROM attendees')
                self.person(db, '发送时名字', 'waiting')
                db.execute('DELETE FROM bot_outbox')
                event = self.latest_event(db)
                plain, buttons, context = bot_outbox.build_message(db, event, 'deadline_reminder')
                plan = bot_outbox.reminder_plan(event, 'deadline_reminder')
                bot_outbox.enqueue(db, self.event_id, 'deadline_reminder', plain,
                                   buttons=buttons, template_context=context,
                                   schedule_key=plan[1], due_at=plan[0])
                db.execute("UPDATE attendees SET status='confirmed' WHERE event_id=?", (self.event_id,))
            delivery = datetime.fromisoformat(self.start) - timedelta(hours=12)
            with mock.patch('qgroup_bot.worker.now', return_value=delivery.isoformat()):
                text = self.send(rich)
            self.assertIn('正式报名（1 人）：发送时名字', text)
            self.assertIn('候补（0 人）：暂无', text)


if __name__ == '__main__':
    unittest.main()
