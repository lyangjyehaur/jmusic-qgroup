"""Quoted shorthand routing, with isolated storage and simulated upstream/QQ."""
import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from qgroup_bot.abbreviation_input import extract_argument, quoted_texts
from qgroup_bot.abbreviations import AbbreviationLookup, USAGE
from qgroup_bot.main import Bot, group_command
from qgroup_core import bot_settings, storage


class InputTests(unittest.TestCase):
    def test_sentence_keeps_only_complete_letter_containing_tokens(self):
        self.assertEqual(extract_argument(['这个YYDS啊，真的awsl！YYDS，3q，2026，a，user_name，'+'z'*33]),
                         'yyds,awsl,3q')

    def test_links_emails_mentions_and_numbers_are_not_queried(self):
        text = ('yyds https://example.test/awsl www.example.org/abc foo@example.com '
                'example.net/xyz <@BOT1> <qqbot-at-user id="BOT2" /> @alice 12345 nbnhhsh')
        self.assertEqual(extract_argument([text]), 'yyds,nbnhhsh')

    def test_terms_are_not_silently_discarded_after_the_fifth(self):
        self.assertEqual(extract_argument(['aa bb cc dd ee ff']), 'aa,bb,cc,dd,ee,ff')

    def test_documented_quote_wrapper_and_nested_elements(self):
        payload = {'message_type':103, 'message_scene':{'ext':['ref_msg_idx=ref']},
                   'msg_elements':[{'content':'今天YYDS', 'msg_elements':[
                       {'content':'真的awsl'}, None, {'attachments':[{'url':'https://private.test'}]}]}]}
        self.assertEqual(quoted_texts(payload), ['今天YYDS','真的awsl'])
        self.assertEqual(group_command(payload), ('缩写','yyds,awsl'))

    def test_reference_selects_only_the_requested_index(self):
        payload = {'message_scene':{'ext':['ref_msg_idx=chosen']}, 'msg_elements':[
            {'msg_idx':'other','content':'privateword'}, {'msg_idx':'chosen','content':'YYDS'}]}
        self.assertEqual(group_command(payload), ('缩写','yyds'))
        payload['message_scene']['ext'] = ['ref_msg_idx=missing']
        self.assertEqual(group_command(payload), ('缩写',''))

    def test_missing_and_malformed_quote_content_is_not_invented(self):
        for elements in (None, 'yyds', [None,42,{'content':42,'msg_idx':{}}]):
            with self.subTest(elements=elements):
                self.assertEqual(group_command({'message_type':103,'msg_elements':elements}), ('缩写',''))
        self.assertEqual(group_command({'msg_elements':[{'content':'yyds'}]}), ('活动',''))

    def test_explicit_commands_override_quote_and_continuations_keep_their_token(self):
        payload={'message_type':103,'msg_elements':[{'content':'yyds'}]}
        for text,expected in (('/帮助',('帮助','')),('/縮寫 这也太awsl了',('缩写','awsl')),
                              ('/縮寫 今天yyds\n真的awsl',('缩写','yyds,awsl')),
                              ('/缩写 继续 '+'a'*24,('缩写','继续 '+'a'*24)),
                              ('/缩写',('缩写','yyds')),('/unknown', (None,''))):
            self.assertEqual(group_command(dict(payload,content=text)),expected)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.db=Path(self.temporary.name)/'bot.sqlite3'
        storage.initialize(self.db)
        self.environment=mock.patch.dict(os.environ,{'KANBAN_BOT_BASE_URL':'https://example.test'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.bot=Bot(SimpleNamespace(db=self.db,group='allowed',dry_run=False,
                                    sandbox=False,verbose_events=True,log_content=True))
        self.bot.bot_id='BOT1'
        self.bot.api.reply_group=mock.Mock(return_value=(True,0,{}))

    def payload(self, **changes):
        return {'id':'quote','group_openid':'allowed','content':'<@BOT1>',
                'mentions':[{'id':'BOT1'}], 'message_type':103,
                'msg_elements':[{'content':'今天真是YYDS，這也太awsl了。秘密原文不要記錄'}],
                **changes}

    def dispatch(self,payload,event='GROUP_AT_MESSAGE_CREATE'):
        return asyncio.run(self.bot.handle_dispatch(None,{'t':event,'d':payload}))

    def test_both_group_events_lookup_extracted_terms_with_masking_and_no_quote_logging(self):
        for event in ('GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE'):
            with self.subTest(event=event), \
                    mock.patch('qgroup_bot.replies.abbreviation_lookup', AbbreviationLookup()), \
                    mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen', return_value=io.BytesIO(
                        json.dumps([{'name':'yyds','trans':['正常释义','傻逼']}]).encode())) as upstream, \
                    self.assertLogs('qgroup_bot.events',level='INFO') as logs:
                self.dispatch(self.payload(id=event),event)
                request=upstream.call_args.args[0]
                self.assertEqual(json.loads(request.data),{'text':'yyds,awsl'})
                self.assertIn('正常释义、[已遮蔽]',self.bot.api.reply_group.call_args.args[1])
                self.assertEqual(self.bot.api.reply_group.call_args.kwargs['msg_id'],event)
                self.assertNotIn('秘密原文不要記錄','\n'.join(logs.output))

    def test_explicit_sentence_uses_the_same_extraction(self):
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer',return_value='正常释义') as lookup:
            self.dispatch(self.payload(content='/縮寫 这个YYDS啊，真的awsl！ https://example.test'))
            lookup.assert_called_once_with('yyds,awsl')

    def test_no_letters_missing_quote_and_too_many_terms_never_call_upstream(self):
        for index,elements in enumerate((None,[{'content':'只有中文和12345'}],
                                        [{'content':'aa bb cc dd ee ff'}])):
            with mock.patch('qgroup_bot.replies.abbreviation_lookup',AbbreviationLookup()), \
                    mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen') as upstream:
                self.dispatch(self.payload(id=str(index),msg_elements=elements))
                upstream.assert_not_called()
                self.assertEqual(self.bot.api.reply_group.call_args.args[1],USAGE)

    def test_quote_never_executes_an_embedded_command(self):
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer',return_value=USAGE) as lookup:
            self.dispatch(self.payload(msg_elements=[{'content':'/退出'}]))
            lookup.assert_called_once_with('')

    def test_group_direct_mention_everyone_and_reply_policy_still_apply(self):
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer') as lookup:
            for changes in ({'group_openid':'other'}, {'content':'','mentions':[]},
                            {'mention_everyone':True}, {'content':'<@all> <@BOT1>'}):
                self.dispatch(self.payload(**changes))
            with storage.connect(self.db) as db:
                current=bot_settings.read(db)
                bot_settings.save(db,dict(base_revision=current['revision'],
                    config=dict(current['config'],replies_enabled=False)),'admin')
            self.dispatch(self.payload(id='disabled'))
            lookup.assert_not_called()
        self.bot.api.reply_group.assert_not_called()

    def test_dry_run_does_not_send_qq(self):
        self.bot.config.dry_run=True
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer',return_value='正常释义'):
            self.dispatch(self.payload())
        self.bot.api.reply_group.assert_not_called()

    def test_quote_lookup_is_a_background_job_and_plain_at_still_lists_activities(self):
        event={'t':'GROUP_AT_MESSAGE_CREATE','d':self.payload()}
        self.assertTrue(self.bot._abbreviation_dispatch(event))
        event['d']['content']='/帮助'
        self.assertFalse(self.bot._abbreviation_dispatch(event))
        self.assertFalse(self.bot._abbreviation_dispatch({'t':'GROUP_AT_MESSAGE_CREATE',
                                                         'd':{'content':'<@BOT1>'}}))
        self.assertEqual(group_command({'content':'<@BOT1>'}),('活动',''))

    def test_distinct_quotes_at_the_same_time_are_not_duplicates_but_dual_events_are(self):
        with mock.patch('qgroup_bot.replies.abbreviation_lookup.answer',return_value='正常释义') as lookup:
            first=self.payload(timestamp='2026-11-13T12:00:00Z')
            self.dispatch(first)
            self.dispatch(dict(first,id='dual'), 'GROUP_MESSAGE_CREATE')
            self.dispatch(dict(first,id='other',msg_elements=[{'content':'awsl'}]))
            self.assertEqual(lookup.call_count,2)


if __name__ == '__main__':
    unittest.main()
