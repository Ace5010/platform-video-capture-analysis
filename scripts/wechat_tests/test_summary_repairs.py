"""Local recovery without model calls, invented coverage or changed message IDs."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from host_service.wechat.archive import ArchiveError
from host_service.wechat.summaries import (compact_model_messages, repair_summary, validate_summary,
                                           summary_for_browser)
from host_service.wechat.summarize import parse_result, save
from host_service.wechat.generation import GenerationManager


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.image = 'm_4ae26467823b2e82'
        self.text = 'm_66f2cb5e3ae3691f'
        self.other = 'm_1111111111111111'
        self.typo = 'm_4ae26467823b14d0'
        contents = [(self.image, 'p001', '[图片：未获取原件]'),
                    (self.text, 'p002', '每天签到支持新模型'),
                    (self.other, 'p001', '独立闲聊')]
        self.prepared = {'sources': {key: {'id': key, 'speaker': who, 'content': content,
                          'sender': '甲' if who == 'p001' else '乙',
                          'time': '09:00:00', 'type': 0} for key, who, content in contents},
                         'people': {'p001': '甲', 'p002': '乙'}, 'replies': {},
                         'external_source_ids': set(), 'source_hash': 'fixture', 'date': '2026-10-24',
                         'summarizable': True, 'complete': True, 'partial': False,
                         'coverage_end': 1792857600, 'message_count': 3}
        self.prepared['messages'] = list(self.prepared['sources'].values())
        self.value = {'format_version': 3, 'overview': '当日群聊总结', 'topics': [{
            'title': '入口与使用', 'summary': 'p001展示入口，p002介绍经验。',
            'refs': [self.image, self.text], 'discussion_refs': [self.image, self.text],
            'blocks': [{'heading': '使用经验', 'speaker': '', 'text': 'p002每天使用。', 'refs': [self.text]}],
            'quotes': [{'speaker': 'p002', 'ref': self.text, 'text': '每天签到支持新模型'}]}],
            'excluded_messages': [{'id': self.other, 'reason': '无主题闲聊'}]}

    def parse(self, value, mapping=None):
        return parse_result(json.dumps({'subtype': 'success', 'result': value}), self.prepared, mapping)

    def test_corrupted_suffix_and_added_emoji_recover_without_modifying_prose_or_input(self):
        value = copy.deepcopy(self.value)
        value['topics'][0]['refs'][0] = self.typo
        value['topics'][0]['discussion_refs'][0] = self.typo
        value['topics'][0]['quotes'][0]['text'] += '[破涕为笑]'
        original = copy.deepcopy(value)
        outer, checked = self.parse(value)
        self.assertEqual(value, original)
        self.assertEqual(checked['topics'][0]['summary'], self.value['topics'][0]['summary'])
        self.assertEqual(checked['topics'][0]['quotes'], [])
        self.assertEqual(checked['topics'][0]['discussion_refs'], [self.image, self.text])
        self.assertEqual({r['kind'] for r in outer['local_repairs']},
                         {'reference_suffix', 'omit_unfaithful_quote'})
        checked2, repairs = repair_summary(checked, self.prepared)
        self.assertEqual(checked2, checked)
        self.assertEqual(repairs, [])
        self.assertEqual(validate_summary(checked, self.prepared), checked)

    def test_ambiguous_and_known_cross_day_ids_never_repaired(self):
        for mode in ('ambiguous', 'cross_day', 'unrelated', 'already_assigned', 'two_typos'):
            value = copy.deepcopy(self.value)
            value['topics'][0]['refs'][0] = self.typo
            value['topics'][0]['discussion_refs'][0] = self.typo
            prepared = copy.deepcopy(self.prepared)
            if mode == 'ambiguous':
                prepared['sources']['m_4ae26467823b1234'] = prepared['sources'][self.image]
            elif mode == 'cross_day':
                prepared['external_source_ids'] = {self.typo}
            elif mode == 'unrelated':
                value['topics'][0]['refs'][0] = 'm_ffffffffffffffff'
            elif mode == 'already_assigned':
                value['topics'][0]['discussion_refs'].append(self.image)
            elif mode == 'two_typos':
                value['topics'][0]['refs'].append('m_4ae26467823bffff')
            with self.subTest(mode=mode):
                fixed, _ = repair_summary(value, prepared)
                with self.assertRaises(ArchiveError):
                    validate_summary(fixed, prepared)

    def test_compact_ids_restore_every_reference_field_and_do_not_expose_other_days(self):
        self.prepared['replies'] = {self.text: self.image, self.image: 'other-day'}
        messages, mapping = compact_model_messages(self.prepared)
        self.assertEqual([m['id'] for m in messages], ['m0001', 'm0002', 'm0003'])
        self.assertEqual([m['reply_to'] for m in messages], ['', 'm0001', ''])
        self.assertNotIn('m_', json.dumps(messages))
        value = copy.deepcopy(self.value)
        topic = value['topics'][0]
        topic.update(refs=['m0001', 'm0002'], discussion_refs=['m0001', 'm0002'],
                     comparisons=[{'heading': '经验', 'text': '每天使用', 'refs': ['m0002']}])
        topic['blocks'][0]['refs'] = ['m0002']
        topic['quotes'][0]['ref'] = 'm0002'
        value['excluded_messages'][0]['id'] = 'm0003'
        _, checked = self.parse(value, mapping)
        self.assertEqual(checked['topics'][0]['refs'], [self.image, self.text])
        self.assertEqual(checked['topics'][0]['quotes'][0]['ref'], self.text)
        self.assertEqual(checked['topics'][0]['comparisons'][0]['refs'], [self.text])
        self.assertEqual(checked['excluded_messages'][0]['id'], self.other)
        value['topics'][0]['refs'].append('m9999')
        with self.assertRaises(ArchiveError): self.parse(value, mapping)
        with self.assertRaises(ArchiveError): self.parse(self.value, {'m0001': 'other-day'})

    def test_existing_evidence_and_explicit_replies_retain_coverage(self):
        self.prepared['replies'] = {self.other: self.text}
        value = copy.deepcopy(self.value)
        value['topics'][0]['refs'] = self.image
        value['topics'][0]['discussion_refs'] = [self.image]
        outer, checked = self.parse(value)
        self.assertEqual(checked['topics'][0]['discussion_refs'], [self.image, self.text, self.other])
        self.assertEqual(checked['excluded_messages'], [])
        self.assertEqual({r['kind'] for r in outer['local_repairs']},
                         {'reference_list', 'include_evidence_and_replies', 'retain_assigned_messages'})

    def test_unassigned_messages_and_missing_evidence_are_not_invented(self):
        value = copy.deepcopy(self.value)
        value['excluded_messages'] = []
        with self.assertRaisesRegex(ArchiveError, '遗漏或冲突'):
            self.parse(value)
        value = copy.deepcopy(self.value)
        value['topics'][0]['blocks'][0]['refs'] = []
        with self.assertRaises(ArchiveError): self.parse(value)

    def test_paraphrased_or_misattributed_optional_quotes_are_omitted(self):
        for changes in ({'speaker': 'p001'}, {'text': '大家都认为模型很好'},
                        {'ref': self.image, 'speaker': 'p001', 'text': '不存在的图片文字'}):
            value = copy.deepcopy(self.value)
            value['topics'][0]['quotes'][0].update(changes)
            with self.subTest(changes=changes):
                with self.assertRaises(ArchiveError): validate_summary(value, self.prepared)
                _, checked = self.parse(value)
                self.assertEqual(checked['topics'][0]['quotes'], [])
                self.assertEqual(checked['topics'][0]['summary'], self.value['topics'][0]['summary'])

    def test_whitespace_and_extra_valid_quotes_do_not_discard_source_text(self):
        value = copy.deepcopy(self.value)
        quote = value['topics'][0]['quotes'][0]
        quote['text'] = '  ' + quote['text'] + '  '
        value['topics'][0]['quotes'] = [quote, copy.deepcopy(quote), copy.deepcopy(quote)]
        outer, checked = self.parse(value)
        self.assertEqual(len(checked['topics'][0]['quotes']), 2)
        self.assertEqual(checked['topics'][0]['quotes'][0]['text'], '每天签到支持新模型')
        self.assertEqual(outer['local_repairs'][0]['kind'], 'limit_optional_quotes')

    def test_run_publishes_compact_id_result_with_original_usage_and_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            value = copy.deepcopy(self.value)
            topic = value['topics'][0]
            topic.update(refs=['m0001', 'm0002'], discussion_refs=['m0001', 'm0002'])
            topic['blocks'][0]['refs'] = ['m0002']
            topic['quotes'][0].update(ref='m0002', text='每天签到支持新模型[表情]')
            value['excluded_messages'][0]['id'] = 'm0003'
            raw = json.dumps([{'type': 'message', 'role': 'assistant', 'providerData': {
                'model': 'fixture', 'rawUsage': {'credit': .5}}},
                {'type': 'result', 'subtype': 'success', 'result': json.dumps(value)}])
            def process(*args, **kwargs):
                def communicate(payload, timeout):
                    self.assertEqual(json.loads(payload)['messages'][0]['id'], 'm0001')
                    kwargs['stdout'].write(raw.encode()); kwargs['stdout'].flush()
                return SimpleNamespace(pid=123, returncode=0, communicate=communicate)
            manager = GenerationManager(root)
            with patch('host_service.wechat.summarize.prepare_day', return_value=self.prepared), \
                 patch('host_service.wechat.summarize.check_effort'), \
                 patch('host_service.wechat.summarize.subprocess.Popen', side_effect=process) as call:
                manager._execute({'id': 'e'*32, 'date': '2026-10-24', 'model': 'fixture',
                                  'effort': 'high', 'started_at': '2026-10-25T00:00:00Z'})
            call.assert_called_once()
            job = manager.latest('2026-10-24')
            self.assertEqual((job['status'], job['credits']), ('complete', .5))
            folder = root/'summary-runs'/job['run_id']
            receipt = json.loads((folder/'receipt.json').read_text(encoding='utf-8'))
            self.assertEqual(receipt['local_repairs'][0]['kind'], 'omit_unfaithful_quote')
            self.assertEqual((folder/'stdout.json').read_text(encoding='utf-8'), raw)
            mapping = json.loads((folder/'reference-map.json').read_text(encoding='utf-8'))
            self.assertEqual(mapping['references']['m0001'], self.image)
            self.assertEqual(mapping['source_hash'], 'fixture')
            self.assertFalse((root/'summary-runs/2026-10-24.lock').exists())
            with patch('host_service.wechat.summaries.prepare_day', return_value=self.prepared):
                self.assertEqual(summary_for_browser(root, '2026-10-24')['status'], 'ready')


if __name__ == '__main__':
    unittest.main()
