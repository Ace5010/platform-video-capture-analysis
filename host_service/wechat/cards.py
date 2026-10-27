"""Read card payloads and every child of a forwarded record, without actions.

Native URLs, CDN credentials and payment identifiers never become display text.
Nested failures retain progress but cannot satisfy the completeness gate.
"""
import base64
import hashlib
import html
from pathlib import Path
import re

from .archive import ArchiveError


class ResourceIncomplete(ArchiveError):
    def __init__(self, reason, partial):
        super().__init__(reason)
        self.partial = partial


def protobuf_strings(data, depth=0):
    """Bounded wire parsing; length-delimited fields are not regex-concatenated."""
    if depth > 8 or len(data) > 1024 * 1024:
        return []
    values, offset = [], 0
    def varint():
        nonlocal offset
        result = 0
        for shift in range(0,70,7):
            if offset >= len(data): raise ValueError()
            byte = data[offset]; offset += 1
            result |= (byte & 127) << shift
            if not byte & 128: return result
        raise ValueError()
    try:
        while offset < len(data):
            tag = varint()
            if not tag >> 3: return []
            wire = tag & 7
            if wire == 0: varint()
            elif wire in (1,5):
                offset += 8 if wire == 1 else 4
                if offset > len(data): return []
            elif wire == 2:
                length = varint()
                if length > len(data)-offset: return []
                field = data[offset:offset+length]; offset += length
                try:
                    text = field.decode('utf-8')
                    if text.startswith(('https://','http://')) and not re.search(r'[\x00-\x20]',text):
                        values.append(text)
                except UnicodeDecodeError: pass
                values.extend(protobuf_strings(field,depth+1))
            else: return []
    except ValueError:
        return []
    return list(dict.fromkeys(values))


def card(root, config, message, spec, image_key, fetcher):
    from .resources import xml_root, collect_one, save_blob, signature
    app = xml_root(spec.get('xml',''))
    if app is None:
        raise ArchiveError('分享消息正文无法解析')
    subtype = app.findtext('type','')
    if subtype == '8':
        expected = app.findtext('.//emoticonmd5','').lower()
        if not re.fullmatch('[a-f0-9]{32}',expected):
            raise ArchiveError('分享表情缺少完整文件指纹')
        try:
            urls = protobuf_strings(base64.b64decode(app.findtext('.//emojiinfo',''),validate=True))
        except ValueError:
            urls = []
        for url in urls[:8]:
            try:
                data, _, _ = fetcher(url)
                if hashlib.md5(data).hexdigest() == expected and signature(data):
                    return {'text':'表情包', 'assets':[save_blob(root,data,signature(data),'表情包',tier='received')]}
            except ArchiveError: pass
        raise ArchiveError('分享表情原件尚未取齐，请在微信中加载后补取')
    if subtype == '53':
        nested = xml_root(html.unescape(app.findtext('.//solitaire_info','')))
        if nested is None or nested.tag != 'solitaire':
            raise ArchiveError('群接龙完整内容无法解析')
        text = '\n'.join(filter(None,[app.findtext('title',''), nested.findtext('tt',''),
                          nested.findtext('ex',''), *[i.findtext('r','') for i in nested.findall('.//content/i')]]))
        if not text: raise ArchiveError('群接龙缺少正文')
        return {'text':text,'assets':[]}
    if subtype in ('1','2000','2001'):
        fields = ['title','des']
        if subtype in ('2000','2001'):
            fields += ['.//wcpayinfo/'+name for name in
                       ('feedesc','receivertitle','sendertitle','scenetext','senderdes','receiverdes')]
        text = '\n'.join(dict.fromkeys(app.findtext(field,'').strip() for field in fields
                                       if app.findtext(field,'').strip()))
        if not text: raise ArchiveError('分享消息缺少正文')
        result = {'text':text,'assets':[]}
        url = app.findtext('url','')
        # Payment cards describe the message only. Never open an action URL.
        if subtype == '1' and url.startswith(('http://','https://')):
            webpage = collect_one(root,config,message,{'kind':'website','url':url},image_key,fetcher)
            result['text'] += '\n'+webpage['text']; result['assets'] += webpage['assets']
        return result
    if subtype in ('51','63','33','36','62'):
        text='\n'.join(filter(None,[app.findtext('title',''),app.findtext('des','')]))
        return {'text':(text+'\n' if text else '')+'分享目标内容未读取（仅读取文字和图片）','assets':[]}
    raise ArchiveError('该分享卡片仍需读取完整目标内容')


def forward(root, config, message, spec, image_key, fetcher, depth=0):
    from .resources import xml_root, collect_one, account_path, decrypt_image, decrypt_image_payload, signature, save_blob, MAX_RESOURCE_BYTES
    if depth >= 8:
        raise ArchiveError('合并转发嵌套层级超过读取上限')
    app = xml_root(spec.get('xml',''))
    record = xml_root(app.findtext('recorditem','')) if app is not None else None
    if record is None:
        raise ArchiveError('合并转发缺少完整记录')
    listing = record.find('.//datalist')
    items = list(listing.findall('dataitem')) if listing is not None else []
    if not items or (listing.get('count') and listing.get('count') != str(len(items))):
        raise ArchiveError('合并转发条目不完整')
    text, assets, errors = [], [], []
    base = account_path(config)/'msg'/'attach'/hashlib.md5(config['group_id'].encode()).hexdigest()
    for index, item in enumerate(items,1):
        kind = item.get('datatype','')
        label = ' '.join(filter(None,[item.findtext('sourcename',''),item.findtext('sourcetime','')]))
        body = item.findtext('datadesc','')
        text.append(f'{index}. {label}\n{body}')
        try:
            if kind == '1':
                if not body: raise ArchiveError('文字正文缺失')
                for url in dict.fromkeys(re.findall(r'https?://[^\s<>"\x00]+',body)):
                    result = collect_one(root,config,message,{'kind':'website','url':url.rstrip('。，；！？）')},image_key,fetcher)
                    text.append(result['text']); assets.extend(result['assets'])
            elif kind == '2':
                expected = item.findtext('fullmd5','').lower()
                dataid = item.get('dataid','')
                if not re.fullmatch('[a-f0-9]{32}',expected):
                    raise ArchiveError('图片缺少完整原件指纹')
                # Windows stores forwarded images as numeric filenames inside
                # record directories. Bind by the original plaintext hash, not
                # by a filename, a thumbnail or the currently opened record.
                candidates = [p for directory in base.glob('*/Rec')
                              for p in directory.rglob('*') if p.is_file()
                              and p.resolve().is_relative_to(base.resolve()) and p.stat().st_size <= MAX_RESOURCE_BYTES]
                found = False
                for path in candidates:
                    try: original = decrypt_image_payload(path.read_bytes(),image_key,config['account_id'])
                    except ArchiveError: continue
                    if hashlib.md5(original).hexdigest() != expected: continue
                    data = decrypt_image(original)
                    assets.append(save_blob(root,data,signature(data),'转发图片',tier='received'))
                    found=True; break
                if not found:
                    raise ArchiveError('完整图片尚未在本机加载')
            elif kind == '17':
                nested = item.findtext('recordxml','')
                if not nested: raise ArchiveError('嵌套转发正文缺失')
                import xml.etree.ElementTree as ET
                wrapper = ET.Element('appmsg'); ET.SubElement(wrapper,'recorditem').text=nested
                result=forward(root,config,message,{'xml':ET.tostring(wrapper,encoding='unicode')},image_key,fetcher,depth+1)
                text.append(result['text']); assets.extend(result['assets'])
            elif kind in ('4','8','22'):
                text.append('附件内容未读取（仅读取文字和图片）')
            else:
                raise ArchiveError({'4':'视频原件尚未完整解析','22':'视频号原件尚未完整解析',
                                    '37':'转发表情原件尚未完整解析'}.get(kind,'该转发附件尚未完整解析'))
        except ArchiveError as exc:
            if isinstance(exc,ResourceIncomplete):
                text.append(exc.partial.get('text','')); assets.extend(exc.partial.get('assets',[]))
            errors.append(f'第 {index} 条：{exc}')
    result = {'text':'\n'.join(text), 'assets':assets}
    if errors:
        raise ResourceIncomplete('合并转发未取齐；'+'；'.join(errors),result)
    return result
