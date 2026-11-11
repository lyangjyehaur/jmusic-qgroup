"""Countdown display at reply/delivery time, without changing activity facts."""
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from unittest import mock

from qgroup_core import bot_outbox, bot_settings, storage
from qgroup_bot.replies import answer, answer_markdown, read_db
from qgroup_bot.worker import OutboxWorker
from test_bot_markdown_broadcast import Fixture


class CountdownTests(unittest.TestCase):
    def test_duration_units_and_start_boundaries(self):
        current = datetime(2026, 11, 11, tzinfo=timezone.utc)
        for delta, expected in (
                (timedelta(days=2, hours=3, minutes=15), '距开始：2 天 3 小时 15 分钟'),
                (timedelta(hours=2), '距开始：2 小时'),
                (timedelta(minutes=1), '距开始：1 分钟'),
                (timedelta(seconds=59), '距开始：不足 1 分钟'),
                (timedelta(0), '已到计划开始时间'),
                (-timedelta(hours=1), '已到计划开始时间')):
            with self.subTest(delta=delta):
                event = dict(starts_at=(current + delta).isoformat(),
                             timezone='Asia/Taipei', lifecycle='scheduled')
                self.assertEqual(bot_outbox.start_countdown(event, at=current), expected)
                self.assertEqual(event['lifecycle'], 'scheduled')

    def test_timezone_offsets_naive_local_time_and_dst(self):
        current = datetime(2026, 11, 11, 10, tzinfo=timezone.utc)
        for start in ('2026-11-11T12:00:00Z', '2026-11-11T20:00:00+08:00',
                      '2026-11-11T20:00:00'):
            with self.subTest(start=start):
                self.assertEqual(bot_outbox.start_countdown(
                    dict(starts_at=start, timezone='Asia/Taipei', lifecycle='scheduled'),
                    at=current), '距开始：2 小时')
        self.assertEqual(bot_outbox.start_countdown(
            dict(starts_at='2026-03-08T03:30:00', timezone='America/New_York', lifecycle='scheduled'),
            at=datetime(2026, 3, 8, 6, 30, tzinfo=timezone.utc)), '距开始：1 小时')

    def test_non_scheduled_and_invalid_times_have_no_countdown(self):
        for lifecycle in ('draft', 'ongoing', 'ended', 'cancelled'):
            self.assertEqual(bot_outbox.start_countdown(dict(
                starts_at='2099-01-01T00:00:00Z', timezone='UTC', lifecycle=lifecycle)), '')
        for start in ('', 'invalid', None):
            self.assertEqual(bot_outbox.start_countdown(dict(
                starts_at=start, timezone='UTC', lifecycle='scheduled')), '')
        self.assertEqual(bot_outbox.start_countdown({}), '')


class CountdownMessageTests(Fixture, unittest.TestCase):
    def clock(self, moment):
        patch = mock.patch.object(bot_outbox, 'datetime', wraps=datetime)
        clock = patch.start()
        clock.now.return_value = moment
        self.addCleanup(patch.stop)
        return clock

    def test_plain_and_markdown_activity_commands_show_countdown_once(self):
        self.event_id = self.event()
        self.clock(datetime.fromisoformat(self.start) - timedelta(days=2, hours=3, minutes=15))
        with closing(read_db(self.path)) as db:
            for command in ('活动', '待办', '名额', '报名', '地点', '规则', '出席',
                            '确认安排', '管理', '结算'):
                for rich in (False, True):
                    with self.subTest(command=command, rich=rich):
                        text = answer_markdown(db, command) if rich else answer(db, command)[0]
                        self.assertEqual(text.count('距开始：2 天 3 小时 15 分钟'), 1)
            for command in ('帮助', '我的', '发起'):
                self.assertNotIn('距开始', answer(db, command)[0])
                self.assertNotIn('距开始', answer_markdown(db, command))

    def test_selection_includes_a_separate_countdown_for_each_event(self):
        self.event()
        later = (datetime.fromisoformat(self.start) + timedelta(days=1)).isoformat()
        self.event('第二场活动', starts_at=later, deadline=later)
        self.clock(datetime.fromisoformat(self.start) - timedelta(hours=4, minutes=30))
        with closing(read_db(self.path)) as db:
            for text in (answer(db, '活动')[0], answer_markdown(db, '活动')):
                self.assertIn('距开始：4 小时 30 分钟', text)
                self.assertIn('距开始：1 天 4 小时 30 分钟', text)

    def test_broadcast_countdown_is_recomputed_without_mutating_frozen_facts(self):
        clock = self.clock(datetime.fromisoformat(self.start) - timedelta(days=2))
        self.event_id = self.event()
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
            db.execute('DELETE FROM bot_outbox')
        self.assertIn('距开始：2 天', plain)
        self.assertNotIn('距开始', context['_default_text'])
        clock.now.return_value += timedelta(hours=6)
        for markdown in ('0', '1'):
            with self.subTest(markdown=markdown):
                with storage.connect(self.path) as db:
                    db.execute('DELETE FROM bot_outbox')
                    bot_outbox.enqueue(db, self.event_id, 'activity_published', plain,
                                       template_context=context)
                    db.execute("UPDATE events SET title='后来的名称' WHERE id=?", (self.event_id,))
                intent = self.rows()[0]['payload_json']
                text = self.send(markdown)
                self.assertEqual(text.count('距开始：1 天 18 小时'), 1)
                self.assertNotIn('距开始：2 天', text)
                self.assertIn('测试活动', text)
                self.assertNotIn('后来的名称', text)
                self.assertEqual(self.rows()[0]['payload_json'], intent)

    def test_custom_templates_include_countdown_automatically(self):
        self.event_id = self.event()
        self.clock(datetime.fromisoformat(self.start) - timedelta(hours=2))
        with storage.connect(self.path) as db:
            config = bot_settings.read(db)['config']
            config['templates'] = {'activity_published': '{title}\n{url}',
                                   'activity_published@md': '## 提醒\n[打开]({url})'}
            plain, _, context = bot_outbox.build_message(
                db, self.latest_event(db), 'activity_published', config=config)
        self.assertEqual(plain.count('距开始：2 小时'), 1)
        self.assertEqual(context['_markdown'].count('距开始：2 小时'), 1)

    def test_countdown_does_not_displace_required_notice_at_message_limit(self):
        self.event_id = self.event()
        self.clock(datetime.fromisoformat(self.start) - timedelta(hours=2))
        with storage.connect(self.path) as db:
            context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')[2]
        config = bot_settings.defaults()
        template = '## 结算\n[打开]({url})'
        config['templates']['settlement_updated@md'] = template
        context['_settlement_notice'] = '必需明细' * 600
        context['_countdown_event'] = None
        baseline = bot_outbox.render_message(config, 'settlement_updated', context, markdown=True)
        config['templates']['settlement_updated@md'] = template + '\n' + 'a' * (3999 - len(baseline))
        baseline = bot_outbox.render_message(config, 'settlement_updated', context, markdown=True)
        self.assertEqual(len(baseline), 4000)
        context['_countdown_event'] = dict(starts_at=self.start, timezone='Asia/Shanghai',
                                          lifecycle='scheduled')
        rich = bot_outbox.render_message(config, 'settlement_updated', context, markdown=True)
        self.assertEqual(rich, baseline)
        self.assertIn(context['_settlement_notice'], rich)

    def test_admin_preview_includes_countdown_in_plain_and_markdown(self):
        self.clock(datetime.now(timezone.utc))
        with storage.connect(self.path) as db:
            preview = bot_settings.preview(db, dict(config=bot_settings.defaults(),
                                                    kind='activity_published'))
        self.assertIn('距开始：', preview['text'])
        self.assertIn('距开始：', preview['markdown'])

    def test_reminder_uses_delivery_time_instead_of_queue_time(self):
        clock = self.clock(datetime.fromisoformat(self.start) - timedelta(days=3))
        self.event_id = self.event()
        with storage.connect(self.path) as db:
            db.execute("DELETE FROM bot_outbox WHERE kind!='deadline_reminder'")
        delivery = datetime.fromisoformat(self.start) - timedelta(hours=12)
        clock.now.return_value = delivery
        with mock.patch('qgroup_bot.worker.now', return_value=delivery.isoformat()):
            text = self.send('1')
        self.assertEqual(text.count('距开始：12 小时'), 1)
        self.assertNotIn('距开始：3 天', text)

    def test_changed_schedule_or_lifecycle_suppresses_old_countdown(self):
        self.event_id = self.event()
        self.clock(datetime.fromisoformat(self.start) - timedelta(hours=4))
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
        shifted = (datetime.fromisoformat(self.start) + timedelta(days=1)).isoformat()
        for start, lifecycle in ((shifted, 'scheduled'), (self.start, 'ongoing'),
                                 (self.start, 'ended'), (self.start, 'cancelled')):
            for markdown in ('0', '1'):
                with self.subTest(start=start, lifecycle=lifecycle, markdown=markdown):
                    with storage.connect(self.path) as db:
                        db.execute('DELETE FROM bot_outbox')
                        db.execute('UPDATE events SET starts_at=?, lifecycle=? WHERE id=?',
                                   (start, lifecycle, self.event_id))
                        bot_outbox.enqueue(db, self.event_id, 'activity_published', plain,
                                           template_context=context)
                    text = self.send(markdown)
                    self.assertNotIn('距开始', text)
                    self.assertNotIn('已到计划开始时间', text)
                    self.assertIn(context['starts_at'], text)

    def test_legacy_context_gets_countdown_only_when_schedule_still_matches(self):
        self.event_id = self.event()
        self.clock(datetime.fromisoformat(self.start) - timedelta(hours=4))
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
        context.pop('_countdown_event')
        for changed in (False, True):
            with self.subTest(changed=changed):
                with storage.connect(self.path) as db:
                    db.execute('DELETE FROM bot_outbox')
                    if changed:
                        db.execute('UPDATE events SET starts_at=? WHERE id=?',
                                   ((datetime.fromisoformat(self.start) + timedelta(days=1)).isoformat(),
                                    self.event_id))
                    bot_outbox.enqueue(db, self.event_id, 'activity_published', plain,
                                       template_context=context)
                text = self.send('1')
                self.assertEqual('距开始：4 小时' in text, not changed)

    def send(self, markdown):
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN=markdown), api)
        self.assertEqual(worker.poll_once()['sent'], 1)
        api.post.assert_called_once()
        body = api.post.call_args.args[1]
        self.assertEqual(body['msg_type'], 2 if markdown == '1' else 0)
        return body['markdown']['content'] if markdown == '1' else body['content']
