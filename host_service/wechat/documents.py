"""Read attachment bytes without executing scripts, archives or PDF actions."""
from io import BytesIO
from pathlib import PurePosixPath
import zipfile

from .archive import ArchiveError

TEXT_EXTENSIONS = {'.txt','.md','.csv','.tsv','.json','.jsonl','.xml','.yaml','.yml','.log',
                   '.py','.js','.ts','.tsx','.jsx','.css','.sql','.ini','.toml','.sh','.ps1'}
MAX_EXPANDED = 64 * 1024 * 1024


def decode_text_file(data):
    if data.startswith((b'\xff\xfe',b'\xfe\xff')):
        encodings = ('utf-16',)
    else:
        encodings = ('utf-8-sig','gb18030')
    for encoding in encodings:
        try:
            text=data.decode(encoding)
            if '\x00' not in text: return text
        except UnicodeError: pass
    raise ArchiveError('文件文字编码无法完整识别')


def read_document(root, data, name, fetcher, depth=0, budget=None):
    from .resources import save_blob, signature, webpage
    if depth > 5 or len(data)>MAX_EXPANDED:
        raise ArchiveError('文件超过完整解析上限')
    if budget is None: budget=[MAX_EXPANDED]
    budget[0]-=len(data)
    if budget[0]<0:raise ArchiveError('文件及嵌套内容超过完整解析总量上限')
    suffix=PurePosixPath(name).suffix.lower()
    if suffix in ('.mp4','.m4a','.mp3','.wav'):
        mime={'.mp4':'video/mp4','.m4a':'audio/mp4','.mp3':'audio/mpeg','.wav':'audio/wav'}[suffix]
        return {'text':'','assets':[save_blob(root,data,mime,name)]}
    mime=signature(data)
    if mime:
        return {'text':name,'assets':[save_blob(root,data,mime,name)]}
    if suffix in TEXT_EXTENSIONS:
        return {'text':decode_text_file(data),'assets':[]}
    if suffix in ('.html','.htm'):
        body,images=webpage(data,'text/html','')
        assets=[]
        for target in images:
            if not target.startswith(('http://','https://')):
                raise ArchiveError('HTML 文件的配套图片未完整取得')
            picture,_,_=fetcher(target)
            if not signature(picture):raise ArchiveError('HTML 文件图片无法完整识别')
            budget[0]-=len(picture)
            if budget[0]<0:raise ArchiveError('文件图片超过完整解析总量上限')
            assets.append(save_blob(root,picture,signature(picture),'文件图片'))
        return {'text':body,'assets':assets}
    if suffix=='.pdf':
        try: import pymupdf
        except ImportError: raise ArchiveError('PDF 完整读取组件尚未安装') from None
        try:
            with pymupdf.open(stream=data,filetype='pdf') as document:
                if document.needs_pass:raise ArchiveError('PDF 需要密码，暂不能完整读取')
                if not len(document) or len(document)>200:raise ArchiveError('PDF 页数超过单次完整读取上限')
                text,assets=[],[]
                expanded=0
                for index,page in enumerate(document):
                    text.append(f'第 {index+1} 页\n'+page.get_text())
                    if page.rect.width*page.rect.height*4>32*1024*1024:
                        raise ArchiveError('PDF 页面尺寸超过完整渲染上限')
                    picture=page.get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False).tobytes('png')
                    expanded+=len(picture)
                    budget[0]-=len(picture)
                    if budget[0]<0:raise ArchiveError('PDF 全部页面超过单次完整读取上限')
                    if expanded>MAX_EXPANDED:raise ArchiveError('PDF 全部页面超过单次完整读取上限')
                    assets.append(save_blob(root,picture,'image/png',f'{name} 第 {index+1} 页'))
                for embedded in document.embfile_names():
                    result=read_document(root,document.embfile_get(embedded),embedded,fetcher,depth+1,budget)
                    text.append('内嵌文件 '+embedded+'\n'+result['text']);assets.extend(result['assets'])
                return {'text':'\n'.join(text),'assets':assets}
        except ArchiveError:raise
        except Exception:raise ArchiveError('PDF 未通过完整解析校验') from None
    if suffix=='.zip':
        try:
            with zipfile.ZipFile(BytesIO(data)) as archive:
                files=[x for x in archive.infolist() if not x.is_dir()]
                if not files or len(files)>1000 or sum(x.file_size for x in files)>MAX_EXPANDED:
                    raise ArchiveError('压缩包超过完整读取上限')
                text,assets=[],[]
                for item in files:
                    if item.flag_bits&1:raise ArchiveError('压缩包需要密码，暂不能完整读取')
                    # No extraction, launch, macros or active-content execution.
                    result=read_document(root,archive.read(item),item.filename,fetcher,depth+1,budget)
                    text.append(item.filename+'\n'+result['text']);assets.extend(result['assets'])
                return {'text':'\n'.join(text),'assets':assets}
        except ArchiveError:raise
        except (OSError,ValueError,zipfile.BadZipFile):
            raise ArchiveError('压缩包未通过完整校验') from None
    raise ArchiveError('该文件格式尚未完成内容解析，原文件保留')
