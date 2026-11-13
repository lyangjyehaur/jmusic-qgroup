"""Passive commands: parsing, de-identified answers, read-only database access."""
import os
import asyncio
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
from qgroup_bot.replies import (COMMANDS, HELP, _estimated_over, answer, answer_markdown,
                               candidates, current_event, parse, read_db)


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
                     minimum_participants=4, join_owner=False, bot_enabled=True))

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
        self.assertIn('登录网站查看', text)
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

    def test_overdue_events_are_hidden_from_active_lists_but_remain_manageable(self):
        start = (datetime.now(timezone.utc) - timedelta(hours=3)).astimezone(
            ZoneInfo('Asia/Taipei')).replace(tzinfo=None).isoformat(timespec='seconds')
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET starts_at=?,timezone='Asia/Taipei',duration_hours=1",
                       (start,))
        for command in ('活动', '报名', '名额', '地点', '规则', '出席'):
            with self.subTest(command=command):
                self.assertNotIn('唱K活动', self.answer(command))
                with read_db(self.path) as db:
                    self.assertNotIn('唱K活动', answer_markdown(db, command))
        for command in ('管理', '待办', '结算'):
            self.assertIn('唱K活动', self.answer(command))
        self.assertIn('唱K活动', self.answer('活动', self.event_id[:8]))
        self.assertNotIn('唱K活动', self.answer('往期'))
        # Extending the planned duration makes it visible again without an
        # actual lifecycle transition.
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET duration_hours=6')
        self.assertIn('唱K活动', self.answer('活动'))

    def test_overdue_filter_precedes_limit_and_keeps_active_command_numbers_aligned(self):
        start = datetime.now(timezone.utc)
        with storage.connect(self.path) as db:
            source = db.execute('SELECT * FROM events WHERE id=?', (self.event_id,)).fetchone()
            for index in range(10):
                event_id = events.create(db, {'id': 'u1', 'nickname': 'test'},
                    dict(title='过期待确认%d' % index, category='聚餐', location='餐厅',
                         starts_at=source['starts_at'], deadline=source['deadline'],
                         capacity=0, description='', duration_hours=1, join_owner=False))
                db.execute('UPDATE events SET starts_at=? WHERE id=?',
                           ((start - timedelta(hours=2)).isoformat(), event_id))
            second = events.create(db, {'id': 'u1', 'nickname': 'test'},
                dict(title='未来另一场', category='聚餐', location='餐厅',
                     starts_at=(start + timedelta(days=3)).isoformat(),
                     deadline=source['deadline'], capacity=0, description='',
                     duration_hours=2, join_owner=False))
        self.assertIn('未来另一场', self.answer('活动'))
        self.assertNotIn('过期待确认', self.answer('活动'))
        with read_db(self.path) as db:
            self.assertNotIn('过期待确认', answer_markdown(db, '活动'))
            for command in ('活动', '报名', '名额', '地点', '规则'):
                self.assertEqual([e['id'] for e in candidates(db, command)],
                                 [self.event_id, second])
                self.assertEqual(current_event(db, '2', command)['id'], second)

    def test_ongoing_events_without_an_estimated_end_remain_in_active_lists(self):
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET lifecycle='ongoing',starts_at=?,duration_hours=NULL",
                       ((datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),))
        self.assertIn('唱K活动', self.answer('活动'))

    def test_simplified_and_traditional_commands_use_the_same_actions(self):
        pairs = [('活动','活動'),('报名','報名'),('名额','名額'),('待办','待辦'),
                 ('出席','簽到'),('结算','結算'),('帮助','幫助'),('发起','發起'),
                 ('再约','再約'),('规则','規則'),('账本','帳本'),('申报','申報'),
                 ('补报','補報'),('认领','認領'),('协办','協辦'),('确认安排','確認安排')]
        for simplified, traditional in pairs:
            self.assertEqual(parse('/'+simplified), parse('／'+traditional))
        self.assertEqual(parse('<@BOT>'), ('活动',''))
        self.assertIn('未识别', self.answer(None))

    def test_private_draft_and_deleted_events_cannot_be_read_by_id(self):
        for field, value in [('visibility','invitation'),('lifecycle','draft'),('status','deleted')]:
            with storage.connect(self.path) as db:
                db.execute("UPDATE events SET visibility='public',lifecycle='scheduled',status='open',bot_enabled=0")
                db.execute('UPDATE events SET '+field+'=? WHERE id=?', (value,self.event_id))
            for command in ('活动','名额','报名','管理','结算','往期','待办','规则'):
                for argument in ('', self.event_id, self.event_id[:8], '%'):
                    with self.subTest(field=field,command=command,argument=argument):
                        self.assertNotIn('唱K活动', self.answer(command, argument))

    def test_public_queries_do_not_require_active_group_sync(self):
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET bot_enabled=0 WHERE id=?',(self.event_id,))
        for command in ('活动','名额','报名','管理','地点','规则','结算','待办','出席'):
            for argument in ('',self.event_id,self.event_id[:8]):
                with self.subTest(command=command,argument=argument):
                    self.assertIn('唱K活动',self.answer(command,argument))

    def test_querying_and_editing_unsynced_public_event_never_queues_broadcasts(self):
        with mock.patch.dict(os.environ,{'KANBAN_BOT_ENABLED':'1'}):
            with storage.connect(self.path) as db:
                source=db.execute('SELECT * FROM events WHERE id=?',(self.event_id,)).fetchone()
                data=dict(title='只查询不推送',category='聚餐',location='餐厅',
                          starts_at=source['starts_at'],deadline=source['deadline'],
                          capacity=10,description='',duration_hours=2,
                          join_owner=False,bot_enabled=False)
                event_id=events.create(db,{'id':'u1','nickname':'test'},data)
                event=db.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
                events.patch(db,event,{'id':'u1','nickname':'test'},dict(data,location='新地点'))
            self.assertIn('只查询不推送',self.answer('活动',event_id))
            self.assertIn('新地点',self.answer('活动',event_id))
            with storage.connect(self.path) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM bot_outbox').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT bot_enabled FROM events WHERE id=?',(event_id,)).fetchone()[0],0)

    def test_bad_or_missing_id_never_falls_back_to_a_different_event(self):
        for argument in ('deadbeefdeadbeef','%','abc','a_b11111'):
            self.assertNotIn('唱K活动', self.answer('活动',argument))

    def test_multiple_events_are_listed_without_silently_picking_one(self):
        with storage.connect(self.path) as db:
            e = db.execute('SELECT * FROM events WHERE id=?',(self.event_id,)).fetchone()
            second = events.create(db,{'id':'u1','nickname':'私密昵称'},
                dict(title='另一个活动',category='聚餐',location='餐厅',starts_at=e['starts_at'],
                     deadline=e['deadline'],capacity=0,description='',duration_hours=2,bot_enabled=False))
        text=self.answer('报名')
        self.assertIn('请选择活动',text)
        self.assertIn(self.event_id,text)
        self.assertIn(second,text)
        self.assertIn('action=join',text)

    def test_colliding_short_codes_request_a_full_id(self):
        with storage.connect(self.path) as db:
            e = db.execute('SELECT * FROM events WHERE id=?',(self.event_id,)).fetchone()
            for suffix in ('aaaaaaaa','bbbbbbbb'):
                with mock.patch('qgroup_core.events.secrets.token_hex',return_value='12345678'+suffix):
                    events.create(db,{'id':'u1','nickname':'test'},dict(title='collision',category='聚餐',
                        location='test',starts_at=e['starts_at'],deadline=e['deadline'],capacity=0,
                        description='',duration_hours=1,bot_enabled=True,join_owner=False))
        self.assertIn('不唯一',self.answer('活动','12345678'))

    def test_finished_events_are_available_to_settlement_queries(self):
        with storage.connect(self.path) as db:
            db.execute("UPDATE events SET lifecycle='ended',actual_ended_at=?,bot_enabled=0",(now(),))
        self.assertIn('唱K活动',self.answer('结算'))
        self.assertIn('尚未发布',self.answer('结算'))
        self.assertIn('唱K活动',self.answer('往期'))

    def test_attendance_uses_the_same_states_as_the_website(self):
        from qgroup_core import roster
        with storage.connect(self.path) as db:
            e=db.execute('SELECT * FROM events WHERE id=?',(self.event_id,)).fetchone()
            roster.add_party(db,e,{'id':'u1','nickname':'test'},
                {'people':[{'is_self':True}]},require_preview=False)
            db.execute("UPDATE events SET lifecycle='ongoing'")
            db.execute("UPDATE attendees SET attendance='present'")
        text=self.answer('出席')
        self.assertIn('到场 1 人',text)
        self.assertIn('尚未替你登记',text)

    def test_shortcut_links_do_not_claim_that_a_write_has_happened(self):
        self.assertIn('尚未替你占位',self.answer('报名'))
        self.assertIn('尚未登记',self.answer('已付款'))
        self.assertIn('action=report',self.answer('申报'))
        self.assertIn('action=mine',self.answer('我的'))

    def test_passive_and_interaction_replies_respect_dry_run_and_group_scope(self):
        from types import SimpleNamespace
        for dry_run, group in ((True,'allowed'),(False,'other')):
            config=SimpleNamespace(db=self.path,group='allowed',dry_run=dry_run,sandbox=False,verbose_events=False)
            bot=Bot(config)
            bot.api.reply_group=mock.Mock(return_value=(True,0,{}))
            for event_type in ('GROUP_AT_MESSAGE_CREATE','INTERACTION_CREATE'):
                payload={'id':event_type,'group_openid':group,'content':'/活動',
                         'data':{'resolved':{'button_data':'/名額 '+self.event_id}}}
                asyncio.run(bot.handle_dispatch(None,{'t':event_type,'d':payload}))
            bot.api.reply_group.assert_not_called()

    def test_live_passive_reply_uses_the_traditional_command_and_card_event(self):
        from types import SimpleNamespace
        with storage.connect(self.path) as db:
            db.execute('UPDATE events SET bot_enabled=0 WHERE id=?',(self.event_id,))
        config=SimpleNamespace(db=self.path,group='allowed',dry_run=False,sandbox=False,verbose_events=False)
        bot=Bot(config);bot.api.reply_group=mock.Mock(return_value=(True,0,{}))
        asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_AT_MESSAGE_CREATE','d':
            {'id':'message','group_openid':'allowed','content':'/名額 '+self.event_id}}))
        self.assertIn('正式 0 人',bot.api.reply_group.call_args.args[1])

    def test_mention_diagnostics_record_everyone_flag_without_chat_text(self):
        from types import SimpleNamespace
        config=SimpleNamespace(db=self.path,group='allowed',dry_run=False,sandbox=False,verbose_events=False)
        bot=Bot(config);bot.api.reply_group=mock.Mock(return_value=(True,0,{}))
        with self.assertLogs(level='INFO') as logs:
            asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_MESSAGE_CREATE','d':
                {'id':'private-message-id','group_openid':'allowed','content':'不要记录这段群聊正文',
                 'mention_everyone':True,'mentions':[]}}))
        logged='\n'.join(logs.output)
        self.assertIn('"mention_everyone":"true"',logged)
        self.assertIn('"reason":"not_addressed"',logged)
        self.assertNotIn('不要记录这段群聊正文',logged)
        self.assertNotIn('private-message-id',logged)
        bot.api.reply_group.assert_not_called()

    def test_successful_reply_and_missing_everyone_flag_are_visible_in_info_logs(self):
        from types import SimpleNamespace
        config=SimpleNamespace(db=self.path,group='allowed',dry_run=False,sandbox=False,verbose_events=True)
        bot=Bot(config);bot.api.reply_group=mock.Mock(return_value=(True,0,{}))
        with self.assertLogs(level='INFO') as logs:
            asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_MESSAGE_CREATE','d':
                {'id':'message','group_openid':'allowed','content':'/名額 '+self.event_id,
                 'mentions':[{'is_you':True,'id':'private-member-id'}]}}))
        logged='\n'.join(logs.output)
        self.assertIn('"mentions_bot":true,"mention_everyone":"missing"',logged)
        self.assertIn('"event":"reply_sent"',logged)
        self.assertIn('"command":"名额"',logged)
        self.assertNotIn(self.event_id,logged)
        self.assertNotIn('private-member-id',logged)


if __name__ == '__main__':
    unittest.main()
