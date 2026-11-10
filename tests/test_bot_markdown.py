"""Passive Markdown replies (msg_type=2): opt-in, fallback and link safety.

Escaping and renderers now live in ``qgroup_core.bot_markdown``; the active
broadcast side and the web/bot payload contract are covered in
``test_bot_markdown_broadcast.py``. Checks are offline; nothing here claims a
real QQ device rendered a markdown message correctly.
"""
import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from qgroup_core import events, storage
from qgroup_core.common import now
from qgroup_bot.api import QQBotAPI
from qgroup_bot.config import Config
from qgroup_bot.main import Bot, _markdown_reply
from qgroup_bot.replies import answer, answer_markdown, read_db
from qgroup_bot import markdown as md


class MarkdownReplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'md.sqlite3'
        storage.initialize(self.path)
        self.env = mock.patch.dict(os.environ, {
            'KANBAN_BOT_ENABLED': '0',
            'KANBAN_BOT_BASE_URL': 'https://example.test',
            'KANBAN_BOT_MARKDOWN': '0',
        })
        self.env.start()
        with storage.connect(self.path) as db:
            db.execute('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)',
                       ('u1', 'hash1', '私密昵称', now()))
        start = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            self.event_id = events.create(db, {'id': 'u1', 'nickname': '私密昵称'},
                dict(title='唱K活动', category='约K', location='某KTV', starts_at=start,
                     deadline=start, capacity=10, description='', duration_hours=3,
                     minimum_participants=4, join_owner=False, bot_enabled=True))
        # User-authored text exercising live inline syntax, a heading on a
        # second line and a platform mention tag.
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET title=?, location=? WHERE id=?',
                       ('唱K *特别* [点我](https://evil.test)',
                        '某 **KTV**\n第二行 <qqbot-at-everyone />', self.event_id))

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def markdown(self, command, argument=''):
        db = read_db(self.path)
        try:
            return answer_markdown(db, command, argument)
        finally:
            db.close()

    def plain(self, command, argument=''):
        db = read_db(self.path)
        try:
            return answer(db, command, argument)[0]
        finally:
            db.close()

    def test_escape_keeps_inline_markdown_but_blocks_structural_injection(self):
        value = md.escape_markdown(
            '[点我](https://evil.test) **粗** <qqbot-at-everyone />\n# 标题')
        # QQ has no escape syntax: real-device A/B/C/D probes rejected
        # backslashes, zero-width insertions and full-width substitutions.
        self.assertIn('[点我](https://evil.test)', value)
        self.assertIn('**粗**', value)
        self.assertIn('# 标题', value)
        self.assertNotIn('\\', value)
        self.assertNotIn('\u200B', value)
        # Structural injection is still neutralised.
        self.assertNotIn('<qqbot-at-everyone />', value)
        self.assertNotIn('\n', value)
        self.assertEqual(md.escape_markdown('<qqbot-at-user id="7" /> 安安'), ' 安安')
        self.assertEqual(md.escape_markdown('a\rb\tc'), 'a b c')

    def test_user_link_is_caught_by_the_outbound_allowlist(self):
        rich = md.render_broadcast('活动发起', '唱K [点我](https://evil.test)', [],
                                   'https://example.test/?event=abc')
        self.assertIn('[点我](https://evil.test)', rich)
        self.assertIsNotNone(md.content_problem(rich, ('example.test',)))
        self.assertIsNone(md.content_problem(
            md.render_broadcast('活动发起', '唱K **特别**', [],
                               'https://example.test/?event=abc'),
            ('example.test',)))

    def test_escape_drops_control_characters(self):
        self.assertNotIn('\x01', md.escape_markdown('a\x01b'))
        self.assertEqual(md.escape_markdown(None), '')

    def test_content_problem_checks_length_controls_and_link_hosts(self):
        self.assertIsNone(md.content_problem('## ok\n[link](https://example.test/x)'))
        self.assertIsNotNone(md.content_problem(''))
        self.assertIsNotNone(md.content_problem('a' * 4001))
        self.assertIsNotNone(md.content_problem('x\x01y'))
        self.assertIsNotNone(md.content_problem('[x](https://evil.test)', ('example.test',)))
        self.assertIsNone(md.content_problem('[x](https://example.test/a?b=1)',
                                             ('example.test',)))

    def test_reply_group_sends_msg_type_2_without_content(self):
        client = QQBotAPI(SimpleNamespace(sandbox=False, app_id='a', app_secret='b'))
        client.send_group = mock.Mock(return_value=(True, 0, {}))
        client.reply_group('G', 'plain fallback', msg_id='M', markdown='## hi')
        body = client.send_group.call_args.args[1]
        self.assertEqual(body['msg_type'], 2)
        self.assertNotIn('content', body)
        self.assertEqual(body['markdown'], {'content': '## hi'})
        self.assertEqual(body['msg_id'], 'M')
        self.assertEqual(body['msg_seq'], 1)

    def test_plain_reply_body_is_unchanged_when_markdown_is_off(self):
        client = QQBotAPI(SimpleNamespace(sandbox=False, app_id='a', app_secret='b'))
        client.send_group = mock.Mock(return_value=(True, 0, {}))
        client.reply_group('G', 'plain fallback', msg_id='M', keyboard={'content': {}})
        self.assertEqual(client.send_group.call_args.args[1], {
            'msg_type': 0, 'content': 'plain fallback',
            'msg_id': 'M', 'msg_seq': 1, 'keyboard': {'content': {}}})

    def test_help_uses_only_syntax_documented_by_qq(self):
        text = self.markdown('帮助')
        self.assertTrue(text.startswith('## '))
        self.assertIn('- **/活动**', text)
        self.assertIn('[隐私政策](https://example.test/privacy)', text)
        self.assertIn('[联络与问题反馈](https://example.test/contact)', text)
        self.assertIn('\u200B', text)
        self.assertNotIn('```', text)
        self.assertNotIn('|', text)
        self.assertIsNone(md.content_problem(text, ('example.test',)))

    def test_unknown_command_gets_markdown_help_with_prefix(self):
        self.assertIn('未识别这条指令', self.markdown(None))

    def test_activity_markdown_keeps_user_syntax_but_blocks_mentions(self):
        rich = self.markdown('活动')
        plain = self.plain('活动')
        # A user-authored title must sit on a plain line, not in a heading or
        # inside a bold span: QQ renders neither position's inline syntax.
        self.assertTrue(rich.startswith('## 活动详情'))
        self.assertIn('\n活动名称：唱K', rich)
        # QQ has no escape syntax: inline markup stays live and renders cleanly.
        self.assertIn('[点我](https://evil.test)', rich)
        self.assertIn('**KTV**', rich)
        self.assertNotIn('\\', rich)
        # Structural injection and platform mentions are still removed.
        self.assertNotIn('<qqbot-at-everyone />', rich)
        self.assertNotIn('\n第二行', rich)
        self.assertIn('[点我](https://evil.test)', plain)
        self.assertIn('[打开活动](https://example.test/?event=%s)' % self.event_id, rich)
        # An off-site link authored by a user is caught by the allowlist, so
        # this card falls back to plain text rather than becoming a hyperlink.
        self.assertIsNotNone(md.content_problem(rich, ('example.test',)))

    def test_user_titles_are_never_in_headings_or_bold_wrappers(self):
        title = '周末 **加粗** _斜体_ ~~删除线~~'
        broadcast = md.render_broadcast('活动发起', title, [],
                                        'https://example.test/?event=abc')
        self.assertEqual(broadcast.splitlines()[0], '## 活动发起')
        self.assertEqual(broadcast.splitlines()[1], '活动名称：' + title)
        event = md.render_event(title, '11-13 18:00', [('地点', '某处')],
                                'https://example.test/?event=abc')
        self.assertEqual(event.splitlines()[0], '## 活动详情')
        self.assertEqual(event.splitlines()[1], '活动名称：' + title)
        selection = md.render_selection(
            [(title, '11-13 18:00', 'https://example.test/?event=abc')],
            '活动', 'https://example.test')
        self.assertIn('1. ' + title, selection)
        self.assertNotIn('1. **', selection)
        # A leading '#' or '-' in a title cannot inject a heading/list item.
        self.assertEqual(md.plain_line('活动名称：', '# 假标题\n第二行'),
                         '活动名称：# 假标题 第二行')
        self.assertTrue(md.render_event('# 假标题', '11-13', [],
                                        'https://example.test/').splitlines()[1]
                        .startswith('活动名称：# 假标题'))

    def test_todos_markdown_is_a_list_and_never_names_a_person(self):
        text = self.markdown('待办')
        self.assertTrue(text.startswith('## 待办'))
        self.assertIn('\n活动名称：', text)
        self.assertIn('\n- ', text)
        self.assertIn('[查看待办](https://example.test/?event=', text)
        self.assertNotIn('私密昵称', text)

    def test_selection_markdown_keeps_user_links_but_allowlist_catches_them(self):
        start = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            events.create(db, {'id': 'u1', 'nickname': '私密昵称'},
                dict(title='第二场活动', category='约K', location='另一处', starts_at=start,
                     deadline=start, capacity=10, description='', duration_hours=2,
                     join_owner=False, bot_enabled=True))
        text = self.markdown('活动')
        self.assertTrue(text.startswith('## 选择活动'))
        self.assertIn('\n1. 唱K', text)
        self.assertIn('\n2. 第二场活动', text)
        self.assertNotIn('1. **', text)
        self.assertIn('[打开活动](https://example.test/?event=', text)
        self.assertIn('[点我](https://evil.test)', text)
        self.assertIsNotNone(md.content_problem(text, ('example.test',)))

    def test_markdown_is_opt_in_by_default(self):
        with mock.patch.dict(os.environ, {'KANBAN_BOT_MARKDOWN': '0'}):
            self.assertFalse(Config().markdown_replies)
        with mock.patch.dict(os.environ, {'KANBAN_BOT_MARKDOWN': '1'}):
            self.assertTrue(Config().markdown_replies)

    def test_disabled_config_never_calls_the_renderer(self):
        config = SimpleNamespace(markdown_replies=False)
        with mock.patch('qgroup_bot.main.answer_markdown') as renderer:
            self.assertIsNone(_markdown_reply(None, '帮助', '', config))
            renderer.assert_not_called()

    def test_unsafe_content_or_renderer_error_falls_back_to_plain(self):
        config = SimpleNamespace(markdown_replies=True, allowed_link_hosts=('example.test',),
                                 log_content=False, app_secret='')
        db = read_db(self.path)
        try:
            with mock.patch.object(md, 'content_problem', return_value='markdown 含控制字符'):
                self.assertIsNone(_markdown_reply(db, '活动', '', config))
            with mock.patch('qgroup_bot.main.answer_markdown',
                            side_effect=RuntimeError('renderer broke')):
                self.assertIsNone(_markdown_reply(db, '活动', '', config))
            self.assertIsNotNone(_markdown_reply(db, '帮助', '', config))
        finally:
            db.close()

    def test_bot_passes_markdown_only_when_opted_in(self):
        def run(enabled):
            config = SimpleNamespace(db=self.path, group='allowed', dry_run=False,
                                     sandbox=False, verbose_events=False,
                                     markdown_replies=enabled, allowed_link_hosts=(),
                                     log_content=False, app_secret='')
            bot = Bot(config)
            bot.api.reply_group = mock.Mock(return_value=(True, 0, {}))
            asyncio.run(bot.reply(None, 'allowed', '帮助', '', msg_id='message-%d' % enabled))
            return bot.api.reply_group.call_args.kwargs
        self.assertNotIn('markdown', run(False))
        self.assertTrue(run(True)['markdown'].startswith('## 群聚看板'))


if __name__ == '__main__':
    unittest.main()
