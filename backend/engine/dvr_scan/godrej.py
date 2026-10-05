"""Godrej NVR adapter (Qualvision QVFS).

Layout from a third-party static disassembly of Qualvision's NVR401L-4P4 firmware (20240531), published as the Godrej
plugin of github.com/victorysingh/dvr-forensics-toolkit. The Godrej link is indirect: that author concludes Godrej's
SeeThru recorders run Qualvision's software because Godrej's cloud portal uses Qualvision's API, and says plainly it is
not established for every Godrej model. No Godrej or Qualvision disk has been read by anyone involved: this adapter is
checked only against a synthetic image built from that description.

All little-endian:
  disk or partition head   "QVEX" @0, version 0x00010000 @4, identity @8, size field @0x0C (in 512-byte sectors), then two
                           (start, size) regions at 0x10 and 0x18. The firmware checks start + size <= size field.
  frame                    20-byte head: 00 00 01 + type 0xE0-0xEB, u32 payload length @4, Dahua-style packed date @8 (sec 0-5, min 6-11,
                           hour 12-16, day 17-21, month 22-25, year-2000 26-31), u16 milliseconds @0x0C, six bytes undecoded.
                           The next frame starts at head + 0x14 + length. The index that names each frame's camera is not decoded.
"""
import re
import struct
from datetime import datetime

from dvr_scan.oem_common import Window, guess_codec, partition_starts

MAGIC, VERSION = b"QVEX", 0x00010000
FRAME_HEAD, MAX_LEN, MIN_RUN, SCAN = 0x14, 8 << 20, 3, 8 << 20
FRAME_RE = re.compile(rb"\x00\x00\x01[\xe0-\xeb]")


def _dhtime(raw):
    try:
        when = datetime(2000 + (raw >> 26), (raw >> 22) & 15, (raw >> 17) & 31, (raw >> 12) & 31, (raw >> 6) & 63, raw & 63)
    except ValueError:
        return None
    return when if when.year >= 2005 else None


def _annexb(first4):
    return first4 == b"\x00\x00\x00\x01" or first4[:3] == b"\x00\x00\x01"


def _head(reader, offset):
    if offset + 0x20 > reader.image_size:
        return None
    raw = reader.read(offset, 0x20)
    if raw[:4] != MAGIC:
        return None
    version, ident, size, a0, a1, b0, b1 = struct.unpack_from("<7I", raw, 4)
    if version != VERSION:
        return None
    return {"offset": offset, "id": ident, "size_field": size, "region_a": (a0, a1), "region_b": (b0, b1),
            "bounds_ok": a0 + a1 <= size and b0 + b1 <= size and a1 + b1 + 1 <= size}


def detect(reader):
    for start in partition_starts(reader):
        head = _head(reader, start)
        if head and head["bounds_ok"]:
            return head
    return None


def _frame(win, offset):
    b = win.read(offset, FRAME_HEAD)
    if len(b) < FRAME_HEAD or b[:3] != b"\x00\x00\x01" or not 0xE0 <= b[3] <= 0xEB:
        return None
    length, packed, ms = struct.unpack_from("<IIH", b, 4)
    when = _dhtime(packed)
    return {"type": b[3], "length": length, "time": when, "ms": ms} if 0 < length <= MAX_LEN and ms < 1000 and when else None


def _runs(reader, win, lo, hi):
    """Runs of chained frames in [lo, hi): each head is followed, where its length says, by the next. A lone head is passed over."""
    pos = lo
    while pos < hi:
        chunk = reader.read(pos, min(SCAN, hi - pos))
        if not chunk:
            return
        m = FRAME_RE.search(chunk)
        if not m:
            pos += max(1, len(chunk) - 3)
            continue
        at, cursor, frames = pos + m.start(), pos + m.start(), []
        while cursor + FRAME_HEAD <= hi:
            f = _frame(win, cursor)
            if f is None or cursor + FRAME_HEAD + f["length"] > hi:
                break
            f["offset"] = cursor
            frames.append(f)
            cursor += FRAME_HEAD + f["length"]
        if len(frames) >= MIN_RUN:
            yield {"start": at, "end": cursor, "frames": frames}
            pos = cursor
        else:
            pos = at + 1


def _stamp(frame):
    return frame["time"].strftime("%Y-%m-%d %H:%M:%S") + f".{frame['ms']:03d} (recorder clock)"


def parse(reader, det, progress=lambda fraction: None):
    win, size, head = Window(reader), reader.image_size, det
    span = size - head["offset"]
    unit = 512 if span and abs(head["size_field"] * 512 - span) <= max(span // 100, 1 << 20) else None
    regions = [(head["offset"] + s * unit, head["offset"] + (s + n) * unit) for s, n in (head["region_a"], head["region_b"]) if n] \
        if unit else [(head["offset"] + 512, size)]
    rows = []
    for lo, hi in regions:
        for run in _runs(reader, win, lo, min(hi, size)):
            video = [f for f in run["frames"] if _annexb(win.read(f["offset"] + FRAME_HEAD, 4))]
            first, last = (video or run["frames"])[0], (video or run["frames"])[-1]
            seconds = (last["time"] - first["time"]).total_seconds() + (last["ms"] - first["ms"]) / 1000
            fps = round((len(video) - 1) / seconds, 2) if len(video) > 1 and seconds > 0 else None
            rows.append({"channel": None, "start": _stamp(first), "end": _stamp(last), "offset": hex(run["start"]),
                         "range": [run["start"], run["end"]], "ranges": [[run["start"], run["end"]]], "frames": len(video),
                         "frames_total": len(run["frames"]), "fps": fps if fps and 1 <= fps <= 120 else None,
                         "codec": guess_codec(win.read(video[0]["offset"] + FRAME_HEAD, 64)) if video else "",
                         "source": "frame chain", "state": "unknown",
                         "state_reason": "found by the frame chain alone; the index that separates live from deleted footage is not decoded",
                         "status": f"Godrej (Qualvision) run, {len(video)} video frames"})
            progress(min(1, (run["end"] - head["offset"]) / max(span, 1)))
    return {"head": dict(head, unit_bytes=unit), "recordings": rows,
            "warnings": ["Godrej layout is Qualvision's QVFS, taken from a third party's disassembly of Qualvision firmware (NVR401L-4P4, 20240531). "
                         "Godrej's use of Qualvision software is inferred from its cloud API, not established for every model, and no such disk "
                         "has been read by the team. Footage is found by the frame chain only: no camera is attributed and live is not told from "
                         "deleted. Times are the recorder's wall clock with no timezone check."]}


def write_stream(reader, row, target):
    win, codec = Window(reader), ""
    for start, end in row["ranges"]:
        pos = start
        while pos < end:
            f = _frame(win, pos)
            if f is None or pos + FRAME_HEAD + f["length"] > end:
                break
            payload = win.read(pos + FRAME_HEAD, f["length"])
            if _annexb(payload[:4]):
                codec = codec or guess_codec(payload[:64])
                target.write(payload)
            pos += FRAME_HEAD + f["length"]
    return codec
