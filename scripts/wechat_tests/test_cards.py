import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError
from host_service.wechat.cards import protobuf_strings
from host_service.wechat.resources import collect_resources, load_resources, require_summary_resources
from test_resources import message, PNG, ACCOUNT, GROUP


class CardTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        account=self.root/'source'/ACCOUNT;account.mkdir(parents=True)
        self.config=dict(db_dir=str(account.parent),account_id=ACCOUNT,account_dir=ACCOUNT,group_id=GROUP)

    def collect(self,body,fetcher=None):
        msg=message(49,body)
        kw={'fetcher':fetcher} if fetcher else {}
        result=collect_resources(self.root,self.config,[msg],**kw)
        return result,load_resources(self.root,self.config)['messages'][msg['platformMessageId']]['items'][0]

    def test_payment_card_reads_visible_fields_without_opening_action_or_leaking_keys(self):
        body='<msg><appmsg><type>2000</type><title>转账</title><url>https://pay.invalid/action</url><wcpayinfo><feedesc>10 元</feedesc><transferid>private-token</transferid><nativeurl>secret-action</nativeurl></wcpayinfo></appmsg></msg>'
        report,item=self.collect(body,lambda _:self.fail('must not perform payment action'))
        self.assertTrue(report['complete']);self.assertEqual(item['text'],'转账\n10 元')
        self.assertNotIn('private-token',str(item));self.assertNotIn('secret-action',str(item))

    def test_forward_all_children_counted_and_partial_downloads_remain_missing(self):
        record=ET.Element('recordinfo');listing=ET.SubElement(record,'datalist',count='2')
        child=ET.SubElement(listing,'dataitem',datatype='1');ET.SubElement(child,'datadesc').text='完整的第一条'
        child=ET.SubElement(listing,'dataitem',datatype='2');ET.SubElement(child,'fullmd5').text='a'*32
        app=ET.Element('appmsg');ET.SubElement(app,'type').text='19';ET.SubElement(app,'recorditem').text=ET.tostring(record,encoding='unicode')
        report,item=self.collect(ET.tostring(app,encoding='unicode'))
        self.assertFalse(report['complete']);self.assertEqual(item['status'],'missing')
        self.assertIn('完整的第一条',item['text']);self.assertIn('第 2 条',item['error'])
        with self.assertRaises(ArchiveError):require_summary_resources({'resource_coverage':report,'messages':[]})

    def test_forward_declared_count_mismatch_is_not_success(self):
        body='<appmsg><type>19</type><recorditem>&lt;recordinfo&gt;&lt;datalist count="2"&gt;&lt;dataitem datatype="1"&gt;&lt;datadesc&gt;text&lt;/datadesc&gt;&lt;/dataitem&gt;&lt;/datalist&gt;&lt;/recordinfo&gt;</recorditem></appmsg>'
        report,item=self.collect(body)
        self.assertFalse(report['complete']);self.assertIn('条目不完整',item['error'])

    def test_forward_full_text_preserves_order_and_speaker(self):
        body='<appmsg><type>19</type><recorditem>&lt;recordinfo&gt;&lt;datalist count="1"&gt;&lt;dataitem datatype="1"&gt;&lt;sourcename&gt;甲&lt;/sourcename&gt;&lt;datadesc&gt;完整正文&lt;/datadesc&gt;&lt;/dataitem&gt;&lt;/datalist&gt;&lt;/recordinfo&gt;</recorditem></appmsg>'
        report,item=self.collect(body)
        self.assertTrue(report['complete']);self.assertEqual(item['text'],'1. 甲\n完整正文')

    def test_shared_emoji_requires_matching_full_hash_not_first_thumbnail(self):
        def field(value):return bytes([10,len(value)])+value
        urls=[b'https://example.invalid/thumb',b'https://example.invalid/original']
        packed=field(field(urls[0]))+field(urls[1])
        self.assertEqual(protobuf_strings(packed),[v.decode() for v in urls])
        self.assertEqual(protobuf_strings(packed[:-1]),[])
        body='<appmsg><type>8</type><appattach><emoticonmd5>'+hashlib.md5(PNG).hexdigest()+'</emoticonmd5><emojiinfo>'+base64.b64encode(packed).decode()+'</emojiinfo></appattach></appmsg>'
        calls=[]
        def fetch(url):calls.append(url);return (b'not original' if url.endswith('thumb') else PNG),'image/png',url
        report,item=self.collect(body,fetch)
        self.assertTrue(report['complete']);self.assertEqual(len(calls),2)
        self.assertEqual(item['assets'][0]['id'],hashlib.sha256(PNG).hexdigest())


if __name__=='__main__': unittest.main()
