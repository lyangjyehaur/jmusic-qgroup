"""Group discovery must never grant access or redirect queued notifications."""
import asyncio
import json
import os
import sqlite3
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from qgroup_core import bot_groups, bot_settings, bot_outbox, storage
from qgroup_core.common import APIError
from qgroup_bot.main import Bot
from qgroup_bot.config import Config
from qgroup_bot.worker import OutboxWorker
from test_bot_outbox import BotOutboxFixture


def group(group_id, *, replies=False, broadcast=False, name=''):
    return dict(id=group_id, name=name, replies=replies, broadcast=broadcast)


class GroupRoutingTests(BotOutboxFixture, unittest.TestCase):
    def save(self, **changes):
        with storage.connect(self.path) as db:
            current = bot_settings.read(db)
            return bot_settings.save(db, dict(base_revision=current['revision'],
                config=dict(current['config'], **changes)), 'group-admin')['bot']

    def bot(self):
        instance = Bot(SimpleNamespace(db=self.path, group='MAIN', dry_run=False,
                       sandbox=False, verbose_events=False))
        instance.api.reply_group = mock.Mock(return_value=(True, 0, {}))
        return instance

    def dispatch(self, instance, group_id, message='m1', event_type='GROUP_AT_MESSAGE_CREATE'):
        asyncio.run(instance.handle_dispatch(None, dict(t=event_type, d=dict(
            id=message, group_openid=group_id, content='/帮助 private-body',
            author={'member_openid': 'private-member'}, mentions=[{'is_you': True}]))))

    def test_unknown_mention_discovers_group_but_never_enables_or_sends(self):
        instance = self.bot()
        self.dispatch(instance, 'TEST')
        instance.api.reply_group.assert_not_called()
        with storage.connect(self.path) as db:
            status = bot_settings.view(db)['group_status']
            observed = next(g for g in status['groups'] if g['id'] == 'TEST')
            self.assertFalse(observed['replies'])
            self.assertFalse(observed['broadcast'])
            self.assertTrue(observed['last_seen'])
            self.assertEqual(status['ignores'][0]['reason'], 'group_not_allowed')
            self.assertNotIn('private-body', json.dumps(status))
            self.assertNotIn('private-member', json.dumps(status))
            self.assertEqual(bot_settings.read(db)['revision'], 0)

    def test_same_bot_accepts_enabled_test_group_and_observes_revocation_immediately(self):
        instance = self.bot()
        self.save(groups=[group('MAIN', replies=True, broadcast=True), group('TEST', replies=True)])
        self.dispatch(instance, 'TEST')
        instance.api.reply_group.assert_called_once()
        self.assertEqual(instance.api.reply_group.call_args.args[0], 'TEST')
        self.save(groups=[group('MAIN', replies=True, broadcast=True), group('TEST')])
        self.dispatch(instance, 'TEST', 'm2')
        asyncio.run(instance.reply(None, 'TEST', '帮助', '', msg_id='m3'))
        self.assertEqual(instance.api.reply_group.call_count, 1)

    def test_explicit_empty_groups_disable_the_environment_default(self):
        instance = self.bot()
        self.save(groups=[])
        self.dispatch(instance, 'MAIN')
        instance.api.reply_group.assert_not_called()
        self.assertFalse(bot_groups.reply_allowed({'groups': []}, 'MAIN', 'MAIN'))
        self.assertEqual(bot_groups.broadcast_target({'groups': []}, 'MAIN'), '')

    def test_global_reply_switch_and_simulation_record_visible_diagnostics(self):
        instance = self.bot()
        self.save(groups=[group('TEST', replies=True)], replies_enabled=False)
        self.dispatch(instance, 'TEST')
        self.save(replies_enabled=True, dry_run=True)
        self.dispatch(instance, 'TEST', 'm2')
        instance.api.reply_group.assert_not_called()
        with storage.connect(self.path) as db:
            self.assertEqual([r[0] for r in db.execute('SELECT reason FROM bot_group_ignores ORDER BY id')],
                             ['replies_disabled', 'dry_run'])

    def test_button_interactions_follow_the_same_group_policy(self):
        instance = self.bot()
        instance.api.ack_interaction = mock.Mock()
        self.save(groups=[group('TEST', replies=True)])
        asyncio.run(instance.handle_dispatch(None, dict(t='INTERACTION_CREATE', id='platform-event',
            d=dict(id='interaction1', group_openid='TEST', type=11,
                   data={'resolved': {'button_data': '/帮助'}}))))
        instance.api.ack_interaction.assert_called_once_with('interaction1', 0)
        instance.api.reply_group.assert_called_once()

    def test_policy_read_failure_fails_closed(self):
        instance = self.bot()
        with mock.patch('qgroup_bot.main.read_db', side_effect=OSError()):
            self.assertFalse(instance.reply_group_allowed('MAIN'))

    def test_validation_rejects_duplicates_multiple_targets_and_bad_values(self):
        cases = [[group('X'), group('X')], [group('../escape')],
                 [group('A', broadcast=True), group('B', broadcast=True)],
                 [dict(group('X'), replies=1)], [dict(group('X'), name='x'*61)],
                 [dict(group('X'), name='line\nbreak')], [dict(group('X'), secret='bad')],
                 'MAIN', [group(str(i)) for i in range(101)]]
        for groups in cases:
            with self.subTest(groups=str(groups)[:100]), self.assertRaises(APIError):
                self.save(groups=groups)

    def test_group_names_remain_exact_in_localized_payloads(self):
        from qgroup_core import i18n
        name='發後臺原文 <img src=x onerror=alert(1)>'
        info=self.save(groups=[group('TEST', name=name, replies=True)])
        for locale in ('hans', 'hant'):
            result=i18n.payload(info, locale)
            self.assertEqual(result['config']['groups'][0]['name'], name)
            self.assertEqual(result['group_status']['groups'][0]['name'], name)

    def test_defaults_are_reported_to_web_without_its_bot_environment(self):
        worker = OutboxWorker(Config(), mock.Mock())
        worker.poll_once()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('KANBAN_BOT_GROUP', None)
            with storage.connect(self.path) as db:
                status=bot_settings.view(db)['group_status']
                self.assertTrue(status['inherited'])
                self.assertEqual([g['id'] for g in status['groups'] if g['broadcast']], ['GROUP_OPENID_TEST'])

    def test_diagnostics_are_bounded_and_membership_events_are_discoverable(self):
        instance=self.bot()
        asyncio.run(instance.handle_dispatch(None, dict(t='GROUP_ADD_ROBOT', d={'group_openid':'NEW'})))
        asyncio.run(instance.handle_dispatch(None, dict(t='GROUP_DEL_ROBOT', d={'group_openid':'NEW'})))
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT membership FROM bot_groups WHERE group_id=?',('NEW',)).fetchone()[0], 'removed')
            for _ in range(125):bot_groups.ignored(db,'NEW','group_not_allowed')
            self.assertEqual(db.execute('SELECT count(*) FROM bot_group_ignores').fetchone()[0],100)
            self.assertEqual(len(bot_groups.view(db,bot_settings.defaults())['ignores']),20)

    def test_switching_broadcast_target_invalidates_old_claims_without_replaying_announcements(self):
        self.save(groups=[group('A', broadcast=True)])
        self.create_event()
        worker=OutboxWorker(Config(),mock.Mock())
        claimed=worker.claim()[0]
        self.save(groups=[group('B', broadcast=True),group('TEST',replies=True)])
        self.assertEqual(worker.deliver(claimed),'skipped')
        worker.api.post.assert_not_called()
        rows=self.rows()
        card=next(r for r in rows if r['kind']=='activity_published')
        self.assertEqual((card['target'],card['status']),('A','skipped'))
        future=[r for r in rows if r['kind'] in bot_outbox.REMINDER_KINDS and r['status']=='pending']
        self.assertEqual(len(future),2)
        self.assertTrue(all(r['target']=='B' for r in future))
        self.save(groups=[group('B',broadcast=True),group('TEST',replies=False)])
        self.assertTrue(all(next(r for r in self.rows() if r['id']==old['id'])['status']=='pending' for old in future))

    def test_future_pushes_bind_to_target_and_never_use_reply_only_test_group(self):
        self.save(groups=[group('MAIN', broadcast=True),group('TEST',replies=True)],dry_run=False)
        self.create_event()
        api=mock.Mock();api.post.return_value=(True,0,{})
        worker=OutboxWorker(Config(),api)
        self.assertEqual(worker.poll_once()['sent'],1)
        self.assertEqual(api.post.call_args.args[0],'/v2/groups/MAIN/messages')
        self.assertTrue(all(r['target']=='MAIN' for r in self.rows()))

    def test_no_broadcast_target_does_not_queue_or_redirect_notifications(self):
        self.save(groups=[group('TEST',replies=True)])
        self.create_event()
        self.assertEqual(self.rows(),[])

    def test_manually_configured_disabled_group_is_retained_without_granting_access(self):
        result=self.save(groups=[group('MANUAL')])
        observed=next(g for g in result['group_status']['groups'] if g['id']=='MANUAL')
        self.assertTrue(observed['configured'])
        self.assertIsNone(observed['last_seen'])
        self.assertFalse(observed['replies'])
        self.assertFalse(observed['broadcast'])

    def test_old_environment_rows_are_not_redirected_on_first_explicit_target(self):
        self.create_event()
        self.assertTrue(all(r['target']=='' for r in self.rows()))
        self.save(groups=[group('OTHER',broadcast=True)])
        self.assertFalse(any(r['status']=='pending' and r['kind']=='activity_published' for r in self.rows()))

    def test_authorization_rejection_is_scoped_to_its_group(self):
        config=Config();config.log_dir=Path(self.tmp.name)/'logs'
        worker=OutboxWorker(config,mock.Mock())
        worker._record_rejection(40034105,'A')
        self.assertTrue(worker._read_authorization_block('A'))
        self.assertIsNone(worker._read_authorization_block('B'))

    def test_upgrade_and_revert_preserve_old_policy_and_explicit_empty_group_semantics(self):
        with storage.connect(self.path) as db:
            original=dict(bot_settings.defaults());original.pop('groups')
            db.execute('UPDATE bot_settings SET config_json=? WHERE id=1',(json.dumps(original),))
            db.execute('DROP TABLE bot_groups');db.execute('DROP TABLE bot_group_ignores')
            db.execute('ALTER TABLE bot_runtime DROP COLUMN deployment_group')
            db.execute('DELETE FROM schema_migrations WHERE version=15')
        source=Path(self.tmp.name)/'v14.sqlite3'
        with sqlite3.connect(self.path) as db,sqlite3.connect(source) as target:
            db.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
        from deploy.verify_migration import verify
        destination=Path(self.tmp.name)/'v15.sqlite3'
        verify(source,destination)
        storage.initialize(self.path)
        self.save(groups=[])
        with storage.connect(self.path) as db:
            result=bot_settings.save(db,{'base_revision':1},'admin',revert=True)['bot']
            self.assertIsNone(result['config']['groups'])
            self.assertTrue(result['group_status']['inherited'])


if __name__=='__main__':unittest.main()
