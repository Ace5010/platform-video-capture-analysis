"""Synthetic complete image streams; no private WeChat files or keys."""
from io import BytesIO
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from host_service.wechat.archive import ArchiveError
from host_service.wechat.wxgf import partitions, decode


def container(parts, width=31, height=29, metadata=b''):
    return b'wxgf' + bytes([15]) + struct.pack('>HHH', 2, width, height) + b'\0'*4 + metadata + b''.join(
        struct.pack('>I', len(part)) + part for part in parts)


class WxgfTests(unittest.TestCase):
    def test_truncated_partition_and_oversized_dimensions_fail(self):
        part = b'\0\0\0\1\x40\1synthetic'
        data = container([part])
        self.assertEqual(partitions(data), (31, 29, [part]))
        with self.assertRaises(ArchiveError): partitions(data[:-1])
        with self.assertRaises(ArchiveError): partitions(container([part], 65535, 65535))

    def test_extra_metadata_is_not_a_frame_but_dependent_frames_are_preserved(self):
        parts = [b'\0\0\1\x40\1first', b'\0\0\1\x02\1dependent']
        data = container(parts, metadata=b'ICC\0\0\0\0\0\0\1\0\0metadata')
        self.assertEqual(partitions(data)[2], parts)
        with self.assertRaises(ArchiveError): decode(container(parts*2))

    def test_checksum_metadata_after_complete_partition_is_not_an_extra_frame(self):
        part = b'\0\0\1\x40\1complete'
        for header in (b'\x1f\xc8', b'\xdd\xe3', b'\x70\x3d'):
            trailer = b'\x73\x13\x57\x21\0\0\0\1' + header + b'checksum-bytes'
            self.assertEqual(partitions(container([part]) + trailer)[2], [part])
        # A real dependent frame with an invalid length must still fail.
        with self.assertRaises(ArchiveError):
            partitions(container([part]) + struct.pack('>I', 40) + b'\0\0\1\x02\1truncated')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg is required')
    def test_real_hevc_pixels_alpha_odd_dimensions_and_all_frames(self):
        from PIL import Image
        def hevc(color, gray=False, frames=1):
            args = ['ffmpeg','-v','error','-f','lavfi','-i',f'color={color}:size=32x30:rate=1',
                    '-frames:v',str(frames),'-filter_threads','1','-pix_fmt','gray' if gray else 'yuv420p',
                    '-c:v','libx265','-threads','1','-x265-params','pools=none:frame-threads=1:log-level=error',
                    '-f','hevc','-']
            result = subprocess.run(args,capture_output=True,timeout=30,check=True)
            return result.stdout
        color, alpha = hevc('red'), hevc('white', True)
        for parts in ([color], [alpha,color]):
            image = Image.open(BytesIO(decode(container(parts))))
            image.load()
            self.assertEqual(image.size,(31,29))
            r,g,b,a = image.getpixel((15,15))
            self.assertGreater(r,230); self.assertLess(g,20); self.assertLess(b,20)
            self.assertGreater(a,230)
        with self.assertRaises(ArchiveError): decode(container([color,color]))
        with self.assertRaises(ArchiveError): decode(container([hevc('red',frames=2)]))
        with self.assertRaises(ArchiveError): decode(container([color])[:-15])


if __name__ == '__main__':
    unittest.main()
