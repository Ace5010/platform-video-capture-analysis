"""Decode complete WXGF stills, including their separate alpha plane.

Container layout reference: https://sarv.blog/posts/wxam/
Never select only the largest partition: smaller partitions can carry alpha or
additional frames. Unsupported animation metadata remains an explicit failure.
"""
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from .archive import ArchiveError

MAX_PIXELS = 32 * 1024 * 1024


def partitions(data):
    if len(data) < 15 or data[:4] != b'wxgf' or not 11 <= data[4] < len(data):
        raise ArchiveError('WXGF 图片头不完整')
    width, height = int.from_bytes(data[7:9], 'big'), int.from_bytes(data[9:11], 'big')
    if not width or not height or width * height > MAX_PIXELS:
        raise ArchiveError('WXGF 图片尺寸无效或超过解码上限')
    chunks, position = [], data[4]
    while match := re.search(b'\x00\x00\x00\x01|\x00\x00\x01', data[position:]):
        start = position + match.start()
        nal = start + len(match[0])
        # Extra headers can contain arbitrary binary metadata (including ICC
        # profiles). Before the first stream, require its VPS/SPS. Afterwards
        # retain dependent-frame partitions too; never silently skip animation.
        header = data[nal:nal + 2]
        if not chunks and header not in (b'\x40\x01', b'\x42\x01'):
            position = nal
            continue
        # Container metadata (including the checksum trailer) can also contain
        # start-code bytes. A HEVC NAL must have forbidden_zero_bit=0 and a
        # nonzero temporal_id_plus1; preserve valid dependent/alpha streams.
        if len(header) < 2 or header[0] & 0x80 or not header[1] & 7 or (header[0] >> 1) > 40:
            position = nal
            continue
        length = int.from_bytes(data[start - 4:start], 'big')
        if length < len(match[0]) + 2 or start + length > len(data):
            raise ArchiveError('WXGF 图片分片不完整')
        chunks.append(data[start:start + length])
        position = start + length
    if not chunks:
        raise ArchiveError('WXGF 图片缺少画面数据')
    return width, height, chunks


def _run(args):
    try:
        result = subprocess.run(args, capture_output=True, timeout=45,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    except (OSError, subprocess.TimeoutExpired):
        raise ArchiveError('WXGF 解码组件不可用或处理超时') from None
    # ffmpeg may report a broken stream but still output a concealed frame.
    if result.returncode or result.stderr.strip():
        raise ArchiveError('WXGF 画面未通过完整解码校验')
    return result.stdout


def decode(data):
    from PIL import Image
    width, height, chunks = partitions(data)
    if len(chunks) > 2:
        raise ArchiveError('WXGF 动图仍需核验完整帧序列与播放时序')
    planes = []
    with tempfile.TemporaryDirectory(prefix='observe-wxgf-') as directory:
        for index, chunk in enumerate(chunks):
            file = Path(directory) / f'{index}.hevc'
            file.write_bytes(chunk)
            probe = json.loads(_run(['ffprobe', '-v', 'error', '-threads', '1', '-count_frames',
                                    '-show_entries', 'stream=width,height,pix_fmt,nb_read_frames',
                                    '-of', 'json', str(file)]))
            streams = probe.get('streams', [])
            if len(streams) != 1:
                raise ArchiveError('WXGF 图片画面流数量无效')
            stream = streams[0]
            # HEVC chroma planes pad odd dimensions to the next even pixel.
            if (stream.get('nb_read_frames') != '1' or
                    stream.get('width') not in (width, width + width % 2) or
                    stream.get('height') not in (height, height + height % 2)):
                raise ArchiveError('WXGF 图片尺寸或完整帧数不匹配')
            gray = stream.get('pix_fmt', '').startswith('gray')
            raw = _run(['ffmpeg', '-v', 'error', '-xerror', '-threads', '1', '-i', str(file),
                        '-filter_threads', '1', '-vf', f'crop={width}:{height}:0:0:exact=1',
                        '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'gray' if gray else 'rgba', '-'])
            if len(raw) != width * height * (1 if gray else 4):
                raise ArchiveError('WXGF 图片像素不完整')
            planes.append((gray, Image.frombytes('L' if gray else 'RGBA', (width, height), raw)))
    if len(planes) == 1:
        picture = planes[0][1].convert('RGBA')
    elif planes[0][0] and not planes[1][0]:
        picture = planes[1][1]
        picture.putalpha(planes[0][1])
    else:
        raise ArchiveError('WXGF 图片透明层与画面无法完整配对')
    output = BytesIO()
    picture.save(output, format='PNG')
    return output.getvalue()
