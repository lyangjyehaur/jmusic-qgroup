"""External lookup contract and QQ routing, without calling the real service."""
import asyncio
import io
import http.server
import json
import os
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from qgroup_bot.abbreviations import (API_URL, TIMEOUT, UNAVAILABLE,
                                      USAGE, AbbreviationLookup)
from qgroup_bot.main import Bot
from qgroup_bot.replies import answer, answer_markdown, help_text, parse
from qgroup_core import bot_settings, storage


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.lookup = AbbreviationLookup()
        patcher = mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen')
        self.open = patcher.start()
        self.addCleanup(patcher.stop)

    def response(self, value):
        self.open.return_value = io.BytesIO(json.dumps(value, ensure_ascii=False).encode())

    def test_request_contains_only_normalized_abbreviations_and_cache_is_reused(self):
        self.response([{'name': 'yyds', 'trans': ['永远的神']},
                       {'name': 'nbnhhsh', 'trans': ['能不能好好说话']}])
        text = self.lookup.answer('YYDS，nbnhhsh yyds')
        self.assertIn('yyds：永远的神', text)
        self.assertIn('nbnhhsh：能不能好好说话', text)
        self.assertEqual(self.lookup.answer('yyds,nbnhhsh'), text)
        self.open.assert_called_once()
        request = self.open.call_args.args[0]
        self.assertEqual(request.full_url, API_URL)
        self.assertEqual(request.method, 'POST')
        self.assertEqual(json.loads(request.data), {'text': 'yyds,nbnhhsh'})
        self.assertEqual(self.open.call_args.kwargs['timeout'], TIMEOUT)
        self.assertNotIn('Authorization', request.headers)

    def test_invalid_or_chat_input_never_reaches_upstream(self):
        for text in ('', '这是 yyds 吗', 'https://example.test', '<@BOT> yyds',
                     'a', 'x'*33, 'aa bb cc dd ee ff', 'yyds,', 'a'*165):
            with self.subTest(text=text):
                self.assertEqual(self.lookup.answer(text), USAGE)
        self.open.assert_not_called()

    def test_unknown_null_and_inputting_are_distinguished(self):
        self.response([{'name': 'aa', 'trans': None, 'inputting': ['不应显示']},
                       {'name': 'bb', 'inputting': ['候选释义']},
                       {'name': 'cc', 'trans': []}])
        text = self.lookup.answer('aa bb cc dd')
        self.assertIn('aa：暂无可显示的释义', text)
        self.assertIn('bb（待确认候选）：候选释义', text)
        self.assertIn('cc：暂无可显示的释义', text)
        self.assertIn('dd：暂无可显示的释义', text)
        self.assertNotIn('不应显示', text)

    def test_upstream_content_cannot_inject_links_or_mentions(self):
        self.response([{'name': 'yyds', 'trans': [
            'https://untrusted.test', 'www.untrusted.test', '@everyone', '＠全体成员',
            '<qqbot-at-everyone />', '**正常**\n释义', '很'*100,
            *['候选%d' % i for i in range(100)]]}])
        text = self.lookup.answer('yyds')
        self.assertIn('**正常** 释义', text)
        for forbidden in ('untrusted', '@', '＠', '<qqbot-at'):
            self.assertNotIn(forbidden, text)
        self.assertIn('很'*100, text)
        self.assertIn('候选99', text)

    def test_plain_definitions_keep_programming_and_math_symbols(self):
        values = ['C#', 'F#', 'a_b', 'a < b', 'a > b', '2 * 3', '[原文]', '**文字**', 'a  +  b']
        self.response([{'name': 'aa', 'trans': values}])
        self.assertIn('：'+'、'.join(values)+'\n', self.lookup.answer('aa'))

    def test_oversized_response_is_complete_but_not_cached(self):
        self.lookup = AbbreviationLookup(cache_bytes=100)
        values = ['完整释义'*100, '完整释义'*100]
        self.response([{'name': 'aa', 'trans': values}])
        self.assertIn('、'.join(values), self.lookup.answer('aa'))
        self.assertEqual(self.lookup.cache_bytes, 0)
        self.assertFalse(self.lookup.cache)

    def test_cache_budget_evicts_old_entries_without_changing_answers(self):
        self.lookup = AbbreviationLookup(cache_bytes=100)
        with mock.patch('qgroup_bot.abbreviations.time.monotonic') as clock:
            for index, term in enumerate(('aa', 'bb', 'cc')):
                clock.return_value = 100+index*2
                self.response([{'name': term, 'trans': ['正常释义']}])
                self.assertIn('正常释义', self.lookup.answer(term))
        self.assertLessEqual(self.lookup.cache_bytes, 100)
        self.assertNotIn('aa', self.lookup.cache)
        self.assertIn('cc', self.lookup.cache)

    def test_wall_deadline_does_not_spawn_additional_abandoned_fetches(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def stuck(*args, **kwargs):
            release.wait(2)
            return io.BytesIO(b'[]')

        self.open.side_effect = stuck
        with mock.patch('qgroup_bot.abbreviations.TIMEOUT', .05):
            import time
            start = time.monotonic()
            self.assertEqual(self.lookup.answer('aa'), UNAVAILABLE)
            self.assertLess(time.monotonic()-start, .5)
            self.lookup.next_request = 0
            self.assertEqual(self.lookup.answer('bb'), UNAVAILABLE)
            self.open.assert_called_once()
            self.assertFalse(self.lookup.cache)
        release.set()
        self.assertTrue(self.lookup.network_lock.acquire(timeout=1))
        self.lookup.network_lock.release()

    def test_continuously_streaming_response_cannot_extend_total_deadline(self):
        import time
        raw = json.dumps([{'name': 'aa', 'trans': ['正常释义']}]).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try:
                    for offset in range(0, len(raw), 3):
                        self.wfile.write(raw[offset:offset+3])
                        self.wfile.flush()
                        time.sleep(.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval':.01}, daemon=True)
        thread.start()
        # setUp patches the shared module attribute; recover the real opener.
        from urllib.request import build_opener
        try:
            with mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen', build_opener().open), \
                    mock.patch('qgroup_bot.abbreviations.API_URL', 'http://127.0.0.1:%d/' % server.server_port), \
                    mock.patch('qgroup_bot.abbreviations.TIMEOUT', .08):
                start = time.monotonic()
                self.assertEqual(self.lookup.answer('aa'), UNAVAILABLE)
                self.assertLess(time.monotonic()-start, .4)
            self.assertTrue(self.lookup.network_lock.acquire(timeout=1))
            self.lookup.network_lock.release()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_all_candidates_keep_their_full_length_order_and_duplicates(self):
        for field in ('trans', 'inputting'):
            with self.subTest(field=field):
                self.lookup = AbbreviationLookup()
                values = ['释义%d%s' % (i, '长'*100) for i in range(100)]
                values += [values[0], '长'*40+'甲', '长'*40+'乙']
                self.response([{'name': 'yyds', field: values}])
                text = self.lookup.answer('yyds')
                self.assertIn('：'+'、'.join(values)+'\n', text)
                self.assertEqual(text.count(values[0]), 2)

    def test_valid_response_larger_than_64_kib_is_displayed_in_full(self):
        values = ['释义%d%s' % (i, '长'*100) for i in range(300)]
        data = [{'name': 'yyds', 'trans': values}]
        self.assertGreater(len(json.dumps(data, ensure_ascii=False).encode()), 65536)
        self.response(data)
        self.assertIn('：'+'、'.join(values)+'\n', self.lookup.answer('yyds'))

    def test_errors_are_friendly_and_do_not_leak_response_or_exception_details(self):
        for failure in (TimeoutError('private detail'), urllib.error.URLError('secret'),
                        urllib.error.HTTPError(API_URL, 429, 'limited', {}, None)):
            with self.subTest(failure=type(failure).__name__):
                self.lookup = AbbreviationLookup()
                self.open.side_effect = failure
                self.assertEqual(self.lookup.answer('yyds'), UNAVAILABLE)
                self.assertNotIn('secret', self.lookup.answer('yyds'))

    def test_invalid_json_and_schema_are_handled(self):
        for raw in (b'not json', b'{}', b'[null]', b'[{"name":"yyds","trans":"bad"}]',
                    b'[{"name":"yyds","trans":[42]}]'):
            with self.subTest(raw=raw[:60]):
                self.lookup = AbbreviationLookup()
                self.open.return_value = io.BytesIO(raw)
                self.assertEqual(self.lookup.answer('yyds'), UNAVAILABLE)

    def test_cache_expiry_and_upstream_rate_limit(self):
        with mock.patch('qgroup_bot.abbreviations.time.monotonic', return_value=100) as clock:
            self.response([{'name': 'yyds', 'trans': ['旧释义']}])
            self.assertIn('旧释义', self.lookup.answer('yyds'))
            self.assertIn('过于频繁', self.lookup.answer('nbnhhsh'))
            self.assertEqual(self.open.call_count, 1)
            clock.return_value = 3701
            self.response([{'name': 'yyds', 'trans': ['新释义']}])
            self.assertIn('新释义', self.lookup.answer('yyds'))
            self.assertEqual(self.open.call_count, 2)

    def test_busy_request_does_not_queue_more_network_work(self):
        with self.lookup.lock:
            self.assertIn('忙碌', self.lookup.answer('yyds'))
        self.open.assert_not_called()


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'bot.sqlite3'
        storage.initialize(self.path)
        self.env = mock.patch.dict(os.environ, {'KANBAN_BOT_BASE_URL': 'https://example.test'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.bot = Bot(SimpleNamespace(db=self.path, group='allowed', dry_run=False,
                                      sandbox=False, verbose_events=False,
                                      markdown_replies=True))
        self.bot.api.reply_group = mock.Mock(return_value=(True, 0, {}))

    def test_aliases_help_and_plain_reply_do_not_require_an_activity(self):
        for command in ('/缩写', '／縮寫', '/NBNHHSH'):
            self.assertEqual(parse(command+' yyds'), ('缩写', 'yyds'))
        self.assertIn('/缩写 yyds', help_text())
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer', return_value='含义') as lookup:
            self.assertEqual(answer(None, '缩写', 'yyds'), ('含义', None))
            self.assertIsNone(answer_markdown(None, '缩写', 'yyds'))
            lookup.assert_called_once_with('yyds')

    def test_real_dispatch_uses_background_thread_and_plain_reply(self):
        main_thread = threading.get_ident()

        def lookup(argument):
            self.assertNotEqual(threading.get_ident(), main_thread)
            self.assertEqual(argument, 'yyds')
            return '【缩写查询】yyds：永远的神'

        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer', side_effect=lookup):
            asyncio.run(self.bot.handle_dispatch(None, {'t': 'GROUP_AT_MESSAGE_CREATE', 'd': {
                'id': 'message', 'group_openid': 'allowed', 'content': '/縮寫 yyds',
                'mentions': [{'is_you': True}]}}))
        self.bot.api.reply_group.assert_called_once()
        self.assertIn('永远的神', self.bot.api.reply_group.call_args.args[1])
        self.assertNotIn('markdown', self.bot.api.reply_group.call_args.kwargs)

    def test_reply_passes_the_entire_result_to_qq_without_truncation(self):
        values = ['释义%d%s' % (i, '长'*100) for i in range(100)]
        with mock.patch('qgroup_bot.replies.abbreviation_lookup', AbbreviationLookup()), \
                mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen',
                           return_value=io.BytesIO(json.dumps(
                               [{'name': 'yyds', 'trans': values}]).encode())):
            asyncio.run(self.bot.reply(None, 'allowed', '缩写', 'yyds', msg_id='full'))
        self.bot.api.reply_group.assert_called_once()
        self.assertIn('：'+'、'.join(values)+'\n', self.bot.api.reply_group.call_args.args[1])

    def test_sensitive_words_are_masked_before_sending_and_output_logging(self):
        self.bot.config.log_content = True
        data = [{'name': 'yyds', 'trans': ['正常释义', '傻逼', '长'*100]}]
        with mock.patch('qgroup_bot.replies.abbreviation_lookup', AbbreviationLookup()), \
                mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen',
                           return_value=io.BytesIO(json.dumps(data).encode())), \
                self.assertLogs('qgroup_bot.events', level='INFO') as logs:
            asyncio.run(self.bot.reply(None, 'allowed', '缩写', 'yyds', msg_id='masked'))
        self.bot.api.reply_group.assert_called_once()
        text = self.bot.api.reply_group.call_args.args[1]
        self.assertIn('正常释义、[已遮蔽]、'+'长'*100, text)
        self.assertNotIn('傻逼', text)
        logged = '\n'.join(logs.output)
        self.assertIn('reply_prepared', logged)
        self.assertIn('[已遮蔽]', logged)
        self.assertNotIn('傻逼', logged)

    def test_qq_length_rejection_and_continuation_deliver_the_entire_result(self):
        values = ['释义%d%s' % (i, '长'*80) for i in range(50)]
        accepted, notices = [], []

        def qq(group, text, **kwargs):
            if len(text.encode('utf-8')) > 2200:
                return False, 40054007, {}
            (notices if '/缩写 继续 ' in text else accepted).append(text)
            return True, 0, {}

        self.bot.api.reply_group.side_effect = qq
        data = [{'name': 'aa', 'trans': values}]
        with mock.patch('qgroup_bot.replies.abbreviation_lookup', AbbreviationLookup()), \
                mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen',
                           return_value=io.BytesIO(json.dumps(data).encode())) as upstream:
            asyncio.run(self.bot.reply(None, 'allowed', '缩写', 'aa', msg_id='first'))
            for index in range(10):
                if not list(self.bot.abbreviation_delivery.root.glob('*.txt')):
                    break
                import re
                argument = re.search(r'/缩写 (继续 [0-9a-f]+)', notices[-1]).group(1)
                asyncio.run(self.bot.reply(None, 'allowed', '缩写', argument, msg_id='next%d' % index))
            upstream.assert_called_once()
        self.assertIn('：'+'、'.join(values)+'\n', ''.join(accepted))

    def test_websocket_keeps_processing_ack_and_other_commands_during_lookup(self):
        async def run():
            started, release, other = asyncio.Event(), asyncio.Event(), asyncio.Event()
            frames = [
                {'op':0, 't':'GROUP_AT_MESSAGE_CREATE', 'd':{'content':'/缩写 aa'}},
                {'op':11},
                {'op':0, 't':'GROUP_AT_MESSAGE_CREATE', 'd':{'content':'/帮助'}}]

            async def handle(ws, message):
                if '缩写' in message['d']['content']:
                    started.set()
                    await release.wait()
                else:
                    self.assertTrue(started.is_set())
                    self.assertIsNotNone(self.bot.last_ack)
                    other.set()
                    release.set()

            class WS:
                async def __aenter__(self):
                    return self
                async def __aexit__(self, *args):
                    pass
                async def __aiter__(self):
                    for frame in frames:
                        yield json.dumps(frame)
                        await asyncio.sleep(0)
                    await asyncio.wait_for(other.wait(), 1)

            self.bot.api.gateway = mock.Mock(return_value='wss://example.test')
            with mock.patch('qgroup_bot.main.ws_connect', return_value=lambda *a,**k:WS()), \
                    mock.patch.object(self.bot, 'handle_dispatch', side_effect=handle):
                await asyncio.wait_for(self.bot.websocket_loop(), 2)
                await asyncio.gather(*list(self.bot.abbreviation_tasks))
            self.assertTrue(other.is_set())

        asyncio.run(run())

    def test_disallowed_group_disabled_replies_and_unmentioned_chat_never_query(self):
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer') as lookup:
            asyncio.run(self.bot.reply(None, 'other', '缩写', 'yyds', msg_id='other'))
            asyncio.run(self.bot.handle_dispatch(None, {'t': 'GROUP_MESSAGE_CREATE', 'd': {
                'id': 'chat', 'group_openid': 'allowed', 'content': '/缩写 yyds'}}))
            with storage.connect(self.path) as db:
                current = bot_settings.read(db)
                bot_settings.save(db, dict(base_revision=current['revision'],
                    config=dict(current['config'], replies_enabled=False)), 'admin')
            asyncio.run(self.bot.reply(None, 'allowed', '缩写', 'yyds', msg_id='disabled'))
            lookup.assert_not_called()
        self.bot.api.reply_group.assert_not_called()


if __name__ == '__main__':
    unittest.main()
