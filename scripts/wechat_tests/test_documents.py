from io import BytesIO
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError
from host_service.wechat.documents import read_document
from host_service.wechat.resources import save_blob,summary_images,blob_path


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
    def fetch(self,_):self.fail('isolated file must not access a network')

    def test_text_zip_nested_entries_and_no_execution(self):
        self.assertEqual(read_document(self.root,'完整中文'.encode('utf-16'),'a.txt',self.fetch)['text'],'完整中文')
        buffer=BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:
            archive.writestr('../outside.txt','第一份全文')
            archive.writestr('script.js','throw new Error("never execute")')
        result=read_document(self.root,buffer.getvalue(),'a.zip',self.fetch)
        self.assertIn('第一份全文',result['text']);self.assertIn('never execute',result['text'])
        self.assertFalse((self.root.parent/'outside.txt').exists())
        with self.assertRaises(ArchiveError):read_document(self.root,b'MZexecutable','a.exe',self.fetch)
        with self.assertRaises(ArchiveError):read_document(self.root,buffer.getvalue()[:-15],'a.zip',self.fetch)
        with self.assertRaises(ArchiveError):read_document(self.root,b'abcdef','a.txt',self.fetch,budget=[5])

    @unittest.skipUnless(importlib.util.find_spec('pymupdf'),'reader PDF dependency required')
    def test_pdf_all_pages_rendered_including_image_only_page(self):
        import pymupdf
        with pymupdf.open() as pdf:
            pdf.new_page(width=200,height=200).insert_text((20,30),'First page full text')
            page=pdf.new_page(width=200,height=200)
            page.draw_rect(pymupdf.Rect(20,20,180,180),color=(1,0,0),fill=(1,0,0))
            data=pdf.tobytes()
        result=read_document(self.root,data,'a.pdf',self.fetch)
        self.assertEqual(len(result['assets']),2)
        self.assertIn('First page full text',result['text']);self.assertIn('第 2 页',result['text'])
        for asset in result['assets']:self.assertTrue(blob_path(self.root,asset).is_file())

    def test_every_animated_frame_and_duration_are_supplied(self):
        from PIL import Image
        output=BytesIO()
        frames=[Image.new('RGB',(20,20),color) for color in ('red','blue','green')]
        for format,mime in [('GIF','image/gif'),('PNG','image/png')]:
            with self.subTest(format=format):
                output=BytesIO()
                frames[0].save(output,format=format,save_all=True,append_images=frames[1:],duration=[100,200,300],loop=0)
                original=save_blob(self.root,output.getvalue(),mime,'animation')
                prepared={'messages':[{'id':'one','resources':[{'assets':[original]}]}]}
                images=summary_images(self.root,prepared)
                self.assertEqual(len(images),3)
                self.assertEqual([a['frame_index'] for _,a,_ in images],[1,2,3])
                self.assertEqual([a['duration_ms'] for _,a,_ in images],[100,200,300])
                self.assertTrue(all(a['source_id']==original['id'] for _,a,_ in images))
                self.assertEqual(len({a['id'] for _,a,_ in images}),3)


if __name__=='__main__':unittest.main()
