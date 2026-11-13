"""QQ rejection, continuation and failure semantics; no real QQ delivery."""
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

from qgroup_bot.abbreviation_delivery import AbbreviationDelivery, Page, TTL
from qgroup_bot.abbreviation_text import AbbreviationText, mask_text
from qgroup_bot.abbreviations import _render
from qgroup_bot.sensitive_words import WordMask


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'results'
        self.delivery = AbbreviationDelivery(self.root, page_bytes=200)
        self.api = mock.Mock()
        self.accepted, self.notices = [], []

        def post(group, text, **kwargs):
            if len(text.encode('utf-8')) > 220:
                return False, 40054007, {}
            if '/缩写 继续 ' in text:
                self.notices.append(text)
            else:
                self.accepted.append(text)
            return True, 0, {}
        self.api.reply_group.side_effect = post

    def token(self):
        return re.search(r'/缩写 继续 ([0-9a-f]{24})', self.notices[-1]).group(1)

    def test_full_result_survives_multiple_passive_windows_and_restart(self):
        text = '【缩写查询】\naa：'+('释义甲、释义乙、释义甲。'*80)+'🙂末尾'
        self.assertTrue(self.delivery.send(self.api, 'group', Page(text), msg_id='first')[0])
        self.assertLessEqual(self.api.reply_group.call_count, 5)
        token = self.token()
        self.assertEqual([c.kwargs['seq'] for c in self.api.reply_group.call_args_list], [1,2,3,4,5])
        self.delivery = AbbreviationDelivery(self.root, page_bytes=200)
        rounds = 0
        while list(self.root.glob('*.txt')):
            self.api.reply_group.reset_mock()
            page = self.delivery.continuation('group', '继续 '+token)
            self.assertTrue(page.token)
            self.delivery.send(self.api, 'group', page, msg_id='next%d' % rounds)
            self.assertLessEqual(self.api.reply_group.call_count, 5)
            rounds += 1
            self.assertLess(rounds, 30)
        self.assertEqual(''.join(self.accepted), text)
        self.assertFalse(list(self.root.glob('*.json')))

    def test_complete_response_is_tried_before_any_transport_segmentation(self):
        self.api.reply_group.side_effect = None
        self.api.reply_group.return_value = True, 0, {}
        text = '完整结果'*3000
        self.delivery.send(self.api, 'group', Page(text), msg_id='one')
        self.api.reply_group.assert_called_once_with('group', text, seq=1, msg_id='one', event_id=None)
        self.assertFalse(self.root.exists())

    def test_explicit_length_rejection_adapts_the_segment_budget(self):
        self.delivery = AbbreviationDelivery(self.root, page_bytes=1000)
        text = '长'*900
        self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        token = self.token()
        meta = json.loads((self.root/(token+'.json')).read_text())
        self.assertLess(meta['budget'], 1000)
        self.assertLessEqual(self.api.reply_group.call_count, 5)
        for index in range(12):
            if not list(self.root.glob('*.txt')):
                break
            self.delivery.send(self.api, 'group', self.delivery.continuation('group', '继续 '+token),
                               msg_id='next%d' % index)
        self.assertEqual(''.join(self.accepted), text)

    def test_unconfirmed_send_is_not_automatically_replayed(self):
        self.api.reply_group.side_effect = [(False, None, {'_unconfirmed_http':202}), (True,0,{})]
        text = '正常释义'
        result = self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        self.assertFalse(result[0])
        self.assertEqual(self.api.reply_group.call_count, 2)
        self.assertEqual(self.api.reply_group.call_args_list[0].args[1], text)
        notice = self.api.reply_group.call_args_list[1].args[1]
        self.assertIn('未自动重发', notice)
        token = re.search(r'([0-9a-f]{24})$', notice).group(1)
        self.assertEqual(self.delivery.continuation('group', '继续 '+token).text, text)

    def test_rejected_middle_segment_remains_first_in_the_continuation(self):
        text = '长'*400
        self.api.reply_group.side_effect = [(False,40054007,{}), (True,0,{}),
                                            (False,304061,{}), (True,0,{})]
        self.assertFalse(self.delivery.send(self.api, 'group', Page(text), msg_id='first')[0])
        calls = self.api.reply_group.call_args_list
        token = re.search(r'([0-9a-f]{24})$', calls[-1].args[1]).group(1)
        accepted = calls[1].args[1]
        self.assertEqual(self.delivery.continuation('group', '继续 '+token).text, text[len(accepted):])
        self.assertIn('未跳过该段', calls[-1].args[1])

    def test_continuation_checks_group_expiry_and_token_format(self):
        self.delivery.send(self.api, 'group', Page('长'*500), msg_id='first')
        token = self.token()
        self.assertFalse(self.delivery.continuation('other', '继续 '+token).token)
        meta = json.loads((self.root/(token+'.json')).read_text())
        with mock.patch('qgroup_bot.abbreviation_delivery.time.time', return_value=meta['created']+TTL+1):
            self.assertFalse(self.delivery.continuation('group', '继续 '+token).token)
        self.assertFalse(self.delivery.continuation('group', '继续 ../../etc/passwd').token)
        self.assertIsNone(self.delivery.continuation('group', 'yyds'))
        for path in self.root.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_pending_output_uses_updated_rules_before_another_send(self):
        text = '长'*500+'新规则词'
        self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        token = self.token()
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['新规则词'])):
            page = self.delivery.continuation('group', '继续 '+token)
        self.assertIn('[已遮蔽]', page.text)
        self.assertNotIn('新规则词', page.text)

    def test_storage_failure_reports_an_error_without_truncating_the_result(self):
        self.api.reply_group.side_effect = [(False,40054007,{}), (True,0,{})]
        with mock.patch.object(self.delivery, '_create', side_effect=OSError('private detail')):
            self.assertFalse(self.delivery.send(self.api,'group',Page('长'*500),msg_id='first')[0])
        self.assertIn('无法保存完整', self.api.reply_group.call_args.args[1])
        self.assertNotIn('private detail', self.api.reply_group.call_args.args[1])

    def test_event_reply_uses_a_message_continuation_instead_of_reusing_sequence(self):
        self.delivery.send(self.api, 'group', Page('长'*500), event_id='interaction')
        self.assertEqual(self.api.reply_group.call_count, 2)
        self.assertTrue(self.delivery.continuation('group', '继续 '+self.token()).token)

    def test_fresh_reply_rechecks_rules_after_waiting_to_send(self):
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['新规则词'])):
            self.delivery.send(self.api, 'group', Page('新规则词'), msg_id='first')
        self.assertEqual(self.accepted, ['[已遮蔽]'])

    def test_fresh_reply_preserves_rendered_boundaries_when_rules_change(self):
        with mock.patch('qgroup_bot.abbreviations.load_mask', return_value=WordMask([])):
            text = _render([{'name': 'slg', 'trans': ['水灵根', 'g水']}], ['slg'])
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['g水'])):
            self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        self.assertIn('slg：水灵根、[已遮蔽]\n', self.accepted[0])

    def test_long_result_keeps_boundaries_across_rule_edits_and_restart(self):
        text = AbbreviationText(['长'*500+'\n', 'slg', '：', '水灵根、正常释义、'*80])
        self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        token = self.token()
        self.delivery = AbbreviationDelivery(self.root, page_bytes=200)
        mask = WordMask(['g水', '正常释义'])
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=mask):
            for index in range(40):
                if not list(self.root.glob('*.txt')):
                    break
                page = self.delivery.continuation('group', '继续 '+token)
                self.assertTrue(page.token)
                self.delivery.send(self.api, 'group', page, msg_id='next%d' % index)
        self.assertFalse(list(self.root.glob('*.txt')))
        self.assertEqual(''.join(self.accepted), mask_text(text, mask))
        self.assertIn('slg：水灵根', ''.join(self.accepted))

    def test_cursor_inside_header_retains_boundary_after_body_rewrite(self):
        token, meta = self.delivery._create('group', AbbreviationText(['slg', '：', '水灵根、g水']))
        meta['offset'] = 2  # The next page starts at the g in slg.
        self.delivery._save_meta(token, meta)
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['g水'])):
            self.assertEqual(self.delivery.continuation('group', '继续 '+token).text,
                             'g：水灵根、[已遮蔽]')
            self.delivery = AbbreviationDelivery(self.root)
            self.delivery.send(self.api, 'group', self.delivery.continuation('group', '继续 '+token),
                               msg_id='next')
        self.assertEqual(''.join(self.accepted), 'g：水灵根、[已遮蔽]')

    def test_legacy_pending_result_without_boundaries_still_rechecks_rules(self):
        token, _ = self.delivery._create('group', '新规则词')
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['新规则词'])):
            self.assertEqual(self.delivery.continuation('group', '继续 '+token).text, '[已遮蔽]')

    def test_corrupt_boundaries_do_not_return_unchecked_pending_text(self):
        token, meta = self.delivery._create('group', AbbreviationText(['slg', '：', '水灵根']))
        for ends in ([], [1], [3, 2, 15], ['bad', 15]):
            meta['section_ends'] = ends
            self.delivery._save_meta(token, meta)
            page = self.delivery.continuation('group', '继续 '+token)
            self.assertFalse(page.token)
            self.assertNotIn('水灵根', page.text)

    def test_stale_continuation_snapshot_does_not_replay_acknowledged_content(self):
        text = '长'*1000
        self.delivery.send(self.api, 'group', Page(text), msg_id='first')
        token = self.token()
        first = self.delivery.continuation('group', '继续 '+token)
        stale = self.delivery.continuation('group', '继续 '+token)
        self.delivery.send(self.api, 'group', first, msg_id='second')
        self.delivery.send(self.api, 'group', stale, msg_id='third')
        self.assertEqual(''.join(self.accepted)+self.delivery.continuation('group', '继续 '+token).text, text)

    def test_rule_update_publish_failure_keeps_the_old_body_and_cursor(self):
        self.delivery.send(self.api, 'group', Page('长'*500+'新规则词'), msg_id='first')
        token = self.token()
        metadata = self.root/(token+'.json')
        before = metadata.read_bytes()
        body = self.root/(token+'.txt')
        original = body.read_bytes()
        with mock.patch('qgroup_bot.abbreviation_delivery.load_mask', return_value=WordMask(['新规则词'])):
            with mock.patch.object(self.delivery, '_save_meta', side_effect=OSError('cannot publish')):
                self.assertFalse(self.delivery.continuation('group', '继续 '+token).token)
            self.assertEqual(metadata.read_bytes(), before)
            self.assertEqual(body.read_bytes(), original)
            self.assertIn('[已遮蔽]', self.delivery.continuation('group', '继续 '+token).text)


if __name__ == '__main__':
    unittest.main()
