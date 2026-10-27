"""Group-scoped resource inventory. A saved message is not a downloaded resource.

Archive batches remain immutable. Resource receipts and content-addressed files
live beside them, so filling a missing attachment cannot rewrite chat history.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import hashlib
import json
from pathlib import Path
import re
import struct
import time
import xml.etree.ElementTree as ET

from .archive import ArchiveError, atomic_json, decode_text, digest

MAX_RESOURCE_BYTES = 64 * 1024 * 1024
LABELS = {'image': '图片', 'sticker': '表情包', 'video': '视频', 'audio': '语音',
          'file': '文件', 'website': '网页', 'forward': '合并转发', 'card': '分享内容',
          'location': '位置', 'unknown': '其他消息'}
EXCLUDED_KINDS = frozenset(('video', 'audio', 'file'))


def restored(value):
    if isinstance(value, dict) and value.get('encoding') == 'base64':
        return base64.b64decode(value['data'], validate=True)
    return value


def source_text(source):
    value = restored(source.get('message_content'))
    if not value:
        value = restored(source.get('compress_content'))
    try:
        text = decode_text(value)
    except (ArchiveError, ModuleNotFoundError):
        return ''
    match = re.search(r'<(?:\?xml|msg\b|appmsg\b)', text)
    return text[match.start():] if match else text


def xml_root(text):
    if re.search(r'<!DOCTYPE\b|<!ENTITY\b', text, re.I):
        raise ArchiveError('消息含有不支持的 XML 声明')
    # WeChat sometimes wraps another XML document directly inside <msg>.
    # Remove only that redundant declaration, retaining all message elements.
    text = re.sub(r'(<msg\b[^>]*>)\s*<\?xml\s[^?]*\?>',r'\1',text,count=1)
    def character_reference(match):
        value=int(match[1][1:],16) if match[1].lower().startswith('x') else int(match[1])
        valid=value in (9,10,13) or 32<=value<=0xd7ff or 0xe000<=value<=0xfffd or 0x10000<=value<=0x10ffff
        return match[0] if valid else '&amp;#'+match[1]+';'
    text=re.sub(r'&#(x[0-9a-fA-F]+|[0-9]+);',character_reference,text)
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def requirements(message):
    """Enumerate every non-text input, including links inside ordinary text.

    No CDN key, signed URL or source path is returned to the browser.
    Unknown cards stay required instead of silently becoming text-only success.
    """
    source = message['_source']
    kind = int(source['local_type']) & 0xffffffff
    text = message.get('content', '') if kind == 1 else source_text(source)
    root = xml_root(text) if text.lstrip().startswith('<') else None
    specs = []
    def add(category, node=None, **fields):
        attrs = dict(node.attrib) if node is not None else {}
        specs.append({'kind': category, 'attributes': attrs, **fields})
    if kind in (3, 34, 43, 47, 11000):
        category, tag = {3: ('image', 'img'), 34: ('audio', 'voicemsg'),
                         43: ('video', 'videomsg'), 47: ('sticker', 'emoji'),
                         11000: ('sticker', 'emoji')}[kind]
        node = root.find('.//' + tag) if root is not None else None
        add(category, node)
    elif kind == 48:
        node = root.find('.//location') if root is not None else None
        add('location', node)
    elif kind == 49:
        app = root if root is not None and root.tag == 'appmsg' else root.find('.//appmsg') if root is not None else None
        subtype = app.findtext('type', '') if app is not None else {7: '5', 4: '6', 25: '57', 22: '62'}.get(message['type'], '')
        if subtype not in ('57', '62'):
            category = {'5': 'website', '6': 'file', '19': 'forward'}.get(subtype, 'card')
            add(category, title=app.findtext('title', '') if app is not None else message.get('content', ''),
                url=app.findtext('url', '') if app is not None else '',
                xml=ET.tostring(app, encoding='unicode') if app is not None else '')
    elif kind not in (1, 50, 10000, 10002):
        add('unknown')
    if kind == 1:
        for url in dict.fromkeys(re.findall(r'https?://[^\s<>\x00"\u3000]+', text)):
            add('website', url=url.rstrip('。，、；！？）)]}'), title='网页')
    return specs


def signature(data):
    """Only complete supported images are accepted, never encrypted DAT bytes."""
    if data.startswith(b'\xff\xd8\xff') and b'\xff\xd9' in data[-64:]:
        return 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n') and b'IEND\xaeB`\x82' in data[-40:]:
        return 'image/png'
    if data.startswith((b'GIF87a', b'GIF89a')) and data.rstrip(b'\x00').endswith(b';'):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP' and len(data) == struct.unpack_from('<I', data, 4)[0] + 8:
        return 'image/webp'
    return None


def decrypt_image(data, cfg_dword=None, wxid=''):
    plain = decrypt_image_payload(data, cfg_dword, wxid)
    if plain.startswith(b'wxgf'):
        from .wxgf import decode
        return decode(plain)
    return plain


def decrypt_image_payload(data, cfg_dword=None, wxid=''):
    """Keep original decrypted bytes available for a message's MD5 check."""
    if signature(data):
        return data
    if data.startswith(b'wxgf'):
        return data
    if data.startswith(b'\x07\x08V2\x08\x07'):
        if cfg_dword is None or not wxid or len(data) < 31:
            raise ArchiveError('图片解密凭据不可用')
        aes_size, xor_size = struct.unpack_from('<II', data, 6)
        block_size = aes_size + 16 - aes_size % 16
        if block_size > len(data) - 15 or xor_size > len(data) - 15 - block_size:
            raise ArchiveError('图片文件尚未完整接收')
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        key = hashlib.md5((str(cfg_dword) + wxid).encode()).hexdigest()[:16].encode()
        decoder = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
        decrypted = decoder.update(data[15:15 + block_size]) + decoder.finalize()
        padding = decrypted[-1]
        if not 1 <= padding <= 16 or decrypted[-padding:] != bytes([padding]) * padding:
            raise ArchiveError('图片解密校验失败')
        end = len(data) - xor_size if xor_size else len(data)
        plain = decrypted[:-padding] + data[15 + block_size:end]
        if xor_size:
            plain += bytes(x ^ (cfg_dword & 255) for x in data[end:])
    else:
        body = data[22:] if data.startswith(b'\x07\x08\x05V\x02\x05') else data
        plain = b''
        for header in (b'\xff\xd8\xff', b'\x89PNG', b'GIF8', b'RIFF', b'wxgf'):
            if not body:
                break
            candidate = bytes(x ^ (body[0] ^ header[0]) for x in body)
            if candidate.startswith(header) and (signature(candidate) or header == b'wxgf'):
                plain = candidate
                break
    # Some containers append a short footer after the actual image terminator.
    for start, marker in ((b'\xff\xd8', b'\xff\xd9'), (b'\x89PNG', b'IEND\xaeB`\x82')):
        at = plain.rfind(marker)
        if plain.startswith(start) and at >= 0 and len(plain) - at - len(marker) <= 32:
            plain = plain[:at + len(marker)]
    if plain.startswith(b'wxgf'):
        return plain
    if not signature(plain):
        raise ArchiveError('图片格式未通过完整性校验')
    return plain


def account_path(config):
    base = Path(config['db_dir']).resolve()
    account = (base / config['account_dir']).resolve()
    if account.parent != base or not account.is_dir():
        raise ArchiveError('账号目录无效')
    return account


def image_candidates(config, message, spec, *, thumbnails=False):
    source = message['_source']
    packed = restored(source.get('packed_info_data'))
    ids = []
    if isinstance(packed, bytes):
        ids.extend(x.decode().lower() for x in re.findall(rb'[a-fA-F0-9]{32}', packed))
    ids += [v.lower() for k, v in spec['attributes'].items()
            if k in ('md5', 'originsourcemd5') and re.fullmatch(r'[a-fA-F0-9]{32}', v)]
    base = account_path(config) / 'msg' / 'attach' / hashlib.md5(config['group_id'].encode()).hexdigest()
    candidates = []
    index = config.get('_image_file_index')
    # Prefer original quality across all identifiers, not just the first one.
    variants = (('_t.dat', 'thumbnail'),) if thumbnails else (('_h.dat', 'original'), ('.dat', 'received'))
    for suffix, tier in variants:
        for md5 in dict.fromkeys(ids):
            paths = index.get(md5 + suffix, ()) if index is not None else base.glob('*/Img/' + md5 + suffix)
            for path in sorted(paths):
                if path.resolve().is_relative_to(base.resolve()):
                    candidates.append((path, tier))
    # A thumbnail alone cannot satisfy an image message.
    return candidates


def index_image_files(config):
    """One group-scoped directory pass per batch; keep thumbnail tiers explicit.

    Rebuild on the next read so newly downloaded originals are discovered.
    The index stays in memory and never enters configuration or receipts.
    """
    base = account_path(config) / 'msg' / 'attach' / hashlib.md5(config['group_id'].encode()).hexdigest()
    index = {}
    for directory in base.glob('*/Img'):
        if not directory.resolve().is_relative_to(base.resolve()):
            continue
        for path in directory.iterdir():
            if (re.fullmatch(r'[a-fA-F0-9]{32}(?:_[ht])?\.dat', path.name, re.I)
                    and path.is_file() and path.resolve().is_relative_to(base.resolve())):
                index.setdefault(path.name.lower(), []).append(path)
    return index


def scope(config):
    return digest([config['account_id'], config['group_id']])


def load_resources(root, config):
    file = Path(root) / 'resources.json'
    if not file.exists():
        return {'version': 1, 'scope': scope(config), 'messages': {}}
    result = json.loads(file.read_text(encoding='utf-8'))
    if result.get('version') != 1 or result.get('scope') != scope(config):
        raise ArchiveError('附件归档与所选账号或群不一致')
    return result


def save_blob(root, data, mime, name, **extra):
    if not data or len(data) > MAX_RESOURCE_BYTES:
        raise ArchiveError('附件为空或超过单项读取上限')
    key = hashlib.sha256(data).hexdigest()
    directory = Path(root) / 'assets' / 'blobs'
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / key
    if file.exists():
        if hashlib.sha256(file.read_bytes()).hexdigest() != key:
            raise ArchiveError('已保存附件校验失败')
    else:
        # Exclusive creation; a failed write never registers a ready receipt.
        import os
        import uuid
        temporary = directory / (key + '.' + uuid.uuid4().hex + '.tmp')
        from .storage import allocation
        try:
            with allocation(root,len(data)):
                with temporary.open('xb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, file)
        finally:
            temporary.unlink(missing_ok=True)
    return {'id': key, 'mime': mime, 'bytes': len(data), 'name': name, **extra}


def blob_path(root, asset):
    if not re.fullmatch(r'[a-f0-9]{64}', asset.get('id', '')):
        raise ArchiveError('附件标识无效')
    base = (Path(root) / 'assets' / 'blobs').resolve()
    file = (base / asset['id']).resolve()
    if file.parent != base or not file.is_file() or file.stat().st_size != asset['bytes']:
        raise ArchiveError('附件文件缺失或长度变化，请重新补取')
    if hashlib.sha256(file.read_bytes()).hexdigest() != asset['id']:
        raise ArchiveError('附件校验失败，请重新补取')
    return file


def browser_resources(message, inventory):
    specs = requirements(message)
    record = inventory['messages'].get(message['platformMessageId'], {})
    items = record.get('items', [])
    result = []
    for index, spec in enumerate(specs):
        if spec['kind'] in EXCLUDED_KINDS:
            result.append(dict(kind=spec['kind'],label=LABELS[spec['kind']],status='excluded',
                               text=LABELS[spec['kind']]+'内容未读取'))
            continue
        item = items[index] if index < len(items) else {}
        public = {k: item[k] for k in ('status', 'error', 'error_code', 'detail', 'text', 'assets', 'title') if k in item}
        if spec['kind'] == 'image' and item.get('status') != 'ready' and 'error_code' not in item:
            # Old receipts were recorded before diagnosis codes existed.
            public['error'] = '未找到图片文件' if not item or '本机尚无' in item.get('error', '') else '图片解析失败'
        if 'assets' in public:
            public['assets'] = [{k: a[k] for k in ('id', 'mime', 'bytes', 'name', 'tier') if k in a}
                                for a in public['assets'] if a['mime'].startswith('image/')]
        category = item.get('kind', spec['kind'])
        result.append(dict(public, kind=category, label=LABELS[category],
                           status=item.get('status', 'pending')))
    return result


def coverage(messages, inventory):
    return coverage_specs(resource_specs(messages), inventory)


def resource_specs(messages):
    """Small immutable expectation index; independent of download progress."""
    return [(message['platformMessageId'], [spec['kind'] for spec in specs])
            for message in messages if (specs := requirements(message))]


def coverage_specs(specs, inventory):
    count = ready = 0
    missing = {}
    for message_id, kinds in specs:
        items = inventory['messages'].get(message_id, {}).get('items', [])
        for index, kind in enumerate(kinds):
            if kind in EXCLUDED_KINDS:
                continue
            resource = items[index] if index < len(items) else {}
            count += 1
            if resource.get('status') == 'ready':
                ready += 1
            else:
                label = LABELS[resource.get('kind', kind)]
                missing[label] = missing.get(label, 0) + 1
    return {'total': count, 'ready': ready, 'missing': count - ready, 'by_kind': missing,
            'complete': count == ready}


def fetch_public(url, limit=MAX_RESOURCE_BYTES, redirects=4):
    """No cookies/proxy, public HTTP(S) only, with DNS pinned to the checked IP.

    URLs are untrusted chat content. Recheck each redirect and every address;
    never let an archived link reach localhost, the LAN or cloud metadata.
    """
    import http.client
    import ipaddress
    import socket
    import ssl
    from urllib.parse import urlsplit, urljoin
    deadline = time.monotonic() + 30
    for _ in range(redirects + 1):
        if time.monotonic() >= deadline:
            raise ArchiveError('内容下载达到本次时限，可稍后补取')
        try:
            parsed = urlsplit(url)
            port = parsed.port or (443 if parsed.scheme == 'https' else 80)
            if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                    or parsed.username or parsed.password or port not in (80, 443)):
                raise ValueError()
            addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(
                parsed.hostname, port, type=socket.SOCK_STREAM)))
            if not addresses or any(not ipaddress.ip_address(addr).is_global for addr in addresses):
                raise ValueError()
        except (ValueError, OSError):
            raise ArchiveError('链接地址不可公开访问') from None
        host = parsed.hostname
        class PinnedConnection(http.client.HTTPConnection):
            def connect(self):
                self.sock = socket.create_connection((addresses[0], port), self.timeout)
                if parsed.scheme == 'https':
                    self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=host)
        connection = PinnedConnection(host, port, timeout=max(.1, min(20, deadline - time.monotonic())))
        try:
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
            connection.request('GET', path, headers={'User-Agent': 'Observer-WeChat-Archive/1.0',
                                                     'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ArchiveError('网页重定向缺少目标')
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ArchiveError('内容服务器未返回完整文件（HTTP ' + str(response.status) + '）')
            if response.getheader('Content-Encoding', 'identity') not in ('identity', ''):
                raise ArchiveError('网站返回了暂不支持的内容编码')
            expected = response.getheader('Content-Length')
            if expected and (not expected.isdecimal() or int(expected) > limit):
                raise ArchiveError('内容超过单项读取上限')
            chunks, size = [], 0
            while size <= limit:
                if time.monotonic() >= deadline:
                    raise ArchiveError('内容下载达到本次时限，可稍后补取')
                # read1 returns after one socket read, letting the total deadline
                # apply even when a server slowly trickles an endless body.
                chunk = response.read1(min(65536, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk); size += len(chunk)
            data = b''.join(chunks)
            if len(data) > limit or (expected and len(data) != int(expected)):
                raise ArchiveError('内容超出上限或尚未完整传输')
            return data, response.getheader('Content-Type', 'application/octet-stream'), url
        except (OSError, http.client.HTTPException, ValueError):
            raise ArchiveError('内容下载失败，请稍后补取') from None
        finally:
            connection.close()
    raise ArchiveError('网站重定向次数过多')


def webpage(data, mime, url):
    from html.parser import HTMLParser
    from urllib.parse import urljoin
    encoding = re.search(r'charset=["\']?([\w-]+)', mime, re.I)
    if not encoding:
        encoding = re.search(rb'charset\s*=\s*["\']?([\w-]+)', data[:4096], re.I)
    charset = encoding[1] if encoding else 'utf-8'
    if isinstance(charset, bytes):
        charset = charset.decode('ascii')
    try:
        text = data.decode(charset)
    except (LookupError, UnicodeDecodeError):
        raise ArchiveError('网页正文编码无法完整识别') from None
    class Page(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.ignored = 0
            self.text = []
            self.images = []
        def handle_starttag(self, tag, attrs):
            if tag in ('script', 'style', 'noscript'):
                self.ignored += 1
            if tag == 'img' and not self.ignored:
                attrs = dict(attrs)
                target = attrs.get('data-src') or attrs.get('src')
                if target and not target.startswith('data:'):
                    self.images.append(urljoin(url, target))
                elif target:
                    self.images.append(target)
        def handle_endtag(self, tag):
            if tag in ('script', 'style', 'noscript'):
                self.ignored = max(0, self.ignored - 1)
        def handle_data(self, value):
            if not self.ignored and value.strip():
                self.text.append(value.strip())
    page = Page()
    page.feed(text)
    body = '\n'.join(page.text)
    if len(body) < 80 or re.search(r'环境异常|验证后继续访问|完成验证后|请在微信客户端打开', body):
        raise ArchiveError('网站需要登录、验证或客户端读取，请处理后补取正文')
    return body, list(dict.fromkeys(page.images))


def collect_one(root, config, message, spec, image_key=None, fetcher=fetch_public):
    category = spec['kind']
    if category in ('card','forward'):
        from .cards import card, forward
        return (card if category == 'card' else forward)(root,config,message,spec,image_key,fetcher)
    if category == 'image':
        from .cards import ResourceIncomplete
        paths = image_candidates(config, message, spec)
        errors = []
        for file, tier in paths:
            try:
                if file.stat().st_size > MAX_RESOURCE_BYTES:
                    raise ArchiveError('图片超过单项读取上限')
                data = decrypt_image(file.read_bytes(), image_key, config['account_id'])
                return {'assets': [save_blob(root, data, signature(data), '图片', tier=tier)]}
            except (ArchiveError, OSError) as exc:
                errors.append(str(exc) if isinstance(exc, ArchiveError) else '文件被占用或无法读取')
        previews = []
        thumbnails = image_candidates(config, message, spec, thumbnails=True)
        for file, tier in thumbnails:
            try:
                if file.stat().st_size > MAX_RESOURCE_BYTES:
                    continue
                data = decrypt_image(file.read_bytes(), image_key, config['account_id'])
                previews = [save_blob(root, data, signature(data), '图片缩略图', tier=tier)]
                break
            except (ArchiveError, OSError) as exc:
                if not errors:
                    errors.append(str(exc) if isinstance(exc, ArchiveError) else '文件被占用或无法读取')
        if paths or (thumbnails and not previews):
            code, reason = 'decode_failed', '图片解析失败'
        elif previews:
            code, reason = 'thumbnail_only', '仅有缩略图'
        else:
            code, reason = 'file_missing', '未找到图片文件'
        detail = errors[0] if errors else '请在电脑微信中打开大图后重试'
        raise ResourceIncomplete(reason, dict(error_code=code, detail=detail, assets=previews))
    if category == 'sticker':
        attrs = spec['attributes']
        url = attrs.get('cdnurl') or attrs.get('thumburl')
        # A thumb-only URL cannot satisfy a full sticker.
        if not attrs.get('cdnurl'):
            raise ArchiveError('表情包缺少完整文件地址，需要从微信补取')
        data, _, _ = fetcher(url)
        mime = signature(data)
        if not mime:
            raise ArchiveError('表情包文件未通过完整性校验')
        expected = attrs.get('md5', '').lower()
        if expected and hashlib.md5(data).hexdigest() != expected:
            raise ArchiveError('表情包与消息的文件指纹不一致')
        return {'assets': [save_blob(root, data, mime, '表情包', tier='received')]}
    if category == 'website':
        data, mime, final_url = fetcher(spec.get('url', ''))
        if mime.split(';')[0].strip() not in ('text/html', 'application/xhtml+xml'):
            raise ArchiveError('网站返回的不是可读取网页正文')
        text, images = webpage(data, mime, final_url)
        assets = [save_blob(root, data, 'application/octet-stream', '网页原始文件.html')]
        for url in images:
            if url.startswith('data:'):
                header, encoded = url.split(',', 1)
                if ';base64' not in header:
                    raise ArchiveError('网页图片编码暂不支持')
                picture = base64.b64decode(encoded, validate=True)
            else:
                picture, _, _ = fetcher(url)
            image_mime = signature(picture)
            if not image_mime:
                raise ArchiveError('网页中有图片尚未完整读取')
            assets.append(save_blob(root, picture, image_mime, '网页图片'))
        return {'text': text, 'title': spec.get('title') or '网页', 'assets': assets}
    if category == 'location' and spec['attributes']:
        attrs = spec['attributes']
        text = '\n'.join(attrs[k] for k in ('label', 'poiname', 'x', 'y', 'scale') if attrs.get(k))
        if text:
            return {'text': text, 'assets': []}
    if category in ('file', 'video'):
        account = account_path(config)
        if category == 'video':
            packed = restored(message['_source'].get('packed_info_data'))
            ids = re.findall(rb'[a-f0-9]{32}', packed or b'') if isinstance(packed, bytes) else []
            names = [x.decode() + '.mp4' for x in ids]
            folder = account / 'msg' / 'video'
        else:
            # Never select an arbitrary same-named file elsewhere in the account.
            title = spec.get('title', '')
            if not title or Path(title).name != title or any(x in title for x in ('/', '\\', ':', '\x00')):
                raise ArchiveError('文件名无法安全定位')
            names = [title]
            folder = account / 'msg' / 'file'
        paths = sorted({p.resolve() for name in names for month in folder.glob('*') for p in [month / name]
                        if p.is_file()
                        if p.resolve().is_relative_to(folder.resolve())})
        if len(paths) != 1:
            raise ArchiveError('完整文件尚未下载或有同名歧义，请在微信中加载后补取')
        path = paths[0]
        if path.stat().st_size > MAX_RESOURCE_BYTES:
            raise ArchiveError('文件超过单项读取上限')
        data = path.read_bytes()
        if category == 'video' and (len(data) < 12 or data[4:8] != b'ftyp'):
            raise ArchiveError('视频文件格式校验失败')
        if category == 'file':
            app = xml_root(spec.get('xml', ''))
            md5 = app.findtext('.//md5', '') if app is not None else ''
            if not re.fullmatch(r'[a-fA-F0-9]{32}', md5):
                raise ArchiveError('文件缺少可核验指纹，不能仅按同名文件确认读取成功')
            if hashlib.md5(data).hexdigest() != md5.lower():
                raise ArchiveError('文件与消息的指纹不一致')
            from .documents import read_document
            from .cards import ResourceIncomplete
            original = save_blob(root,data,'application/octet-stream',path.name)
            try:
                result = read_document(root,data,path.name,fetcher)
                result['assets'].insert(0,original)
                return result
            except ArchiveError as exc:
                raise ResourceIncomplete(str(exc),{'assets':[original]}) from None
        return {'assets': [save_blob(root, data, 'video/mp4' if category == 'video' else
                                    'application/octet-stream', path.name)]}
    raise ArchiveError(LABELS[category] + '需要补充完整内容读取通道')


def collect_resources(root, config, messages, image_key=None, fetcher=fetch_public, *, max_seconds=None, images_only=False):
    """Retry missing items, retain successful files, record every failure by message."""
    inventory = load_resources(root, config)
    deadline = time.monotonic() + max_seconds if max_seconds is not None else None
    work = [(message, specs) for message in messages if (specs := requirements(message))]
    if images_only:
        work = [(m, specs) for m, specs in work if any(s['kind'] == 'image' for s in specs)]
    # Thousands of missing images must not cause thousands of repeated scans
    # of the same month's attachment directory.
    if any(spec['kind'] == 'image' for _, specs in work for spec in specs):
        config = dict(config, _image_file_index=index_image_files(config))
    # A repeatedly failing old URL must not starve as-yet-unread history.
    work.sort(key=lambda task: task[0]['platformMessageId'] in inventory['messages'])

    def read_message(message, specs):
        message_id = message['platformMessageId']
        prior = inventory['messages'].get(message_id, {}).get('items', [])
        items = []
        for index, spec in enumerate(specs):
            previous = prior[index] if index < len(prior) else {}
            if images_only and spec['kind'] != 'image':
                items.append(previous or dict(kind=spec['kind'],status='pending'))
                continue
            if spec['kind'] in EXCLUDED_KINDS:
                # Keep historical receipts/blobs until an explicit cleanup.
                items.append(previous or dict(kind=spec['kind'],status='excluded'))
                continue
            if (spec['kind']=='image' and previous.get('error_code')=='thumbnail_only'
                    and previous.get('assets') and not image_candidates(config,message,spec)):
                try:
                    for asset in previous['assets']:
                        blob_path(root,asset)
                    items.append(previous)
                    continue
                except ArchiveError:
                    pass
            if previous.get('status') == 'ready':
                try:
                    for asset in previous.get('assets', []):
                        blob_path(root, asset)
                    if (spec['kind'] == 'image' and
                            not any(a.get('tier') == 'original' for a in previous.get('assets', [])) and
                            any(tier == 'original' for _, tier in image_candidates(config, message, spec))):
                        try:
                            upgraded = collect_one(root, config, message, spec, image_key, fetcher)
                            items.append(dict(upgraded, kind='image', status='ready'))
                            continue
                        except (ArchiveError, OSError):
                            pass  # Retain the verified full received image.
                    items.append(previous)
                    continue
                except ArchiveError:
                    pass
            try:
                item_deadline = time.monotonic() + 120
                def bounded_fetch(url):
                    if time.monotonic() >= item_deadline:
                        raise ArchiveError('该项内容读取达到本次时限，可继续补取')
                    return fetcher(url)
                result = collect_one(root, config, message, spec, image_key, bounded_fetch)
                items.append(dict(result, kind=spec['kind'], status='ready'))
            except Exception as exc:
                from .cards import ResourceIncomplete
                reason = str(exc) if isinstance(exc, ArchiveError) else '内容读取失败，请重新补取'
                partial = exc.partial if isinstance(exc, ResourceIncomplete) else {}
                items.append(dict(partial, status='missing', kind=spec['kind'], error=reason))
        return message_id, {'items': items}

    # At most four network/file readers, with all inventory writes on this
    # coordinating thread. Checkpoint batches avoid rewriting the multi-MB
    # inventory for every thumbnail; flush all completed work on exit as well.
    remaining = iter(work)
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='wechat-resource')
    pending = set()
    dirty = 0
    last_saved = time.monotonic()
    try:
        for task in remaining:
            if deadline is not None and time.monotonic() >= deadline:
                break
            pending.add(pool.submit(read_message, *task))
            if len(pending) == 4:
                break
        while pending:
            finished, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in finished:
                message_id, record = future.result()
                if inventory['messages'].get(message_id) != record:
                    inventory['messages'][message_id] = record
                    dirty += 1
                if dirty and (dirty >= 16 or time.monotonic() - last_saved >= .5):
                    atomic_json(Path(root) / 'resources.json', inventory)
                    dirty = 0
                    last_saved = time.monotonic()
                task = next(remaining, None) if deadline is None or time.monotonic() < deadline else None
                if task is not None:
                    pending.add(pool.submit(read_message, *task))
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        if dirty:
            atomic_json(Path(root) / 'resources.json', inventory)
    return coverage(messages, inventory)


def missing_resources(prepared):
    gaps = []
    for message in prepared['messages']:
        source = prepared.get('sources', {}).get(message['id'], {})
        for resource in message.get('resources', []):
            if resource.get('status') not in ('ready', 'excluded'):
                gaps.append({'message': message['id'], 'time': message['time'],
                             'sender': source.get('sender', ''), 'kind': resource['kind'],
                             'label': resource['label'],
                             'reason': resource.get('error') or '尚未读取完整内容'})
    return gaps


def require_summary_resources(prepared, *, allow_media=False, allow_missing=False):
    report = prepared.get('resource_coverage', {})
    if report.get('missing', 0) and not allow_missing:
        raise ArchiveError('附件或网页内容尚未取齐，请先补取后再生成总结')
    for message in prepared['messages']:
        for resource in message.get('resources', []):
            if resource.get('status') == 'excluded':
                continue
            if allow_missing and resource.get('status') != 'ready':
                continue
            if resource['kind'] in ('audio', 'video', 'file', 'forward', 'card', 'unknown') and not resource.get('text'):
                if allow_media and any(asset.get('mime','').startswith(('audio/','video/')) for asset in resource.get('assets',[])):
                    continue
                raise ArchiveError(resource['label'] + '尚未完成内容解析，暂不生成缺少该内容的总结')


MAX_SUMMARY_IMAGE_BYTES = 40 * 1024 * 1024
MAX_SUMMARY_IMAGE_COUNT = 64


def summary_images(root, prepared, *, temporary_dir=None, skipped=None):
    images = []
    total_bytes = 0
    candidates = []
    for message in prepared['messages']:
        for resource in message.get('resources', []):
            for asset in resource.get('assets', []):
                if asset['mime'].startswith('image/') and asset.get('tier') != 'thumbnail':
                    candidates.append((message, resource, asset))
    # Read all static images before expanding animation frames; a long sticker
    # must never consume the input budget ahead of a later static chat image.
    def image_order(row):
        animated = False
        if row[2]['mime'] in ('image/gif','image/webp','image/png'):
            from PIL import Image
            try:
                with Image.open(blob_path(root,row[2])) as picture:
                    animated = getattr(picture,'n_frames',1) > 1
            except (ArchiveError,OSError,ValueError,EOFError):
                pass  # The normal per-image path records the failure below.
        return animated, row[1].get('kind') != 'image'
    candidates.sort(key=image_order)
    for message, resource, asset in candidates:
        generated = []
        try:
            file = blob_path(root, asset)
            batch = [(message['id'], asset, file)]
            if asset['mime'] in ('image/gif','image/webp','image/png'):
                from PIL import Image
                from io import BytesIO
                try:
                    with Image.open(file) as animation:
                        count = getattr(animation, 'n_frames', 1)
                        if len(images) + count > MAX_SUMMARY_IMAGE_COUNT:
                            raise ArchiveError('图片或动图完整帧数超过本次输入上限，未送入模型')
                        if count > 1:
                            batch = []
                            batch_bytes = 0
                            for index in range(count):
                                animation.seek(index)
                                picture = animation.convert('RGBA')
                                output = BytesIO(); picture.save(output,format='PNG')
                                data = output.getvalue()
                                batch_bytes += len(data)
                                if total_bytes + batch_bytes > MAX_SUMMARY_IMAGE_BYTES:
                                    raise ArchiveError('图片或动图完整大小超过本次输入上限，未送入模型')
                                metadata = dict(source_id=asset['id'],frame_index=index+1,frame_count=count,
                                                duration_ms=animation.info.get('duration',0))
                                if temporary_dir is None:
                                    frame = save_blob(root,data,'image/png','动图完整帧',**metadata)
                                    frame_path = blob_path(root,frame)
                                else:
                                    key = hashlib.sha256(data).hexdigest()
                                    frame_path = Path(temporary_dir) / (key + '.png')
                                    frame_path.write_bytes(data)
                                    generated.append(frame_path)
                                    frame = dict(id=key,bytes=len(data),mime='image/png',name='动图完整帧',**metadata)
                                batch.append((message['id'],frame,frame_path))
                except (OSError, ValueError, EOFError):
                    raise ArchiveError('图片或动图未能完整解码，未送入模型') from None
            size = sum(item[1]['bytes'] for item in batch)
            if total_bytes + size > MAX_SUMMARY_IMAGE_BYTES or len(images) + len(batch) > MAX_SUMMARY_IMAGE_COUNT:
                raise ArchiveError('图片完整输入超过本次上限，未送入模型')
            images.extend(batch)
            total_bytes += size
        except ArchiveError as exc:
            accepted_paths = {item[2] for item in images}
            for path in generated:
                if path not in accepted_paths:
                    path.unlink(missing_ok=True)
            if skipped is None:
                raise
            source = prepared.get('sources',{}).get(message['id'],{})
            skipped.append(dict(message=message['id'],time=message.get('time',''),sender=source.get('sender',''),
                                kind=resource.get('kind','image'),label=resource.get('label','图片'),reason=str(exc)))
    return images
