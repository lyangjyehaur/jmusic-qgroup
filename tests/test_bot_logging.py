"""Debugging must retain causality across async HTTP, retries and container recreation."""
import asyncio
import io
import json
import logging
import os
import sqlite3
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from qgroup_bot import observability as obs
from qgroup_bot.api import QQBotAPI
from qgroup_bot.config import Config
from qgroup_bot.main import Bot, union_diagnostics
from qgroup_bot.worker import OutboxWorker
from qgroup_core import storage
from test_bot_outbox import BotOutboxFixture


def records(captured):
    return [json.loads(record.getMessage()) for record in captured.records]


class LogTests(unittest.TestCase):
    def test_text_is_metadata_by_default_and_opt_in_is_bounded_and_redacted(self):
        text='私密称呼 https://example.test/?account_link=secret-link <@member> '+\
             'QQBot access-secret clientSecret=fixed-secret {"access_token":"json-secret"} '
        default=obs.text_fields(text,SimpleNamespace())
        self.assertNotIn('text_preview',default)
        self.assertEqual(default['text_chars'],len(text))
        self.assertEqual(default['text_hash'],obs.reference(text))
        content=obs.text_fields(text*30,SimpleNamespace(log_content=True,log_content_limit=200,app_secret='fixed-secret'))
        preview=content['text_preview']
        self.assertLessEqual(len(preview),200)
        self.assertTrue(content['text_truncated'])
        for value in ('secret-link','<@member>','access-secret','fixed-secret','json-secret'):
            self.assertNotIn(value,preview)

    def test_context_restores_and_does_not_cross_async_tasks(self):
        async def work(label):
            with obs.scope(trace_id=label):
                await asyncio.sleep(0)
                await asyncio.to_thread(obs.event,'thread_result')
                self.assertEqual(obs.trace_id(),label)
        async def run():
            await asyncio.gather(work('first'),work('second'))
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            asyncio.run(run())
        self.assertEqual({r['trace_id'] for r in records(captured)},{'first','second'})
        self.assertNotIn(obs.trace_id(),('first','second'))

    def test_http_auth_retry_has_one_trace_without_request_bodies_or_raw_targets(self):
        config=SimpleNamespace(sandbox=False,app_id='app',app_secret='private-app-secret')
        api=QQBotAPI(config);api._token='private-token';api._token_expiry=time.time()+1000
        api.http_json=mock.Mock(side_effect=[(401,{'code':11241,'raw':'private-token'}),
            (200,{'access_token':'refreshed-private-token'}),(200,{'id':'platform-message-id'})])
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            ok,_,_=api.post('/v2/groups/private-group/messages',{'content':'private body'})
        self.assertTrue(ok)
        rows=records(captured);results=[r for r in rows if r['event']=='api_result']
        self.assertEqual([r['http_status'] for r in results],[401,200])
        self.assertEqual([r['api_attempt'] for r in results],[1,2])
        self.assertEqual(len({r['trace_id'] for r in rows}),1)
        self.assertEqual(results[-1]['sent_ref'],obs.reference('platform-message-id'))
        logged='\n'.join(captured.output)
        for secret in ('private-group','private-token','private-app-secret','refreshed-private-token','private body'):
            self.assertNotIn(secret,logged)

    def test_token_failure_does_not_echo_response_credentials(self):
        api=QQBotAPI(SimpleNamespace(sandbox=False,app_id='app',app_secret='private-secret'))
        api.http_json=mock.Mock(return_value=(400,{'code':123,'clientSecret':'echoed-secret'}))
        with self.assertLogs(obs.LOGGER,level='WARNING') as captured:
            with self.assertRaises(RuntimeError) as error:
                api.token()
        self.assertNotIn('echoed-secret',str(error.exception)+'\n'.join(captured.output))


class PersistentLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.config=SimpleNamespace(log_dir=Path(self.tmp.name)/'bot-logs',log_content=False)
        self.previous=(list(obs.LOGGER.handlers),obs.LOGGER.level,obs.LOGGER.propagate)
        self.addCleanup(self.restore_logger)
        self.stderr=mock.patch('sys.stderr',io.StringIO());self.stderr.start();self.addCleanup(self.stderr.stop)

    def restore_logger(self):
        for handler in list(obs.LOGGER.handlers):
            handler.close();obs.LOGGER.removeHandler(handler)
        handlers,level,propagate=self.previous
        obs.LOGGER.handlers=handlers;obs.LOGGER.setLevel(level);obs.LOGGER.propagate=propagate

    def test_reopening_log_after_process_recreation_keeps_prior_events(self):
        obs.configure(self.config);obs.event('before_recreate',trace_id='before')
        obs.configure(self.config);obs.event('after_recreate',trace_id='after')
        rows=[json.loads(line) for line in (self.config.log_dir/'bot-events.jsonl').read_text().splitlines()]
        self.assertEqual([r['event'] for r in rows],['logging_ready','before_recreate','logging_ready','after_recreate'])
        self.assertTrue(rows[0]['persistent'])
        self.assertTrue(rows[-1]['ts'].endswith('+00:00'))

    def test_rotation_is_bounded_and_files_remain_private(self):
        obs.configure(self.config)
        file_handler=next(h for h in obs.LOGGER.handlers if isinstance(h,obs.PrivateRotatingHandler))
        file_handler.maxBytes=600
        for i in range(30):obs.event('rotation_example',trace_id=str(i),data='x'*150)
        paths=list(self.config.log_dir.glob('bot-events.jsonl*'))
        self.assertEqual(len(paths),5)
        for path in paths:
            self.assertEqual(path.stat().st_mode&0o077,0)
            for line in path.read_text().splitlines():self.assertIsInstance(json.loads(line),dict)

    def test_unwritable_storage_reports_failure_and_keeps_console_logging(self):
        self.config.log_dir.write_text('blocking file')
        obs.configure(self.config)
        stream=next(h for h in obs.LOGGER.handlers if not isinstance(h,obs.PrivateRotatingHandler)).stream
        rows=[json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(rows[0]['event'],'log_storage_unavailable')
        self.assertFalse(rows[-1]['persistent'])


class DeliveryLogTests(BotOutboxFixture,unittest.TestCase):
    def bot(self,dry_run=False):
        config=SimpleNamespace(db=self.path,group='allowed',dry_run=dry_run,sandbox=False,verbose_events=False)
        return Bot(config)

    def test_passive_http_send_can_be_traced_back_to_one_input(self):
        bot=self.bot();bot.api._token='private-access-token';bot.api._token_expiry=time.time()+1000
        bot.api.http_json=mock.Mock(return_value=(200,{'id':'sent-message'}))
        payload={'id':'incoming-message','group_openid':'allowed','content':'/帮助',
                 'author':{'member_openid':'private-member'},'mentions':[{'is_you':True}]}
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_MESSAGE_CREATE','d':payload}))
        rows=records(captured)
        self.assertEqual([r['event'] for r in rows],['message_received','command_parsed','reply_prepared',
                         'reply_sending','api_request','api_result','reply_sent'])
        self.assertEqual(len({r['trace_id'] for r in rows}),1)
        self.assertTrue(all(r['input_ref']==obs.reference('incoming-message') for r in rows))
        self.assertEqual(rows[-1]['sent_ref'],obs.reference('sent-message'))
        for value in ('private-access-token','private-member','incoming-message'):
            self.assertNotIn(value,'\n'.join(captured.output))

    def test_failed_reply_retains_trace_and_safe_stack(self):
        bot=self.bot();bot.api.reply_group=mock.Mock(side_effect=RuntimeError('do-not-log-secret'))
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_AT_MESSAGE_CREATE','d':
                {'id':'input','group_openid':'allowed','content':'/帮助'}}))
        rows=records(captured)
        self.assertEqual(rows[-1]['event'],'reply_failed')
        self.assertEqual(rows[-1]['error_type'],'RuntimeError')
        self.assertTrue(rows[-1]['stack'])
        self.assertEqual(len({r['trace_id'] for r in rows}),1)
        self.assertNotIn('do-not-log-secret','\n'.join(captured.output))

    def test_simulation_and_duplicate_are_distinct_from_real_sends(self):
        bot=self.bot(dry_run=True);bot.api.reply_group=mock.Mock()
        payload={'id':'same-input','group_openid':'allowed','content':'/帮助'}
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            for _ in range(2):asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_AT_MESSAGE_CREATE','d':payload}))
        rows=records(captured)
        self.assertEqual(sum(r['event']=='reply_simulated' for r in rows),1)
        self.assertFalse(any(r['event']=='reply_sent' for r in rows))
        self.assertEqual(rows[-1]['reason'],'duplicate')
        self.assertEqual(len({r['input_ref'] for r in rows}),1)
        bot.api.reply_group.assert_not_called()

    def test_outbox_failure_and_retry_log_both_attempts_and_receipt(self):
        self.create_event()
        with mock.patch.dict(os.environ,{'KANBAN_BOT_DRY_RUN':'0'}):config=Config()
        api=mock.Mock();api.post.side_effect=[RuntimeError('token-secret'),(True,0,{'id':'sent-message'})]
        worker=OutboxWorker(config,api)
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            worker.poll_once()
            row=next(r for r in self.rows() if r['kind']=='activity_published')
            with mock.patch('qgroup_bot.worker.now',return_value=row['retry_at']):worker.poll_once()
        rows=records(captured)
        self.assertTrue(all(r['outbox_id']==row['id'] for r in rows))
        retry=next(r for r in rows if r['event']=='outbox_retry_scheduled')
        sent=next(r for r in rows if r['event']=='outbox_sent')
        self.assertEqual((retry['attempt'],sent['attempt']),(1,2))
        self.assertNotEqual(retry['trace_id'],sent['trace_id'])
        self.assertEqual(sent['sent_ref'],obs.reference('sent-message'))
        self.assertNotIn('token-secret','\n'.join(captured.output))


class UnionIdObservationTests(BotOutboxFixture,unittest.TestCase):
    """The binding is platform-side; the bot can only observe what QQ supplies."""
    def bot(self):
        return Bot(SimpleNamespace(db=self.path,group='allowed',dry_run=True,
                                   sandbox=False,verbose_events=False))

    def received(self,author):
        bot=self.bot()
        payload={'id':'union-input','group_openid':'allowed','content':'/帮助',
                 'author':author,'mentions':[{'is_you':True}]}
        with self.assertLogs(obs.LOGGER,level='INFO') as captured:
            asyncio.run(bot.handle_dispatch(None,{'t':'GROUP_AT_MESSAGE_CREATE','d':payload}))
        rows=records(captured)
        return (next(r for r in rows if r['event']=='message_received'),
                [r['event'] for r in rows],'\n'.join(captured.output))

    def test_absent_union_openid_is_a_platform_state_not_a_failure(self):
        row,events,_=self.received({'member_openid':'private-member'})
        self.assertFalse(row['union_openid_present'])
        self.assertEqual(row['union_openid_len'],0)
        self.assertFalse(row['union_user_account_present'])
        self.assertNotIn('union_openid_ref',row)
        self.assertNotIn('unionid_matches_site',row)
        self.assertIn('reply_simulated',events)

    def test_present_union_openid_is_compared_without_exposing_its_value(self):
        with storage.connect(self.path) as db:
            db.execute("INSERT INTO external_identities VALUES('qq','1906357065','openid-x','u1','nick','2026-11-10T00:00:00+00:00')")
            db.execute("INSERT INTO external_unionids VALUES('qq','1906357065','openid-x','SITE-UNION-SECRET','2026-11-10T00:00:00+00:00')")
        row,_,output=self.received({'member_openid':'private-member',
                                    'union_openid':'SITE-UNION-SECRET',
                                    'union_user_account':'qq-account'})
        self.assertTrue(row['union_openid_present'])
        self.assertEqual(row['union_openid_len'],len('SITE-UNION-SECRET'))
        self.assertTrue(row['union_user_account_present'])
        self.assertEqual(row['union_openid_ref'],obs.reference('SITE-UNION-SECRET'))
        self.assertTrue(row['unionid_matches_site'])
        self.assertNotIn('SITE-UNION-SECRET',output)
        self.assertNotIn('qq-account',output)
        mismatch,_,mismatch_output=self.received({'union_openid':'OTHER-UNION-SECRET'})
        self.assertTrue(mismatch['union_openid_present'])
        self.assertFalse(mismatch['unionid_matches_site'])
        self.assertNotIn('OTHER-UNION-SECRET',mismatch_output)

    def test_unavailable_schema_is_reported_without_raising(self):
        with mock.patch('qgroup_bot.main.read_db',
                        side_effect=sqlite3.OperationalError('no such table: external_unionids')):
            fields=union_diagnostics({'union_openid':'ANY-UNION-SECRET'},
                                     SimpleNamespace(db=Path('/unused')))
        self.assertTrue(fields['union_openid_present'])
        self.assertEqual(fields['unionid_lookup'],'unavailable')
        self.assertEqual(fields['unionid_lookup_error'],'OperationalError')
        self.assertNotIn('unionid_matches_site',fields)
        self.assertNotIn('ANY-UNION-SECRET',json.dumps(fields))


if __name__=='__main__':unittest.main()
