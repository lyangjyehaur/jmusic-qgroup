"""Protocol fixes checked against docs/bot-official-docs-audit-2026-11-10.md.

Covers A01 (err_code), A03 (interaction ACK), A05 (panel schema),
A06 (platform trace), A07 (mentions and de-duplication) and the HELP entries.
"""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from qgroup_core import bot_settings
from qgroup_bot.api import QQBotAPI, classify_error
from qgroup_bot.config import Config
from qgroup_bot.main import Bot, normalize_content, mentions_bot
from qgroup_bot.replies import help_text
from qgroup_bot import observability as obs


def api():
    client = QQBotAPI(SimpleNamespace(sandbox=False, app_id='app', app_secret='secret'))
    client._token = 'private-token'
    client._token_expiry = time.time() + 1000
    return client


def bot():
    return Bot(SimpleNamespace(db=Path('/tmp/qgroup-protocol-test.sqlite3'),
                               group='allowed', dry_run=True, sandbox=False,
                               verbose_events=False))


class ErrorEnvelopeTests(unittest.TestCase):
    def test_api_code_accepts_both_platform_error_fields(self):
        self.assertEqual(obs.api_code({'err_code': 40034105}), 40034105)
        self.assertEqual(obs.api_code({'code': 100007}), 100007)
        self.assertEqual(obs.api_code({'code': 0, 'err_code': 0}), 0)
        self.assertIsNone(obs.api_code({'id': 'sent-message'}))
        self.assertIsNone(obs.api_code({'raw': 'not json'}))

    def test_http_200_with_err_code_is_never_a_delivery(self):
        client = api()
        client.http_json = mock.Mock(return_value=(200, {'err_code': 40034105, 'message': 'no permission'}))
        ok, code, data = client.post('/v2/groups/group/messages', {'content': 'x'})
        self.assertFalse(ok)
        self.assertEqual(code, 40034105)
        self.assertEqual(client.http_json.call_count, 1)

    def test_async_2xx_is_unconfirmed_and_must_not_be_retried_as_sending(self):
        client = api()
        client.http_json = mock.Mock(return_value=(202, {'id': 'async-result'}))
        ok, code, data = client.post('/v2/groups/group/messages', {'content': 'x'})
        self.assertFalse(ok)
        self.assertEqual(data['_unconfirmed_http'], 202)
        self.assertEqual(classify_error(None, data=data), 'unconfirmed')

    def test_malformed_body_is_not_success(self):
        client = api()
        client.http_json = mock.Mock(return_value=(200, {'raw': '<html>'}))
        ok, _, _ = client.post('/v2/groups/group/messages', {'content': 'x'})
        self.assertFalse(ok)

    def test_error_kinds_separate_quota_authorization_and_hard_reject(self):
        self.assertEqual(classify_error(40034100, data={}), 'rate_limit')
        self.assertEqual(classify_error(None, status=429, data={}), 'rate_limit')
        self.assertEqual(classify_error(40054010, data={}), 'permanent')
        self.assertEqual(classify_error(40034105, data={}), 'authorization')
        self.assertEqual(classify_error(50055001, data={}), 'transient')

    def test_platform_trace_is_bounded_and_never_stores_a_secret(self):
        obs.set_platform_trace('4a8a-trace-id')
        self.assertEqual(obs.platform_trace(), '4a8a-trace-id')
        obs.set_platform_trace('Bearer private-token')
        self.assertIsNone(obs.platform_trace())
        obs.set_platform_trace(None)
        self.assertIsNone(obs.platform_trace())


class InteractionAndPanelTests(unittest.TestCase):
    def test_button_callback_is_acked_with_put_on_d_id(self):
        client = api()
        client.http_json = mock.Mock(return_value=(200, {}))
        ok, _, _ = client.ack_interaction('a1b2-c3d4')
        self.assertTrue(ok)
        args = client.http_json.call_args[0]
        self.assertEqual(args[0], 'PUT')
        self.assertTrue(args[1].endswith('/interactions/a1b2-c3d4'))
        self.assertEqual(args[2], {'code': 0})

    def test_invalid_interaction_id_never_reaches_the_platform(self):
        client = api()
        client.http_json = mock.Mock()
        ok, _, _ = client.ack_interaction('../other-path')
        self.assertFalse(ok)
        client.http_json.assert_not_called()

    def test_panels_use_current_scope_and_panel_items_schema(self):
        client = api()
        client.http_json = mock.Mock(return_value=(200, {'records': [], 'is_end': True}))
        client.post = mock.Mock(return_value=(True, 0, {'panel_id': 'p1'}))
        self.assertTrue(client.setup_panels([{'name': '/活动', 'desc': '查活动'}], 'GROUP1'))
        path, body = client.post.call_args[0]
        self.assertEqual(path, '/v2/panels')
        self.assertEqual(body['scope'], 'group')
        self.assertEqual(body['target_type'], 'specific')
        self.assertEqual(body['group_openids'], ['GROUP1'])
        self.assertEqual(body['panel']['items'][0]['type'], 'command')

    def test_existing_group_panel_is_not_created_again(self):
        client = api()
        client.http_json = mock.Mock(return_value=(200, {'records': [{'scope': 'group', 'panel_id': 'p1'}]}))
        client.post = mock.Mock()
        self.assertTrue(client.setup_panels([{'name': '/活动', 'desc': '查活动'}], 'GROUP1'))
        client.post.assert_not_called()


class MentionAndDuplicateTests(unittest.TestCase):
    def test_mention_markup_is_stripped_for_fingerprints(self):
        self.assertEqual(normalize_content('<@!BOT1> /活动'), '/活动')
        self.assertEqual(normalize_content('<qqbot-at-user id="BOT1" /> /名额'), '/名额')

    def test_full_message_mode_does_not_depend_on_is_you(self):
        self.assertTrue(mentions_bot([{'id': 'BOT1', 'bot': True}], 'BOT1', 'hi'))
        self.assertTrue(mentions_bot([{'is_you': True}], None, 'hi'))
        self.assertTrue(mentions_bot([], 'BOT1', '<@!BOT1> /活动'))
        self.assertFalse(mentions_bot([{'id': 'OTHER'}], 'BOT1', 'hi'))

    def test_a_repeated_question_with_a_new_timestamp_is_not_swallowed(self):
        instance = bot()
        first = 'allowed|member|/活动|2026-11-10T10:00:00+08:00'
        again = 'allowed|member|/活动|2026-11-10T10:00:31+08:00'
        self.assertFalse(instance.duplicate('m1', first))
        self.assertFalse(instance.duplicate('m2', again))
        self.assertTrue(instance.duplicate('m3', first))

    def test_same_utterance_arriving_as_two_event_types_is_still_one(self):
        instance = bot()
        fingerprint = 'allowed|member|/活动|2026-11-10T10:00:00+08:00'
        self.assertFalse(instance.duplicate('m1', fingerprint))
        self.assertTrue(instance.duplicate('m2', fingerprint))

    def test_the_same_interaction_is_only_acked_once(self):
        instance = bot()
        self.assertTrue(instance.remember_interaction('interaction-1'))
        self.assertFalse(instance.remember_interaction('interaction-1'))
        self.assertTrue(instance.remember_interaction('interaction-2'))


class DeploymentPolicyTests(unittest.TestCase):
    def test_url_allowlist_is_opt_in(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('KANBAN_BOT_ALLOWED_HOSTS', None)
            self.assertEqual(Config().allowed_link_hosts, ())
        with mock.patch.dict(os.environ, {'KANBAN_BOT_ALLOWED_HOSTS': 'kanban.danndann.cn, example.test'}):
            self.assertEqual(Config().allowed_link_hosts, ('kanban.danndann.cn', 'example.test'))

    def test_unified_api_host_is_default_with_legacy_fallback(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('KANBAN_BOT_API_BASE', None)
            config = Config()
            self.assertEqual(config.api_base, 'https://api.bot.qq.com')
            self.assertEqual(config.legacy_api_base, 'https://api.sgroup.qq.com')

    def test_help_lists_privacy_contact_and_no_implicit_signup(self):
        text = help_text()
        self.assertIn('/privacy', text)
        self.assertIn('/contact', text)
        self.assertIn('不会替你报名', text)


class LivePolicyTests(unittest.TestCase):
    """The admin DB policy, not the boot environment, decides bot behaviour."""

    def test_web_and_bot_inherit_the_same_broadcast_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('KANBAN_BOT_ENABLED', None)
            self.assertEqual(bot_settings.defaults(worker=True)['enabled'],
                             bot_settings.defaults()['enabled'])
            self.assertFalse(bot_settings.defaults(worker=True)['enabled'])
        with mock.patch.dict(os.environ, {'KANBAN_BOT_ENABLED': '1'}):
            self.assertTrue(bot_settings.defaults(worker=True)['enabled'])
            self.assertTrue(bot_settings.defaults()['enabled'])

    def test_admin_policy_overrides_a_dry_run_boot_environment(self):
        instance = bot()
        conn = mock.MagicMock()
        with mock.patch('qgroup_bot.main.read_db', return_value=conn), \
             mock.patch('qgroup_bot.main.bot_settings.read',
                        return_value={'config': {'dry_run': False}}):
            self.assertFalse(instance.resolve_dry_run())
        with mock.patch('qgroup_bot.main.read_db', return_value=conn), \
             mock.patch('qgroup_bot.main.bot_settings.read',
                        return_value={'config': {'dry_run': None}}):
            self.assertTrue(instance.resolve_dry_run())

    def test_missing_settings_table_falls_back_without_blocking(self):
        instance = bot()
        with mock.patch('qgroup_bot.main.read_db', side_effect=OSError('no table')):
            self.assertTrue(instance.resolve_dry_run())

    def test_health_state_reports_the_effective_policy_not_the_boot_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            instance = bot()
            instance.config.log_dir = Path(tmp)
            instance.resolved_dry_run = False
            instance.write_health()
            state = json.loads((Path(tmp) / 'bot-health.json').read_text())
            self.assertFalse(state['dry_run'])
            self.assertTrue(state['deployment_dry_run'])
            self.assertTrue(state['policy_resolved'])

    def test_panel_registration_follows_a_live_policy_switch(self):
        instance = bot()
        instance.config.setup_panels = True
        instance.api.setup_panels = mock.Mock(return_value=True)
        instance.resolved_dry_run = True
        asyncio.run(instance.sync_panels())
        instance.api.setup_panels.assert_not_called()
        instance.resolved_dry_run = False
        asyncio.run(instance.sync_panels())
        instance.api.setup_panels.assert_called_once()
        instance.resolved_dry_run = True
        asyncio.run(instance.sync_panels())
        instance.resolved_dry_run = False
        asyncio.run(instance.sync_panels())
        self.assertEqual(instance.api.setup_panels.call_count, 2)

    def test_health_path_honours_a_custom_log_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            instance = bot()
            instance.config.log_dir = Path(tmp)
            self.assertEqual(instance.health_path(), Path(tmp) / 'bot-health.json')


if __name__ == '__main__':
    unittest.main()
