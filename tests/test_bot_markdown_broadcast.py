"""List-number selection + shared Markdown broadcasts (web/bot contract).

Covers the both-scope change: qgroup_core composes an additive
``markdown_text`` payload field, qgroup_bot decides at send time whether to use
it. All checks are offline; nothing here claims a real QQ device accepted the
markdown body.
"""
import json
import os
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from qgroup_core import (bot_markdown, bot_outbox, bot_settings, events, storage)
from qgroup_core.common import APIError, now
from qgroup_bot.config import Config
from qgroup_bot.markdown import MARKDOWN_REJECTION_CODES
from qgroup_bot.replies import (ALIASES, HELP, SelectionError, answer, answer_markdown,
                                candidates, current_event, read_db)
from qgroup_bot.worker import OutboxWorker


class Fixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'both.sqlite3'
        storage.initialize(self.path)
        self.env = mock.patch.dict(os.environ, {
            'KANBAN_BOT_ENABLED': '1',
            'KANBAN_BOT_BASE_URL': 'https://example.test',
            'KANBAN_DB': str(self.path),
            'KANBAN_BOT_GROUP': 'GROUP_OPENID_TEST',
            'KANBAN_BOT_DRY_RUN': '1',
            'KANBAN_BOT_MARKDOWN': '0',
        })
        self.env.start()
        with storage.connect(self.path) as db:
            db.execute('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)',
                       ('u1', 'hash1', '发起人', now()))
        self.user = {'id': 'u1', 'nickname': '发起人'}
        self.start = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec='seconds')

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def event(self, title='测试活动', **overrides):
        data = dict(title=title, category='约K', location='某KTV',
                    starts_at=self.start, deadline=self.start, capacity=0,
                    description='', duration_hours=3, join_owner=False,
                    bot_enabled=True, lifecycle='scheduled')
        data.update(overrides)
        with storage.connect(self.path) as db:
            return events.create(db, self.user, data)

    def rows(self):
        with storage.connect(self.path) as db:
            return [dict(row) for row in db.execute('SELECT * FROM bot_outbox ORDER BY id')]

    def config(self, **overrides):
        values = dict(KANBAN_BOT_ENABLED='1', KANBAN_BOT_BASE_URL='https://example.test',
                      KANBAN_DB=str(self.path), KANBAN_BOT_GROUP='GROUP_OPENID_TEST',
                      KANBAN_BOT_DRY_RUN='1', QQBOT_APP_ID='x', QQBOT_APP_SECRET='y')
        values.update(overrides)
        with mock.patch.dict(os.environ, values):
            return Config()

    def latest_event(self, db):
        return db.execute('SELECT * FROM events WHERE id=?', (self.event_id,)).fetchone()


class ListNumberTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.first = self.event('第一场 *特别*', lifecycle='scheduled')
        later = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat(timespec='seconds')
        self.second = self.event('第二场活动', starts_at=later, deadline=later)
        self.event_id = self.first

    def test_number_matches_the_list_and_is_stable_across_commands(self):
        db = read_db(self.path)
        try:
            listed = candidates(db, '活动')[:8]
            self.assertEqual(current_event(db, '1', '活动')['id'], listed[0]['id'])
            self.assertEqual(current_event(db, '2', '活动')['id'], listed[1]['id'])
            # The usual flow: look at /活动, then type /名额 2.
            self.assertEqual(current_event(db, '2', '名额')['id'], listed[1]['id'])
        finally:
            db.close()

    def test_out_of_range_and_invalid_arguments_are_actionable(self):
        db = read_db(self.path)
        try:
            with self.assertRaises(SelectionError) as caught:
                current_event(db, '3', '活动')
            self.assertIn('序号 3', str(caught.exception))
            self.assertIn('共 2 场', str(caught.exception))
            with self.assertRaises(SelectionError) as caught:
                current_event(db, '9', '活动')
            self.assertIn('1–8', str(caught.exception))
            with self.assertRaises(SelectionError) as caught:
                current_event(db, 'abc', '活动')
            self.assertIn('序号', str(caught.exception))
        finally:
            db.close()

    def test_legacy_short_code_still_resolves(self):
        db = read_db(self.path)
        try:
            self.assertEqual(current_event(db, self.first[:8], '活动')['id'], self.first)
        finally:
            db.close()

    def test_plain_and_markdown_selection_put_the_number_first(self):
        db = read_db(self.path)
        try:
            plain = answer(db, '活动', '')[0]
            rich = answer_markdown(db, '活动', '')
        finally:
            db.close()
        self.assertIn('请选择活动', plain)
        self.assertIn('1. 第一场', plain)
        self.assertIn('/活动 1', plain)
        self.assertNotIn('[' + self.first[:8] + ']', plain)
        self.assertIn('序号以最近一次', plain)
        self.assertTrue(rich.startswith('## 选择活动'))
        self.assertIn('1. 第一场', rich)
        self.assertNotIn('1. **', rich)
        self.assertIn('/活动 1', rich)
        self.assertNotIn('短码 **', rich)
        self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))

    def test_help_advertises_numbers_instead_of_short_codes(self):
        self.assertIn('/名额 2', HELP)
        self.assertNotIn('a1b2c3d4', HELP)
        db = read_db(self.path)
        try:
            rich = answer_markdown(db, '帮助')
        finally:
            db.close()
        self.assertIn('/名额 2', rich)
        self.assertNotIn('8 位活动短码', rich)

    def test_activity_commands_have_safe_cards_and_external_lookup_stays_plain(self):
        db = read_db(self.path)
        try:
            for command in sorted(set(ALIASES.values())):
                with self.subTest(command=command):
                    rich = answer_markdown(db, command, '')
                    if command == '缩写':
                        self.assertIsNone(rich)
                        continue
                    self.assertIsInstance(rich, str)
                    self.assertTrue(rich.startswith('## '))
                    self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))
            numbered = answer_markdown(db, '名额', '2')
            self.assertTrue(numbered.startswith('## /名额'))
            self.assertIn('第二场活动', numbered)
        finally:
            db.close()


class BroadcastMarkdownTests(Fixture, unittest.TestCase):
    def test_build_message_freezes_a_sanitised_system_card(self):
        self.event_id = self.event('唱K *特别* [点我](https://evil.test)')
        with storage.connect(self.path) as db:
            planned = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
        rich = planned[2]['_markdown']
        self.assertIsInstance(rich, str)
        self.assertTrue(rich.startswith('## 活动发起'))
        self.assertIn('活动名称：唱K 特别 点我', rich)
        self.assertNotIn('*特别*', rich)
        self.assertNotIn('[点我]', rich)
        self.assertNotIn('evil.test', rich)
        self.assertNotIn('\\', rich)
        self.assertNotIn('<qqbot-at-everyone />', rich)
        self.assertIn('[打开活动](https://example.test/?event=', rich)
        # User-authored Markdown can no longer produce a clickable off-site
        # link, so the allowlist does not need to downgrade this card.
        self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))
        # The plain-text body is untouched by the rich version.
        self.assertIn('唱K *特别*', planned[0])

    def test_admin_template_body_keeps_markdown_but_values_are_sanitised(self):
        config = bot_settings.defaults()
        config['templates']['activity_published'+bot_settings.MARKDOWN_SUFFIX] = (
            '## **{title}**\n\u200B\n{details}\n\u200B\n[打开活动]({url})')
        context = dict(_default_text='fallback', title='唱K *特别*',
                       details='时间：周六\n地点：<qqbot-at-everyone />',
                       url='https://example.test/?event=abc', heading='h',
                       _label='活动发起', _details_lines=[])
        rich = bot_outbox.render_message(config, 'activity_published', context, markdown=True)
        self.assertIn('## **唱K 特别**', rich)   # admin-written bold survives
        self.assertNotIn('*特别*', rich)         # substituted value is sanitised
        self.assertNotIn('\\', rich)
        self.assertNotIn('<qqbot-at-everyone />', rich)
        self.assertIn('- 时间：周六', rich)
        self.assertIn('[打开活动](https://example.test/?event=abc)', rich)
        # Plain rendering keeps the admin's original text verbatim.
        config['templates']['activity_published'] = '{title}\n{details}\n{url}'
        plain = bot_outbox.render_message(config, 'activity_published', context)
        self.assertIn('唱K *特别*', plain)
        self.assertIn('<qqbot-at-everyone />', plain)

    def test_user_values_cannot_inject_markdown_through_a_template(self):
        config = bot_settings.defaults()
        config['templates']['activity_published'+bot_settings.MARKDOWN_SUFFIX] = (
            '## {title}\n\u200B\n{details}\n\u200B\n[打开活动]({url})')
        context = dict(_default_text='fallback',
                       title='# 假标题\n~~删除~~ [x](https://evil.test)',
                       details='- 伪装项\n> 伪装引用',
                       url='https://example.test/?event=abc', heading='h',
                       _label='活动发起', _details_lines=[])
        rich = bot_outbox.render_message(config, 'activity_published', context, markdown=True)
        self.assertIn('## 假标题 删除 x', rich)
        self.assertNotIn('~~', rich)
        self.assertNotIn('\n# ', rich)   # no injected heading line
        self.assertNotIn('- - ', rich)   # no injected nested bullet
        self.assertNotIn('https://evil.test', rich)
        self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))

    def test_system_time_change_is_the_only_styled_user_adjacent_fact(self):
        line = bot_markdown.system_time_change('11-13 18:00', '11-14 19:00')
        self.assertEqual(line, '- **时间** ~~11-13 18:00~~ → **11-14 19:00**')
        self.assertIsNone(bot_markdown.system_time_change('', '11-14 19:00'))
        self.assertIsNone(bot_markdown.system_time_change('11-13 18:00', '11-13 18:00'))
        # User-looking syntax in a system value can never escape the line.
        self.assertNotIn('**加粗**', bot_markdown.system_time_change(
            '11-13 **加粗**', '11-14 19:00'))

    def test_reschedule_card_strikes_the_previous_time(self):
        self.event_id = self.event('周末聚餐')
        shifted = (datetime.fromisoformat(self.start) + timedelta(days=2)).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            before = self.latest_event(db)
            events.patch(db, before, self.user,
                         dict(title='周末聚餐', category='约K', location='某KTV',
                              starts_at=shifted, deadline=shifted, capacity=0,
                              description='', duration_hours=3, join_owner=False,
                              bot_enabled=True, reason='改期'))
            planned = bot_outbox.build_message(db, self.latest_event(db), 'conditions_changed')
        context = planned[2]
        self.assertTrue(context['previous_starts_at'])
        self.assertNotEqual(context['previous_starts_at'], context['starts_at'])
        self.assertIn('- **时间** ~~%s~~ → **%s**' % (
            context['previous_starts_at'], context['starts_at']), context['_markdown'])
        self.assertIsNone(bot_markdown.content_problem(context['_markdown'], ('example.test',)))

    def test_admin_template_can_style_system_timestamps(self):
        config = bot_settings.defaults()
        config['templates']['conditions_changed'+bot_settings.MARKDOWN_SUFFIX] = (
            '## 安排变更\n\u200B\n~~{previous_starts_at}~~ → **{starts_at}**'
            '\n\u200B\n[打开活动]({url})')
        context = dict(_default_text='fallback', title='周末聚餐', heading='h',
                       details='', url='https://example.test/?event=abc',
                       previous_starts_at='11-13 18:00', starts_at='11-14 19:00',
                       _label='安排变更', _details_lines=[])
        rich = bot_outbox.render_message(config, 'conditions_changed', context, markdown=True)
        self.assertIn('~~11-13 18:00~~ → **11-14 19:00**', rich)
        self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))

    def test_validate_accepts_rich_keys_but_rejects_unknown_ones(self):
        config = bot_settings.defaults()
        config['templates']['activity_published'+bot_settings.MARKDOWN_SUFFIX] = '## {title}\n[打开]({url})'
        self.assertIs(bot_settings.validate(config), config)
        for key in ('fake'+bot_settings.MARKDOWN_SUFFIX,
                    'activity_published'+bot_settings.MARKDOWN_SUFFIX+'@md'):
            with self.assertRaises(APIError):
                bot_settings.validate(dict(config, templates={key: '{url}'}))

    def test_preview_returns_both_bodies_and_view_exposes_the_example(self):
        with storage.connect(self.path) as db:
            config = bot_settings.read(db)['config']
            result = bot_settings.preview(db, dict(config=config, kind='activity_published'))
            info = bot_settings.view(db)
        self.assertIn('https://example.test/?event=preview', result['text'])
        self.assertTrue(result['markdown'].startswith('## '))
        self.assertEqual(info['markdown_suffix'], bot_settings.MARKDOWN_SUFFIX)
        self.assertIn('{url}', info['default_markdown_template'])

    def test_settlement_notice_cannot_be_dropped_from_a_rich_card(self):
        config = bot_settings.defaults()
        config['templates']['settlement_updated'+bot_settings.MARKDOWN_SUFFIX] = '## 结算\n[打开]({url})'
        context = dict(_default_text='fallback', title='聚餐', heading='h',
                       details='每人应付已发布', url='https://example.test/?event=abc',
                       _label='结算发布', _details_lines=['每人应付已发布'],
                       _settlement_notice='收款人：甲\n甲：50.00 元\n待补 50.00 元')
        rich = bot_outbox.render_message(config, 'settlement_updated', context, markdown=True)
        self.assertIn('收款人：甲', rich)
        self.assertIn('甲：50.00 元', rich)
        self.assertIn('待补 50.00 元', rich)
        # No custom template -> the system card carries the notice too.
        card = bot_outbox.render_message(bot_settings.defaults(), 'settlement_updated',
                                         context, markdown=True)
        self.assertIn('## 逐人应付', card)
        self.assertIn('待补 50.00 元', card)

    def test_real_settlement_notice_appears_once_in_system_and_custom_cards(self):
        self.event_id = self.event()
        for version, size in ((1, 2), (2, 20)):
            names = ['参加者%02d' % n + '姓名长' * 10 for n in range(size)]
            snapshot = dict(group_notice=True, collector={'name': '收款人'},
                            people=[dict(name=n, due_cents=5000) for n in names],
                            balances=[dict(name=n, due_cents=5000, balance_cents=5000)
                                      for n in names])
            with storage.connect(self.path) as db:
                db.execute("""INSERT INTO settlement_history(event_id,version,total_cents,
                    headcount,note,updated_at,actor_id,actor_name,kind,changed_fields)
                    VALUES(?,?,?,?,'',?,'u1','收款人','detailed_published','[]')""",
                           (self.event_id, version, size * 5000, size, now()))
                db.execute('INSERT INTO settlement_details VALUES(?,?,?)',
                           (self.event_id, version, json.dumps(snapshot)))
                plain, _, context = bot_outbox.build_message(
                    db, self.latest_event(db), 'settlement_updated')
            self.assertLess(len(plain), 4000)
            frozen = deepcopy(context)
            for template in (None, bot_settings.DEFAULT_MARKDOWN_TEMPLATE,
                             '## 结算\n[打开]({url})'):
                config = bot_settings.defaults()
                if template:
                    config['templates']['settlement_updated@md'] = template
                for legacy in (False, True):
                    with self.subTest(size=size, template=template, legacy=legacy):
                        queued = deepcopy(context)
                        if legacy:
                            queued.pop('_details_lines')
                        rich = bot_outbox.render_message(config, 'settlement_updated',
                                                        queued, markdown=True)
                        self.assertIsInstance(rich, str)
                        self.assertEqual(rich.count('收款人：收款人'), 1)
                        self.assertEqual(rich.count('## 逐人应付'), 1)
                        for name in names:
                            self.assertEqual(rich.count(name + '：50.00 元'), 1)
                            self.assertEqual(rich.count(name + '：AA 50.00 元，待补 50.00 元'), 1)
                        self.assertIsNone(bot_markdown.content_problem(rich, ('example.test',)))
            self.assertEqual(context, frozen)
            self.assertEqual(bot_outbox.render_message(bot_settings.defaults(),
                                                      'settlement_updated', context), plain)
        # Exercise queue-time composition and send-time re-rendering for the long card.
        with storage.connect(self.path) as db:
            db.execute('DELETE FROM bot_outbox')
            bot_outbox.enqueue(db, self.event_id, 'settlement_updated', plain,
                               template_context=context)
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN='1'), api)
        self.assertEqual(worker.poll_once()['sent'], 1)
        body = api.post.call_args.args[1]
        self.assertEqual(body['msg_type'], 2)
        self.assertEqual(body['markdown']['content'].count('收款人：收款人'), 1)

    def test_old_context_delivers_after_templates_add_previous_starts_at(self):
        self.event_id = self.event()
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'conditions_changed')
        context.pop('previous_starts_at')
        for markdown in ('0', '1'):
            with self.subTest(markdown=markdown):
                with storage.connect(self.path) as db:
                    db.execute('DELETE FROM bot_outbox')
                    bot_outbox.enqueue(db, self.event_id, 'conditions_changed', plain,
                                       template_context=context)
                    settings = bot_settings.read(db)
                    settings['config']['templates'] = {
                        'conditions_changed': '原时间：{previous_starts_at}\n新时间：{starts_at}\n{url}',
                        'conditions_changed@md': '## 安排变更\n原时间：{previous_starts_at}\n'
                                                 '新时间：**{starts_at}**\n[打开]({url})',
                    }
                    bot_settings.save(db, dict(config=settings['config'],
                                               base_revision=settings['revision']), 'u1')
                intent = self.rows()[0]['payload_json']
                api = mock.Mock()
                api.post.return_value = (True, 0, {'id': 'sent'})
                worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0',
                                                  KANBAN_BOT_MARKDOWN=markdown), api)
                self.assertEqual(worker.poll_once()['sent'], 1)
                api.post.assert_called_once()
                body = api.post.call_args.args[1]
                self.assertEqual(body['msg_type'], 2 if markdown == '1' else 0)
                text = body['markdown']['content'] if markdown == '1' else body['content']
                self.assertIn('原时间：\n', text)
                self.assertIn(context['starts_at'], text)
                self.assertEqual(self.rows()[0]['payload_json'], intent)

    def test_markdown_rejections_stop_without_retry_or_plain_resend(self):
        self.event_id = self.event()
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
        for code in sorted(MARKDOWN_REJECTION_CODES):
            with self.subTest(code=code):
                with storage.connect(self.path) as db:
                    db.execute('DELETE FROM bot_outbox')
                    bot_outbox.enqueue(db, self.event_id, 'activity_published', plain,
                                       template_context=context)
                api = mock.Mock()
                api.post.return_value = (False, code, {'code': code})
                worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0',
                                                  KANBAN_BOT_MARKDOWN='1'), api)
                self.assertEqual(worker.poll_once()['failed'], 1)
                row = self.rows()[0]
                self.assertEqual(row['status'], 'failed')
                self.assertEqual(row['attempts'], 1)
                self.assertIsNone(row['retry_at'])
                self.assertEqual(worker.poll_once()['claimed'], 0)
                api.post.assert_called_once()
                self.assertEqual(api.post.call_args.args[1]['msg_type'], 2)

    def test_mixed_case_external_urls_block_rich_and_plain_broadcasts(self):
        self.event_id = self.event(location='HTTPS://evil.test/x')
        with storage.connect(self.path) as db:
            plain, _, context = bot_outbox.build_message(db, self.latest_event(db), 'activity_published')
        for markdown in ('0', '1'):
            with self.subTest(markdown=markdown):
                with storage.connect(self.path) as db:
                    db.execute('DELETE FROM bot_outbox')
                    bot_outbox.enqueue(db, self.event_id, 'activity_published', plain,
                                       template_context=context)
                api = mock.Mock()
                worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0',
                                                  KANBAN_BOT_MARKDOWN=markdown,
                                                  KANBAN_BOT_ALLOWED_HOSTS='example.test'), api)
                self.assertEqual(worker.poll_once()['failed'], 1)
                self.assertIn('未报备域名', self.rows()[0]['last_error'])
                api.post.assert_not_called()

    def test_enqueue_payload_is_additive_and_old_style_rows_still_work(self):
        self.event_id = self.event()
        new_payload = json.loads(self.rows()[0]['payload_json'])
        self.assertIsInstance(new_payload.get('markdown_text'), str)
        self.assertNotIn('_markdown', new_payload['_template_context'])
        self.assertEqual(new_payload['msg_type'], 0)
        # An older web build queues without a template context or rich body.
        with storage.connect(self.path) as db:
            db.execute('DELETE FROM bot_outbox')
            self.assertTrue(bot_outbox.enqueue(db, self.event_id, 'activity_published',
                                               '旧版纯文字消息'))
        old_payload = json.loads(self.rows()[0]['payload_json'])
        self.assertNotIn('markdown_text', old_payload)
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        worker = OutboxWorker(self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN='1'), api)
        worker.poll_once()
        body = api.post.call_args.args[1]
        self.assertEqual(body['msg_type'], 0)
        self.assertEqual(body['content'], '旧版纯文字消息')

    def test_worker_sends_msg_type_2_only_when_opted_in(self):
        self.event_id = self.event()
        def body_for(markdown):
            with storage.connect(self.path) as db:
                db.execute('DELETE FROM bot_outbox')
            self.event_id = self.event('活动 %s' % markdown)
            api = mock.Mock()
            api.post.return_value = (True, 0, {'id': 'sent'})
            config = self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN=markdown)
            OutboxWorker(config, api).poll_once()
            return api.post.call_args.args[1]
        plain = body_for('0')
        self.assertEqual(plain['msg_type'], 0)
        self.assertIn('content', plain)
        rich = body_for('1')
        self.assertEqual(rich['msg_type'], 2)
        self.assertNotIn('content', rich)
        self.assertTrue(rich['markdown']['content'].startswith('## 活动发起'))

    def test_unsafe_markdown_or_bad_button_url_never_breaks_delivery(self):
        self.event_id = self.event()
        api = mock.Mock()
        api.post.return_value = (True, 0, {'id': 'sent'})
        config = self.config(KANBAN_BOT_DRY_RUN='0', KANBAN_BOT_MARKDOWN='1')
        with mock.patch('qgroup_bot.worker.md.content_problem',
                        return_value='markdown 含控制字符'):
            OutboxWorker(config, api).poll_once()
        body = api.post.call_args.args[1]
        self.assertEqual(body['msg_type'], 0)
        self.assertIn('content', body)
        # Jump buttons are checked against the same allowlist as message text.
        worker = OutboxWorker(self.config(KANBAN_BOT_ALLOWED_HOSTS='example.test'), mock.Mock())
        keyboard = {'content': {'rows': [
            {'buttons': [{'action': {'type': 0, 'data': 'https://evil.test/x'}}]},
        ]}}
        for scheme in ('https', 'HTTPS', 'HtTp'):
            keyboard['content']['rows'][0]['buttons'][0]['action']['data'] = scheme + '://evil.test/x'
            self.assertIn('未报备域名', worker._keyboard_problem(keyboard))
        self.assertIsNone(worker._keyboard_problem({'content': {'rows': [
            {'buttons': [{'action': {'type': 0, 'data': 'https://example.test/x'}}]},
        ]}}))


if __name__ == '__main__':
    unittest.main()
