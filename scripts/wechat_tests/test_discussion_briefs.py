"""Brief prose keeps complete source membership and old summaries readable."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from host_service.wechat.archive import ArchiveError
from host_service.wechat.summaries import validate_summary, discussion_messages, summary_for_browser
from host_service.wechat.summarize import parse_result, save


class DiscussionBriefTests(unittest.TestCase):
    def setUp(self):
        rows = [('a', '最初试用'), ('b', '另一个问题'), ('c', '晚间补充失败'), ('d', '[图片]')]
        self.prepared = {'people': {'p001': '甲'}, 'sources': {
            key: {'speaker': 'p001', 'sender': '甲', 'time': '09:00:00', 'content': text}
            for key, text in rows}, 'replies': {'c': 'a'}, 'source_hash': 'fixture', 'complete': True}
        self.value = {'format_version': 4, 'overview': '当日讨论', 'topics': [
            {'title': '多角色协作的积分消耗', 'summary': '交流了先定架构再拆任务的做法。后续试用暂未测出节省。',
             'refs': ['a'], 'discussion_refs': ['a', 'c', 'd']},
            {'title': '一个尚未解决的问题', 'summary': '提出了使用中的疑问，暂时没有答复。',
             'refs': ['b'], 'discussion_refs': ['b']}], 'excluded_messages': [], 'notes': []}

    def test_brief_keeps_late_feedback_and_attachments_without_extra_prose(self):
        clean = validate_summary(self.value, self.prepared)
        self.assertEqual(clean, validate_summary(clean, self.prepared))
        self.assertEqual([m['id'] for m in discussion_messages(self.prepared, clean['topics'][0])], ['a', 'c', 'd'])
        _, restored = parse_result(json.dumps({'result': self.value}), self.prepared)
        self.assertEqual(restored, clean)

    def test_reject_expanded_person_tagged_or_multiline_briefs(self):
        for changes in ({'summary': '字' * 281}, {'title': '字' * 61}, {'summary': '第一段\n第二段'},
                        {'summary': 'p001提出方案。'}, {'title': '群友p001的经验'},
                        {'blocks': [{'text': '长分析'}]}, {'quotes': [{'text': '摘录'}]},
                        {'comparisons': [{'text': '对照'}]}, {'progress': '另外的结论'},
                        {'views': [{'speaker': 'p001'}]}, {'details': '详细正文'}):
            value = copy.deepcopy(self.value)
            value['topics'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ArchiveError):
                validate_summary(value, self.prepared)

    def test_short_prose_still_requires_all_messages_and_valid_evidence(self):
        for mode in ('missing', 'foreign', 'empty', 'unsupported', 'overlap'):
            value = copy.deepcopy(self.value)
            topic = value['topics'][0]
            if mode == 'missing': topic['discussion_refs'].remove('d')
            if mode == 'foreign': topic['discussion_refs'].append('other-day')
            if mode == 'empty': topic['refs'] = []
            if mode == 'unsupported': topic['refs'].append('b')
            if mode == 'overlap': value['excluded_messages'].append({'id': 'a', 'reason': '无主题闲聊'})
            with self.subTest(mode=mode), self.assertRaises(ArchiveError):
                validate_summary(value, self.prepared)

    def test_stale_v4_can_be_read_and_never_claims_complete_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            save(Path(tmp) / 'summaries/2026-10-25.json', {'source_hash': 'old', 'summary': self.value})
            current = copy.deepcopy(self.prepared)
            current['sources']['new'] = dict(current['sources']['a'], content='新消息')
            with patch('host_service.wechat.summaries.prepare_day', return_value=current):
                result = summary_for_browser(tmp, '2026-10-25')
            self.assertTrue(result['stale'])
            self.assertFalse(result['summary']['topics'][0]['discussion_complete'])
            self.assertEqual(result['summary']['topics'][0]['discussion_count'], 3)

    def test_existing_v3_long_summaries_are_still_readable(self):
        value = copy.deepcopy(self.value)
        value['format_version'] = 3
        value['topics'][0]['summary'] = 'p001提出方案。' * 100
        self.assertEqual(validate_summary(value, self.prepared)['format_version'], 3)


if __name__ == '__main__':
    unittest.main()
