"""Synthetic parser fixtures are intentionally not evidence of real-device coverage."""
import calendar
import contextlib
import hashlib
import io
import json
import re
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zlib

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


class SparseReader:
    """Evidence reader for a multi-GB disk that is mostly zeros: only the written extents exist."""
    is_ewf = False

    def __init__(self, size, image_path="synthetic.img"):
        self.image_size, self.image_path, self.extents = size, image_path, {}

    def write(self, offset, data):
        self.extents[offset] = bytes(data)

    def read(self, offset, size):
        size = max(0, min(size, self.image_size - offset))
        out = bytearray(size)
        for start, data in self.extents.items():
            lo, hi = max(offset, start), min(offset + size, start + len(data))
            if lo < hi:
                out[lo - offset:hi - offset] = data[lo - start:hi - start]
        return bytes(out)


def access_units(h264):
    """Split an Annex-B stream into (is_key, bytes) access units, keeping every start code."""
    starts = [m.start() for m in re.finditer(rb'\x00\x00\x00?\x01', h264)] + [len(h264)]
    units, current, has_vcl, key = [], 0, False, False
    for a, b in zip(starts, starts[1:]):
        nal = h264[a + (4 if h264[a + 2] == 0 else 3)] & 31
        if has_vcl and (nal in (6, 7, 8, 9) or nal in (1, 5)):
            units.append((key, h264[current:a]))
            current, has_vcl, key = a, False, False
        has_vcl, key = has_vcl or nal in (1, 5), key or nal == 5
    units.append((key, h264[current:]))
    return units


def honeywell_disk(streams, listed, groups):
    """SYNTHETIC Honeywell NVR disk laid out as in Yoon & Hwang (2026). It is not an image of a real recorder."""
    part, video, tail = 0x5000, 0x80000000, 8 * 1024 * 1024
    disk = SparseReader(part + video + tail, 'synthetic-honeywell.img')
    disk.write(510, b'\x55\xaa')
    gpt = bytearray(92)
    gpt[:8] = b'EFI PART'
    struct.pack_into('<QII', gpt, 72, 2, 128, 128)
    disk.write(512, gpt)
    entry = bytearray(128)
    entry[:16], entry[16:32] = bytes([1]) * 16, bytes([2]) * 16
    struct.pack_into('<QQ', entry, 32, part // 512, (part + video + tail) // 512 - 1)
    entry[56:56 + 22] = 'Partition 1'.encode('utf-16-le')
    disk.write(1024, entry)
    disk.write(0x4440, b'B011003AWFNRZEFKV')
    disk.write(0x446B, b'HN35080200')
    header = bytearray(0x4000)
    for offset, value in ((0, video // 0x1000), (8, 0x01BB349E), (0x10, 0x0007FF33), (0x18, 0x01BB33D1)):
        struct.pack_into('<I', header, offset, value)
    for i, start in enumerate(groups):
        struct.pack_into('<I', header, 0x40 + 16 * i + 4, start)
        header[0x40 + 16 * i + 12] = i + 1
    disk.write(part, header)
    channel_list = bytearray()
    for i, s in enumerate(streams):
        data = bytearray()
        for key, payload, ts in s['frames']:
            data += bytes([0x82 if key else 0x02]) + b'\x80\x01\x00' + struct.pack('<HHIQ', s['width'], s['height'], len(payload), ts) + payload
        data += bytes(20)  # end-of-channel delimiter
        disk.write(part + video + s['offset'], data)
        s['expected'] = b''.join(payload for _, payload, _ in s['frames'])
        if i in listed:
            item = bytearray(16)
            item[0], item[1] = s['channel'], s['kind']
            struct.pack_into('<HII', item, 2, -(-len(data) // 0x1000), s['frames'][0][2] // 10 ** 6, (video + s['offset']) // 0x1000)
            channel_list += item
    disk.write(part + 0x400000, channel_list)
    return disk


def h264_units(work, size, name, seconds=3, rate=10, gop=10):
    """Real H.264 access units from FFmpeg, as (is_key, bytes) pairs."""
    out = work / f'{name}.h264'
    w, h = size
    subprocess.run([str(Path(__file__).resolve().parents[1] / 'ffmpeg.exe'), '-y', '-v', 'error', '-f', 'lavfi', '-i',
                    f'testsrc=size={w}x{h}:rate={rate}', '-t', str(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
                    '-bf', '0', '-x264-params', f'keyint={gop}:scenecut=0:repeat-headers=1', '-f', 'h264', str(out)], check=True)
    return access_units(out.read_bytes())


def split_gops(units):
    """Access units grouped into GOPs, each starting at a key frame."""
    gops = []
    for key, payload in units:
        if key or not gops:
            gops.append([])
        gops[-1].append((key, payload))
    return gops


def _crc16(data):
    """CRC-16/ARC, written out independently of the code under test."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def uniview_disk(listed, unlisted_after_write, wiped_block, times):
    """SYNTHETIC Uniview UBS disk laid out as in a third party's disassembly of Uniview's storage driver. Not a real recorder image.
    listed: AUs of the GOPs the block's index names; unlisted_after_write: a GOP past the block's write position;
    wiped_block: a GOP in a block with no header and no abstract entry."""
    page, block, dz = 0x1000, 1 << 28, 0x100000
    disk = SparseReader(dz + 2 * block + 0x100000, 'synthetic-uniview.img')

    def gop(offset, sec, aus):
        body = bytearray(struct.pack('<I', 0x2006) + struct.pack('<IH', sec, 0) + bytes(14))
        for key, payload in aus:
            packet = bytearray(24)
            struct.pack_into('<I', packet, 0, 0x1357)
            packet[12], packet[17] = 2, 1
            struct.pack_into('<H', packet, 18, len(payload))
            body += packet + payload + bytes(4)
        body += struct.pack('<I', 0x6002)
        end = len(body)
        padded = -(-(end + 1) // page) * page
        body += bytes(padded - end - 8) + struct.pack('<II', end, 0x6003)
        disk.write(offset, body)
        return len(body)

    sup = bytearray(0x10000)
    struct.pack_into('<II', sup, 0, 0x20131031, 0x2000)
    sup[0x0C:0x0C + 11] = b'NVR301-TEST'
    struct.pack_into('<QIIQQ', sup, 0x60, disk.image_size, 2, page, 0x10000, dz)
    struct.pack_into('<I', sup, 0x88, times[0])
    struct.pack_into('<I', sup, 8, _crc16(bytes(sup)))
    disk.write(0, sup)
    disk.write(disk.image_size - 0x10000, sup)  # the copy at capacity - 64 KiB
    # abstract zone: group 0, entry for block 0 (channel 3)
    group = bytearray(page)
    struct.pack_into('<HxxI', group, 128, 1, 0x80)
    struct.pack_into('<4I', group, 128 + 0x10, 3, 0, 0, 0)
    struct.pack_into('<II', group, 128 + 0x20, times[0], times[0] + 2)
    struct.pack_into('<H', group, 0, _crc16(bytes(group)))
    disk.write(0x10000, group)
    # block 0: header, GOP index, two listed GOPs, then a GOP past the write position
    first, pages = 0x10, []
    header, index = bytearray(0x2000), bytearray()
    for i, aus in enumerate(listed):
        start = first + sum(pages)
        length = gop(dz + start * page, times[i], aus)
        pages.append(length // page)
        entry = bytearray(32)
        struct.pack_into('<IHB', entry, 0, times[i], 0, 1)
        struct.pack_into('<QHH', entry, 8, 0, length // page, start)
        index += entry
    write_page = first + sum(pages)
    struct.pack_into('<II', header, 0, 0x5050, 0x400)
    struct.pack_into('<4I', header, 0x10, 3, 0, 0, 0)
    struct.pack_into('<II', header, 0x20, times[0], times[0] + 2)
    struct.pack_into('<HH', header, 0x2C, len(listed), write_page)
    header[0x40:0x40 + 5] = b'CAM03'
    struct.pack_into('<H', header, 8, _crc16(bytes(header)))
    disk.write(dz, header)
    disk.write(dz + 0x2000, index)
    gop(dz + (write_page + 2) * page, times[2], unlisted_after_write)
    gop(dz + block + 0x10 * page, times[3], wiped_block)
    return disk


def qvfs_disk(runs, size=4 << 20):
    """SYNTHETIC Qualvision QVFS disk (the layout behind Godrej) as in a third party's disassembly of Qualvision firmware.
    runs: lists of (payload, packed date, ms); a payload not opening with a start code stands in for audio."""
    disk = bytearray(size)
    sectors = size // 512
    disk[:4] = b'QVEX'
    struct.pack_into('<7I', disk, 4, 0x00010000, 0x1234, sectors, 8, sectors - 16, 0, 0)
    pos = 4096
    for run in runs:
        for payload, packed, ms in run:
            disk[pos:pos + 20] = b'\x00\x00\x01\xe0' + struct.pack('<IIH', len(payload), packed, ms) + bytes(6)
            disk[pos + 20:pos + 20 + len(payload)] = payload
            pos += 20 + len(payload)
        pos += 4096  # a gap between runs
    return bytes(disk)


def dhtime(year, month, day, hour, minute, second):
    return ((year - 2000) << 26) | (month << 22) | (day << 17) | (hour << 12) | (minute << 6) | second


def dav_frame(ftype, counter, when, ms, payload, ext=b''):
    """One DHAV frame: 24-byte header with its checksum byte, extension, payload, then 'dhav' and the length."""
    length = 24 + len(ext) + len(payload) + 8
    head = bytearray(24)
    head[:4], head[4] = b'DHAV', ftype
    struct.pack_into('<IIIH', head, 8, counter, length, when, ms & 0xFFFF)
    head[22] = len(ext)
    head[23] = sum(head[:23]) & 0xFF
    return bytes(head) + ext + payload + b'dhav' + struct.pack('<I', length)


def dav_camera(units, counter0, start, size, fps=10):
    """A camera's video as DHAV frames (I-frames carry the resolution/codec/fps tags), with an audio frame each second."""
    ext = bytes([0x80, 0, size[0] // 8, size[1] // 8, 0x81, 0, 0x02, fps])
    out = []
    for i, (key, payload) in enumerate(units):
        when = dhtime(*start[:5], start[5] + i // fps)
        out.append({'bytes': dav_frame(0xFD if key else 0xFC, counter0 + i, when, (i % fps) * 100, payload, ext if key else b''),
                    'payload': payload, 'when': when})
        if i % fps == fps - 1:
            out.append({'bytes': dav_frame(0xF0, 7000 + i, when, 950, b'\xd5' * 40), 'payload': None, 'when': when})
    return out


def dhfs_disk(title=b'', clips=None, cs=0x5000, pad=0x1400, size=(160, 120)):
    """SYNTHETIC Dahua-family DHFS 4.1 volume laid out as in a third party's notes on one real disk, with the traps those notes describe: two
    cameras with near-identical clocks, a frame crossing a cluster end into the next physical cluster, another camera's frame spilled into the
    start of a cluster, and footage left in clusters the table calls empty. Not an image of a real recorder."""
    base, first, slots = 0x60000, 4, 13
    disk = SparseReader(base + slots * cs + 0x1000, 'synthetic-dhfs.img')
    ca, cb, cc = clips or (h264_units(Path(tempfile.mkdtemp()), size, n) for n in ('dh_a', 'dh_b', 'dh_c'))
    cam0 = dav_camera(ca, 100, (2025, 11, 26, 21, 0, 0), size)
    cam1 = dav_camera(cb, 5000, (2025, 11, 26, 21, 0, 30), size)
    old = dav_camera(cc, 9000, (2025, 11, 25, 10, 0, 0), size)
    foreign = dav_frame(0xFC, 5100, dhtime(2025, 11, 26, 21, 0, 2), 500, b'\x00\x00\x00\x01\x41' + b'F' * 60)

    def fill(frames, start=0, prefix=b'', cross=False):
        """Frames laid down from `start`. With cross, the frame that starts before the cluster end is written whole, even across it;
        otherwise a frame that would not fit is left for the next cluster."""
        data, used = bytearray(prefix), 0
        for fr in frames:
            if start + len(data) >= cs or (not cross and start + len(data) + len(fr['bytes']) > cs):
                break
            data += fr['bytes']
            used += 1
        return bytes(data), used

    c6, n6 = fill(cam0, cross=True)
    c7, n7 = fill(cam1, start=pad, prefix=dav_frame(0xF1, 1, dhtime(2025, 11, 26, 21, 0, 30), 0, b'TEXT' + title + b'\0\0') if title else b'')
    c8, n8 = fill(cam0[n6:], prefix=foreign)
    c9, n9 = fill(cam1[n7:])
    c10, n10 = fill(old)
    c11, n11 = fill(old[n10:])
    assert n6 + n8 == len(cam0) and n7 + n9 == len(cam1) and n10 + n11 == len(old), 'fixture clusters too small'
    assert len(c6) > cs and len(c6) - cs < pad, 'fixture needs one frame crossing into the next cluster'
    disk.write(base + 6 * cs, c6)
    disk.write(base + 7 * cs + pad, c7)
    disk.write(base + 8 * cs, c8)
    disk.write(base + 9 * cs, c9)
    disk.write(base + 10 * cs, c10)
    disk.write(base + 11 * cs, c11)

    def window(frames):
        dates = [f['when'] for f in frames if f['payload']]
        return dates[0], dates[-1]
    w6, w7, w8, w9 = window(cam0[:n6]), window(cam1[:n7]), window(cam0[n6:]), window(cam1[n7:])
    head0, head1 = (dhtime(2025, 11, 26, 21, 0, 0), dhtime(2025, 11, 26, 21, 59, 59)), (dhtime(2025, 11, 26, 21, 0, 30), dhtime(2025, 11, 26, 21, 59, 59))
    spec = [(1, '0', 2, *head0, 6, 0, 4), (1, '1', 2, *head1, 7, 0, 5), (2, '0', 1, *w6, 8, 4, 4), (2, '1', 1, *w7, 9, 5, 5),
            (2, '0', 2, *w8, 0, 6, 4), (2, '1', 2, *w9, 0, 7, 5)]
    table = bytearray(slots * 32)
    for i in range(first):
        table[i * 32] = 0xFE
    for k, (kind, cam, seq, start, end, nxt, prev, head) in enumerate(spec):
        struct.pack_into('<BBHIIIIIIHH', table, (first + k) * 32, kind, ord(cam), seq, start, end, nxt, 0, prev, head, 0, 0)
    disk.write(0x17600, table)
    sb = bytearray(512)
    sb[:7], sb[0x20:0x20 + 21], sb[0x1F4:0x1F8] = b'DHFS4.1', b'uuid:{synthetic-dhfs}', b'\xaa\x55\xaa\x55'
    disk.write(0, sb)
    part = bytearray(0x400)
    struct.pack_into('<I', part, 0x40 + 0x24, 0)  # volume 1 starts at sector 0
    struct.pack_into('<I', part, 0x40 + 0x2C, disk.image_size // 512)
    disk.write(0x3C00, part)
    vhdr = bytearray(512)
    struct.pack_into('<II', vhdr, 0x10, dhtime(2025, 11, 26, 21, 0, 0), dhtime(2025, 11, 26, 21, 59, 59))
    struct.pack_into('<II', vhdr, 0x2C, 512, cs // 512)
    struct.pack_into('<I', vhdr, 0x38, first)
    struct.pack_into('<I', vhdr, 0x44, 0x17600 // 512)
    struct.pack_into('<I', vhdr, 0x4C, slots)
    disk.write(0x4400, vhdr)
    disk.truth = {'base': base, 'cam0': cam0, 'cam1': cam1, 'old': old, 'cs': cs}
    return disk


def vigi_disk(indexed, unindexed_zone0, unindexed_zone1, start_ms):
    """SYNTHETIC TP-Link VIGI raw disk laid out as in a third party's disassembly of VIGI firmware. Not a real recorder image.
    indexed: GOPs (lists of AUs) named by zone 0's index; unindexed_*: a GOP whose index entry is gone."""
    zone, area = 1 << 30, 64 << 20
    zones_at = 0x23200000 + 2 * area
    disk = SparseReader(zones_at + 2 * zone + 0x100000, 'synthetic-vigi.img')
    sector = bytearray(512)
    tag = b'TP-Link Corporation Limited, NVR FOR VERSION 1.0.0'
    sector[:len(tag)] = tag
    struct.pack_into('<IQII', sector, 0x80, 0x5450, disk.image_size, zone, 0x08000000)
    struct.pack_into('<I', sector, 0x1FC, zlib.crc32(bytes(sector[:0x1FC])))
    disk.write(0x20000000, sector)

    def gop(offset, aus, first_ms):
        body = bytearray()
        for i, (key, payload) in enumerate(aus):
            frame = bytearray(32)
            struct.pack_into('<QI', frame, 0, first_ms + i * 100, len(payload))
            frame[0x0D], frame[0x10] = 1 if key else 0, 0
            body += frame + payload + bytes(-len(payload) % 8)
        body += b'\xaa' * 64  # the key-frame table closing the GOP
        disk.write(offset, body)
        return len(body)

    index, at = bytearray(), 0x100000
    for i, aus in enumerate(indexed):
        length = gop(zones_at + at, aus, start_ms + i * 1000)
        entry = bytearray(0x50)
        struct.pack_into('<IIQQIIIIIII', entry, 0, 0, 7, start_ms + i * 1000, start_ms + (i + 1) * 1000, 0, at, length, 0, 0, len(aus), 0)
        index += entry
        at += (length + 0xFFF) & ~0xFFF
    disk.write(zones_at, index)
    gop(zones_at + at + 0x10000, unindexed_zone0, start_ms + 60_000)
    gop(zones_at + zone + 0x200000, unindexed_zone1, start_ms + 3_600_000)
    return disk


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

    def test_carving_unknown_vendor_disk(self):
        ffmpeg = Path(__file__).resolve().parents[1] / 'ffmpeg.exe'
        streams = {}
        for fmt in ('h264', 'vob'):
            out = self.work / f'clip.{fmt}'
            subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5', '-t', '4',
                            '-g', '5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-f', fmt, str(out)], check=True)
            streams[fmt] = out.read_bytes()
        dhav = bytearray()
        for channel in (3, 5):
            header = bytearray(24)
            header[:4] = b'DHAV'
            header[6] = channel
            struct.pack_into('<I', header, 12, 36)
            struct.pack_into('<I', header, 16, (26 << 26) | (9 << 22) | (14 << 17) | (1 << 12) | (23 << 6) | 8)
            dhav.extend(header + b'data' + b'dhav' + struct.pack('<I', 36))
        junk = bytes(range(251)) * 40000  # ~10 MB, no start codes, so runs stay apart
        disk = self.work / 'unknown-brand.img'
        disk.write_bytes(junk + streams['h264'] + junk + streams['vob'] + junk + dhav + junk)
        reader = self.reader(disk)
        with contextlib.redirect_stdout(io.StringIO()): bundle = parse(reader, self.work)
        kinds = sorted({r['kind'] for r in bundle['recordings']})
        self.assertEqual(kinds, ['dhav', 'h264', 'ps'])
        self.assertTrue(all(r['state'] == 'unknown' for r in bundle['recordings']))
        dhav_rows = [r for r in bundle['recordings'] if r['kind'] == 'dhav']
        self.assertEqual([r['channel'] for r in dhav_rows], [3, 5])
        self.assertTrue(dhav_rows[0]['start'].startswith('2026-09-14 01:23:08'))
        for row in bundle['recordings']:
            if row['kind'] == 'dhav': continue
            result = extract(reader, bundle, row['id'], self.work)
            self.assertEqual(result['gate']['result'], 'passed', result['gate'])
            self.assertGreaterEqual(result['gate']['frames'], 15)

    def test_carving_pes_wrapped_mpeg4(self):
        # Shape of the Dynacolor sample: one MPEG-4 frame per bare PES packet, vendor bytes between packets.
        ffmpeg = Path(__file__).resolve().parents[1] / 'ffmpeg.exe'
        raw = self.work / 'clip.m4v'
        subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5', '-t', '4',
                        '-c:v', 'mpeg4', '-f', 'm4v', str(raw)], check=True)
        stream = raw.read_bytes()
        cuts = [0] + [m.start() for m in re.finditer(rb'\x00\x00\x01\xb6', stream)][1:] + [len(stream)]
        wrapped = bytearray(bytes(range(251)) * 4000)
        for a, b in zip(cuts, cuts[1:]):
            payload = stream[a:b]
            wrapped += b'VNDR' + bytes(12) + b'\x00\x00\x01\xe0' + struct.pack('>H', len(payload) + 3) + b'\x80\x00\x00' + payload
        wrapped += bytes(range(251)) * 4000
        disk = self.work / 'pes.bin'
        disk.write_bytes(wrapped)
        reader = self.reader(disk)
        with contextlib.redirect_stdout(io.StringIO()): bundle = parse(reader, self.work)
        self.assertEqual([r['kind'] for r in bundle['recordings']], ['pes'])
        result = extract(reader, bundle, '0', self.work)
        self.assertEqual(result['gate']['result'], 'passed', result['gate'])
        self.assertEqual(result['gate']['frames'], 20)

    def test_carving_mp4_files_byte_exact(self):
        # Formatted disk: whole MP4 files in unreferenced space, bounded by their own box sizes, incl. a vendor box.
        ffmpeg = Path(__file__).resolve().parents[1] / 'ffmpeg.exe'
        clips = []
        for i, size in enumerate(('160x120', '320x240')):
            out = self.work / f'c{i}.mp4'
            subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=5', '-t', '2',
                            '-pix_fmt', 'yuv420p', '-c:v', 'libx264', str(out)], check=True)
            clips.append(out.read_bytes() + struct.pack('>I', 24) + b'beam' + bytes(16))  # at the end: chunk offsets stay valid
        disk = self.work / 'formatted.img'
        disk.write_bytes(bytes(4096) + clips[0] + bytes(3000) + clips[1] + bytes(4096))
        reader = self.reader(disk)
        with contextlib.redirect_stdout(io.StringIO()): bundle = parse(reader, self.work)
        self.assertEqual([r['kind'] for r in bundle['recordings']], ['mp4', 'mp4'])
        for row, clip in zip(bundle['recordings'], clips):
            result = extract(reader, bundle, row['id'], self.work)
            self.assertEqual(result['recovered_sha256'], hashlib.sha256(clip).hexdigest())
            self.assertEqual(result['gate']['result'], 'passed')

    def test_vendor_attribution(self):
        junk = bytes(range(251)) * 100
        def vendor(name, data):
            path = self.work / name
            path.write_bytes(data)
            return identify(self.reader(path))['vendor']
        # every required brand is recognised from its name in the evidence, including UTF-16 text and the file end
        names = {'Dahua Technology': b'Dahua', 'CP Plus': b'CP PLUS', 'Honeywell Security': b'Honeywell', 'TP-Link': b'TP-LINK',
                 'Godrej': b'GODREJ', 'Uniview': b'Uniview', 'Hikvision': b'HIKVISION', 'Matrix': b'MATRIX COMSEC'}
        for brand, text in names.items():
            self.assertEqual(vendor(f'{brand}.bin', junk + text + junk)['brand'], brand)
        self.assertEqual(vendor('utf16.bin', junk + 'Godrej'.encode('utf-16-le') + junk)['brand'], 'Godrej')
        big = bytes(20 * 1024 * 1024) + b'Uniview' + bytes(10)
        self.assertEqual(vendor('tail.bin', big)['brand'], 'Uniview')
        # format signatures: Hikvision is certain, DHAV is only a family (Dahua or an OEM), never a guessed brand
        hik = vendor('hik.img', b'4HKH' + junk)
        self.assertEqual((hik['brand'], hik['confidence']), ('Hikvision', 'Storage-format signature'))
        dav = vendor('x.dav', b'DHAV' + bytes(20) + junk)
        self.assertIsNone(dav['brand'])
        self.assertEqual(dav['candidates'], ['Dahua Technology', 'CP Plus'])
        # a brand name plus the DHAV family: the name wins and the format is reported as evidence
        both = vendor('cp.dav', b'DHAV' + bytes(20) + junk + b'cpplus')
        self.assertEqual(both['brand'], 'CP Plus')
        self.assertIn('Stored in the Dahua DHAV format', both['evidence'])
        # nothing to go on: not determined, and no brand is made up
        none = vendor('plain.bin', junk)
        self.assertEqual((none['brand'], none['confidence'], none['candidates']), (None, 'Not determined', []))
        self.assertEqual(vendor('two.bin', junk + b'honeywell' + junk + b'dahua')['confidence'], 'Several brand names found')

    def test_honeywell_layout_synthetic(self):
        # SYNTHETIC image from the published layout: proves the parser follows the paper, not that it works on a real recorder.
        ffmpeg = Path(__file__).resolve().parents[1] / 'ffmpeg.exe'

        def stream(size, channel, kind, offset, start):
            out = self.work / f'h{channel}{kind}.h264'
            w, h = size
            subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc=size={w}x{h}:rate=10', '-t', '3',
                            '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0',
                            '-x264-params', 'keyint=10:scenecut=0:repeat-headers=1', '-f', 'h264', str(out)], check=True)
            frames = [(key, payload, start + i * 100_000) for i, (key, payload) in enumerate(access_units(out.read_bytes()))]
            return {'channel': channel, 'kind': kind, 'offset': offset, 'width': w, 'height': h, 'frames': frames}

        expired = stream((320, 240), 3, 0x00, 0x000000, calendar.timegm((2025, 11, 26, 21, 48, 19)) * 10 ** 6)
        current = stream((160, 120), 5, 0x20, 0x200000, calendar.timegm((2025, 12, 3, 21, 18, 0)) * 10 ** 6)
        oldest_group = calendar.timegm((2025, 12, 3, 21, 0, 0))

        # Expiration: the channel list names only the current stream; the expired one survives in the video data region.
        disk = honeywell_disk([expired, current], listed=[1], groups=[oldest_group])
        with contextlib.redirect_stdout(io.StringIO()):
            ident = identify(disk)
            bundle = parse(disk, self.work)
        self.assertEqual(ident['adapter'], 'honeywell')
        self.assertEqual((ident['vendor']['brand'], ident['vendor']['confidence'], ident['vendor']['model']),
                         ('Honeywell Security', 'Storage-format signature', 'HN35080200'))
        self.assertEqual(bundle['machine_data']['device_id'], 'B011003AWFNRZEFKV')
        rows = {r['state']: r for r in bundle['recordings']}
        self.assertEqual(sorted(rows), ['deleted', 'live'])
        live, deleted = rows['live'], rows['deleted']
        self.assertEqual((live['channel'], live['stream'], live['source']), (5, 'sub', 'channel list'))
        self.assertEqual((live['width'], live['height'], live['frames'], live['keyframes']), (160, 120, 30, 3))
        self.assertEqual(live['fps'], 10.0)
        self.assertEqual(live['start'], '2025-12-03 21:18:00.000 (recorder clock)')
        self.assertEqual((deleted['channel'], deleted['width'], deleted['frames']), (None, 320, 30))
        self.assertEqual(deleted['start'], '2025-11-26 21:48:19.000 (recorder clock)')
        self.assertTrue(deleted['complete'])
        self.assertEqual(len(bundle['block_groups']), 1)
        for row, original in ((live, current), (deleted, expired)):
            with contextlib.redirect_stdout(io.StringIO()):
                result = extract(disk, bundle, row['id'], self.work)
            self.assertEqual(result['recovered_sha256'], hashlib.sha256(original['expected']).hexdigest())
            self.assertEqual(result['gate']['result'], 'passed', result['gate'])
            self.assertEqual(result['gate']['frames'], 30)

        # Formatting resets the header (no block groups, no channel list) but leaves video data: everything is deleted.
        with contextlib.redirect_stdout(io.StringIO()):
            formatted = parse(honeywell_disk([expired, current], listed=[], groups=[]), self.work)
        self.assertEqual([r['state'] for r in formatted['recordings']], ['deleted', 'deleted'])
        self.assertEqual([r['frames'] for r in formatted['recordings']], [30, 30])

        # A GPT disk without Honeywell's header or custom records is not Honeywell.
        plain = SparseReader(0x5000 + 0x80000000 + 4096)
        plain.write(512, disk.read(512, 92))
        plain.write(1024, disk.read(1024, 128))
        found = identify(plain)
        self.assertNotEqual(found['adapter'], 'honeywell')
        self.assertIsNone(found['vendor']['brand'])

    def check_recovery(self, disk, bundle, row, original):
        with contextlib.redirect_stdout(io.StringIO()):
            result = extract(disk, bundle, row['id'], self.work)
        self.assertEqual(result['recovered_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(result['gate']['result'], 'passed', result['gate'])
        return result

    def test_uniview_ubs_synthetic(self):
        # SYNTHETIC image from a third party's description of Uniview's UBS layout: proves the parser follows it, not that it fits a real recorder.
        gops = split_gops(h264_units(self.work, (160, 120), 'uni'))
        other = split_gops(h264_units(self.work, (96, 96), 'uni2'))
        t0 = calendar.timegm((2025, 11, 26, 21, 48, 19))
        disk = uniview_disk(gops[:2], gops[2], other[0], [t0, t0 + 1, t0 + 2, t0 + 3600])
        with contextlib.redirect_stdout(io.StringIO()):
            ident = identify(disk)
            bundle = parse(disk, self.work)
        self.assertEqual(ident['adapter'], 'uniview')
        self.assertEqual((ident['vendor']['brand'], ident['vendor']['confidence']), ('Uniview', 'Storage-format signature'))
        self.assertIn('Superblock device ID: NVR301-TEST', ident['vendor']['evidence'])
        self.assertTrue(bundle['superblock']['crc_ok'])
        rows = bundle['recordings']
        self.assertEqual([r['state'] for r in rows], ['live', 'deleted', 'deleted'])
        live, stale, wiped = rows
        self.assertEqual((live['channel'], live['gops'], live['frames'], live['fps']), (3, 2, 20, 10.0))
        self.assertEqual(live['start'], '2025-11-26 21:48:19 (recorder clock)')
        self.assertIn('write position', stale['state_reason'])
        self.assertEqual((wiped['channel'], wiped['gops']), (None, 1))
        self.assertIn('wiped', wiped['state_reason'])
        payload = lambda aus: b''.join(p for _, p in aus)
        self.check_recovery(disk, bundle, live, payload(gops[0]) + payload(gops[1]))
        self.check_recovery(disk, bundle, stale, payload(gops[2]))
        self.check_recovery(disk, bundle, wiped, payload(other[0]))
        # a disk whose first sector is not a UBS superblock is not Uniview
        self.assertNotEqual(identify(SparseReader(0x10000 + 4096))['adapter'], 'uniview')

    def test_godrej_qvfs_synthetic(self):
        # SYNTHETIC image from a third party's description of Qualvision's QVFS (Godrej): not a real recorder image.
        a, b = h264_units(self.work, (160, 120), 'gj1'), h264_units(self.work, (96, 96), 'gj2', seconds=2)

        def run(units, when):
            frames = []
            for i, (_, payload) in enumerate(units):
                frames.append((payload, dhtime(*when[:5], when[5] + i // 10), (i % 10) * 100))
                if i == 5:
                    frames.append((b'AUDIO' * 20, dhtime(*when[:5], when[5]), 0))  # audio: not video, must be skipped
            return frames
        disk = qvfs_disk([run(a, (2025, 11, 26, 21, 48, 19)), run(b, (2025, 12, 3, 9, 10, 0))])
        path = self.work / 'qvfs.img'
        path.write_bytes(disk)
        reader = self.reader(path)
        with contextlib.redirect_stdout(io.StringIO()):
            ident = identify(reader)
            bundle = parse(reader, self.work)
        self.assertEqual(ident['adapter'], 'godrej')
        self.assertEqual((ident['vendor']['brand'], ident['vendor']['confidence']), ('Godrej', 'Storage-format signature'))
        self.assertIn('Qualvision', ident['vendor']['note'])
        rows = bundle['recordings']
        self.assertEqual([r['state'] for r in rows], ['unknown', 'unknown'])
        self.assertEqual((rows[0]['frames'], rows[0]['fps'], rows[0]['channel']), (30, 10.0, None))
        self.assertEqual(rows[0]['start'], '2025-11-26 21:48:19.000 (recorder clock)')
        self.assertEqual((rows[1]['frames'], rows[1]['start']), (20, '2025-12-03 09:10:00.000 (recorder clock)'))
        for row, units in zip(rows, (a, b)):
            self.check_recovery(reader, bundle, row, b''.join(p for _, p in units))
        # a lone frame head that chains to nothing is not footage
        lone = bytearray(4 << 20)
        lone[:4] = b'QVEX'
        struct.pack_into('<7I', lone, 4, 0x00010000, 1, (4 << 20) // 512, 8, 8000, 0, 0)
        lone[4096:4116] = b'\x00\x00\x01\xe0' + struct.pack('<IIH', 5, dhtime(2025, 1, 1, 0, 0, 0), 0) + bytes(6)
        path2 = self.work / 'lone.img'
        path2.write_bytes(lone)
        with self.assertRaisesRegex(ValueError, 'no video was found'), contextlib.redirect_stdout(io.StringIO()):
            parse(self.reader(path2), self.work)

    def test_tplink_vigi_synthetic(self):
        # SYNTHETIC image from a third party's description of the VIGI raw layout: not a real recorder image.
        gops = split_gops(h264_units(self.work, (160, 120), 'tp', seconds=4))
        start_ms = calendar.timegm((2025, 11, 26, 21, 48, 19)) * 1000
        disk = vigi_disk(gops[:2], gops[2], gops[3], start_ms)
        with contextlib.redirect_stdout(io.StringIO()):
            ident = identify(disk)
            bundle = parse(disk, self.work)
        self.assertEqual(ident['adapter'], 'tplink')
        self.assertEqual((ident['vendor']['brand'], ident['vendor']['confidence']), ('TP-Link', 'Storage-format signature'))
        self.assertTrue(bundle['format_sector']['crc32_ok'])
        self.assertEqual(bundle['geometry']['data_zone_at'], 0x23200000 + 2 * (64 << 20))
        rows = bundle['recordings']
        self.assertEqual([r['state'] for r in rows], ['live', 'deleted', 'deleted'])
        live, gone0, gone1 = rows
        self.assertEqual((live['stream'], live['frames'], live['gops'], live['fps'], live['time_unit']), ('main', 20, 2, 10.0, 'ms'))
        self.assertEqual(live['start'], '2025-11-26 21:48:19 (recorder clock)')
        self.assertEqual((gone0['frames'], gone1['frames']), (len(gops[2]), len(gops[3])))
        self.assertEqual((gone0['fps'], gone1['fps']), (10.0, 10.0))
        payload = lambda aus: b''.join(p for _, p in aus)
        self.check_recovery(disk, bundle, live, payload(gops[0]) + payload(gops[1]))
        self.check_recovery(disk, bundle, gone0, payload(gops[2]))
        self.check_recovery(disk, bundle, gone1, payload(gops[3]))
        # without the format sector it is not a VIGI disk
        self.assertNotEqual(identify(SparseReader(0x30000000))['adapter'], 'tplink')

    def test_dhfs_dahua_family_synthetic(self):
        # SYNTHETIC volume from a third party's notes on one real Dahua-family disk: proves the parser follows them, not that it fits a real recorder.
        disk = dhfs_disk(title=b'CPPlusIPCam')
        t = disk.truth
        with contextlib.redirect_stdout(io.StringIO()):
            ident = identify(disk)
            bundle = parse(disk, self.work)
        self.assertEqual(ident['adapter'], 'dhfs')
        # on this tiny image the video data sits inside the identification sample, so the CP Plus channel title is already seen
        self.assertEqual((bundle['vendor']['brand'], bundle['vendor']['confidence']), ('CP Plus', 'Brand name found in the data'))
        self.assertIn('CPPlusIPCam', bundle['channel_titles'])
        self.assertIn('Stored in the Dahua DHFS 4.1 (DHAV frames) format', bundle['vendor']['evidence'])
        cal = bundle['volumes'][0]['calibration']
        self.assertEqual(cal['data_base'], t['base'])
        self.assertFalse(cal['weak'])
        rows = bundle['recordings']
        self.assertEqual([(r['channel'], r['state']) for r in rows], [(1, 'live'), (2, 'live'), (None, 'deleted')])
        self.assertEqual(rows[0]['start'], '2025-11-26 21:00:00 (recorder clock)')
        self.assertEqual(rows[2]['start'], '2025-11-25 10:00:00 (recorder clock)')
        self.assertEqual(rows[2]['clusters'], [10, 11])
        self.assertIn('empty', rows[2]['state_reason'])
        payload = lambda frames: b''.join(f['payload'] for f in frames if f['payload'])
        # every video frame comes back, in order: the one crossing a cluster end is kept, the other camera's spilled frame is not
        for row, frames in zip(rows, (t['cam0'], t['cam1'], t['old'])):
            result = self.check_recovery(disk, bundle, row, payload(frames))
            self.assertEqual(result['gate']['frames'], 30)
            self.assertEqual((row['fps'], row['codec']), (10, 'h264'))
        # without the notes' channel title the brand stays open between Dahua and its OEMs
        with contextlib.redirect_stdout(io.StringIO()):
            plain = identify(dhfs_disk())['vendor']
        self.assertEqual((plain['brand'], plain['candidates']), (None, ['Dahua Technology', 'CP Plus']))
        self.assertIn('DHFS', plain['note'])
        # a title read later from the video data names the brand without it being in the identification sample
        from dvr_scan.forensics import _vendor
        later = _vendor(disk, b'', [{'signature': 'Dahua DHFS 4.1 superblock', 'offset': '0x0', 'family': 'Dahua family'}], extra_text=b'CPPlusIPCam')
        self.assertEqual(later['brand'], 'CP Plus')
        self.assertIn('channel title', later['evidence'][0])
        # when the data area cannot be placed, recordings are still listed but extraction refuses to guess
        stripped = SparseReader(disk.image_size)
        stripped.extents = {o: d for o, d in disk.extents.items() if o < t['base']}
        with contextlib.redirect_stdout(io.StringIO()):
            listed = parse(stripped, self.work)
        self.assertIsNone(listed['volumes'][0]['calibration']['data_base'])
        self.assertEqual([r['state'] for r in listed['recordings']], ['live', 'live'])
        with self.assertRaisesRegex(ValueError, 'cannot be extracted'), contextlib.redirect_stdout(io.StringIO()):
            extract(stripped, listed, listed['recordings'][0]['id'], self.work)

    def test_uniview_export_file_names(self):
        from dvr_scan.forensics import _uniview_name
        self.assertEqual(_uniview_name('/Ch9-20150630183546.mp4'),
                         {'channel': 9, 'start': '2015-06-30 18:35:46 (recorder clock, from file name)', 'end': None})
        self.assertEqual(_uniview_name('/exports/Front Door-20240102030405.TS')['channel'], 'Front Door')
        for bad in ('/Ch9-20151330183546.mp4', '/Ch9-2015063018354.mp4', '/clip.mp4', '/Ch9-20150630183546.avi'):
            self.assertIsNone(_uniview_name(bad))

    def test_matrix_recording_paths(self):
        from dvr_scan.forensics import _matrix_path, _is_video, _vendor
        label = ' (recorder clock, from file path)'
        got = _matrix_path('/Camera03/26_Nov_2025/21/21_48_19~21_55_00.stm1')
        self.assertEqual(got, {'channel': 3, 'start': '2025-11-26 21:48:19' + label, 'end': '2025-11-26 21:55:00' + label})
        self.assertEqual(_matrix_path('/vol/Camera12/05_Jan_2026/23/23_58_00~00_02_00.stm')['end'], '2026-01-06 00:02:00' + label)
        for bad in ('/Camera03/26_Nov_2025/21/21_48_19~21_55_00.mp4', '/Camera03/31_Feb_2025/21/21_00_00~21_10_00.stm1',
                    '/Cam03/26_Nov_2025/21/21_48_19~21_55_00.stm1', '/Camera03/26_Xyz_2025/21/21_48_19~21_55_00.stm1'):
            self.assertIsNone(_matrix_path(bad))
        self.assertTrue(all(_is_video(n) for n in ('a.stm', 'a.stm2', 'A.STM1', 'a.mp4')))
        self.assertFalse(any(_is_video(n) for n in ('a.evnt', 'a.ifrm', 'a.tmid', 'a.stmx', 'a.txt')))
        path = self.work / 'plain.bin'
        path.write_bytes(bytes(range(251)) * 10)
        vendor = _vendor(self.reader(path), path.read_bytes(), [], matrix_paths=True)
        self.assertEqual((vendor['brand'], vendor['confidence']), ('Matrix', 'Directory-layout signature'))
        self.assertIn('Matrix SATATYA recording folders', vendor['evidence'][0])
        self.assertIsNone(_vendor(self.reader(path), path.read_bytes(), [])['brand'])

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
