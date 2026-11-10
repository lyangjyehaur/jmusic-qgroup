"""Passive commands: parsing, de-identified answers, read-only database access."""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from qgroup_core import events, storage
from qgroup_core.common import now
from qgroup_bot.main import Bot
from qgroup_bot.replies import COMMANDS, HELP, _estimated_over, answer, parse, read_db


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'cmd.sqlite3'
        storage.initialize(self.path)
        self.env = mock.patch.dict(os.environ, {
            'KANBAN_BOT_ENABLED': '0',
            'KANBAN_BOT_BASE_URL': 'https://example.test',
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
                     minimum_participants=4, join_owner=False))

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def answer(self, command, argument=''):
        db = read_db(self.path)
        try:
            return answer(db, command, argument)[0]
        finally:
            db.close()

    def test_parse_variants(self):
        self.assertEqual(parse('/名额'), ('名额', ''))
        self.assertEqual(parse('／待办'), ('待办', ''))
        self.assertEqual(parse('<@EF77ABC> /结算  a1b2'), ('结算', 'a1b2'))
        self.assertEqual(parse('@ 活动'), ('活动', ''))
        self.assertEqual(parse('/help'), ('帮助', ''))
        self.assertEqual(parse('/me'), ('我的', ''))
        self.assertEqual(parse('随便聊天'), (None, ''))

    def test_readonly_connection_rejects_writes(self):
        db = read_db(self.path)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE events SET title='hacked' WHERE id=?", (self.event_id,))
        finally:
            db.close()
        with storage.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT title FROM events WHERE id=?',
                                        (self.event_id,)).fetchone()[0], '唱K活动')

    def test_activity_and_quota_include_link(self):
        for command in ('活动', '名额'):
            text = self.answer(command)
            self.assertIn('唱K活动', text)
            self.assertIn('https://example.test/?event=' + self.event_id, text)
        self.assertIn('最低成团 4 人', self.answer('名额'))

    def test_todos_are_counts_not_names(self):
        text = self.answer('待办')
        self.assertNotIn('私密昵称', text)
        self.assertIn('唱K活动', text)

    def test_my_never_discloses_an_amount(self):
        text = self.answer('我的')
        self.assertIn('站内查看', text)
        self.assertNotIn('元', text)
        self.assertNotIn('私密昵称', text)

    def test_settlement_before_publish(self):
        self.assertIn('尚未发布', self.answer('结算'))

    def test_settlement_after_publish_shows_total_only(self):
        with storage.connect(self.path) as db:
            db.execute('''INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,
                qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
                VALUES(?,1,12345,3,'',NULL,?,'u1','发起者','detailed_published','[]')''',
                (self.event_id, now()))
            db.execute('INSERT INTO settlements VALUES(?,?,?,?,?,?)',
                       (self.event_id, 12345, 3, None, '', now()))
        text = self.answer('结算')
        self.assertIn('123.45 元', text)
        self.assertIn('不在此列出', text)

    def test_no_event_returns_a_helpful_message(self):
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET lifecycle='ended',actual_ended_at=? WHERE id=?",
                       (now(), self.event_id))
        self.assertIn('没有进行中', self.answer('活动'))

    def test_help_lists_every_command(self):
        for item in COMMANDS:
            self.assertIn(item['name'], HELP)

    def test_panel_labels_fit_official_limits(self):
        for item in COMMANDS:
            self.assertLessEqual(len(item['name']), 14)
            self.assertLessEqual(len(item['desc']), 30)

    def test_readonly_uri_survives_paths_with_spaces_and_question_marks(self):
        target_dir = Path(self.tmp.name) / 'dir with space?'
        target = target_dir / 'cmd.sqlite3'
        storage.initialize(target)
        db = read_db(target)
        try:
            self.assertIsNotNone(db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='events'").fetchone())
        finally:
            db.close()
        db = read_db(target)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE events SET title='nope'")
        finally:
            db.close()

    def test_one_at_with_two_event_ids_is_answered_once(self):
        bot = Bot(mock.Mock())
        fingerprint = 'g1|member1|<@BOT> /名额'
        self.assertFalse(bot.duplicate('event-id-1', fingerprint))
        self.assertTrue(bot.duplicate('event-id-2', fingerprint))
        self.assertFalse(bot.duplicate('event-id-3', 'g1|member1|<@BOT> /待办'))

    def test_estimated_over_respects_the_event_timezone(self):
        """A Taipei-local naive time already past in UTC must count as overdue."""
        start_utc = datetime.now(timezone.utc) - timedelta(hours=3)
        local_naive = start_utc.astimezone(ZoneInfo('Asia/Taipei')) \
            .replace(tzinfo=None).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET starts_at=?,timezone='Asia/Taipei',"
                       "duration_hours=1 WHERE id=?", (local_naive, self.event_id))
            row = db.execute('SELECT * FROM events WHERE id=?', (self.event_id,)).fetchone()
        self.assertTrue(_estimated_over(row))


if __name__ == '__main__':
    unittest.main()
