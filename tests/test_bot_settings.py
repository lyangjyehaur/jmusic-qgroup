"""Runtime policy, immutable message facts, scheduling, pacing and admin boundaries."""
import asyncio
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import server
from qgroup_bot.config import Config
from qgroup_bot.main import Bot
from qgroup_bot.worker import OutboxWorker
from qgroup_core import bot_outbox, bot_settings, storage
from qgroup_core.common import APIError, now
from test_bot_outbox import BotOutboxFixture
from test_roster import ModernClient


class RuntimeSettingsTests(BotOutboxFixture, unittest.TestCase):
    def save(self, **changes):
        with storage.connect(self.path) as db:
            current = bot_settings.read(db)
            config = dict(current['config'], **changes)
            return bot_settings.save(db, dict(base_revision=current['revision'], config=config), 'admin-test')['bot']

    def worker(self, dry_run=True):
        config = Config()
        config.dry_run = dry_run
        api = mock.Mock()
        api.post.return_value = (True, 0, {})
        return OutboxWorker(config, api)

    def test_defaults_inherit_deployment_without_changing_business_data(self):
        with storage.connect(self.path) as db:
            self.assertTrue(bot_settings.read(db)['config']['enabled'])
            self.assertEqual(bot_settings.read(db)['revision'], 0)
            self.assertIsNone(bot_settings.read(db)['config']['dry_run'])
        self.save(deadline_hours=6)
        storage.initialize(self.path)
        with storage.connect(self.path) as db:
            self.assertEqual(bot_settings.read(db)['config']['deadline_hours'], 6)
            self.assertEqual(db.execute('SELECT count(*) FROM bot_settings_history').fetchone()[0], 2)

    def test_schema_13_upgrade_preserves_the_previous_database_and_is_repeatable(self):
        from deploy.verify_migration import verify
        self.create_event()
        source = Path(self.tmp.name)/'v12.sqlite3'
        destination = Path(self.tmp.name)/'v13.sqlite3'
        with storage.connect(self.path) as db, sqlite3.connect(source) as out:
            db.backup(out)
        with sqlite3.connect(source) as db:
            for table in ('bot_settings_history', 'bot_settings', 'bot_runtime'):
                db.execute('DROP TABLE '+table)
            db.execute('DELETE FROM schema_migrations WHERE version=13')
        verify(source, destination)
        with storage.connect(destination) as db:
            self.assertEqual(bot_settings.read(db)['revision'], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM events').fetchone()[0], 1)

    def test_saved_policy_is_shared_even_when_process_environments_differ(self):
        self.save(enabled=True, deadline_hours=6)
        with mock.patch.dict(os.environ, {'KANBAN_BOT_ENABLED':'0', 'KANBAN_BOT_SCHEDULE':'0'}):
            self.create_event()
            with storage.connect(self.path) as db:
                self.assertTrue(bot_settings.read(db, worker=True)['config']['enabled'])
        self.assertEqual(sum(row['kind'] == 'deadline_reminder' for row in self.rows()), 1)

    def test_validation_rejects_unsafe_templates_and_invalid_policy(self):
        invalid = [dict(deadline_hours=0), dict(deadline_hours=True), dict(min_interval_seconds=3601),
                   dict(timezone='../UTC'), dict(enabled=1), dict(dry_run='false'),
                   dict(broadcast_kinds=['activity_published']*2), dict(quiet_start='24:00'),
                   dict(quiet_enabled=True, quiet_start='08:00', quiet_end='08:00')]
        for template in ('{title}', '{url.__class__}', '{url!r}', '{url:1000}', '{secret}\n{url}', '{', ' '*5, '{description}'*100+'{url}'):
            invalid.append(dict(templates={'activity_published': template}))
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(APIError):
                self.save(**changes)
        with storage.connect(self.path) as db:
            self.assertEqual(bot_settings.read(db)['revision'], 0)

    def test_history_conflicts_revert_and_atomic_rollback(self):
        first = self.save(deadline_hours=12)
        self.save(deadline_hours=6)
        with storage.connect(self.path) as db:
            with self.assertRaises(APIError) as problem:
                bot_settings.save(db, dict(base_revision=1, config=first['config']), 'other')
            self.assertEqual(problem.exception.status, 409)
            restored = bot_settings.save(db, dict(base_revision=2), 'admin', revert=True)['bot']
            self.assertEqual(restored['revision'], 3)
            self.assertEqual(restored['config']['deadline_hours'], 12)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('DELETE FROM bot_settings_history')
        with storage.connect(self.path) as db:
            db.execute("CREATE TRIGGER fail_settings BEFORE INSERT ON bot_settings_history BEGIN SELECT RAISE(ABORT,'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.save(enabled=False)
        with storage.connect(self.path) as db:
            self.assertEqual(bot_settings.read(db)['revision'], 3)
            self.assertTrue(bot_settings.read(db)['config']['enabled'])

    def test_switches_cancel_queued_messages_and_empty_event_selection_disables_all(self):
        self.create_event()
        self.save(broadcast_kinds=[])
        self.assertTrue(all(row['status'] == 'skipped' for row in self.rows()))
        worker = self.worker(False)
        worker.poll_once()
        worker.api.post.assert_not_called()
        with storage.connect(self.path) as db:
            self.assertFalse(bot_outbox.enqueue(db, self.event_id, 'activity_published', 'test'))
        self.save(broadcast_kinds=list(bot_settings.KINDS), enabled=False)
        self.assertTrue(all(row['status'] == 'skipped' for row in self.rows()))

    def test_reminders_reschedule_without_replaying_past_broadcasts(self):
        self.create_event()
        old = next(row for row in self.rows() if row['kind'] == 'deadline_reminder')
        self.save(deadline_hours=6, estimated_over_delay_minutes=30)
        rows = self.rows()
        self.assertEqual(next(row for row in rows if row['id'] == old['id'])['status'], 'skipped')
        future = next(row for row in rows if row['kind'] == 'deadline_reminder' and row['status'] == 'pending')
        self.assertEqual(datetime.fromisoformat(future['due_at']) - datetime.fromisoformat(old['due_at']), timedelta(hours=18))
        self.save(schedule_enabled=False)
        self.assertFalse(any(row['status'] == 'pending' and row['due_at'] for row in self.rows()))
        self.save(schedule_enabled=True)
        self.assertEqual(sum(row['status'] == 'pending' and row['kind'] == 'deadline_reminder' for row in self.rows()), 1)
        self.assertEqual(sum(row['kind'] == 'activity_published' for row in self.rows()), 1)

    def test_template_updates_pending_messages_but_keeps_their_event_snapshot(self):
        self.create_event()
        original = next(row for row in self.rows() if row['kind'] == 'activity_published')
        self.save(templates={'activity_published': '新版：{title}\n{url}'}, dry_run=False)
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET title='后来的名称' WHERE id=?", (self.event_id,))
        worker = self.worker()
        worker.poll_once()
        text = worker.api.post.call_args.args[1]['content']
        self.assertIn('新版：测试活动', text)
        self.assertNotIn('后来的名称', text)
        row = self.rows('WHERE id=?', (original['id'],))[0]
        self.assertEqual(row['payload_json'], original['payload_json'])
        self.assertEqual(json.loads(row['delivered_payload_json'])['_config_revision'], 1)

    def test_reset_template_restores_default_for_a_pending_custom_message(self):
        self.save(templates={'activity_published': '旧模板：{title}\n{url}'})
        self.create_event()
        self.save(templates={}, dry_run=False)
        worker = self.worker()
        worker.poll_once()
        self.assertNotIn('旧模板', worker.api.post.call_args.args[1]['content'])
        self.assertIn('时间：', worker.api.post.call_args.args[1]['content'])

    def test_same_worker_observes_live_mode_and_independent_reply_switch(self):
        self.create_event()
        worker = self.worker(True)
        self.save(dry_run=False, replies_enabled=False)
        self.assertEqual(worker.poll_once()['sent'], 1)
        bot = Bot(SimpleNamespace(db=self.path, group='allowed', dry_run=True, sandbox=False))
        bot.api.reply_group = mock.Mock(return_value=(True, 0, {}))
        asyncio.run(bot.reply(None, 'allowed', '帮助', '', msg_id='message'))
        bot.api.reply_group.assert_not_called()
        self.save(enabled=False, replies_enabled=True, dry_run=False)
        asyncio.run(bot.reply(None, 'allowed', '帮助', '', msg_id='message2'))
        bot.api.reply_group.assert_called_once()
        with storage.connect(self.path) as db:
            runtime = bot_settings.view(db)['runtime']
            self.assertEqual(runtime['applied_revision'], 1)
            self.assertTrue(runtime['checked_at'])

    def test_quiet_hours_across_midnight_and_same_day(self):
        config = dict(bot_settings.defaults(), quiet_enabled=True, timezone='Asia/Taipei')
        moment = datetime(2030, 1, 1, 16, tzinfo=timezone.utc)  # Jan 2 00:00 local
        self.assertEqual(bot_settings.quiet_until(config, moment), datetime(2030, 1, 2, 0, tzinfo=timezone.utc))
        self.assertIsNone(bot_settings.quiet_until(config, datetime(2030, 1, 2, 0, tzinfo=timezone.utc)))
        config.update(quiet_start='12:00', quiet_end='14:00')
        self.assertEqual(bot_settings.quiet_until(config, datetime(2030, 1, 1, 5, tzinfo=timezone.utc)), datetime(2030, 1, 1, 6, tzinfo=timezone.utc))

    def test_quiet_deferral_is_not_a_failure_and_policy_edits_release_it(self):
        self.create_event()
        self.save(dry_run=False, quiet_enabled=True, timezone='UTC')
        worker = self.worker()
        moment = datetime(2030, 1, 1, 23, 30, tzinfo=timezone.utc)
        with mock.patch('qgroup_bot.worker.datetime') as clock:
            clock.now.return_value = moment
            self.assertEqual(worker.poll_once()['deferred'], 1)
        worker.api.post.assert_not_called()
        row = next(row for row in self.rows() if row['kind'] == 'activity_published')
        self.assertEqual(row['attempts'], 0)
        self.assertEqual(row['retry_at'], '2030-01-02T08:00:00+00:00')
        self.save(quiet_enabled=False)
        self.assertEqual(worker.poll_once()['sent'], 1)

    def test_send_interval_persists_across_worker_restarts(self):
        self.create_event()
        self.due_rows(1)
        self.save(dry_run=False, min_interval_seconds=60)
        worker = self.worker()
        result = worker.poll_once()
        self.assertEqual((result['sent'], result['deferred']), (1, 1))
        second = self.worker()
        self.assertEqual(second.poll_once()['sent'], 0)
        second.api.post.assert_not_called()
        pending = next(row for row in self.rows() if row['status'] == 'pending')
        self.assertEqual(pending['attempts'], 0)

    def test_pacing_never_rounds_down_a_subsecond_send_time(self):
        policy = dict(bot_settings.defaults(), min_interval_seconds=1)
        moment = datetime(2030, 1, 1, 12, 0, 0, 900000, tzinfo=timezone.utc)
        with storage.connect(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            self.assertIsNone(bot_settings.reserve_send(db, policy, moment))
        with storage.connect(self.path) as db:
            due = bot_settings.reserve_send(db, policy, moment+timedelta(milliseconds=200))
            self.assertEqual(datetime.fromisoformat(due)-moment, timedelta(seconds=1))

    def test_preview_all_kinds_is_read_only_and_preserves_custom_text(self):
        config = bot_settings.defaults()
        with storage.connect(self.path) as db:
            for kind in bot_settings.KINDS:
                result = bot_settings.preview(db, dict(config=config, kind=kind))
                self.assertIn('周末聚餐', result['text'])
            config['templates'] = {'activity_published': '發後臺原文 <b>文字</b> {title}\n{url}'}
            self.assertIn('發後臺原文 <b>文字</b>', bot_settings.preview(db, dict(config=config, kind='activity_published'))['text'])
            self.assertEqual(db.execute('SELECT count(*) FROM bot_outbox').fetchone()[0], 0)
            self.assertEqual(bot_settings.read(db)['revision'], 0)


class AdminBotHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous_db = server.DB
        server.DB = Path(self.tmp.name)/'admin.sqlite3'
        server.initialize()
        server.LIMITS.clear()
        self.key = 'bot-admin-test-'+'x'*40
        self.env = mock.patch.dict(os.environ, {'KANBAN_ADMIN_KEY_HASH': hashlib.sha256(self.key.encode()).hexdigest()})
        self.env.start()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.client = ModernClient('http://127.0.0.1:%d' % self.http.server_address[1])

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.env.stop(); server.DB = self.previous_db; self.tmp.cleanup()

    def login(self):
        self.assertEqual(self.client.request('/api/admin/login', 'POST', dict(key=self.key))[0], 200)
        info = self.client.request('/api/admin/session')[1]
        self.headers = {'X-Kanban-Admin': info['csrf']}
        return info['bot']

    def test_admin_auth_csrf_origin_and_conflicts(self):
        self.assertEqual(self.client.request('/api/admin/bot-settings')[0], 401)
        self.assertEqual(self.client.request('/api/admin/bot-preview', 'POST', {})[0], 401)
        info = self.login()
        payload = dict(base_revision=info['revision'], config=info['config'])
        self.assertEqual(self.client.request('/api/admin/bot-settings', 'POST', payload)[0], 403)
        self.assertEqual(self.client.request('/api/admin/bot-settings', 'POST', payload, headers=dict(self.headers, Origin='https://evil.test'))[0], 403)
        status, saved = self.client.request('/api/admin/bot-settings', 'POST', payload, headers=self.headers)
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.client.request('/api/admin/bot-settings', 'POST', payload, headers=self.headers)[0], 409)
        self.assertEqual(self.client.request('/api/admin/bot-revert', 'POST', dict(base_revision=saved['bot']['revision']), headers=self.headers)[0], 200)

    def test_preview_and_localization_do_not_convert_user_templates(self):
        info = self.login()
        info['config']['templates'] = {'activity_published': '后台原文 {url}'}
        data = dict(config=info['config'], kind='activity_published')
        status, result = self.client.request('/api/admin/bot-preview', 'POST', data, headers=self.headers)
        self.assertEqual(status, 200, result)
        self.assertIn('后台原文', result['text'])
        status, saved = self.client.request('/api/admin/bot-settings', 'POST', dict(base_revision=0, config=info['config']), headers=self.headers)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['bot']['config']['templates']['activity_published'], '后台原文 {url}')
        with storage.connect(server.DB) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM bot_outbox').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
