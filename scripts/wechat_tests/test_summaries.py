import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError, build_export, save_export
from host_service.wechat.summaries import day_bounds, covers_day, prepare_day, validate_summary, summary_for_browser, summary_scope, TZ
from host_service.wechat.summarize import parse_result, billing_metadata, run, save, check_effort


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.day = '2026-10-21'
        start, end = day_bounds(self.day)
        save(self.root / 'config.json', {'account_id': 'test', 'group_id': 'group@chatroom', 'group_name': '测试群'})
        rows = [{'local_id': n, 'server_id': str(n), 'shard': 'a', 'local_type': 1,
                 'sender_username': 'person', 'sort_seq': n, 'create_time': timestamp,
                 'message_content': '<script>测试文字</script>', 'compress_content': None,
                 'chat_id': 'group@chatroom'} for n, timestamp in enumerate([start - 1, start, end - 1, end], 1)]
        save_export(self.root / 'batches', build_export('test', 'group@chatroom', '测试群', start - 1, end + 1, rows, {'person': '测试者'}))
        self.prepared = prepare_day(self.root, self.day)
        self.ref = self.prepared['messages'][0]['id']
        self.summary = {'overview': '测试总览', 'topics': [{'title': '测试讨论', 'summary': '测试正文',
            'views': [{'speaker': 'p001', 'text': '一个观点', 'refs': [self.ref]}], 'refs': [self.ref]}]}

    def test_exact_day_scope_and_minimal_input(self):
        self.assertEqual(self.prepared['message_count'], 2)
        self.assertTrue(self.prepared['complete'])
        self.assertEqual(set(self.prepared['messages'][0]), {'id', 'speaker', 'time', 'type', 'content'})
        self.assertNotIn('person', json.dumps(self.prepared['messages']))

    def test_coverage_rejects_gap(self):
        self.assertTrue(covers_day([(0, 10), (10, 30)], 5, 20))
        self.assertFalse(covers_day([(0, 10), (11, 30)], 5, 20))

    def test_today_snapshot_requires_continuous_coverage_from_midnight(self):
        start, end = day_bounds('2026-10-24')
        now = datetime(2026, 10, 24, 14, tzinfo=TZ)
        noon = start + 12 * 3600
        good = summary_scope([(start-100, noon)], '2026-10-24', now)
        self.assertEqual(good, {'complete':False,'summarizable':True,'partial':True,'coverage_end':noon})
        for ranges in [[(start+1,noon)],[(start,start+100),(start+101,noon)],[]]:
            self.assertFalse(summary_scope(ranges,'2026-10-24',now)['summarizable'])
        self.assertTrue(summary_scope([(start,end)],'2026-10-24',now)['complete'])
        tomorrow = datetime(2026,10,25,1,tzinfo=TZ)
        self.assertFalse(summary_scope([(start,noon)],'2026-10-24',tomorrow)['summarizable'])

    def test_partial_summary_scope_reaches_model_receipt_and_saved_result(self):
        prepared = dict(self.prepared, complete=False, summarizable=True, partial=True,
                        coverage_end=day_bounds(self.day)[0]+12*3600)
        refs = list(prepared['sources'])
        summary = {'format_version':3,'overview':'当日群聊总结','topics':[{
            'title':'测试话题','summary':'测试观点','refs':refs,'discussion_refs':refs,
            'blocks':[],'comparisons':[],'quotes':[]}], 'excluded_messages':[]}
        payloads = []
        def process(*args, **kwargs):
            def communicate(payload, timeout):
                payloads.append(json.loads(payload))
                kwargs['stdout'].write(json.dumps({'subtype':'success','result':summary}).encode())
                kwargs['stdout'].flush()
            return SimpleNamespace(pid=123,returncode=0,communicate=communicate)
        with patch('host_service.wechat.summarize.prepare_day',return_value=prepared), \
             patch('host_service.wechat.summarize.check_effort'), \
             patch('host_service.wechat.summarize.subprocess.Popen',side_effect=process):
            result = run(self.day,data_dir=self.root)
        self.assertFalse(payloads[0]['coverage']['full_day'])
        self.assertEqual(payloads[0]['coverage']['end_exclusive'],prepared['coverage_end'])
        self.assertTrue(result['partial'])
        with patch('host_service.wechat.summaries.prepare_day',return_value=prepared):
            rendered = summary_for_browser(self.root,self.day)
        self.assertTrue(rendered['partial'])
        self.assertEqual(rendered['coverage_end'],prepared['coverage_end'])

    def test_refs_and_speaker_must_match(self):
        for mutate in ('ref', 'speaker'):
            value = copy.deepcopy(self.summary)
            if mutate == 'ref':
                value['topics'][0]['refs'] = ['other-day']
            else:
                value['topics'][0]['views'][0]['speaker'] = 'p099'
            with self.assertRaises(ArchiveError):
                validate_summary(value, self.prepared)

    def test_cli_error_is_not_success(self):
        with self.assertRaises(ArchiveError):
            parse_result(json.dumps({'is_error': True, 'result': 'error'}), self.prepared)
        outer, clean = parse_result(json.dumps({'subtype': 'success', 'result': json.dumps(self.summary)}), self.prepared)
        self.assertEqual(clean['topics'][0]['refs'], [self.ref])

    def test_actual_cli_event_array_and_official_credits(self):
        raw = json.dumps([{'type': 'message', 'role': 'assistant', 'providerData': {
            'model': 'fixture', 'rawUsage': {'credit': 1.25, 'prompt_tokens': 100}}},
            {'type': 'result', 'subtype': 'success', 'result': json.dumps(self.summary), 'total_cost_usd': 0}])
        _, clean = parse_result(raw, self.prepared)
        self.assertEqual(clean['topics'][0]['refs'], [self.ref])
        self.assertEqual(billing_metadata(raw)['credits'], 1.25)
        self.assertEqual(billing_metadata('{}'), {})

    def test_unsupported_effort_fails_before_paid_call(self):
        with patch('host_service.wechat.summarize.subprocess.Popen') as process:
            with self.assertRaises(ArchiveError):
                run(self.day, effort='low', variant='test', data_dir=self.root)
            process.assert_not_called()
        check_effort('glm-5.3-flash','low')

    def test_mixed_sender_view_is_rejected(self):
        prepared=copy.deepcopy(self.prepared)
        ref2=prepared['messages'][1]['id']
        prepared['sources'][ref2]['speaker']='p002'
        summary=copy.deepcopy(self.summary)
        summary['topics'][0]['views'][0]['refs'].append(ref2)
        with self.assertRaises(ArchiveError):
            parse_result(json.dumps({'subtype':'success','result':json.dumps(summary)}),prepared)

    def test_cache_never_calls_model(self):
        save(self.root / 'summaries' / (self.day + '.json'), {'source_hash': self.prepared['source_hash'], 'summary': self.summary, 'run_id': 'fixture'})
        with patch('host_service.wechat.summarize.subprocess.Popen') as process:
            self.assertEqual(run(self.day, data_dir=self.root)['status'], 'cached')
            process.assert_not_called()

    def test_identity_is_separate_from_prose_for_consistent_badges(self):
        summary = copy.deepcopy(self.summary)
        summary['overview'] = 'p001提出一个想法。'
        summary['topics'][0]['summary'] = '随后p001补充。'
        summary['topics'][0]['details'] = 'p001还提供了具体案例。'
        save(self.root / 'summaries' / (self.day + '.json'), {'source_hash': self.prepared['source_hash'], 'summary': summary})
        response = summary_for_browser(self.root, self.day)
        view = response['summary']
        self.assertEqual(response['people']['p001'], '测试者')
        self.assertEqual(view['overview'], 'p001提出一个想法。')
        self.assertEqual(view['topics'][0]['summary'], '随后p001补充。')
        self.assertEqual(view['topics'][0]['details'], 'p001还提供了具体案例。')

    def test_v2_blocks_keep_sources_and_reject_wrong_attribution(self):
        value={'format_version':2,'overview':'当日群聊总结','topics':[{'title':'问题','summary':'背景',
               'refs':[self.ref], 'blocks':[{'heading':'做法','speaker':'p001','text':'具体经验','refs':[self.ref]}]}]}
        valid=validate_summary(value,self.prepared)
        self.assertEqual(valid['topics'][0]['blocks'][0]['speaker'],'p001')
        self.assertEqual(validate_summary(valid,self.prepared),valid)
        for mutation in ('wrong_speaker','unknown_reference','unknown_mention','duplicate_fields'):
            bad=copy.deepcopy(value)
            if mutation=='wrong_speaker': bad['topics'][0]['blocks'][0]['speaker']='p002'
            elif mutation=='unknown_reference': bad['topics'][0]['blocks'][0]['refs']=['other-day']
            elif mutation=='unknown_mention': bad['topics'][0]['summary']='p999提出建议'
            else: bad['topics'][0]['points']=['重复要点']
            with self.subTest(mutation=mutation), self.assertRaises(ArchiveError):
                validate_summary(bad,self.prepared)

    def test_invisible_nickname_gets_stable_display_name(self):
        from host_service.wechat.summaries import display_name
        self.assertEqual(display_name('\x7f\u200b','p003'),'未命名 03')
        self.assertEqual(display_name('11','p001'),'11')
        self.assertEqual(display_name('雪中赏梅','p016'),'雪中赏梅')

    def test_existing_attempt_blocks_duplicate(self):
        (self.root / 'summary-runs').mkdir()
        (self.root / 'summary-runs' / (self.day + '.lock')).write_text('prior attempt')
        with patch('host_service.wechat.summarize.subprocess.Popen') as process:
            with self.assertRaises(ArchiveError):
                run(self.day, data_dir=self.root)
            process.assert_not_called()


if __name__ == '__main__':
    unittest.main()
