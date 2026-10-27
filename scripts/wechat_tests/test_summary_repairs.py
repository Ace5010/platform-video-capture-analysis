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
        from host_service.wechat.models import CAPABILITIES
        self.enterContext(patch.dict(CAPABILITIES, {'fixture': {'text': True}}))
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

    def test_only_unconnected_sticker_omissions_are_accounted_without_inventing_topic(self):
        value = copy.deepcopy(self.value)
        value['excluded_messages'] = []
        source = self.prepared['sources'][self.other]
        source.update(content='[表情：未获取原件]', resources=[{'kind': 'sticker', 'status': 'ready'}])
        outer, checked = self.parse(value)
        self.assertEqual(checked['excluded_messages'], [{'id': self.other, 'reason': '模型未归入讨论'}])
        self.assertEqual(checked['topics'][0]['summary'], value['topics'][0]['summary'])
        self.assertIn('独立表情', checked['notes'][0])
        self.assertEqual(outer['local_repairs'][-1]['kind'], 'unassigned_isolated_stickers')
        self.assertEqual(repair_summary(checked, self.prepared)[1], [])
        source['content'] = '需要纳入总结的真实观点'
        with self.assertRaises(ArchiveError): self.parse(value)
        source['content'] = '[图片：未获取原件]'
        source['resources'] = [{'kind': 'image'}]
        with self.assertRaises(ArchiveError): self.parse(value)
        source.update(content='[表情：未获取原件]', resources=[{'kind': 'sticker'}])
        self.prepared['replies'] = {self.other: 'external-parent'}
        with self.assertRaises(ArchiveError): self.parse(value)

    def test_recover_uses_paid_output_and_preserves_failure_and_fee(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / 'summary-runs' / 'fixture-run'
            record = dict(source_hash='fixture', error_stage='validate', exit_code=0, credits=.5)
            job = dict(id='d'*32, run_id='fixture-run', date='2026-10-24', status='failed',
                       credits=.5, started_at='2026-10-25T00:00:00Z', error='original failure')
            save(folder/'receipt.json', record)
            save(folder/'reference-map.json', dict(source_hash='fixture', references={}))
            save(folder/'stdout.json', dict(subtype='success', result=self.value))
            save(root/'generation-jobs'/(job['id']+'.json'), job)
            manager = GenerationManager(root, runner=lambda *a, **kw: self.fail('must not call model'))
            with patch('host_service.wechat.generation.prepare_day', return_value=dict(self.prepared,source_hash='changed')):
                with self.assertRaises(ArchiveError): manager.recover(job['id'])
            self.assertFalse((folder/'local-recovery.json').exists())
            with patch('host_service.wechat.generation.prepare_day', return_value=self.prepared):
                result = manager.recover(job['id'])
            self.assertEqual((result['status'],result['credits']),('complete',.5))
            self.assertEqual(json.loads((folder/'receipt.json').read_text()), record)
            self.assertEqual(json.loads((folder/'local-recovery.json').read_text())['original_job'], job)
            self.assertTrue((root/'summaries/2026-10-24.json').exists())

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

    def test_excluded_id_list_keeps_explicit_membership_without_inventing_reason(self):
        value=copy.deepcopy(self.value)
        value['excluded_messages']=['m0003']
        outer,checked=self.parse(value,{'m0003':self.other})
        self.assertEqual(checked['excluded_messages'],[{'id':self.other,'reason':'模型未归入讨论'}])
        self.assertEqual(checked['topics'][0]['summary'],value['topics'][0]['summary'])
        self.assertEqual(outer['local_repairs'][0]['kind'],'excluded_id_record')
        value['excluded_messages']=['m9999']
        with self.assertRaises(ArchiveError):self.parse(value)
        value['excluded_messages']=[self.other,self.other]
        with self.assertRaises(ArchiveError):self.parse(value)

    def test_run_publishes_compact_id_result_with_original_usage_and_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.prepared['messages'][0]['resources']=[dict(kind='image',label='图片',status='missing',error='未取得完整图片')]
            self.prepared['resource_coverage']={'missing':1,'ready':0,'total':1}
            value = copy.deepcopy(self.value)
            value['format_version'] = 4
            topic = value['topics'][0]
            topic['summary'] = '讨论了新模型的入口及签到使用经验。'
            topic.update(refs=['m0001', 'm0002'], discussion_refs=['m0001', 'm0002'])
            topic['blocks'] = []
            topic['quotes'] = []
            value['excluded_messages'][0]['id'] = 'm0003'
            raw = json.dumps([{'type': 'message', 'role': 'assistant', 'providerData': {
                'model': 'fixture', 'rawUsage': {'credit': .5}}},
                {'type': 'result', 'subtype': 'success', 'result': json.dumps(value)}])
            def process(*args, **kwargs):
                def communicate(payload, timeout):
                    self.assertEqual(json.loads(payload)['messages'][0]['id'], 'm0001')
                    self.assertEqual(json.loads(payload)['coverage']['missing_resources'][0]['message'],'m0001')
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
            self.assertEqual(receipt['editorial_contract'], 'discussion-briefs-v4')
            self.assertEqual(receipt['local_repairs'], [])
            self.assertEqual(receipt['missing_resources'][0]['message'],self.image)
            self.assertEqual((folder/'stdout.json').read_text(encoding='utf-8'), raw)
            mapping = json.loads((folder/'reference-map.json').read_text(encoding='utf-8'))
            self.assertEqual(mapping['references']['m0001'], self.image)
            self.assertEqual(mapping['source_hash'], 'fixture')
            self.assertFalse((root/'summary-runs/2026-10-24.lock').exists())
            with patch('host_service.wechat.summaries.prepare_day', return_value=self.prepared):
                published=summary_for_browser(root, '2026-10-24')
                self.assertEqual(published['status'], 'ready')
                self.assertEqual(published['missing_resources'][0]['reason'],'未取得完整图片')
            self.assertFalse(list((root/'cache').iterdir()))


if __name__ == '__main__':
    unittest.main()
