"""Blind schema induction on an unknown DVR/NVR disk (plan.md M3.2).

The idea: every recorder hides standard H.264/H.265 inside its own record wrapper, so the video is a vendor-independent anchor. Find
access units by their Annex-B syntax (an SPS must parse to a sane resolution), then look at the bytes just before each one. Fixed
positions in those bytes that are constant, count up by one, track the picture size, follow the key-frame flag, hold a plausible clock,
or equal the distance to the next record are the header's fields. Every claim carries a measured score, and a schema is accepted only
if it decodes a held-out region of the disk (never the bytes it was induced from) with coverage and consistency of at least 95%.

Scope, stated plainly: this finds the header that sits before video payloads. Records that carry no video (audio, index, log records) are
not seen, and a vendor header that holds no constant, counter, clock or length field cannot be located. Annex-B payloads only (no
length-prefixed NAL units yet), and a hand-written SPS parser stands in for libavcodec's, which is not installed here. Nothing here has
been run on a real unknown recorder disk: validation so far is on synthetic layouts built from other, known layouts.
"""
import hashlib
import math
import re
import time
import zlib
from collections import Counter

import numpy as np

START = re.compile(rb"\x00\x00\x00\x01|\x00\x00\x01")
H264_TYPES = {1, 5, 6, 7, 8, 9}
H265_VCL = set(range(0, 10)) | set(range(16, 22))
H265_PARAM = {32, 33, 34, 35, 39, 40}
PROFILES = {44, 66, 77, 83, 86, 88, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244}
WINDOW, REGIONS, K, GAP = 16 << 20, 16, 96, 4 << 20
ACCEPT = 0.95
EPOCH_LO = 1104537600  # 2005-01-01


# -- bit reading and SPS parsing ------------------------------------------------------------------------------------------------
class _Bits:
    def __init__(self, data):
        self.d, self.i = data, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.i >> 3] >> (7 - (self.i & 7))) & 1)
            self.i += 1
        return v

    def ue(self):
        zeros = 0
        while self.u(1) == 0:
            zeros += 1
            if zeros > 32:
                raise ValueError("bad Exp-Golomb code")
        return (1 << zeros) - 1 + (self.u(zeros) if zeros else 0)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def _unescape(raw):
    return raw.replace(b"\x00\x00\x03", b"\x00\x00")


def sps_h264(nal):
    """Resolution of an H.264 SPS (NAL bytes from the header byte on), or None if it does not parse to something sane."""
    try:
        b = _Bits(_unescape(nal[1:80]))
        profile = b.u(8)
        b.u(8)
        level = b.u(8)
        b.ue()
        chroma = 1
        if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            chroma = b.ue()
            if chroma == 3:
                b.u(1)
            b.ue(), b.ue(), b.u(1)
            if b.u(1):
                for i in range(8 if chroma != 3 else 12):
                    if b.u(1):
                        last = nxt = 8
                        for _ in range(16 if i < 6 else 64):
                            if nxt:
                                nxt = (last + b.se() + 256) % 256
                            last = last if nxt == 0 else nxt
        b.ue()
        poc = b.ue()
        if poc == 0:
            b.ue()
        elif poc == 1:
            b.u(1), b.se(), b.se()
            for _ in range(b.ue()):
                b.se()
        b.ue(), b.u(1)
        w_mbs, h_map, frame_mbs_only = b.ue() + 1, b.ue() + 1, b.u(1)
        if not frame_mbs_only:
            b.u(1)
        b.u(1)
        crop = [0, 0, 0, 0]
        if b.u(1):
            crop = [b.ue() for _ in range(4)]
        cx = 1 if chroma in (0, 3) else 2
        cy = (1 if chroma in (0, 3) else 2) * (2 - frame_mbs_only)
        width, height = w_mbs * 16 - (crop[0] + crop[1]) * cx, (2 - frame_mbs_only) * h_map * 16 - (crop[2] + crop[3]) * cy
    except (IndexError, ValueError):
        return None
    if profile not in PROFILES or not 9 <= level <= 62 or not (64 <= width <= 8192 and 64 <= height <= 8192):
        return None
    return {"width": width, "height": height, "profile": profile, "level": level}


def sps_h265(nal):
    try:
        b = _Bits(_unescape(nal[2:90]))
        b.u(4)
        sub_layers = b.u(3)
        b.u(1)
        b.u(2 + 1 + 5 + 32 + 4 + 43 + 1)
        level = b.u(8)
        flags = [(b.u(1), b.u(1)) for _ in range(sub_layers)]
        if sub_layers:
            for _ in range(sub_layers, 8):
                b.u(2)
        for prof, lev in flags:
            b.u(88 if prof else 0), b.u(8 if lev else 0)
        b.ue()
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        width, height = b.ue(), b.ue()
        if b.u(1):
            left, right, top, bottom = (b.ue() for _ in range(4))
            sw, sh = (2 if chroma in (1, 2) else 1), (2 if chroma == 1 else 1)
            width, height = width - (left + right) * sw, height - (top + bottom) * sh
    except (IndexError, ValueError):
        return None
    return {"width": width, "height": height, "profile": 0, "level": level} if 64 <= width <= 8192 and 64 <= height <= 8192 else None


def _pps_ok(raw):
    """A PPS must parse its two ids and end in a stop bit; four bytes of someone else's header rarely do."""
    try:
        b = _Bits(_unescape(raw[:30]))
        pps, sps = b.ue(), b.ue()
    except (IndexError, ValueError):
        return False
    return 2 <= len(raw) <= 80 and pps < 256 and sps < 32 and raw[-1] != 0


def _sei_ok(raw):
    """An SEI is (type, size, data) messages ending in a stop bit: its first message has to fit inside the NAL."""
    i = 0
    for _ in range(2):  # payload type, then payload size, each in 0xFF-extended bytes
        while i < len(raw) and raw[i] == 0xFF:
            i += 1
        i += 1
    size = 0
    j = 1
    while j < len(raw) and raw[j] == 0xFF:
        size += 255
        j += 1
    return len(raw) >= 3 and i <= len(raw) and raw[-1] != 0 and (size + (raw[j] if j < len(raw) else 0)) + i <= len(raw) + 1


# -- M3.1: find access units ----------------------------------------------------------------------------------------------------
def find_aus(buf, base=0):
    """Access units in buf: where each starts, whether it is a key frame, and the resolution of any SPS in it. A stream is accepted
    only once an SPS parses; NAL units before that, or that break the syntax chain, are ignored."""
    nals, codec = [], None
    matches = list(START.finditer(buf))
    for n, m in enumerate(matches):
        pos, at = m.start(), m.end()
        end = matches[n + 1].start() if n + 1 < len(matches) else None  # NAL bytes run to the next start code
        if at + 3 > len(buf):
            break
        b = buf[at]
        if b & 0x80:
            continue
        if codec is None:
            if b & 0x1F == 7 and sps_h264(buf[at:at + 80]):
                codec = "h264"
            elif (b >> 1) & 0x3F == 33 and sps_h265(buf[at:at + 92]):
                codec = "h265"
            else:
                continue
        if codec == "h264":
            t = b & 0x1F
            if t not in H264_TYPES:
                continue
            # A start code can appear inside a record header (Uniview's packet header holds 00 00 00 01), followed by a byte that happens
            # to look like a NAL header. Non-picture NAL units are therefore checked against their own syntax before they can open an AU.
            if end is not None and ((t == 7 and not sps_h264(buf[at:at + 80])) or (t == 8 and not _pps_ok(buf[at + 1:end]))
                                    or (t == 9 and not (end - at == 2 and buf[at + 1] & 0x1F == 0x10)) or (t == 6 and not _sei_ok(buf[at + 1:end]))):
                continue
            vcl, first = t in (1, 5), buf[at + 1] & 0x80
        else:
            t = (b >> 1) & 0x3F
            if t not in H265_VCL | H265_PARAM or ((b & 1) << 5 | buf[at + 1] >> 3) != 0:
                continue
            if t == 33 and end is not None and not sps_h265(buf[at:at + 92]):
                continue
            vcl, first = t in H265_VCL, buf[at + 2] & 0x80
        nals.append((pos, at, t, vcl, first))
    aus, cur = [], None
    for pos, at, t, vcl, first in nals:
        if cur is None or (cur["vcl"] and (first if vcl else True)):
            if cur:
                aus.append(cur)
            cur = {"offset": base + pos, "codec": codec, "key": False, "vcl": False, "sps": None, "sps_fp": None}
        if vcl:
            cur["vcl"] = True
            cur["key"] = cur["key"] or (t == 5 if codec == "h264" else 16 <= t <= 21)
        elif (codec == "h264" and t == 7) or (codec == "h265" and t == 33):
            sps = (sps_h264 if codec == "h264" else sps_h265)(buf[at:at + 92])
            if sps and not cur["sps"]:
                cur["sps"], cur["sps_fp"] = sps, hashlib.md5(buf[at:at + 24]).hexdigest()[:8]
    return aus[1:] if len(aus) > 1 else []  # the first can start mid-record; the last is cut off by the window


def _regions(size):
    if size <= WINDOW * REGIONS:
        step = WINDOW - (64 << 10)
        return [(o, min(WINDOW, size - o)) for o in range(0, max(size, 1), step)]
    stride = (size - WINDOW) // (REGIONS - 1) // (1 << 20) * (1 << 20)
    return [(i * stride, WINDOW) for i in range(REGIONS)]


def collect(reader, progress=lambda f: None):
    """Access units across regions spread over the disk, each tagged with its region so a held-out region can be kept apart."""
    seen, out = set(), []
    regions = _regions(reader.image_size)
    for n, (off, length) in enumerate(regions):
        buf = reader.read(off, length)
        if b"\x00\x00\x01" in buf:
            for au in find_aus(buf, off):
                if au["offset"] not in seen:
                    seen.add(au["offset"])
                    out.append(dict(au, region=n))
        progress((n + 1) / len(regions))
    out.sort(key=lambda a: a["offset"])
    return [a for a in out if a["offset"] >= K]


# -- M3.2: field-role tests ----------------------------------------------------------------------------------------------------
class _Set:
    """Pre-windows (the K bytes before each access unit) plus what the video itself says about each record."""

    def __init__(self, reader, aus):
        n = len(aus)
        self.n, self.aus = n, aus
        self.W = np.zeros((n, K), np.uint8)
        for i, a in enumerate(aus):
            self.W[i] = np.frombuffer(reader.read(a["offset"] - K, K), np.uint8)
        self.key = np.array([a["key"] for a in aus])
        offs = np.array([a["offset"] for a in aus], np.int64)
        same = np.zeros(n, bool)
        same[:-1] = (offs[1:] - offs[:-1] < GAP) & (np.array([a["region"] for a in aus[1:]]) == np.array([a["region"] for a in aus[:-1]])) if n > 1 else False
        self.same = same  # record i and i+1 are neighbours in one run
        self.run = np.r_[0, np.cumsum(~same[:-1])] if n > 1 else np.zeros(n, int)
        self.span = np.where(same, np.r_[offs[1:] - offs[:-1], 0], -1).astype(np.int64)
        width = height = 0
        self.width, self.height = np.zeros(n, np.int64), np.zeros(n, np.int64)
        self.fp = np.array([a["sps_fp"] or "" for a in aus], object)
        for i, a in enumerate(aus):
            if a["sps"]:
                width, height = a["sps"]["width"], a["sps"]["height"]
            self.width[i], self.height[i] = width, height


def _cols(S, j, r, w):
    """Values of the w-byte field at offset r from each record's anchor index j: (little-endian, big-endian, valid)."""
    idx = j[:, None] + r + np.arange(w)[None, :]
    ok = ((idx >= 0) & (idx < K)).all(axis=1)
    B = S.W[np.arange(S.n)[:, None], np.clip(idx, 0, K - 1)].astype(np.uint64)
    shifts = (np.arange(w, dtype=np.uint64) * np.uint64(8))[None, :]
    return (B << shifts).sum(axis=1, dtype=np.uint64), (B << shifts[:, ::-1]).sum(axis=1, dtype=np.uint64), ok


def _mode_frac(d, valid):
    d = d[valid]
    if len(d) < 8:
        return 0.0, 0
    vals, counts = np.unique(d, return_counts=True)
    k = counts.argmax()
    return counts[k] / len(d), int(vals[k])


def _step_fraction(vals, S, mod, groups=None):
    """Fraction of records whose value rises by exactly one over the previous record of the same group in the same run (modulo the width)."""
    last, ok, total = {}, 0, 0
    for i in range(S.n):
        g = None if groups is None else int(groups[i])
        p = last.get(g)
        if p is not None and S.run[p] == S.run[i]:
            total += 1
            ok += int((int(vals[i]) - int(vals[p])) % mod == 1)
        last[g] = i
    return ok / total if total >= 8 else 0.0


def _timestamp(vals, w, S, now):
    """Best clock encoding for a field: (encoding, plausible fraction, monotone fraction, median step) or None."""
    v = vals.astype(np.float64)
    out = []
    if w in (4, 8):
        out.append(("unix seconds", v, 1, 0.6, 1))
    if w == 8:
        out += [("unix milliseconds", v / 1e3, 1, 1e-4, 1e3), ("unix microseconds", v / 1e6, 1, 1e-4, 1e6), ("Windows FILETIME", v / 1e7 - 11644473600, 1, 1e-4, 1e7)]
    if w == 4:
        u = vals.astype(np.uint64)
        year, month, day = (u >> np.uint64(26)) & np.uint64(63), (u >> np.uint64(22)) & np.uint64(15), (u >> np.uint64(17)) & np.uint64(31)
        hour, minute, sec = (u >> np.uint64(12)) & np.uint64(31), (u >> np.uint64(6)) & np.uint64(63), u & np.uint64(63)
        plaus = (year >= 5) & (year <= 100) & (month >= 1) & (month <= 12) & (day >= 1) & (day <= 31) & (hour < 24) & (minute < 60) & (sec < 60)
        out.append(("packed date (sec 0-5, min 6-11, hour 12-16, day 17-21, month 22-25, year-2000 26-31)", plaus, None, 0.44, None))
    fits = []
    # a field that holds one value in most records is a constant, not a clock
    if np.unique(vals, return_counts=True)[1].max() / len(vals) > 0.5:
        return None
    for enc, series, kind, spec, unit in out:
        plaus = series if kind is None else (series >= EPOCH_LO) & (series <= now + 86400)
        frac = float(plaus.mean())
        if frac < 0.9:
            continue
        ok = S.same[:-1]
        mono = float((vals[1:][ok] >= vals[:-1][ok]).mean()) if ok.sum() >= 8 else 0.0
        steps = np.diff(vals.astype(np.float64))[ok]
        if len(np.unique(vals)) < 4:
            continue
        if unit is not None and len(steps):
            # neighbouring records are frames apart: a real clock advances by seconds at most, never by days (a counter shifted into the high bytes does)
            seconds = np.abs(steps) / unit
            if np.median(seconds) > 5 or np.percentile(seconds, 90) > 60:
                continue
        fits.append((enc, frac, mono, float(np.median(steps)) if len(steps) else 0.0, spec))
    if not fits:
        return None
    fits.sort(key=lambda f: (-round(min(f[1:3]), 2), f[4]))  # best fit first; on a tie the more specific encoding
    best = fits[0]
    # encodings that fit as well cannot be told apart on this span of data (a short run never rolls over a minute): say so rather than pick silently
    alternatives = [f[0].split(" (")[0] for f in fits[1:] if round(min(f[1:3]), 2) >= round(min(best[1:3]), 2) - 0.02]
    return best + (alternatives,)


def _entropy(x):
    _, c = np.unique(x, return_counts=True)
    p = c / c.sum()
    return float(-(p * np.log2(p)).sum())


def _crc16(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


PRIORITY = {"ext_length": 0, "length": 1, "timestamp": 2, "counter": 3, "resolution": 4, "frame_type": 5, "channel": 6, "checksum": 7, "relative_clock": 8}


def _fields(S, j, h, now, anchored):
    """Every field-role hypothesis over the pre-windows, anchored at index j (per record). Returns candidate fields and the h-array facts."""
    N = S.n
    fmin = int(h.min()) if anchored else 0
    rlo = -40 if anchored else -(K // 2)
    rhi = fmin if anchored else 0
    cand, consts = [], {}
    hn = np.r_[h[1:], h[-1]]
    span_valid = S.span >= 0
    cols = {}
    for w in (1, 2, 4, 8):
        for r in range(rlo, rhi - w + 1):
            le, be, ok = _cols(S, j, r, w)
            if ok.mean() < 0.99:
                continue
            for endian, vals in (("le", le), ("be", be)):
                if w == 1 and endian == "be":
                    continue
                cols[(r, w, endian)] = (vals, ok)
    for (r, w, endian), (vals, ok) in cols.items():
        if w == 1:
            u, c = np.unique(vals[ok], return_counts=True)
            if c.max() / ok.sum() >= 0.99:
                consts[r] = int(u[c.argmax()])
        nuniq = len(np.unique(vals[ok]))
        field = {"offset": r, "width": w, "endian": endian}
        # length: payload-plus-trailer or whole record, up to a constant
        if w in (2, 4) and nuniq >= 3:
            for variant, d in (("payload+trailer", vals.astype(np.int64) - (S.span - hn)), ("whole record", vals.astype(np.int64) - h - (S.span - hn))):
                frac, c0 = _mode_frac(d, span_valid & ok)
                if frac >= ACCEPT:
                    cand.append(dict(field, role="length", score=frac, evidence=f"{variant}: value = distance to the next record - next header + {c0}", const=c0, variant=variant))
        if w == 1 and nuniq >= 2 and len(np.unique(h)) >= 2:
            frac, c0 = _mode_frac(vals.astype(np.int64) - (h - fmin), ok)
            if frac >= ACCEPT:
                cand.append(dict(field, role="ext_length", score=frac, evidence=f"= header bytes beyond the fixed {fmin} + {c0}", const=c0))
        if w in (4, 8):
            ts = _timestamp(vals, w, S, now)
            if ts and min(ts[1], ts[2]) >= 0.9:
                note = f" (this span of data cannot rule out: {'; '.join(ts[5])})" if ts[5] else ""
                cand.append(dict(field, role="timestamp", score=min(ts[1], ts[2]), encoding=ts[0], median_step=ts[3], specificity=ts[4],
                                 alternatives=ts[5], evidence=f"{ts[0].split(' (')[0]}: {ts[1]:.0%} plausible dates, {ts[2]:.0%} rising{note}"))
        if w in (1, 2, 4) and nuniq >= 4:
            frac = _step_fraction(vals, S, 1 << (8 * w))
            if frac >= ACCEPT:
                cand.append(dict(field, role="counter", score=frac, evidence=f"{frac:.0%} of neighbouring records rise by exactly 1"))
        if w in (1, 2):
            known = S.width > 0
            for dim, arr in (("width", S.width), ("height", S.height)):
                for div in (1, 8, 16):
                    frac = float((vals[known & ok].astype(np.int64) * div == arr[known & ok]).mean()) if (known & ok).sum() >= 8 else 0
                    if frac >= ACCEPT and nuniq <= 3:
                        cand.append(dict(field, role="resolution", score=frac, dimension=dim, divisor=div,
                                         evidence=f"x{div} equals the SPS {dim} in {frac:.0%} of records"))
        if w == 1 and 2 <= nuniq <= 8 and S.key.any() and not S.key.all():
            pk, v = S.key.mean(), vals[ok]
            h_key = _entropy(S.key)
            h_cond = sum((v == x).mean() * _entropy(S.key[ok][v == x]) for x in np.unique(v))
            mi = (h_key - h_cond) / h_key if h_key > 0 else 0
            if mi >= 0.9:
                mapping = {int(x): bool(S.key[ok][v == x].mean() > 0.5) for x in np.unique(v)}
                cand.append(dict(field, role="frame_type", score=float(mi) - 0.001 * nuniq, mapping=mapping, evidence=f"{mi:.0%} of the key-frame flag is explained by this byte"))
        if w in (4, 8) and nuniq >= 10 and not any(c["offset"] == r and c["role"] == "timestamp" for c in cand):
            ok_pairs = S.same[:-1]
            if ok_pairs.sum() >= 8:
                diffs = np.diff(vals.astype(np.float64))[ok_pairs]
                mono = float((diffs >= 0).mean())
                if mono >= ACCEPT and np.median(diffs) > 0 and sum(consts.get(r + k) is not None for k in range(w)) <= w // 2 - 1:
                    cand.append(dict(field, role="relative_clock", score=0.5, evidence=f"{mono:.0%} rising; no date decoding fits (a tick counter such as a 90 kHz PTS?)"))
    gcols = [(k, v) for k, v in cols.items() if k[1] in (1, 2) and 2 <= len(np.unique(v[0][v[1]])) <= 64]
    ccols = [(k, v) for k, v in cols.items() if k[1] in (1, 2, 4) and len(np.unique(v[0][v[1]])) >= max(8, N // 4)]
    have = {(c["offset"], c["width"]) for c in cand if c["role"] == "counter"}
    # counters that only count within a channel (cameras alternate on disk, so no one counter rises by 1 across neighbours)
    for gk, (gvals, gok) in sorted(gcols, key=lambda kv: len(np.unique(kv[1][0][kv[1][1]])))[:10]:
        groups = gvals.astype(np.int64)
        for ck, (cvals, cok) in ccols:
            if (ck[0], ck[1]) in have or (ck[0] < gk[0] + gk[1] and gk[0] < ck[0] + ck[1]):
                continue
            within = _step_fraction(cvals, S, 1 << (8 * ck[1]), groups)
            if within >= ACCEPT:
                have.add((ck[0], ck[1]))
                cand.append(dict(offset=ck[0], width=ck[1], endian=ck[2], role="counter", score=within, group_by=gk[0],
                                 evidence=f"{within:.0%} of records rise by exactly 1 over the previous record with the same value at offset {gk[0]}"))
    narrow = {(c["offset"], c["endian"]) for c in cand if c["role"] == "relative_clock" and c["width"] == 4}
    cand = [c for c in cand if not (c["role"] == "relative_clock" and c["width"] == 8 and (c["offset"], c["endian"]) in narrow and (c["offset"] + 4, c["endian"]) in narrow)]
    # channel: few values, and splitting by it makes counters count up (or the SPS homogeneous)
    counters = [c for c in cand if c["role"] == "counter"]
    for (r, w, endian), (vals, ok) in cols.items():
        if w not in (1, 2) or any(c["offset"] == r and c["width"] == w for c in cand):
            continue
        nuniq = len(np.unique(vals[ok]))
        if not 2 <= nuniq <= 64:
            continue
        groups = vals.astype(np.int64)
        best = None
        for c in counters:
            cv = cols.get((c["offset"], c["width"], c["endian"]))
            if cv is None:
                continue
            within, overall = _step_fraction(cv[0], S, 1 << (8 * c["width"]), groups), _step_fraction(cv[0], S, 1 << (8 * c["width"]))
            if within >= ACCEPT and within - overall >= 0.1:
                best = (within, f"counting by this value makes the counter rise by 1 in {within:.0%} of records (against {overall:.0%} without it)")
        if best is None and len(set(S.fp) - {""}) >= 2:
            known = S.fp != ""
            homog = sum(Counter(S.fp[known & (groups == g)]).most_common(1)[0][1] for g in np.unique(groups[known])) / known.sum()
            if homog >= ACCEPT:
                best = (homog, f"records with the same value share an SPS in {homog:.0%} of cases")
        if best:
            cand.append(dict(offset=r, width=w, endian=endian, role="channel", score=best[0], values=nuniq, evidence=best[1]))
    # checksum over the header bytes before the field (anchored layouts only)
    if anchored:
        for (r, w, endian), (vals, ok) in cols.items():
            if r < 4 or w not in (1, 2, 4) or len(np.unique(vals[ok])) < 4 or any(
                    c["offset"] < r + w and r < c["offset"] + c["width"] for c in cand if c["role"] != "checksum"):
                continue
            for alg in ("sum8", "xor8", "crc16", "sum16", "crc32") if w != 1 else ("sum8", "xor8"):
                if (alg in ("crc16", "sum16") and w != 2) or (alg == "crc32" and w != 4):
                    continue
                hit = 0
                for i in range(N):
                    data = S.W[i, j[i]:j[i] + r].tobytes()
                    calc = {"sum8": sum(data) & 0xFF, "xor8": int(np.bitwise_xor.reduce(np.frombuffer(data, np.uint8))) if data else 0,
                            "crc16": _crc16(data), "sum16": sum(data) & 0xFFFF, "crc32": zlib.crc32(data)}[alg]
                    hit += int(calc == int(vals[i]))
                if hit / N >= ACCEPT:
                    cand.append(dict(offset=r, width=w, endian=endian, role="checksum", score=hit / N, algorithm=alg,
                                     evidence=f"{alg} of the {r} header bytes before it matches in {hit / N:.0%} of records"))
    # a constant byte at the low end of a multi-byte field is odd (leading zeros sit at the high end), so such an alignment loses a tie
    for c in cand:
        c["lsb_const"] = int(c["width"] > 1 and consts.get(c["offset"] if c["endian"] == "le" else c["offset"] + c["width"] - 1) is not None)
    return cand, consts


SINGLE = {"frame_type", "ext_length", "length", "counter", "channel", "checksum"}


def _assign(cand, consts, fmin, prefer="le"):
    """Greedy, by role priority then score: one role per byte, and one of each single-instance role. Of equal candidates the wider field
    wins (a 2-byte slice of a 4-byte length is not a length field) and, for clocks, the more specific encoding. Constants fill what is left."""
    taken, chosen, seen = set(), [], set()
    for c in sorted(cand, key=lambda c: (PRIORITY[c["role"]], -round(c["score"], 3), c.get("specificity", 0),
                                     c["width"] if c["role"] in ("relative_clock", "channel") else -c["width"], c["endian"] != prefer, c.get("lsb_const", 0),
                                     abs(c["offset"]))):
        span = set(range(c["offset"], c["offset"] + c["width"]))
        if span & taken or (c["role"] in SINGLE and c["role"] in seen):
            continue
        seen.add(c["role"])
        taken |= span
        chosen.append(c)
    runs, run = [], []
    for r in sorted(consts):
        if r in taken:
            continue
        if run and r != run[-1] + 1:
            runs.append(run)
            run = []
        run.append(r)
    if run:
        runs.append(run)
    for run in runs:
        while len(run) > 1 and consts[run[0]] == 0:
            run = run[1:]
        while len(run) > 1 and consts[run[-1]] == 0:
            run = run[:-1]
        if len(run) >= 2 or consts[run[0]] != 0:
            chosen.append({"offset": run[0], "width": len(run), "endian": "-", "role": "constant", "score": 1.0, "value": bytes(consts[r] for r in run).hex(),
                           "evidence": "the same bytes in at least 99% of records"})
            taken |= set(run)
    return sorted(chosen, key=lambda c: c["offset"]), taken


def _anchor_candidates(S):
    """Constant n-grams that sit before (almost) every record: the magic of a record header, or of the trailer before it."""
    rows = [S.W[i].tobytes() for i in range(0, S.n, max(1, S.n // 800))]
    found, taken = [], []
    for n in (6, 5, 4, 3, 2):
        cnt = Counter()
        for row in rows:
            cnt.update({row[x:x + n] for x in range(K - n + 1)})
        for gram, c in cnt.most_common(40):
            if c / len(rows) >= 0.98 and len(set(gram)) > 1 and not any(gram in t for t in taken):
                found.append(gram)
                taken.append(gram)
    return found[:8]


def _anchor_positions(S, gram):
    j = np.full(S.n, -1, np.int64)
    for i in range(S.n):
        p = S.W[i].tobytes().rfind(gram)
        j[i] = p
    return j


def induce_schema(S, now):
    """The best schema for the records in S: tried anchored on each candidate magic, and with no anchor (fixed header before the payload)."""
    options = []
    for gram in _anchor_candidates(S):
        j = _anchor_positions(S, gram)
        if (j < 0).mean() > 0.02:
            continue
        j = np.where(j < 0, int(np.median(j[j >= 0])), j)
        h = K - j
        if len(np.unique(h)) > 12:
            continue
        options.append(("anchored", gram, j, h))
    options.append(("payload", b"", np.full(S.n, K, np.int64), np.zeros(S.n, np.int64)))
    best = None
    for mode, gram, j, h in options:
        anchored = mode == "anchored"
        cand, consts = _fields(S, j, h, now, anchored)
        fmin = int(h.min()) if anchored else 0
        chosen, taken = _assign(cand, consts, fmin)
        varying = Counter(c["endian"] for c in chosen if c["width"] > 1 and c["role"] in ("length", "timestamp", "counter", "checksum", "relative_clock"))
        if varying and varying.most_common(1)[0][0] != "le":
            # the byte order the varying fields use decides the ambiguous constant ones (resolution, a zero-padded value)
            chosen, taken = _assign(cand, consts, fmin, prefer=varying.most_common(1)[0][0])
        roles = {}
        for c in chosen:
            if c["role"] != "constant":
                roles[c["role"]] = max(roles.get(c["role"], 0), c["score"])
        score = sum(roles.values()) + 0.1 * any(c["role"] == "constant" for c in chosen)
        # on a tie prefer the anchor farther from the payload: it is nearer the start of the record
        key = (round(score, 3), int(h.max()) if anchored else 0)
        if best is None or key > best["key"]:
            best = {"key": key, "mode": mode, "anchor": gram, "j": j, "h": h, "fields": chosen, "taken": taken, "fmin": fmin, "score": score}
    return best


# -- M3.2.4 verifier ------------------------------------------------------------------------------------------------------------
def verify(schema, held, now):
    """Decode the held-out records with the induced schema alone. Coverage: the record's header could be located. Consistency: every
    rule the schema learned holds on the records it located."""
    N = held.n
    if schema["mode"] == "anchored":
        j = _anchor_positions(held, schema["anchor"])
        located = j >= 0
        j = np.where(located, j, K)
        h = K - j
        located &= h >= schema["fmin"]
    else:
        j, h, located = np.full(N, K, np.int64), np.zeros(N, np.int64), np.ones(N, bool)
    hn = np.r_[h[1:], h[-1]]
    rule_ok = np.ones(N, bool)
    rules = []
    channel = next((f for f in schema["fields"] if f["role"] == "channel"), None)
    groups = None
    if channel:
        cle, cbe, _ = _cols(held, j, channel["offset"], channel["width"])
        groups = (cbe if channel["endian"] == "be" else cle).astype(np.int64)
    for f in schema["fields"]:
        r, w = f["offset"], f["width"]
        le, be, ok = _cols(held, j, r, w)
        vals = be if f["endian"] == "be" else le
        passed = np.ones(N, bool)
        role = f["role"]
        if role == "constant":
            passed = np.array([held.W[i, max(0, min(K - 1, j[i] + r)):j[i] + r + w].tobytes().hex() == f["value"] for i in range(N)])
        elif role == "length":
            d = vals.astype(np.int64) - (held.span - hn) - (h if f["variant"] == "whole record" else 0)
            passed = np.where(held.span >= 0, d == f["const"], True)
        elif role == "ext_length":
            passed = vals.astype(np.int64) - (h - schema["fmin"]) == f["const"]
        elif role == "timestamp":
            ts = _timestamp(vals, w, held, now)
            passed = np.full(N, bool(ts and ts[0] == f["encoding"] and ts[1] >= 0.9 and ts[2] >= 0.9))
        elif role == "counter":
            passed = np.full(N, _step_fraction(vals, held, 1 << (8 * w), groups) >= ACCEPT)
        elif role == "resolution":
            arr = held.width if f["dimension"] == "width" else held.height
            passed = np.where(arr > 0, vals.astype(np.int64) * f["divisor"] == arr, True)
        elif role == "frame_type":
            passed = np.array([f["mapping"].get(int(v), None) == bool(k) for v, k in zip(vals, held.key)])
        elif role == "checksum":
            calc = [{"sum8": lambda d: sum(d) & 0xFF, "xor8": lambda d: int(np.bitwise_xor.reduce(np.frombuffer(d, np.uint8))) if d else 0,
                     "crc16": _crc16, "sum16": lambda d: sum(d) & 0xFFFF, "crc32": zlib.crc32}[f["algorithm"]](held.W[i, j[i]:j[i] + r].tobytes()) for i in range(N)]
            passed = np.array([c == int(v) for c, v in zip(calc, vals)])
        passed = passed | ~ok
        rules.append({"role": role, "offset": r, "width": w, "holds": float(passed[located].mean()) if located.any() else 0.0})
        rule_ok &= passed
    coverage = float(located.mean())
    consistency = float(rule_ok[located].mean()) if located.any() else 0.0
    return {"records": N, "coverage": coverage, "consistency": consistency, "rules": rules, "accepted": N >= 20 and coverage >= ACCEPT and consistency >= ACCEPT}


# -- output ----------------------------------------------------------------------------------------------------------------------
def to_ksy(schema, name="induced_record"):
    """A Kaitai Struct description of the induced header, for the examiner to review and correct."""
    fields = [f for f in schema["fields"]]
    lo = min(f["offset"] for f in fields)
    lines = [f"meta:\n  id: {name}\n  endian: le", "doc: |", "  Induced blind from the video payloads (plan.md M3.2). Offsets are from the first byte of the anchor magic."
             if schema["mode"] == "anchored" else "  Induced blind from the video payloads. Offsets count back from the payload start.", "seq:"]
    pos = lo
    for f in fields:
        if f["offset"] > pos:
            lines.append(f"  - id: unknown_{pos}\n    size: {f['offset'] - pos}\n    doc: not decoded")
        t = {"constant": None, "frame_type": "u1"}.get(f["role"], f"u{f['width']}{f['endian']}" if f["width"] > 1 else "u1")
        if f["role"] == "constant":
            lines.append(f"  - id: magic_{f['offset']}\n    contents: [{', '.join('0x' + f['value'][i:i + 2] for i in range(0, len(f['value']), 2))}]")
        else:
            lines.append(f"  - id: {f['role']}_{f['offset']}\n    type: {t}\n    doc: \"{f['evidence']} (score {f['score']:.2f})\"")
        pos = f["offset"] + f["width"]
    return "\n".join(lines) + "\n"


def _public(schema):
    fields = []
    for f in schema["fields"]:
        out = {k: v for k, v in f.items() if k not in ("mapping",)}
        out["score"] = round(float(out["score"]), 3)
        if "mapping" in f:
            out["mapping"] = {str(k): v for k, v in f["mapping"].items()}
        if "median_step" in out:
            out["median_step"] = round(out["median_step"], 3)
        fields.append(out)
    covered = {b for f in schema["fields"] for b in range(f["offset"], f["offset"] + f["width"])}
    lo, hi = min(covered), schema["fmin"] if schema["mode"] == "anchored" else 0
    return {"mode": schema["mode"], "anchor": schema["anchor"].hex() or None, "fixed_header_bytes": schema["fmin"] if schema["mode"] == "anchored" else None,
            "extension_bytes": int(schema["h"].max() - schema["h"].min()) if schema["mode"] == "anchored" else 0, "fields": fields,
            "undecoded_bytes": [b for b in range(lo, hi) if b not in covered], "score": round(schema["score"], 2)}


def induce(reader, progress=lambda f: None, now=None):
    """Blind induction on an image. Always returns a report; `found` says whether a verified header schema came out of it."""
    now = now or time.time()
    aus = collect(reader, progress)
    summary = {"access_units": len(aus), "key_frames": sum(a["key"] for a in aus), "codecs": sorted({a["codec"] for a in aus}),
               "resolutions": sorted({f"{a['sps']['width']}x{a['sps']['height']}" for a in aus if a["sps"]})}
    limits = "Finds the header before video payloads only; audio, index and log records are not seen. Annex-B video only."
    if len(aus) < 60:
        return {"found": False, "reason": f"only {len(aus)} H.264/H.265 access units were found (60 are needed to learn and then check a layout)",
                "payloads": summary, "limits": limits}
    regions = sorted({a["region"] for a in aus})
    if len(regions) >= 2:
        cut = regions[len(regions) // 2]
        train, test = [a for a in aus if a["region"] < cut], [a for a in aus if a["region"] >= cut]
    else:
        half = len(aus) // 2
        train, test = aus[:half], aus[half:]
    S, H = _Set(reader, train), _Set(reader, test)
    schema = induce_schema(S, now)
    result = {"payloads": summary, "split": {"induced_from": len(train), "held_out": len(test),
                                              "held_out_region": "later regions of the disk" if len(regions) >= 2 else "second half of the one region"}, "limits": limits}
    if not schema or not [f for f in schema["fields"] if f["role"] != "constant"]:
        groups = Counter(a["sps_fp"] for a in aus if a["sps_fp"])
        return dict(result, found=False, reason="no field in the bytes before the video follows a rule (no constant, counter, clock, size or key-frame field)",
                    fallback={"method": "access units grouped by SPS fingerprint", "groups": [{"sps": k, "access_units": v} for k, v in groups.most_common(8)]})
    report = verify(schema, H, now)
    public = _public(schema)
    result.update(found=report["accepted"], schema=public, verification=report, ksy=to_ksy(schema))
    if not report["accepted"]:
        result["reason"] = (f"the schema learned from the first region decodes the held-out region at coverage {report['coverage']:.0%} and consistency "
                            f"{report['consistency']:.0%}; both must reach 95%. It is shown for review but not trusted.")
    return result
