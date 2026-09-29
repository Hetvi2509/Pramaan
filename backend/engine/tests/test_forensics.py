"""Synthetic parser fixtures are intentionally not evidence of real-device coverage."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

from dvr_scan.forensics import identify, parse, extract, hash_evidence, upscale
from dvr_scan.hikvision.helpers import ImageReader


def hikvision_fixture(filename, h264=b"\0\0\0\1\x67synthetic"):
    block = 0x5000
    block_size = len(h264) + 112
    data = bytearray(block + block_size)
    signature = b"HIKVISION@HANGZHOU"
    data[512:512 + len(signature)] = signature
    log = b'RATS\x14\x00\x00\x00' + struct.pack('<IH', 1600000000, 3) + b'admin login'
    data[0x4500:0x4500 + len(log)] = log
    fields = [(55, 'Q', len(data)), (79, 'Q', 0x4500), (87, 'Q', len(log)), (103, 'Q', block),
              (119, 'Q', block_size), (127, 'I', 1), (135, 'Q', 0x1000), (143, 'I', 256),
              (151, 'Q', 0x1000), (159, 'I', 256)]
    for offset, kind, value in fields: struct.pack_into('<' + kind, data, 512 + offset + len(signature) - 17, value)
    data[0x1000:0x1008] = b'HIKBTREE'
    struct.pack_into('<Q', data, 0x1000 + 48, 0x4000)
    struct.pack_into('<Q', data, 0x1000 + 64, 0x2000)
    struct.pack_into('<Q', data, 0x1000 + 72, 0x3000)
    struct.pack_into('<I', data, 0x2000, 1)
    struct.pack_into('<Q', data, 0x2000 + 80, 0x3000)
    struct.pack_into('<Q', data, 0x3000 + 16, 0xffffffffffffffff)
    entry = 0x3000 + 80
    data[entry:entry+8] = b'\xff' * 8
    data[entry+17] = 1
    struct.pack_into('<IIQ', data, entry + 24, 1600000000, 1600000001, block)
    data[0x4000:0x4008] = b'\xff' * 8
    data[block:block + len(h264)] = h264
    for index in range(2):
        address = block + len(h264) + 56 * index
        data[address:address+4] = b'OFNI'
        struct.pack_into('<I', data, address + 4, 56)
        struct.pack_into('<I', data, address + 24, 1600000000 + index)
    Path(filename).write_bytes(data)


class ForensicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)

    def reader(self, filename):
        reader = ImageReader(str(filename))
        reader.open()
        self.addCleanup(reader.close)
        return reader

    def test_hashes_and_unknown_format(self):
        filename = self.work / 'unknown.img'
        filename.write_bytes(b'ordinary evidence')
        reader = self.reader(filename)
        with contextlib.redirect_stdout(io.StringIO()): result = hash_evidence(reader)
        self.assertEqual(result['md5'], hashlib.md5(filename.read_bytes()).hexdigest())
        self.assertEqual(result['sha256'], hashlib.sha256(filename.read_bytes()).hexdigest())
        self.assertIsNone(identify(reader)['adapter'])
        with self.assertRaisesRegex(ValueError, 'No supported parser'): parse(reader, self.work)

    def test_niriksha_parsers_and_h264_export(self):
        ffmpeg = Path(__file__).resolve().parents[1] / 'ffmpeg.exe'
        raw = self.work / 'video.h264'
        subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5',
                        '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-f', 'h264', str(raw)], check=True)
        filename = self.work / 'synthetic-hikvision.img'
        hikvision_fixture(filename, raw.read_bytes())
        reader = self.reader(filename)
        bundle = parse(reader, self.work)
        self.assertEqual(bundle['identification']['family'], 'Hikvision')
        self.assertEqual(bundle['recordings'][0]['channel'], 1)
        self.assertIn('system_logs', bundle)
        self.assertEqual(len(bundle['system_logs']['system_logs']), 1)
        result = extract(reader, bundle, '0', self.work)
        cap = cv2.VideoCapture(result['output'])
        ok, frame = cap.read()
        cap.release()
        self.assertTrue(ok)
        self.assertEqual(frame.shape[:2], (120, 160))

    def test_dhav_validation_and_channels(self):
        filename = self.work / 'sample.dav'
        records = bytearray()
        for channel in (1, 2):
            header = bytearray(24)
            header[:4] = b'DHAV'
            header[6] = channel
            struct.pack_into('<I', header, 12, 36)
            records.extend(header + b'data' + b'dhav' + struct.pack('<I', 36))
        filename.write_bytes(records)
        bundle = parse(self.reader(filename), self.work)
        self.assertEqual([r['channel'] for r in bundle['recordings']], [1, 2])
        corrupt = self.work / 'broken.dav'
        corrupt.write_bytes(records[:-1])
        with self.assertRaises(ValueError): parse(self.reader(corrupt), self.work)

    def test_media_export_and_upscale(self):
        filename = self.work / 'input.avi'
        writer = cv2.VideoWriter(str(filename), cv2.VideoWriter_fourcc(*'MJPG'), 5, (160, 120))
        for _ in range(5): writer.write(np.zeros((120, 160, 3), dtype=np.uint8))
        writer.release()
        reader = self.reader(filename)
        bundle = parse(reader, self.work)
        result = extract(reader, bundle, '0', self.work)
        self.assertTrue(Path(result['output']).exists())
        image = self.work / 'image.png'
        cv2.imwrite(str(image), np.zeros((20, 40, 3), dtype=np.uint8))
        output = upscale(str(image), self.work, 3)
        self.assertEqual((output['width'], output['height']), (120, 60))
        self.assertIn('sha256', output['hashes'])


if __name__ == '__main__': unittest.main()
