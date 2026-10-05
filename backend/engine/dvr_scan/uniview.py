"""Uniview NVR adapter (UBS, Uniview's block storage).

Layout from a third-party static disassembly of Uniview's storage driver (comm.ko, NVR301-04LS3-W firmware
B3612.1.21.220408), published as the Uniview plugin of github.com/victorysingh/dvr-forensics-toolkit. Uniview's own
site confirms only that video is written straight into disk data blocks, not into FAT or NTFS. No Uniview disk has
been read by anyone involved: this adapter is checked only against a synthetic image built from that description.

All little-endian:
  LBA 0                  64 KiB superblock: magic 0x20131031 @0, version 0x2000 @4, CRC-16 @8, device id @0x0C, capacity @0x60,
                         units @0x68, abstract-zone size @0x6C and offset @0x70, data-zone offset @0x78. A copy sits at capacity - 64 KiB.
  abstract zone          4 KiB groups (CRC-16 in the first 2 bytes), 31 entries of 128 bytes each at (k+1) * 128: block type @0, flags @4,
                         channel ids (4 x u32) @0x10, start @0x20, end @0x24 (Unix s).
  data block n           at data-zone offset + n * 256 MiB. Record block header (8 KiB): magic 0x5050, version 0x400, channel ids @0x10,
                         start/end @0x20/@0x24, GOP-index count @0x2C, write position in 4 KiB pages @0x2E. GOP index at +0x2000: 32-byte
                         entries, GOP length in pages @0x10 and start page @0x12.
  GOP                    on a 4 KiB boundary: 24-byte header (0x2006, Unix s @4, ms @8), packets (24-byte header: 0x1357, payload length
                         @0x12, flags @0x0C, stream type @0x11; payload; 4 spare bytes), end marker 0x6002, padding to the next 4 KiB page
                         whose last 8 bytes are the GOP's length and 0x6003. The trailer makes each GOP self-checking.
"""
import struct

from dvr_scan.oem_common import Window, clock, guess_codec, merge, overlaps

SUPER_MAGIC, SUPER_VERSION, SUPER_BYTES = 0x20131031, 0x2000, 0x10000
BLOCK, PAGE = 1 << 28, 0x1000
DZ_MAX = 0x10000000  # the firmware rejects a data zone starting past 256 MiB
GROUP, PER_GROUP, ENTRY = 0x1000, 31, 0x80
REC_MAGIC, REC_V4, REC_HEADER = 0x5050, 0x400, 0x2000
INDEX_AT, INDEX_ENTRY, INDEX_MAX = 0x2000, 32, 0x3F00
GOP_MAGIC, PKT_MAGIC, GOP_END, GOP_TAIL = 0x2006, 0x1357, 0x6002, 0x6003
GOP_HEAD = PKT_HEAD = 0x18
PKT_STEP = 0x1C  # next packet at payload length + 0x1C
MAX_GOP = 0x8000000
SCAN_BLOCK = 64 * 1024 * 1024
GAP_S = 60  # adjacent GOPs further apart than this start a new run


def _crc16(data):
    """CRC-16/ARC, the kernel's crc16()."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def _crc_zeroed(buf, at, width):
    return _crc16(buf[:at] + bytes(width) + buf[at + width:])


def _cstr(raw):
    return raw.split(b"\x00", 1)[0].decode("ascii", "replace")


def _super(reader, offset):
    if offset < 0 or offset + SUPER_BYTES > reader.image_size:
        return None
    raw = reader.read(offset, SUPER_BYTES)
    if len(raw) < SUPER_BYTES or struct.unpack_from("<I", raw, 0)[0] != SUPER_MAGIC:
        return None
    u32, u64 = (lambda o: struct.unpack_from("<I", raw, o)[0]), (lambda o: struct.unpack_from("<Q", raw, o)[0])
    return {"offset": offset, "version": u32(4), "crc_ok": _crc_zeroed(raw, 8, 4) == u32(8), "device_id": _cstr(raw[0x0C:0x3C]),
            "capacity": u64(0x60), "units": u32(0x68), "az_size": u32(0x6C), "az_pos": u64(0x70), "dz_pos": u64(0x78),
            "formatted": clock(u32(0x88))}


def detect(reader):
    sup = _super(reader, 0)
    return sup if sup and sup["version"] == SUPER_VERSION and 0 < sup["dz_pos"] <= DZ_MAX and sup["units"] > 0 else None


def _block_header(win, base):
    raw = win.read(base, REC_HEADER)
    if len(raw) < 0x80 or struct.unpack_from("<I", raw, 0)[0] != REC_MAGIC or struct.unpack_from("<I", raw, 4)[0] != REC_V4:
        return None
    u16, u32 = (lambda o: struct.unpack_from("<H", raw, o)[0]), (lambda o: struct.unpack_from("<I", raw, o)[0])
    return {"crc_ok": len(raw) == REC_HEADER and _crc_zeroed(raw, 8, 2) == u16(8), "channel": tuple(u32(o) & 0xFF for o in (0x10, 0x14, 0x18, 0x1C)),
            "start": u32(0x20), "end": u32(0x24), "items": u16(0x2C), "write_page": u16(0x2E), "camera_code": _cstr(raw[0x40:0x7F])}


def _gop_index(win, base, items):
    raw = win.read(base + INDEX_AT, min(items, INDEX_MAX) * INDEX_ENTRY)
    out = []
    for i in range(len(raw) // INDEX_ENTRY):
        pages, page = struct.unpack_from("<HH", raw, i * INDEX_ENTRY + 0x10)
        if pages and page * PAGE + pages * PAGE <= BLOCK:
            out.append((base + page * PAGE, base + (page + pages) * PAGE))
    return out


def _walk_gop(win, offset, limit):
    """One GOP, checked the way the recorder checks it on recovery: header magic, a chain of packet headers, the end
    marker, and a trailer whose length matches. None if any of it fails."""
    head = win.read(offset, GOP_HEAD)
    if len(head) < GOP_HEAD or struct.unpack_from("<I", head, 0)[0] != GOP_MAGIC:
        return None
    sec, ms = struct.unpack_from("<IH", head, 4)
    pos, packets = offset + GOP_HEAD, []
    while True:
        if pos + 4 > limit or pos - offset > MAX_GOP:
            return None
        hdr = win.read(pos, PKT_HEAD)
        if len(hdr) < 4:
            return None
        magic = struct.unpack_from("<I", hdr, 0)[0]
        if magic == GOP_END:
            end = pos + 4
            break
        if magic != PKT_MAGIC or len(hdr) < PKT_HEAD:
            return None
        bits, stream_type, length = hdr[12], hdr[17], struct.unpack_from("<H", hdr, 18)[0]
        packets.append({"payload": pos + PKT_HEAD, "length": length, "first": bool(bits & 2),
                        "video": not bits & 1 and stream_type not in (0x10, 0x11, 0x15)})
        pos += length + PKT_STEP
    trailer = (end + PAGE) & ~(PAGE - 1)
    if trailer > limit:
        return None
    length, tail = struct.unpack("<II", win.read(trailer - 8, 8))
    if tail != GOP_TAIL or length != end - offset:
        return None
    return {"offset": offset, "sec": sec, "ms": ms, "packets": packets, "next": trailer}


def _stats(win, ranges):
    """GOPs, frames, first and last GOP times and the codec across the given ranges."""
    gops = frames = 0
    first = last = None
    codec = ""
    for start, end in ranges:
        pos = start
        while pos < end:
            g = _walk_gop(win, pos, end)
            if g is None:
                pos += PAGE
                continue
            gops += 1
            frames += sum(p["first"] for p in g["packets"] if p["video"])
            first = first or (g["sec"], g["ms"])
            last = (g["sec"], g["ms"])
            if not codec:
                video = next((p for p in g["packets"] if p["video"]), None)
                codec = guess_codec(win.read(video["payload"], min(video["length"], 64))) if video else ""
            pos = g["next"]
    return {"gops": gops, "frames": frames, "first": first, "last": last, "codec": codec}


def _fps(stats):
    """GOPs carry whole-second times, so the rate is an estimate: frames over the span, plus one GOP's duration."""
    if stats["gops"] < 2 or not stats["first"]:
        return None
    span = (stats["last"][0] + stats["last"][1] / 1000) - (stats["first"][0] + stats["first"][1] / 1000)
    fps = stats["frames"] / (span * stats["gops"] / (stats["gops"] - 1)) if span > 0 else 0
    return round(fps, 2) if 1 <= fps <= 120 else None


def _channel(ids):
    return ids[0] if ids[0] and not any(ids[1:]) else "/".join(map(str, ids)) if any(ids) else None


def _row(win, ranges, channel, state, reason, source, stats=None):
    stats = stats or _stats(win, ranges)
    first, last = stats["first"], stats["last"]
    return {"channel": channel, "start": clock(*first) if first else None, "end": clock(*last) if last else None,
            "offset": hex(ranges[0][0]), "range": [ranges[0][0], ranges[-1][1]], "ranges": ranges, "gops": stats["gops"],
            "frames": stats["frames"], "fps": _fps(stats), "codec": stats["codec"], "source": source, "state": state,
            "state_reason": reason, "status": f"Uniview {stats['gops']} GOPs, {stats['frames']} frames"}


def parse(reader, det, progress=lambda fraction: None):
    win = Window(reader)
    tail = _super(reader, det["capacity"] - SUPER_BYTES) if det["capacity"] else None
    sup = det if det["crc_ok"] or not (tail and tail["crc_ok"]) else tail
    size = reader.image_size
    # abstract zone: which blocks the recorder lists and their camera and times
    abstract, bad_groups = {}, []
    for g in range(-(-sup["units"] // PER_GROUP)):
        raw = win.read(sup["az_pos"] + g * GROUP, GROUP)
        if len(raw) < GROUP:
            break
        if _crc_zeroed(raw, 0, 2) != struct.unpack_from("<H", raw, 0)[0]:
            bad_groups.append(g)
        for k in range(PER_GROUP):
            n = g * PER_GROUP + k
            e = raw[(k + 1) * ENTRY:(k + 2) * ENTRY]
            if n < sup["units"] and any(e[:0x30]):
                abstract[n] = {"channel": struct.unpack_from("<4I", e, 0x10), "start": struct.unpack_from("<I", e, 0x20)[0],
                               "end": struct.unpack_from("<I", e, 0x24)[0]}
    rows, listed, headers, kinds = [], [], {}, {}
    for n in sorted(abstract):
        base = sup["dz_pos"] + n * BLOCK
        h = _block_header(win, base) if base + REC_HEADER <= size else None
        kinds["record"] = kinds.get("record", 0) + bool(h)
        kinds["not a record block"] = kinds.get("not a record block", 0) + (not h)
        if not h:
            continue
        headers[n] = h
        ranges = merge(_gop_index(win, base, h["items"]))
        if ranges:
            listed += ranges
            rows.append(_row(win, ranges, _channel(h["channel"]), "live", "named by the block's GOP index", "GOP index"))
    # GOPs the recorder no longer lists: index wiped, block header gone, or older footage past the write position
    covered = merge(listed)
    for n in range(sup["units"]):
        base = sup["dz_pos"] + n * BLOCK
        if base >= size:
            break
        end, h = min(base + BLOCK, size), headers.get(n)
        write_pos = base + h["write_page"] * PAGE if h else None
        cur, cursor = None, base + INDEX_AT
        magic = struct.pack("<I", GOP_MAGIC)
        while cursor < end:
            chunk = reader.read(cursor, min(SCAN_BLOCK, end - cursor))
            if not chunk:
                break
            at, moved = chunk.find(magic), False
            while at != -1:
                pos = cursor + at
                g = _walk_gop(win, pos, end) if pos % PAGE == 0 else None
                if g is None:
                    at = chunk.find(magic, at + 1)
                    continue
                if overlaps(covered, pos, g["next"]):  # the index lists it: not residue
                    if g["next"] - cursor >= len(chunk):
                        cursor, moved = g["next"], True
                        break
                    at = chunk.find(magic, g["next"] - cursor)
                    continue
                stale = write_pos is not None and pos >= write_pos
                state, reason = ("deleted", "older footage past the block's write position, which the recorder no longer lists") if stale or not h \
                    else ("unknown", "inside the block's recorded area but missing from its GOP index")
                if not h:
                    reason = "no block header or abstract entry names this block: the index was wiped or never written"
                joined = cur and cur["next"] == pos and cur["state"] == state and 0 <= g["sec"] - cur["t1"] <= GAP_S
                if joined:
                    cur.update(next=g["next"], t1=g["sec"])
                else:
                    if cur:
                        rows.append(_finish(win, cur))
                    cur = {"start": pos, "next": g["next"], "t1": g["sec"], "state": state, "reason": reason, "channel": _channel(h["channel"]) if h else None}
                if g["next"] - cursor >= len(chunk):
                    cursor, moved = g["next"], True
                    break
                at = chunk.find(magic, g["next"] - cursor)
            if not moved:
                cursor += max(len(chunk) - 3, 1)
            progress((n + (cursor - base) / BLOCK) / sup["units"])
        if cur:
            rows.append(_finish(win, cur))
    rows.sort(key=lambda r: r["range"][0])
    return {"superblock": dict(sup, tail_copy="matches" if tail and tail["dz_pos"] == sup["dz_pos"] else "absent or differs",
                               groups_failing_crc=bad_groups), "block_kinds": kinds, "recordings": rows,
            "warnings": ["Uniview layout taken from a third party's disassembly of Uniview's storage driver (UBS, firmware B3612.1.21.220408). "
                         "No Uniview disk has been read by the team; it has not been validated on this model or firmware. Times are the "
                         "recorder's clock with no timezone check, and the frame rate is estimated from whole-second GOP times."]}


def _finish(win, cur):
    return _row(win, [[cur["start"], cur["next"]]], cur["channel"], cur["state"], cur["reason"], "GOP walk (no index)")


def write_stream(reader, row, target):
    win, codec = Window(reader), ""
    for start, end in row["ranges"]:
        pos = start
        while pos < end:
            g = _walk_gop(win, pos, end)
            if g is None:
                pos += PAGE
                continue
            for p in g["packets"]:
                if p["video"]:
                    data = win.read(p["payload"], p["length"])
                    codec = codec or guess_codec(data[:64])
                    target.write(data)
            pos = g["next"]
    return codec
