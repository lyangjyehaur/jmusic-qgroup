"""Whole-term masking and reloads must not leak third-party explanations."""
import io
import json
import os
from pathlib import Path
import random
import tempfile
import unittest
from unittest import mock

from qgroup_bot.abbreviations import AbbreviationLookup, UNAVAILABLE
from qgroup_bot.sensitive_words import REPLACEMENT, WordMask, load_mask


class WordMaskTests(unittest.TestCase):
    def test_whole_term_is_replaced_without_exposing_characters(self):
        mask = WordMask(['敏感词', '敏感词句'])
        self.assertEqual(mask.mask('前文敏感词句，后文敏感词。'),
                         '前文'+REPLACEMENT+'，后文'+REPLACEMENT+'。')

    def test_spacing_punctuation_zero_width_and_fullwidth_variants(self):
        mask = WordMask(['测试词', 'fuck'])
        for value in ('测 试 词', '测*试*词', '测\u200b试\u200d词',
                      'ＦｕＣＫ', 'f.u.c.k', 'f\u2060u\u2060ck'):
            with self.subTest(value=value):
                self.assertEqual(mask.mask(value), REPLACEMENT)

    def test_normal_text_punctuation_and_length_are_preserved(self):
        text = '永远的神，音乐大师（同一个缩写可能有不同含义）。'+'完整释义'*100
        self.assertEqual(WordMask(['测试词']).mask(text), text)
        self.assertEqual(WordMask([]).mask(text), text)

    def test_default_rules_cover_explicit_terms_in_both_scripts(self):
        with mock.patch.dict(os.environ, {'KANBAN_BOT_SENSITIVE_WORDS_FILE': ''}):
            mask = load_mask()
        for value in ('傻逼', '腦殘', '脑残', '意淫', '鸡巴', '雞巴'):
            with self.subTest(value=value):
                self.assertEqual(mask.mask(value), REPLACEMENT)

    def test_invalid_word_lists_are_rejected(self):
        for words in ('test', [42], [''], ['***']):
            with self.subTest(words=words), self.assertRaises(ValueError):
                WordMask(words)

    def test_overlapping_terms_cover_the_entire_union(self):
        mask = WordMask(['甲乙', '乙丙', '乙丙丁'])
        self.assertEqual(mask.mask('前甲乙丙丁后甲乙'),
                         '前'+REPLACEMENT+'后'+REPLACEMENT)

    def test_fallback_suffix_and_adjacent_matches(self):
        mask = WordMask(['abcd', 'bce', 'ce', 'ef'])
        self.assertEqual(mask.mask('abce ef'), 'a'+REPLACEMENT+' '+REPLACEMENT)

    def test_casefold_expansions_preserve_original_offsets(self):
        self.assertEqual(WordMask(['s']).mask('前ß后'), '前'+REPLACEMENT+'后')
        self.assertEqual(WordMask(['ff']).mask('前ﬃ后'), '前'+REPLACEMENT+'后')

    def test_script_normalization_preserves_original_display(self):
        mask = WordMask(['测试词', '法轮功', '习近平'])
        for text in ('測試詞', '测試词', '法輪功', '習近\u200b平'):
            with self.subTest(text=text):
                self.assertEqual(mask.mask(text), REPLACEMENT)
        self.assertEqual(mask.mask('音樂大師，永遠的神。'), '音樂大師，永遠的神。')

    def test_assembled_matches_mask_each_candidate_without_losing_separators(self):
        mask = WordMask(['测试词'])
        self.assertEqual(mask.mask_parts(['前测试', '、', '词后', '\n', '测试词']),
                         '前'+REPLACEMENT+'、'+REPLACEMENT+'后\n'+REPLACEMENT)

    def test_allowed_expressions_only_exempt_contained_matches(self):
        mask = WordMask(['测试', '大测试词'], ['测试词'])
        self.assertEqual(mask.mask('测试词，测试，大测试词'),
                         '测试词，'+REPLACEMENT+'，'+REPLACEMENT)
        # Two overlapping exceptions do not allow a larger denied phrase.
        self.assertEqual(WordMask(['abcde'], ['abc', 'cde']).mask('abcde'), REPLACEMENT)

    def test_invalid_allow_list_is_rejected(self):
        for allowed in ('abc', ['***'], [None]):
            with self.subTest(allowed=allowed), self.assertRaises(ValueError):
                WordMask(['测试'], allowed)

    def test_invalid_bundled_dictionary_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bundled.json'
            with mock.patch('qgroup_bot.sensitive_words.DEFAULT_FILE', path), mock.patch.dict(
                    os.environ, {'KANBAN_BOT_SENSITIVE_WORDS_FILE': ''}):
                for data in ([], {'words': None}, {'words': ['测试'], 'allow_words': 'bad'}):
                    path.write_text(json.dumps(data))
                    with self.subTest(data=data), self.assertRaises(ValueError):
                        load_mask()

    def test_randomized_matches_agree_with_exhaustive_span_coverage(self):
        rng = random.Random(17)
        for _ in range(120):
            words = list({''.join(rng.choices('abc', k=rng.randint(1, 7))) for _ in range(15)})
            allowed = [''.join(rng.choices('abc', k=rng.randint(2, 8))) for _ in range(3)]
            text = ''.join(rng.choices('abcd', k=60))
            exceptions = [(i, i+len(w)) for w in allowed
                          for i in range(len(text)) if text.startswith(w, i)]
            spans = sorted((i, i+len(w)) for w in words for i in range(len(text))
                           if text.startswith(w, i) and not any(
                               a <= i and i+len(w) <= b for a, b in exceptions))
            merged = []
            for start, end in spans:
                if merged and start < merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], end))
                else:
                    merged.append((start, end))
            expected, position = [], 0
            for start, end in merged:
                expected.extend((text[position:start], REPLACEMENT))
                position = end
            expected.append(text[position:])
            self.assertEqual(WordMask(words, allowed).mask(text), ''.join(expected))

    def test_bundled_political_rules_and_upstream_exceptions(self):
        with mock.patch.dict(os.environ, {'KANBAN_BOT_SENSITIVE_WORDS_FILE': ''}):
            mask = load_mask()
        for value in ('六四', '法轮功', '习近平'):
            with self.subTest(value=value):
                self.assertEqual(mask.mask(value), REPLACEMENT)
        self.assertEqual(mask.mask('QQ，柑橘，曹操生日快乐，永远的神，音乐大师。'),
                         'QQ，柑橘，曹操生日快乐，永远的神，音乐大师。')


class FilteredLookupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'extra.json'
        self.path.write_text(json.dumps(['测试词']))
        patcher = mock.patch.dict(os.environ, {'KANBAN_BOT_SENSITIVE_WORDS_FILE': str(self.path)})
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch('qgroup_bot.abbreviations.urllib.request.urlopen')
        self.open = patcher.start()
        self.addCleanup(patcher.stop)
        self.lookup = AbbreviationLookup()

    def response(self, data):
        self.open.return_value = io.BytesIO(json.dumps(data).encode())

    def test_sensitive_terms_masked_but_all_candidates_and_long_values_remain(self):
        for field in ('trans', 'inputting'):
            with self.subTest(field=field):
                self.lookup = AbbreviationLookup()
                values = ['正常%d' % i for i in range(20)]+['前测试词后', '长'*100, '前测试词后']
                self.response([{'name': 'yyds', field: values}])
                text = self.lookup.answer('yyds')
                self.assertNotIn('测试词', text)
                self.assertIn('、'.join(values[:-3]), text)
                self.assertIn('长'*100, text)
                self.assertEqual(text.count('前'+REPLACEMENT+'后'), 2)

    def test_abbreviation_echo_is_also_masked(self):
        self.response([{'name': 'fuck', 'trans': ['正常释义']}])
        text = self.lookup.answer('fuck')
        self.assertNotIn('fuck', text)
        self.assertIn(REPLACEMENT+'：正常释义', text)

    def test_slg_header_does_not_combine_with_first_definition(self):
        for field in ('trans', 'inputting'):
            with self.subTest(field=field):
                self.lookup = AbbreviationLookup()
                self.response([{'name': 'slg', field: ['水灵根', 'g水', '测试词']}])
                text = self.lookup.answer('slg')
                label = '（待确认候选）' if field == 'inputting' else ''
                self.assertIn('slg'+label+'：水灵根、'+REPLACEMENT+'、'+REPLACEMENT, text)

    def test_result_fields_do_not_match_into_other_queries_or_footer(self):
        self.response([{'name': 'aa', 'trans': ['结尾']},
                       {'name': 'bb', 'trans': ['正文']}])
        mask = WordMask(['结尾bb', '正文来源', 'aa'])
        with mock.patch('qgroup_bot.abbreviations.load_mask', return_value=mask):
            text = self.lookup.answer('aa bb')
        self.assertIn(REPLACEMENT+'：结尾\nbb：正文\n来源：', text)

    def test_candidate_punctuation_cannot_inject_semantic_boundaries(self):
        self.response([{'name': 'slg', 'trans': ['水灵根', 'g：水', 'g\n水', 'g', '水']}])
        with mock.patch('qgroup_bot.abbreviations.load_mask', return_value=WordMask(['g水'])):
            text = self.lookup.answer('slg')
        self.assertIn('slg：水灵根、'+REPLACEMENT+'、'+REPLACEMENT+'、'+
                      REPLACEMENT+'、'+REPLACEMENT+'\n', text)

    def test_cross_candidate_sensitive_phrase_is_masked_after_assembly(self):
        self.response([{'name': 'aa', 'trans': ['测试', '词', '正常释义', '测试', '词']}])
        self.assertIn('：'+REPLACEMENT+'、'+REPLACEMENT+'、正常释义、'+
                      REPLACEMENT+'、'+REPLACEMENT+'\n', self.lookup.answer('aa'))

    def test_cached_response_rechecks_updated_rules_without_another_request(self):
        self.response([{'name': 'yyds', 'trans': ['新规则词', '测试词']}])
        self.assertIn('新规则词', self.lookup.answer('yyds'))
        self.path.write_text(json.dumps(['测试词', '新规则词']))
        text = self.lookup.answer('yyds')
        self.assertNotIn('新规则词', text)
        self.assertNotIn('测试词', text)
        self.open.assert_called_once()

    def test_missing_or_invalid_rule_file_never_returns_unfiltered_cached_content(self):
        self.response([{'name': 'yyds', 'trans': ['正常释义']}])
        self.assertIn('正常释义', self.lookup.answer('yyds'))
        for value in ('{bad', '{"wrong":[]}', '[42]'):
            with self.subTest(value=value):
                self.path.write_text(value)
                self.assertEqual(self.lookup.answer('yyds'), UNAVAILABLE)
        self.path.unlink()
        self.assertEqual(self.lookup.answer('yyds'), UNAVAILABLE)
        self.open.assert_called_once()

    def test_invalid_rules_never_return_fresh_unfiltered_content(self):
        self.path.write_text('invalid')
        self.response([{'name': 'yyds', 'trans': ['不会发送原文']}])
        with self.assertLogs('qgroup_bot.events', level='INFO') as logs:
            self.assertEqual(self.lookup.answer('yyds'), UNAVAILABLE)
        self.assertNotIn('不会发送原文', '\n'.join(logs.output))


if __name__ == '__main__':
    unittest.main()
