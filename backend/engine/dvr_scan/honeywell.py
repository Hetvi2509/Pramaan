"""Honeywell NVR adapter.

Layout from Yoon & Hwang, "Forensic analysis of video data deletion and recovery in Honeywell surveillance
file system" (arXiv 2605.07430, 2026), measured by the authors on one NVR (HN35080200). Everything here is
checked only against a synthetic image built from that paper, never a real Honeywell disk, and the results say so.

Disk: GPT. Sector 34 holds machine data (device ID, model). Partition 1 is a proprietary file system, little-endian:
  +0x00      header: video-data offset (u32 x 4 KiB), next-video offset @0x08, available memory @0x10, total @0x18
  +0x40      block-group index, 16-byte entries, start time (u32 Unix s) @+4, group number @+12
  +0x400000  video channel list, 16-byte entries: channel, stream type (0x00 main / 0x20 sub), length (u16 x 4 KiB),
             start time (u32 Unix s), start offset (u32 x 4 KiB)
  +0x80000000 video data: a 20-byte custom header before each H.264 access unit:
             type (0x82 IDR / 0x02 other), 80 01 00, width u16, height u16, length u32, Unix microseconds u64.
             Each channel's data ends with 20 zero bytes.
Deletion (paper section 6) leaves the video data region intact and changes only the header, so a stream is deleted when
it is older than every block group's start time, or when the header holds no block groups at all (formatted).
"""
import struct
from datetime import datetime, timezone

from dvr_scan.oem_common import Window as _Window, gpt as _gpt, guess_codec

SECTOR = 512
UNIT = 0x1000
VIDEO_START = 0x80000000
CHANNEL_LIST = 0x400000
MACHINE_DATA = 34 * SECTOR
SCAN_BLOCK = 64 * 1024 * 1024
MAX_FRAME = 16 * 1024 * 1024
US_MIN, US_MAX = 946684800 * 10 ** 6, 4102444800 * 10 ** 6  # 2000-01-01 .. 2100-01-01


def _stamp(microseconds):
    return datetime.fromtimestamp(microseconds / 10 ** 6, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " (recorder clock)"


def _seconds(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") + " (recorder clock)"


def _record(win, offset):
    """The 20-byte custom header at offset, or None if it is not one."""
    h = win.read(offset, 20)
    if len(h) < 20 or h[0] not in (0x02, 0x82) or h[1:4] != b"\x80\x01\x00":
        return None
    width, height, length = struct.unpack_from("<HHI", h, 4)
    ts = int.from_bytes(h[12:20], "little")
    if not (64 <= width <= 8192 and 64 <= height <= 8192 and 0 < length <= MAX_FRAME and US_MIN <= ts <= US_MAX):
        return None
    return {"key": h[0] == 0x82, "width": width, "height": height, "length": length, "ts": ts}


def _walk(win, start, end, sink=None):
    """Follow consecutive frames from start. sink, if given, receives each frame's H.264 bytes."""
    pos, frames, keys, total, first, last, size = start, 0, 0, 0, None, None, None
    while pos + 20 <= end:
        r = _record(win, pos)
        if not r or pos + 20 + r["length"] > end:
            break
        if sink:
            sink(win.read(pos + 20, r["length"]))
        frames, keys, total = frames + 1, keys + r["key"], total + r["length"]
        first = r["ts"] if first is None else first
        last, size = r["ts"], size or (r["width"], r["height"])
        pos += 20 + r["length"]
    complete = frames > 0 and win.read(pos, 20) == bytes(20)
    return {"frames": frames, "keyframes": keys, "bytes": total, "first": first, "last": last, "size": size,
            "end": pos + (20 if complete else 0), "complete": complete}


def _printable(data):
    run = bytearray()
    for byte in data + b"\0":
        if 0x20 <= byte < 0x7F:
            run.append(byte)
        elif run:
            if len(run) >= 4:
                yield run.decode()
            run.clear()


def detect(reader):
    """Partition info if this is a Honeywell NVR disk. GPT alone proves nothing, so either the header's video-data
    offset field or a valid custom record at partition 1 + 0x80000000 must also hold."""
    parts = _gpt(reader)
    if not parts:
        return None
    p = parts[0]
    if p["start"] + VIDEO_START + 20 > reader.image_size:
        return None
    field = struct.unpack("<I", reader.read(p["start"], 4))[0] * UNIT == VIDEO_START
    record = _record(_Window(reader), p["start"] + VIDEO_START) is not None
    return {"partition": p, "partitions": parts, "header_field": field, "first_record": record} if field or record else None


def machine_data(reader):
    sector = reader.read(MACHINE_DATA, SECTOR)
    ident = next(_printable(sector[0x40:0x60]), None)
    model = next(_printable(sector[0x60:0x80]), None)
    return {"offset": hex(MACHINE_DATA), "device_id": ident, "model": model, "strings": list(_printable(sector))}


def _row(info, start, source, state, reason, channel=None, stream=None):
    fps = (info["frames"] - 1) / ((info["last"] - info["first"]) / 10 ** 6) if info["frames"] > 1 and info["last"] > info["first"] else None
    return {"channel": channel, "stream": stream, "start": _stamp(info["first"]), "end": _stamp(info["last"]),
            "offset": hex(start), "range": [start, info["end"]], "frames": info["frames"], "keyframes": info["keyframes"],
            "width": info["size"][0], "height": info["size"][1], "fps": round(fps, 3) if fps and 1 <= fps <= 120 else None,
            "complete": info["complete"], "source": source, "state": state, "state_reason": reason,
            "status": f"Honeywell stream, {info['frames']} frames, {info['size'][0]}x{info['size'][1]}"}


def parse(reader, det, progress=lambda fraction: None):
    p = det["partition"]
    base, win = p["start"], _Window(reader)
    header = reader.read(base, 0x4000)
    u32 = lambda o: struct.unpack_from("<I", header, o)[0]
    groups = []
    for offset in range(0x40, 0x4000, 16):
        if u32(offset + 4) == 0:
            break
        groups.append({"group": header[offset + 12], "start_time": _seconds(u32(offset + 4)), "raw": u32(offset + 4), "offset": hex(offset)})
    oldest = min((g["raw"] for g in groups), default=None)
    head = {"video_data_offset": hex(u32(0) * UNIT), "next_video_offset": hex(u32(8) * UNIT), "available_memory": hex(u32(0x10) * UNIT),
            "total_allocatable_memory": hex(u32(0x18) * UNIT), "block_groups": len(groups), "note": "offset fields are in 4 KiB units"}

    def classify(first_us, listed):
        if oldest is None:
            return "deleted", "the header holds no block groups: the disk was formatted or the index was reset"
        if first_us // 10 ** 6 < oldest:
            return "deleted", "older than every block group's start time, so the NVR no longer lists it"
        return ("live", "newer than the oldest block group start time and listed in the channel list") if listed else \
               ("unknown", "newer than the oldest block group but missing from the channel list")

    rows, listed_ranges, channels = [], [], []
    raw = reader.read(base + CHANNEL_LIST, 1 << 20)
    for i in range(0, len(raw) - 15, 16):
        entry = raw[i:i + 16]
        if not any(entry) or entry[0] == 0:
            break
        length, start_time, offset = struct.unpack_from("<H", entry, 2)[0] * UNIT, struct.unpack_from("<I", entry, 4)[0], struct.unpack_from("<I", entry, 8)[0] * UNIT
        item = {"channel": entry[0], "stream_type": "sub" if entry[1] == 0x20 else "main" if entry[1] == 0 else hex(entry[1]),
                "length": length, "start_time": _seconds(start_time) if start_time else None, "start_offset": hex(offset), "frames": 0}
        channels.append(item)
        if not (VIDEO_START <= offset < p["size"]):
            continue
        absolute = base + offset
        info = _walk(win, absolute, min(absolute + max(length, 20), reader.image_size))
        item["frames"] = info["frames"]
        if info["frames"]:
            state, reason = classify(info["first"], True)
            rows.append(_row(info, absolute, "channel list", state, reason, entry[0], item["stream_type"]))
            listed_ranges.append((absolute, info["end"]))

    # Streams the channel list no longer names (expired, overwritten, formatted away) survive in the video data region.
    end, cursor = min(base + p["size"], reader.image_size), base + VIDEO_START
    total = max(end - cursor, 1)
    listed_ranges.sort()
    while cursor < end:
        skip = next((b for a, b in listed_ranges if a <= cursor < b), None)
        if skip:
            cursor = skip
            continue
        limit = next((a for a, _ in listed_ranges if a > cursor), end)  # never re-find a stream the channel list names
        chunk = reader.read(cursor, min(SCAN_BLOCK, limit - cursor))
        if not chunk:
            break
        found, j = None, chunk.find(b"\x80\x01\x00", 1)
        while j != -1:
            if chunk[j - 1] in (0x02, 0x82) and _record(win, cursor + j - 1):
                found = cursor + j - 1
                break
            j = chunk.find(b"\x80\x01\x00", j + 1)
        if found is None:
            cursor += max(len(chunk) - 4, 1)
        else:
            info = _walk(win, found, limit)
            state, reason = classify(info["first"], False)
            rows.append(_row(info, found, "carved from the video data region", state, reason))
            cursor = max(info["end"], found + 1)
        progress((cursor - base - VIDEO_START) / total)

    rows.sort(key=lambda r: r["range"][0])
    return {"gpt": det["partitions"], "machine_data": machine_data(reader), "header": head, "block_groups": groups,
            "channel_list": channels, "recordings": rows,
            "warnings": ["Honeywell layout taken from Yoon & Hwang (2026), measured on one NVR model (HN35080200). It has not been "
                         "validated on this device or firmware, and timestamps are raw recorder clock values with no timezone check."]}


def write_stream(reader, row, target):
    """Write one stream's H.264 access units, without the 20-byte custom headers (ffmpeg decodes the rest)."""
    start, end = row["range"]
    codec = []

    def sink(data):
        codec.append(guess_codec(data[:64])) if not codec else None
        target.write(data)
    _walk(_Window(reader), start, end, sink=sink)
    return codec[0] if codec else ""
