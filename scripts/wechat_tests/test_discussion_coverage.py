"""Prevent missing corrections/attachments and leaking transport XML in source review."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from host_service.wechat.summaries import validate_summary, discussion_messages, readable_content, model_messages, summary_for_browser
from host_service.wechat.archive import ArchiveError


class DiscussionCoverageTests(unittest.TestCase):
    def setUp(self):
        texts = [('a','p001','09:00:00','初步方案'), ('x','p002','10:00:00','独立闲聊'),
                 ('image','p001','10:01:00','[图片：未获取原件]'),
                 ('late','p002','22:00:00','后来测试没有成功'),
                 ('confirm','p001','23:00:00','明白，继续排查\n引用 乙：后来测试没有成功')]
        self.p={'people':{'p001':'甲','p002':'乙'},'sources':{
            key:{'speaker':speaker,'sender':'甲' if speaker=='p001' else '乙','time':time,'content':text}
            for key,speaker,time,text in texts},'replies':{'late':'a','confirm':'late'}}
        self.value={'format_version':3,'overview':'当日群聊总结','topics':[
            {'title':'方案尚在排查','summary':'p001提出方案，p002晚间报告失败。','blocks':[],
             'refs':['a','late'],'discussion_refs':['a','image','late'],
             'quotes':[{'speaker':'p002','ref':'late','text':'后来测试没有成功'}]}],
            'excluded_messages':[{'id':'x','reason':'无主题闲聊'}]}

    def test_late_reply_chain_and_attachment_are_all_returned_in_order(self):
        clean=validate_summary(self.value,self.p)
        self.assertEqual(clean['topics'][0]['discussion_refs'],['a','image','late','confirm'])
        messages=discussion_messages(self.p,clean['topics'][0])
        self.assertEqual([m['id'] for m in messages],['a','image','late','confirm'])
        self.assertEqual(messages[1]['content'],'[图片：未获取原件]')
        self.assertEqual(messages[-1]['reply_to'],'late')
        self.assertEqual(clean,validate_summary(clean,self.p))

    def test_no_silent_omission_or_excluding_relevant_replies(self):
        for mode in ['missing','overlap','reply','foreign','unsupported','speaker_blocks']:
            value=copy.deepcopy(self.value)
            if mode=='missing':value['topics'][0]['discussion_refs'].remove('image')
            if mode=='overlap':value['excluded_messages'].append({'id':'a','reason':'无主题闲聊'})
            if mode=='reply':value['excluded_messages'].append({'id':'confirm','reason':'无主题闲聊'})
            if mode=='foreign':value['topics'][0]['discussion_refs'].append('other-day')
            if mode=='unsupported':value['topics'][0]['refs'].append('x')
            if mode=='speaker_blocks':value['topics'][0]['blocks']=[{'heading':'甲','speaker':'p001','text':'逐人发言','refs':['a']}]
            with self.subTest(mode=mode),self.assertRaises(ArchiveError):validate_summary(value,self.p)

    def test_quotes_cannot_be_rewritten_or_borrowed_from_quoted_author(self):
        for q in [{'speaker':'p001','ref':'late','text':'后来测试没有成功'},
                  {'speaker':'p002','ref':'late','text':'测试已经成功'},
                  {'speaker':'p001','ref':'confirm','text':'后来测试没有成功'}]:
            value=copy.deepcopy(self.value);value['topics'][0]['discussion_refs'].append('confirm');value['topics'][0]['quotes']=[q]
            with self.subTest(quote=q),self.assertRaises(ArchiveError):validate_summary(value,self.p)

    def test_transport_metadata_removed_without_losing_reply_text(self):
        content='这是我的回复\n引用 乙：<msg><appmsg><title>对方的原话</title><appattach><aeskey>DO_NOT_EXPOSE</aeskey></appattach></appmsg></msg>'
        self.assertEqual(readable_content(content),'这是我的回复\n引用 乙：对方的原话')
        self.assertEqual(readable_content('回复\n引用 乙：<msg><img aeskey="SECRET"/></msg>'),'回复\n引用 乙：[图片：未获取原件]')
        self.assertEqual(readable_content('<script>作为文字保留</script>'),'<script>作为文字保留</script>')
        self.assertNotIn('SECRET',readable_content('<!DOCTYPE msg [<!ENTITY x "SECRET">]><msg>&x;</msg>'))
        self.p['messages']=[{'id':'late','content':content}]
        messages=model_messages(self.p)
        self.assertEqual(messages[0]['reply_to'],'a')
        self.assertNotIn('DO_NOT_EXPOSE',messages[0]['content'])

    def test_more_than_512_messages_are_not_truncated(self):
        p={'people':{'p001':'甲'},'sources':{str(i):{'speaker':'p001','sender':'甲','time':str(i),'content':str(i)} for i in range(600)}}
        value={'format_version':3,'overview':'当日群聊总结','topics':[{'title':'长讨论','summary':'完整','refs':['0'],'discussion_refs':list(p['sources'])}], 'excluded_messages':[]}
        clean=validate_summary(value,p)
        self.assertEqual(len(discussion_messages(p,clean['topics'][0])),600)

    def test_new_archive_messages_mark_existing_summary_incomplete(self):
        clean=validate_summary(self.value,self.p)
        current=copy.deepcopy(self.p)
        current.update(source_hash='new',complete=True)
        current['sources']['new']={'speaker':'p001','sender':'甲','time':'23:59:00','content':'新增讨论'}
        current['replies']['new']='a'
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'summaries'/'2026-10-21.json'
            target.parent.mkdir()
            target.write_text(json.dumps({'source_hash':'old','summary':clean}),encoding='utf-8')
            with patch('host_service.wechat.summaries.prepare_day',return_value=current):
                result=summary_for_browser(folder,'2026-10-21')
        self.assertTrue(result['stale'])
        self.assertFalse(result['summary']['topics'][0]['discussion_complete'])
        self.assertEqual(result['summary']['topics'][0]['discussion_count'],4)
        self.assertEqual(len(discussion_messages(current)),6)


if __name__=='__main__':unittest.main()
