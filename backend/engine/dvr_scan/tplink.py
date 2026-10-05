"""TP-Link VIGI NVR adapter (raw layout, "tpfs V1").

Layout from a third-party static disassembly of VIGI NVR1008H V2 firmware 240119 (liblayouthddb.so, libstorage.so, nvrcore),
published as the TP-Link plugin of github.com/victorysingh/dvr-forensics-toolkit. TP-Link's own documentation names no file system,
layout or extension. No VIGI disk has been read by anyone involved: this adapter is checked only against a synthetic image built from
that description. The recorder's SQLite index (a 512-byte "TP-Link format1" header, then the database, AES-capable) is not read, so no
camera is attributed; the older V0 layout (an ext4 partition holding sys.bin and zone files) is not handled.

  512 MiB (retried up to 560 MiB)   512-byte format sector: ASCII "TP-Link Corporation Limited, NVR FOR VERSION x.y.z" @0, u32 0x5450 @0x80,
                                    disk size u64 @0x84, zone size u32 @0x8C, CRC-32 of bytes 0..0x1FB @0x1FC. Database-area record @+0x400.
  data zones                        start at 0x23200000 + 2 x database-area size (64 MiB below 32 GiB of disk, 128 MiB below 3 TiB, else 256 MiB);
                                    zone z is the 1 GiB at start + z x 0x40000000.
  zone index                        the zone's first 1 MiB: 80-byte entries, one per GOP: zone u32 @0, event u32 @4, start u64 @8, end u64 @0x10,
                                    stream u32 @0x18 (0 main, 1 sub), offset in the zone u32 @0x1C, length u32 @0x20, frames @0x2C. Bytes 0x34..0x4F are zero.
  GOP                               its frames back to back: 32-byte header (time u64 @0, payload length u32 @8, type @0x0D, codec @0x10: 0 H.264, 1 H.265),
                                    then the payload, which starts 00 00 00 01, padded to 8 bytes; a key-frame table closes the GOP.
"""
import struct
import zlib
from datetime import datetime, timezone

from dvr_scan.oem_common import TIME_HI, TIME_LO, Window, clock, merge, overlaps

FORMAT_AT, FORMAT_WINDOW, FORMAT_SECTOR, CRC_AT = 0x20000000, 0x3200000, 0x200, 0x1FC
TAG = b"TP-Link Corporation Limited, NVR FOR VERSION"
FMT_MARKER = 0x5450
DB_AREA_AT, AREA_INFO_AT, AREA_JOURNAL_AT, AREA_EXTENTS, AREA_HEAD = 0x23200000, 0x400, 0x600, 31, 0x1000
ZONE_BYTES, ZONE_INDEX_BYTES, ENTRY = 0x40000000, 0x100000, 0x50
FRAME_HEAD, START4, GOP_MAX, MAX_ZONES = 0x20, b"\x00\x00\x00\x01", 64 << 20, 1 << 17
STREAMS, CODECS = {0: "main", 1: "sub"}, {0: "h264", 1: "h265"}
SCAN_BLOCK, RUN_GAP_BYTES, RUN_GAP_S = 64 << 20, 1 << 16, 120
# a GOP's first payload opens with an H.264 SPS/SEI/AUD or an H.265 VPS; the header and frame walk then have to check out
SPS_STARTS = tuple(START4 + nal for nal in (b"\x67", b"\x06", b"\x09", b"\x40\x01"))


def _when(value):
    """(seconds as float, unit) for an integer time of unknown unit, or (None, 'unrecognised')."""
    for div, unit in ((1, "s"), (1000, "ms"), (1_000_000, "us")):
        if value and TIME_LO <= value // div <= TIME_HI:
            return value / div, unit
    return None, "unrecognised"


def _text(seconds):
    return clock(int(seconds), int(round((seconds % 1) * 1000))) if seconds is not None else None


def _format_sector(raw):
    if len(raw) < FORMAT_SECTOR or not raw.startswith(TAG):
        return None
    tag = raw[:0x80].split(b"\x00", 1)[0].decode("ascii", "replace")
    stored = struct.unpack_from("<I", raw, CRC_AT)[0]
    marker, disk = struct.unpack_from("<IQ", raw, 0x80)
    return {"tag": tag, "version": tag[len(TAG):].strip(), "crc32_ok": zlib.crc32(raw[:CRC_AT]) == stored,
            "disk_bytes": disk if marker == FMT_MARKER else 0, "zone_bytes": struct.unpack_from("<I", raw, 0x8C)[0]}


def detect(reader):
    """The format sector near 512 MiB (the firmware retries past bad sectors up to 560 MiB), or None."""
    if reader.image_size < FORMAT_AT + FORMAT_SECTOR:
        return None
    pos, end = FORMAT_AT, min(FORMAT_AT + FORMAT_WINDOW, reader.image_size)
    while pos < end:
        buf = reader.read(pos, min(4 << 20, end - pos))
        if not buf:
            return None
        i = buf.find(TAG)
        while i >= 0:
            if (pos + i) % FORMAT_SECTOR == 0:
                fmt = _format_sector(reader.read(pos + i, FORMAT_SECTOR))
                if fmt:
                    return dict(fmt, offset=pos + i)
            i = buf.find(TAG, i + 1)
        pos += max(len(buf) - len(TAG), 1)
    return None


def _db_size(disk_bytes):
    return (64 << 20) if disk_bytes < 8 << 32 else (128 << 20) if disk_bytes < 0x300 << 32 else 256 << 20


def _geometry(reader, fmt):
    """Where the data zones start: the database area's start plus twice its size (rawDiskLayout_resetDBAreaInfo)."""
    area, source = None, "disk size"
    for where in (AREA_INFO_AT, AREA_JOURNAL_AT):
        raw = reader.read(fmt["offset"] + where, FORMAT_SECTOR)
        if len(raw) == FORMAT_SECTOR and zlib.crc32(raw[:CRC_AT]) == struct.unpack_from("<I", raw, CRC_AT)[0]:
            start, length = struct.unpack_from("<QQ", raw, 0)
            if length and start == DB_AREA_AT + AREA_HEAD:
                area, source = length + AREA_HEAD, "area record"
                break
    disk = fmt["disk_bytes"] or reader.image_size
    area = area or _db_size(disk)
    zones_at = DB_AREA_AT + 2 * area
    return {"database_area_bytes": area, "area_from": source, "data_zone_at": zones_at, "disk_bytes": disk,
            "zones": min(MAX_ZONES, max(0, (disk - zones_at) // ZONE_BYTES))}


def _entry(raw, zone):
    """One 80-byte zone-index entry, if this zone could have written it (the firmware never fills bytes 0x34..0x4F)."""
    if len(raw) < ENTRY or any(raw[0x34:ENTRY]):
        return None
    z, event, start, end, kind, offset, length, _a, _b, frames, _c = struct.unpack_from("<IIQQIIIIIII", raw, 0)
    if z != zone or not 0 < length <= GOP_MAX or not start or end < start or offset < ZONE_INDEX_BYTES or offset + length > ZONE_BYTES:
        return None
    return {"event": event, "start": start, "end": end, "stream": kind & 0xFFFF, "offset": offset, "length": length, "frames": frames & 0xFFFFFF}


def _walk(read, start, limit):
    """Frames of one GOP as the recorder's playback walks them: a 32-byte header, then its payload padded to 8 bytes."""
    out, pos = [], start
    while pos + FRAME_HEAD + 4 <= limit:
        head = read(pos, FRAME_HEAD + 4)
        if len(head) < FRAME_HEAD + 4:
            break
        pts, n = struct.unpack_from("<QI", head, 0)
        if not n or pos + FRAME_HEAD + n > limit or head[FRAME_HEAD:] != START4:
            break
        out.append({"at": pos + FRAME_HEAD, "length": n, "time": pts, "codec": CODECS.get(head[0x10], "")})
        pos += FRAME_HEAD + ((n + 7) & ~7)
    return out, pos - start


def _row(ranges, frames, first, last, stream, state, reason, source, codec, intervals=None):
    t0, unit = _when(first)
    t1, _ = _when(last)
    # index times span whole GOPs (frames per span); frame times mark frame starts (intervals = frames - 1)
    fps = round((frames if intervals is None else intervals) / (t1 - t0), 2) if t0 is not None and t1 and t1 > t0 else None
    return {"channel": None, "stream": stream, "start": _text(t0), "end": _text(t1), "offset": hex(ranges[0][0]),
            "range": [ranges[0][0], ranges[-1][1]], "ranges": ranges, "gops": len(ranges), "frames": frames,
            "fps": fps if fps and 1 <= fps <= 120 else None,
            "codec": codec, "time_unit": unit, "source": source, "state": state, "state_reason": reason,
            "status": f"TP-Link {stream or 'unindexed'} stream, {frames} frames, {len(ranges)} GOPs"}


def parse(reader, det, progress=lambda fraction: None):
    win, size, geo = Window(reader), reader.image_size, _geometry(reader, det)
    indexed, owned, zones = {}, [], {}
    for z in range(geo["zones"]):
        base = geo["data_zone_at"] + z * ZONE_BYTES
        if base >= size:
            break
        if _entry(reader.read(base, ENTRY), z) is None:
            continue
        raw, got = reader.read(base, ZONE_INDEX_BYTES), []
        for k in range(len(raw) // ENTRY):
            chunk = raw[k * ENTRY:(k + 1) * ENTRY]
            e = _entry(chunk, z)
            if e is None:
                if not any(chunk):
                    break
                continue
            got.append(e)
            e["start_at"] = base + e["offset"]
            owned.append([e["start_at"], e["start_at"] + e["length"]])
        zones[z] = len(got)
        for e in got:
            indexed.setdefault((e["event"], e["stream"]), []).append(e)
    rows = []
    for (event, stream), gops in sorted(indexed.items()):
        if stream not in STREAMS:
            continue
        gops.sort(key=lambda g: (g["start"], g["start_at"]))
        head = win.read(gops[0]["start_at"], FRAME_HEAD + 4)
        codec = CODECS.get(head[0x10], "") if len(head) == FRAME_HEAD + 4 and head[FRAME_HEAD:] == START4 else ""
        rows.append(_row([[g["start_at"], g["start_at"] + g["length"]] for g in gops], sum(g["frames"] for g in gops),
                         gops[0]["start"], max(g["end"] for g in gops), STREAMS[stream], "live",
                         "named by its zone's GOP index", "zone GOP index", codec))
    # GOPs whose index entry is gone: found by their first frame (a payload opening with an SPS/VPS) and header
    # ponytail: scans every zone end to end (about a second per GiB); restrict to unindexed spans if multi-TB disks get slow
    covered = merge(owned)
    for z in range(geo["zones"]):
        base = geo["data_zone_at"] + z * ZONE_BYTES
        if base >= size:
            break
        cur, cursor, end = None, base + ZONE_INDEX_BYTES, min(base + ZONE_BYTES, size)
        while cursor < end:
            chunk = reader.read(cursor, min(SCAN_BLOCK, end - cursor))
            if not chunk:
                break
            hits = sorted(i for pattern in SPS_STARTS for i in _find_all(chunk, pattern))
            skip_to = cursor
            for i in hits:
                start = cursor + i - FRAME_HEAD
                if start < skip_to or i < FRAME_HEAD or start % 8 or overlaps(covered, start, start + FRAME_HEAD + 1):
                    continue
                pts, n = struct.unpack_from("<QI", chunk, i - FRAME_HEAD)
                if not (0 < n <= GOP_MAX and chunk[i - FRAME_HEAD + 0x10] in CODECS and _when(pts)[0]):
                    continue
                gop, used = _walk(win.read, start, min(start + GOP_MAX, end))
                if not gop:
                    continue
                last_pts = gop[-1]["time"]
                gap_ok = cur and 0 <= start - cur["end"] <= RUN_GAP_BYTES and 0 <= _when(pts)[0] - _when(cur["last"])[0] <= RUN_GAP_S
                if gap_ok:
                    cur["ranges"].append([start, start + used])
                    cur.update(end=start + used, last=last_pts, frames=cur["frames"] + len(gop))
                else:
                    if cur:
                        rows.append(_remnant(cur))
                    cur = {"ranges": [[start, start + used]], "end": start + used, "first": pts, "last": last_pts, "frames": len(gop),
                           "codec": gop[0]["codec"]}
                skip_to = start + used
            cursor += max(len(chunk) - 5, 1)
            progress((z + (cursor - base) / ZONE_BYTES) / max(geo["zones"], 1))
        if cur:
            rows.append(_remnant(cur))
            cur = None
    rows.sort(key=lambda r: r["range"][0])
    return {"format_sector": det, "geometry": geo, "zones_with_index": zones, "recordings": rows,
            "warnings": ["TP-Link layout taken from a third party's disassembly of VIGI NVR1008H V2 firmware 240119. No VIGI disk has been read by "
                         "the team; it has not been validated on this model or firmware. The recorder's SQLite index was not read (it can be "
                         "AES-encrypted), so no camera is attributed. Times are the recorder's clock with no timezone check."]}


def _remnant(cur):
    return _row(cur["ranges"], cur["frames"], cur["first"], cur["last"], None, "deleted",
                "found in a zone with no index entry naming it: the recorder no longer lists it", "frame scan (no index)", cur["codec"],
                intervals=cur["frames"] - 1)


def _find_all(buf, pattern):
    at = buf.find(pattern)
    while at != -1:
        yield at
        at = buf.find(pattern, at + 1)


def write_stream(reader, row, target):
    win, codec = Window(reader), ""
    for start, end in row["ranges"]:
        frames, _ = _walk(win.read, start, end)
        for f in frames:
            codec = codec or f["codec"]
            target.write(win.read(f["at"], f["length"]))
    return codec
