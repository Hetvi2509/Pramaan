"""Blind schema induction (plan.md M3.2) against layouts whose truth we know. Everything here is synthetic: the induction is never told the
layout, and it is scored on what it recovers. That says how well the method works, not that it will work on a recorder nobody has opened."""
import random
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from dvr_scan import induce
from tests.test_forensics import SparseReader, dav_frame, dhtime, h264_units

FFMPEG = str(Path(__file__).resolve().parents[1] / 'ffmpeg.exe')
RATE = 25


def disk_of(chunks, noise=4096):
    rng = random.Random(7)
    data = bytearray(rng.randbytes(noise))
    for chunk in chunks:
        data += chunk
    disk = SparseReader(len(data) + 4096)
    disk.write(0, data)
    return disk


def dhav_layout(units):
    out, ext = [], bytes([0x80, 0, 20, 15, 0x81, 0, 0x02, RATE])
    for i, (key, payload) in enumerate(units):
        out.append(dav_frame(0xFD if key else 0xFC, 1000 + i, dhtime(2025, 11, 26, 21, 0, i // RATE), (i % RATE) * 40, payload, ext if key else b''))
        if i % RATE == RATE - 1:  # an audio record between video records, as a real DHAV stream has
            out.append(dav_frame(0xF0, 7000 + i, dhtime(2025, 11, 26, 21, 0, i // RATE), 950, b'\xd5' * 40))
    return out, {('constant', 4, -8, b'dhav'.hex()), ('constant', 4, 0, b'DHAV'.hex()), ('frame_type', 1, 4), ('counter', 4, 8), ('length', 4, 12), ('timestamp', 4, 16), ('ext_length', 1, 22), ('checksum', 1, 23)}


def honeywell_layout(units):
    out = []
    for i, (key, payload) in enumerate(units):
        out.append(bytes([0x82 if key else 0x02]) + b'\x80\x01\x00' + struct.pack('<HHIQ', 160, 120, len(payload), 1_764_000_000_000_000 + i * 40_000) + payload)
    return out, {('frame_type', 1, 0), ('constant', 3, 1, '800100'), ('resolution', 2, 4), ('resolution', 2, 6), ('length', 4, 8), ('timestamp', 8, 12)}


def godrej_layout(units):
    out = []
    for i, (key, payload) in enumerate(units):
        out.append(b'\x00\x00\x01\xe0' + struct.pack('<IIH', len(payload), dhtime(2025, 11, 26, 21, 0, i // RATE), (i % RATE) * 40) + bytes(6) + payload)
    return out, {('constant', 4, 0, '000001e0'), ('length', 4, 4), ('timestamp', 4, 8)}


def uniview_layout(units):
    out = []
    for i, (key, payload) in enumerate(units):
        head = bytearray(24)
        struct.pack_into('<III', head, 0, 0x1357, 90_000 * 5 + i * 3600, 90_000 * 5 + i * 3600)
        head[12], head[17] = 2, 1
        struct.pack_into('<HI', head, 18, len(payload), 500 + i)
        out.append(bytes(head) + payload + bytes(4))
    return out, {('constant', 4, 0, '57130000'), ('constant', 1, 12, '02'), ('constant', 1, 17, '01'), ('relative_clock', 4, 4), ('relative_clock', 4, 8), ('length', 2, 18), ('counter', 4, 20)}


def vigi_layout(units):
    out = []
    for i, (key, payload) in enumerate(units):
        head = bytearray(32)
        struct.pack_into('<QI', head, 0, 1_764_000_000_000 + i * 40, len(payload))
        head[0x0D] = 1 if key else 0
        out.append(bytes(head) + payload + bytes(-len(payload) % 8))
    return out, {('timestamp', 8, 0), ('length', 4, 8), ('frame_type', 1, 13)}


def core(offset, width, value):
    """A constant as its runs of non-zero bytes. Whether a zero at an edge belongs to the magic or to the field beside it cannot be told
    from the bytes, and one run of '02 00 00 00 00 01' is the same structure as two constants '02' and '01', so both sides are compared as
    non-zero segments: (offset, length) for each."""
    raw, out, i = bytes.fromhex(value), [], 0
    while i < len(raw):
        if raw[i] == 0:
            i += 1
            continue
        j = i
        while j < len(raw) and raw[j] != 0:
            j += 1
        out.append(('constant', j - i, offset + i))
        i = j
    return out


def crc16_arc(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def interleaved_layout(units, other=None):
    """A layout the heuristics were NOT tuned on: big-endian fields, two cameras alternating on disk with a counter each, a channel byte,
    resolution, a CRC-16 over the header, and a length. 20-byte header: magic, channel, type, counter u16, time u32, width u16,
    height u16, crc16 u16, length u16."""
    out, counters, streams = [], {1: 100, 2: 5000}, (units, other or units)
    for i in range(min(len(streams[0]), len(streams[1]))):
        for channel in (1, 2):
            key, payload = streams[channel - 1][i]
            head = b'NVRX' + bytes([channel, 1 if key else 0]) + struct.pack('>HIHH', counters[channel] & 0xFFFF, 1_764_000_000 + i // RATE, 160, 120)
            head += struct.pack('>H', crc16_arc(head)) + struct.pack('>H', len(payload))
            counters[channel] += 1
            out.append(head + payload)
    return out, {('constant', 4, 0, b'NVRX'.hex()), ('channel', 1, 4), ('frame_type', 1, 5), ('counter', 2, 6), ('timestamp', 4, 8),
                 ('resolution', 2, 12), ('resolution', 2, 14), ('checksum', 2, 16), ('length', 2, 18)}


def f1(found, truth):
    """Best F1 of (role, width, offset) over every shift of the offsets: the anchor may sit anywhere along the same header. Constants are
    compared as their non-zero segments (zero bytes are padding, not claims)."""
    got = set()
    for f in found:
        if f['role'] == 'constant':
            got.update(core(f['offset'], f['width'], f['value']))
        else:
            got.add((f['role'], f['width'], f['offset']))
    want = set()
    for t in truth:
        want.update(core(t[2], t[1], t[3]) if t[0] == 'constant' else [t])
    best = (0.0, 0, set())
    for shift in range(-40, 41):
        moved = {(r, w, o + shift) for r, w, o in got}
        tp = len(moved & want)
        if not tp:
            continue
        p, r = tp / len(moved), tp / len(want)
        if 2 * p * r / (p + r) > best[0]:
            best = (2 * p * r / (p + r), shift, moved)
    return best


class InduceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp())
        cls.units = h264_units(cls.work, (160, 120), 'ind', seconds=14, rate=RATE, gop=RATE)

    def run_layout(self, build):
        chunks, truth = build(self.units)
        result = induce.induce(disk_of(chunks))
        return result, truth

    def test_sps_resolution_matches_ffmpeg(self):
        for size in ((160, 120), (320, 180), (96, 96)):
            units = h264_units(self.work, size, f'sps{size[0]}', seconds=1, rate=5, gop=5)
            sps = induce.sps_h264(next(p for k, p in units if k)[units[0][1].find(b'\x67'):])
            nal = units[0][1]
            at = nal.find(b'\x00\x00\x00\x01\x67') + 4
            parsed = induce.sps_h264(nal[at:at + 80])
            self.assertEqual((parsed['width'], parsed['height']), size)

    def test_sps_h265(self):
        out = self.work / 'x265.h265'
        done = subprocess.run([FFMPEG, '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=192x108:rate=5', '-t', '1', '-c:v', 'libx265',
                               '-x265-params', 'log-level=none', '-f', 'hevc', str(out)], capture_output=True)
        if done.returncode:
            self.skipTest('this FFmpeg has no libx265')
        data = out.read_bytes()
        at = data.find(b'\x00\x00\x00\x01\x42\x01') + 4
        parsed = induce.sps_h265(data[at:at + 92])
        self.assertEqual((parsed['width'], parsed['height']), (192, 108))
        self.assertEqual(induce.find_aus(data)[0]['codec'], 'h265')

    def test_access_units_are_found_with_key_flags(self):
        aus = induce.find_aus(b''.join(p for _, p in self.units))
        self.assertEqual(len(aus), len(self.units) - 2)  # the first and last are dropped: they may be cut by the window
        self.assertEqual(sum(a['key'] for a in aus), sum(k for k, _ in self.units[1:-1]))
        self.assertEqual({(a['sps']['width'], a['sps']['height']) for a in aus if a['sps']}, {(160, 120)})

    def check(self, build, minimum):
        result, truth = self.run_layout(build)
        self.assertTrue(result['found'], result.get('reason'))
        score, shift, _ = f1(result['schema']['fields'], truth)
        self.assertGreaterEqual(score, minimum, (score, [(f['role'], f['width'], f['offset'], f['score']) for f in result['schema']['fields']]))
        return result

    def test_dhav_layout_recovered_blind(self):
        # the plan's headline demo: magic, frame type, counter, length, packed date, extension length and checksum of DHAV, with no adapter
        result = self.check(dhav_layout, 0.85)
        fields = {(f['role']): f for f in result['schema']['fields'] if f['role'] != 'constant'}
        self.assertIn('packed date', fields['timestamp']['encoding'])
        self.assertEqual(fields['checksum']['algorithm'], 'sum8')
        self.assertTrue(result['verification']['accepted'])
        self.assertGreaterEqual(result['verification']['coverage'], 0.95)
        self.assertIn('contents: [', result['ksy'])

    def test_honeywell_layout_recovered_blind(self):
        result = self.check(honeywell_layout, 0.85)
        fields = {(f['role'], f.get('dimension')): f for f in result['schema']['fields']}
        self.assertEqual(fields[('timestamp', None)]['encoding'], 'unix microseconds')
        self.assertEqual({fields[('resolution', 'width')]['divisor'], fields[('resolution', 'height')]['divisor']}, {1})
        self.assertTrue(result['verification']['accepted'])

    def test_godrej_layout_recovered_blind(self):
        self.check(godrej_layout, 0.8)

    def test_uniview_packet_layout_recovered_blind(self):
        self.check(uniview_layout, 0.8)

    def test_unseen_layout_with_interleaved_cameras_and_big_endian_fields(self):
        result = self.check(interleaved_layout, 0.7)
        roles = {f['role']: f for f in result['schema']['fields'] if f['role'] != 'constant'}
        self.assertEqual(roles['channel']['values'], 2)
        self.assertEqual(roles['counter']['endian'], 'be')
        # 14 seconds of data cannot tell a unix clock from a packed date; the tool has to say so instead of choosing silently
        self.assertIn('unix seconds', [roles['timestamp']['encoding']] + roles['timestamp']['alternatives'])
        self.assertEqual(roles['checksum']['algorithm'], 'crc16')
        self.assertTrue(result['verification']['accepted'])

    def test_unanchored_header_is_found_but_padded_length_is_not_claimed(self):
        # TP-Link style: no constant bytes to anchor on, and payloads padded to 8 so the length never equals a record distance
        result = self.check(vigi_layout, 0.5)
        roles = {f['role'] for f in result['schema']['fields']}
        self.assertIn('timestamp', roles)
        self.assertIn('frame_type', roles)
        self.assertNotIn('length', roles)

    def test_result_is_plain_json_and_runs_through_the_engine_cli(self):
        import json
        import subprocess
        import sys
        chunks, _ = honeywell_layout(self.units)
        path = self.work / 'unknown.img'
        rng = random.Random(7)
        path.write_bytes(rng.randbytes(4096) + b''.join(chunks))
        done = subprocess.run([sys.executable, '-m', 'dvr_scan.forensics', 'induce', '--image', str(path), '--work', str(self.work / 'w')],
                              capture_output=True, text=True, cwd=str(Path(__file__).resolve().parents[1]))
        self.assertEqual(done.returncode, 0, done.stderr[-500:])
        events = [json.loads(line) for line in done.stdout.splitlines() if line.startswith('{')]
        data = next(e for e in events if e['type'] == 'forensics_result')['data']
        self.assertTrue(data['found'])
        self.assertTrue(any(e['type'] == 'progress' for e in events))
        self.assertEqual(sorted(f['role'] for f in data['schema']['fields'] if f['role'] != 'constant'),
                         ['frame_type', 'length', 'resolution', 'resolution', 'timestamp'])
        json.dumps(data)

    def test_bare_video_with_no_headers_finds_no_schema(self):
        result = induce.induce(disk_of([p for _, p in self.units]))
        self.assertFalse(result['found'])
        self.assertIn('no field', result['reason'])
        self.assertTrue(result['fallback']['groups'])

    def test_a_disk_without_video_says_so(self):
        result = induce.induce(disk_of([random.Random(3).randbytes(200_000)]))
        self.assertFalse(result['found'])
        self.assertIn('access units', result['reason'])

    def test_a_layout_that_changes_across_the_disk_is_rejected(self):
        # the counter restarts at a different step in the second half: what was learned from the first half must fail the held-out half
        chunks, _ = dhav_layout(self.units)
        half = len(chunks) // 2
        tail = []
        for k, c in enumerate(chunks[half:]):
            tail.append(c[:8] + struct.pack('<I', (k * 5) & 0xFFFFFFFF) + c[12:] if c[:4] == b'DHAV' else c)
        # keep the header checksum valid so only the counter rule can object
        fixed = []
        for c in tail:
            if c[:4] == b'DHAV':
                c = bytearray(c)
                c[23] = sum(c[:23]) & 0xFF
                c = bytes(c)
            fixed.append(c)
        result = induce.induce(disk_of(chunks[:half] + fixed))
        self.assertFalse(result['found'])
        self.assertLess(result['verification']['consistency'], 0.95)


if __name__ == '__main__':
    unittest.main()
