"""Pramaan adapter for Niriksha's Hikvision parsers and local evidence tools.

Original parser implementations remain in dvr_scan/hikvision. Results retain
their raw fields and addresses; this adapter adds a common recordings list.
"""
import argparse
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

from dvr_scan import dhfs, fingerprint, godrej, honeywell, tplink, uniview
from dvr_scan.hikvision.helpers import ImageReader

VIDEO_EXTENSIONS = {".mp4", ".avi", ".h264", ".264", ".h265", ".265", ".dav", ".mkv",
                     ".ts", ".mov", ".3gp", ".flv", ".wmv", ".asf", ".mpg", ".mpeg"}


# Stamped into every result so a stored finding can be reproduced with the same engine.
# Bump the minor when a parser's output changes shape; bump the patch for fixes that keep it.
PARSER_VERSION = "0.5.0"
PARSER_NAME = "pramaan-dvr-engine"


def emit(data):
    print(json.dumps(data, default=lambda o: o.item() if hasattr(o, "item") else str(o)), flush=True)  # numpy scalars from the induction


class _ReaderImg:
    """Bridges Niriksha's ImageReader (raw/E01) into pytsk3's Img_Info interface,
    so the same reader handles both proprietary block parsers and filesystem walking."""
    def __init__(self, reader):
        import pytsk3
        self._reader = reader
        self._pytsk3 = pytsk3

    def as_img_info(self):
        pytsk3 = self._pytsk3
        reader = self._reader

        class _Img(pytsk3.Img_Info):
            def __init__(self):
                pytsk3.Img_Info.__init__(self, url="", type=pytsk3.TSK_IMG_TYPE_EXTERNAL)
            def close(self): pass
            def read(self, offset, size): return reader.read(offset, size)
            def get_size(self): return reader.image_size
        return _Img()


def _detect_filesystems(reader):
    """Vendor-agnostic: many DVR brands just write standard video files onto a FAT/NTFS/ext
    partition instead of a proprietary block format. Detect any such filesystem with The Sleuth
    Kit (pytsk3) rather than hand-parsing each brand's partition scheme."""
    try:
        import pytsk3
    except ImportError:
        return []
    img = _ReaderImg(reader).as_img_info()
    found = []
    try:
        vol = pytsk3.Volume_Info(img)
        for part in vol:
            if part.len <= 0:
                continue
            offset = part.start * vol.info.block_size
            try:
                fs = pytsk3.FS_Info(img, offset=offset)
            except Exception:
                continue
            found.append({"offset": offset, "type": str(fs.info.ftype), "description": part.desc.decode(errors="replace")})
    except Exception:
        try:
            fs = pytsk3.FS_Info(img)
            found.append({"offset": 0, "type": str(fs.info.ftype), "description": "Unpartitioned volume"})
        except Exception:
            pass
    return found


def _file_ranges(pytsk3, entry, base, block_size):
    """Absolute byte ranges of a file's data runs (for FAT deletions TSK assumes the clusters were contiguous)."""
    ranges = []
    for attr in entry:
        if attr.info.type in (pytsk3.TSK_FS_ATTR_TYPE_DEFAULT, pytsk3.TSK_FS_ATTR_TYPE_NTFS_DATA):
            ranges += [(base + run.addr * block_size, base + (run.addr + run.len) * block_size) for run in attr if run.len]
    return ranges


MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
# Matrix SATATYA recordings (Matrix wiki "Backup recording files from HDD", 2018, via a third-party summary; not validated
# on a real recorder): <volume>/CameraNN/DD_Mon_YYYY/HH/HH_MM_SS~HH_MM_SS.stmN, plus .evnt/.ifrm/.tmid sidecar files.
MATRIX_PATH = re.compile(r"(?:^|/)Camera(\d+)/(\d{1,2})_([A-Za-z]{3})_(\d{4})/\d{1,2}/(\d{2})_(\d{2})_(\d{2})~(\d{2})_(\d{2})_(\d{2})\.stm\d*$")


def _is_video(name):
    ext = os.path.splitext(name)[1].lower()
    return ext in VIDEO_EXTENSIONS or re.fullmatch(r"\.stm\d*", ext) is not None


def _matrix_path(path):
    """Camera and recording times Matrix writes into the path, or None. Times are the recorder's wall clock, never UTC."""
    m = MATRIX_PATH.search(path)
    if not m or m.group(3).lower() not in MONTHS:
        return None
    from datetime import datetime, timedelta
    day, year, month = int(m.group(2)), int(m.group(4)), MONTHS.index(m.group(3).lower()) + 1
    h1, m1, s1, h2, m2, s2 = map(int, m.groups()[4:])
    try:
        start, end = datetime(year, month, day, h1, m1, s1), datetime(year, month, day, h2, m2, s2)
    except ValueError:
        return None
    end += timedelta(days=1) if end < start else timedelta()
    label = "%Y-%m-%d %H:%M:%S (recorder clock, from file path)"
    return {"channel": int(m.group(1)), "start": start.strftime(label), "end": end.strftime(label)}


# Uniview's own backup guide: "A backup file is named: camera name-recording start time.file extension, e.g. Ch9-20150630183546.mp4".
UNIVIEW_NAME = re.compile(r"(?:^|/)(?P<name>[^/]+?)-(?P<time>\d{14})\.(?:mp4|ts)$", re.I)


def _uniview_name(path):
    """Camera and start time from a file named the way Uniview names its exports, or None. Other products can name files
    the same way, so this labels the recording but never identifies the brand."""
    m = UNIVIEW_NAME.search(path)
    if not m:
        return None
    from datetime import datetime
    try:
        start = datetime.strptime(m.group("time"), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    channel = re.fullmatch(r"(?:ch|channel)[ _]?(\d+)", m.group("name"), re.I)
    return {"channel": int(channel.group(1)) if channel else m.group("name"),
            "start": start.strftime("%Y-%m-%d %H:%M:%S (recorder clock, from file name)"), "end": None}


def _walk_fs(pytsk3, directory, path, out, seen, owned=None, base=0, block_size=512):
    """Collect video files into out; add every byte range a directory entry accounts for to owned,
    so carving can tell residue in unallocated space from footage the filesystem already lists."""
    owned = [] if owned is None else owned
    for entry in directory:
        meta = entry.info.meta
        name_info = entry.info.name
        if meta is None or name_info is None:
            continue
        name = name_info.name.decode(errors="replace")
        if name in (".", ".."):
            continue
        deleted = bool(name_info.flags & pytsk3.TSK_FS_NAME_FLAG_UNALLOC)
        full_path = f"{path}/{name}"
        try:
            if meta.type == pytsk3.TSK_FS_META_TYPE_DIR:
                if deleted or meta.addr in seen:
                    continue  # deleted directories' contents are unreliable; skip, don't fabricate
                seen.add(meta.addr)
                _walk_fs(pytsk3, entry.as_directory(), full_path, out, seen, owned, base, block_size)
            elif _is_video(name):
                out.append({"path": full_path, "inode": meta.addr, "size": meta.size, "deleted": deleted})
                owned += _file_ranges(pytsk3, entry, base, block_size)
            elif not deleted:
                owned += _file_ranges(pytsk3, entry, base, block_size)
        except Exception:
            continue  # unreadable/corrupt directory entry; skip rather than abort the whole walk


# Vendor-agnostic carving (plan.md M3.0/M3.1): any brand's footage is H.264/H.265, bare or inside
# DHAV / MPEG-PS. Syntax checks here only propose runs; the ffmpeg decode gate in extract() decides.
CARVE_WINDOW = 64 * 1024 * 1024
CARVE_OVERLAP = 64 * 1024
RUN_GAP = 4 * 1024 * 1024
# 3-byte start codes also cover 4-byte ones. 0x20-0x2F = MPEG-4 Part 2 VOL, 0xB6 = VOP (common on 2005-2012 DVRs).
CARVE_PATTERN = re.compile(rb"DHAV|\x00\x00\x01(?:[\xba\xb6\x47\x67\x20-\x2f\xe0-\xef]|\x40\x01\x0c)")
PES_PATTERN = re.compile(rb"\x00\x00\x01[\xe0-\xef]")
H264_PROFILES = {44, 66, 77, 83, 86, 88, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244}
CARVE_SUFFIX = {"dhav": ".dav", "ps": ".mpg", "pes": ".es", "h264": ".h264", "hevc": ".hevc", "m4v": ".m4v", "mp4": ".mp4"}
CARVE_TAIL = {"ps": 64 * 1024, "pes": 64 * 1024, "m4v": 1024 * 1024, "h264": RUN_GAP, "hevc": RUN_GAP}
# Outer wrappers win over what they wrap: a PS holds PES packets, which hold H.264 / MPEG-4.
CARVE_PRIORITY = {"mp4": 0, "dhav": 0, "ps": 1, "pes": 2, "h264": 3, "hevc": 3, "m4v": 3}
def _mp4_length(reader, start):
    """Exact length of an MP4/MOV file whose ftyp box starts here, by walking its top-level boxes.
    MP4 stores H.264 length-prefixed, so it has no start codes to carve; the box sizes bound the file."""
    head = reader.read(start, 12)
    if len(head) < 12 or not 16 <= int.from_bytes(head[:4], "big") <= 4096 or not all(0x20 <= c < 0x7F for c in head[8:12]):
        return None
    pos, seen = start, set()
    while pos + 8 <= reader.image_size:
        box = reader.read(pos, 16)
        size, kind = int.from_bytes(box[:4], "big"), box[4:8]
        # Any printable fourcc is a box (exports add vendor boxes such as 'beam'); zeros/slack or the next ftyp end the file.
        if len(kind) < 4 or not all(0x20 <= c < 0x7F for c in kind) or (kind == b"ftyp" and pos != start):
            break
        if size == 1:
            size = int.from_bytes(box[8:16], "big")
        if size < 8 or pos + size > reader.image_size:
            return None  # open-ended or cut short: not a complete file
        seen.add(kind)
        pos += size
    return pos - start if {b"moov", b"mdat"} <= seen or {b"moof", b"mdat"} <= seen else None


def _dhav_date(raw):
    """DHAV packed bitfield, recorder local time (plan.md M2 DHAV layout)."""
    if raw is None:
        return None
    try:
        from datetime import datetime
        return datetime((raw >> 26) + 2000, (raw >> 22) & 15, (raw >> 17) & 31, (raw >> 12) & 31,
                        (raw >> 6) & 63, raw & 63).strftime("%Y-%m-%d %H:%M:%S (recorder local clock)")
    except ValueError:
        return None


def _dhav_record(reader, offset):
    """(length, channel, packed date) if a complete DHAV record with matching footer starts at offset."""
    header = reader.read(offset, 24)
    if len(header) < 24 or header[:4] != b"DHAV":
        return None
    length = int.from_bytes(header[12:16], "little")
    if length < 32 + header[22] or offset + length > reader.image_size:
        return None
    if reader.read(offset + length - 8, 8) != b"dhav" + length.to_bytes(4, "little"):
        return None
    return length, header[6], int.from_bytes(header[16:20], "little")


def _carve_hit(reader, window, rel, offset):
    """(kind, length, channel, date, is_header) or a falsy value. A run is only kept if it holds a header."""
    b = window[rel:rel + 14]
    if b[:4] == b"DHAV":
        record = _dhav_record(reader, offset)
        return record and ("dhav", *record, True)
    if len(b) < 8:
        return None
    nal, follow = b[3], window[rel + 4:rel + 260]
    if nal == 0xBA:  # MPEG-2 / MPEG-1 pack header with its fixed marker bits
        if len(b) == 14 and (b[4] & 0xC4) == 0x44 and b[6] & 4 and b[8] & 4 and b[9] & 1 and (b[12] & 3) == 3:
            return "ps", 14 + (b[13] & 7), None, None, True
        ok = len(b) >= 12 and (b[4] & 0xF1) == 0x21 and b[6] & 1 and b[8] & 1 and b[9] & 0x80 and b[11] & 1
        return ok and ("ps", 12, None, None, True)
    if nal == 0x40:  # H.265 VPS, must be followed by an SPS (plan.md M3.1 syntax chain)
        return b"\x00\x00\x01\x42\x01" in follow and ("hevc", 6, None, None, True)
    if 0xE0 <= nal <= 0xEF:  # bare MPEG-2 video PES (no pack layer), payload must open with a start code
        length, payload = int.from_bytes(b[4:6], "big"), rel + 9 + b[8]
        ok = length and (b[6] & 0xC0) == 0x80 and window[payload:payload + 3] in (b"\x00\x00\x01", b"\x00\x00\x00")
        return ok and ("pes", 6 + length, None, None, True)
    if nal == 0xB6:  # MPEG-4 VOP: frame data, only counts inside a run that has a VOL
        return "m4v", 4, None, None, False
    # H.264 SPS: sane profile/level and a PPS right after it
    if nal in (0x27, 0x47, 0x67) and b[4] in H264_PROFILES and 9 <= b[6] <= 62 and re.search(rb"\x00\x00\x01[\x28\x48\x68]", follow):
        return "h264", 7, None, None, True
    # MPEG-4 VOL: video_object_type_indication 1..18
    return 0x20 <= nal <= 0x2F and 1 <= ((b[4] << 1 | b[5] >> 7) & 0xFF) <= 18 and ("m4v", 4, None, None, True)


def _carve(reader):
    runs, current, pos, mp4_until = [], {}, 0, 0
    while pos < reader.image_size:
        window = reader.read(pos, CARVE_WINDOW + CARVE_OVERLAP)
        j = window.find(b"ftyp", 4)
        while j != -1 and j - 4 < CARVE_WINDOW:
            start = pos + j - 4
            length = start >= mp4_until and _mp4_length(reader, start)
            if length:  # each MP4 file is its own run, never merged with its neighbour
                runs.append({"kind": "mp4", "start": start, "end": start + length, "hits": 1, "headers": 1, "channels": {}})
                mp4_until = start + length
            j = window.find(b"ftyp", j + 4)
        for match in CARVE_PATTERN.finditer(window):
            rel = match.start()
            if rel >= CARVE_WINDOW:
                break  # the next window owns it
            offset = pos + rel
            hit = _carve_hit(reader, window, rel, offset)
            if not hit:
                continue
            kind, length, channel, date, is_header = hit
            run = current.get(kind)
            if not run or offset - run["end"] > RUN_GAP:
                run = current[kind] = {"kind": kind, "start": offset, "end": offset, "hits": 0, "headers": 0, "channels": {}}
                runs.append(run)
            run["end"] = max(run["end"], offset + length)
            run["hits"] += 1
            run["headers"] += is_header
            if channel is not None:
                times = run["channels"].setdefault(channel, [date, date])
                times[1] = date
        pos += CARVE_WINDOW
        emit({"type": "progress", "progress": min(pos, reader.image_size) * 100 / reader.image_size})
    # DHAV (footer-verified), H.264 (SPS+PPS) and H.265 (VPS+SPS) headers are strong alone;
    # a pack or VOL header is weaker, so those runs need a second hit.
    # An MPEG-4 run also needs frames (VOPs), not just VOL-looking bytes.
    runs = [r for r in runs if r["headers"] and (r["kind"] in ("mp4", "dhav", "h264", "hevc") or r["hits"] >= 2)
            and (r["kind"] != "m4v" or r["hits"] - r["headers"] >= 2)]
    kept = []
    # ponytail: O(runs^2) overlap filter, fine for thousands of runs; sort+sweep if disks get fragmented
    for run in sorted(runs, key=lambda r: CARVE_PRIORITY[r["kind"]]):
        if not any(CARVE_PRIORITY[k["kind"]] < CARVE_PRIORITY[run["kind"]] and k["start"] <= run["end"] and run["start"] <= k["end"] for k in kept):
            kept.append(run)
    runs = sorted(kept, key=lambda r: r["start"])
    starts = sorted(r["start"] for r in runs)
    for run in runs:
        if run["kind"] in CARVE_TAIL:  # last header found is not the end of its payload (DHAV/MP4 lengths are exact)
            following = next((s for s in starts if s > run["start"]), reader.image_size)
            run["end"] = min(run["end"] + CARVE_TAIL[run["kind"]], following, reader.image_size)
    return runs


def _merge(ranges):
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def _overlaps(merged, start, end):
    i = bisect.bisect_right(merged, [end]) - 1  # last span starting before end
    return i >= 0 and merged[i][1] > start


def _dhav_channel(reader, start, end, channel, target):
    offset = start
    while offset < end:
        record = _dhav_record(reader, offset)
        if not record:
            found = reader.read(offset + 1, min(end - offset, 1024 * 1024)).find(b"DHAV")
            offset = offset + 1 + found if found >= 0 else offset + 1024 * 1024
            continue
        length, record_channel, _ = record
        if record_channel == channel:
            target.write(reader.read(offset, length))
        offset += length


def _pes_payloads(reader, start, end, target):
    """Strip PES headers (and any vendor bytes between packets) using each packet's own length field."""
    step = 8 * 1024 * 1024
    pos = start
    while pos < end:
        chunk = reader.read(pos, min(step + 65542, end - pos))  # 65542 = largest PES packet
        i = 0
        while match := PES_PATTERN.search(chunk, i):
            o = match.start()
            if o >= step:
                break
            b = chunk[o:o + 9]
            length = int.from_bytes(b[4:6], "big") if len(b) == 9 else 0
            if length and (b[6] & 0xC0) == 0x80 and 9 + b[8] <= 6 + length <= len(chunk) - o:
                target.write(chunk[o + 9 + b[8]:o + 6 + length])
                i = o + 6 + length
            else:
                i = o + 4
        if not chunk:
            break
        pos = max(pos + step, pos + i)


def _decode_gate(output, stderr):
    """plan.md M4.5: sample first/middle/last frames; failing clips are excluded from analytics, never dropped."""
    import cv2
    cap = cv2.VideoCapture(str(output))
    try:
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        failed = []
        for label, index in (("first", 0), ("middle", frames // 2), ("last", max(frames - 1, 0))):
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            if not cap.read()[0]:
                failed.append(label)
    finally:
        cap.release()
    errors = [line for line in stderr.splitlines() if line.strip()]
    # ponytail: 5% decoder-error threshold is uncalibrated; tune on the controlled disks (plan.md §4.1)
    if frames <= 0 or failed:
        reason = "no decodable frames" if frames <= 0 else f"{', '.join(failed)} sample frame(s) did not decode"
    elif len(errors) > max(3, frames * 0.05):
        reason = f"decoder reported {len(errors)} errors over {frames} frames"
    else:
        reason = None
    return {"result": "excluded" if reason else "passed", "reason": reason, "frames": frames,
            "decoder_errors": len(errors), "decoder_log": errors[-20:]}


def hashes(filename):
    digests = {name: hashlib.new(name) for name in ("md5", "sha256")}
    with open(filename, "rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            for digest in digests.values():
                digest.update(chunk)
    return {name: digest.hexdigest() for name, digest in digests.items()}


def hash_evidence(reader):
    digests = {name: hashlib.new(name) for name in ("md5", "sha256")}
    offset = 0
    while offset < reader.image_size:
        chunk = reader.read(offset, min(8 * 1024 * 1024, reader.image_size - offset))
        if not chunk:
            raise IOError("Evidence ended before its declared size")
        for digest in digests.values():
            digest.update(chunk)
        offset += len(chunk)
        emit({"type": "progress", "progress": offset * 100 / reader.image_size})
    return {"scope": "decoded media" if reader.is_ewf else "file bytes", "size_bytes": offset,
            **{name: digest.hexdigest() for name, digest in digests.items()}}


def _ffmpeg():
    """ffmpeg.exe ships beside the engine: next to the executable once frozen, one level above this
    package when run from source. PRAMAAN_FFMPEG overrides both."""
    if override := os.environ.get("PRAMAAN_FFMPEG"):
        return override
    roots = []
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).resolve().parent)
    roots.append(Path(__file__).resolve().parent.parent)
    for root in roots:
        if (bundled := root / "ffmpeg.exe").exists():
            return str(bundled)
    return "ffmpeg"


def _ffmpeg_probe(path):
    """FFmpeg as the standard-container pass (plan.md M3.0): it already demuxes many DVR formats
    (nc, lvf, iv8, m4v, ...). Accepted only if it finds a video stream."""
    err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True, errors="replace").stderr
    fmt = re.search(r"Input #0, ([^,]+),", err)
    video = re.search(r"Video: ([^,\n]+).*?(\d{2,5})x(\d{2,5})", err)
    # image2 matches by extension alone (a disk named .img probes as a GEM raster), so still-image demuxers never count.
    # Stream formats the carver handles are left to it: FFmpeg would skip leading bytes and merge a whole disk into
    # one stream, while carving keeps each run's byte range and channel.
    name = fmt and fmt.group(1)
    if not video or name.startswith("image2") or name.endswith("_pipe") or name in ("tty", "mpeg", "mpegvideo", "h264", "hevc", "m4v", "dhav"):
        return None
    fps = re.search(r"([\d.]+) fps", err)
    return {"format": fmt.group(1), "codec": video.group(1).strip(), "width": int(video.group(2)),
            "height": int(video.group(3)), "fps": float(fps.group(1)) if fps else None}


# OEM disk adapters in detection order. Each module has detect(reader), parse(reader, det, progress), write_stream(reader, row, target).
OEM_ADAPTERS = {"honeywell": honeywell, "uniview": uniview, "godrej": godrej, "tplink": tplink, "dhfs": dhfs}
# signature name -> (brand shown, storage format named in the evidence)
OEM_SIGNATURES = {
    "Honeywell NVR layout": ("Honeywell Security", "Honeywell NVR (GPT + custom record header)"),
    "Uniview UBS superblock": ("Uniview", "Uniview UBS (superblock 0x20131031)"),
    "Godrej Qualvision QVFS head": ("Godrej", "Godrej / Qualvision QVFS (QVEX head)"),
    "TP-Link VIGI format sector": ("TP-Link", "TP-Link VIGI raw layout (format sector)"),
    "Dahua DHFS 4.1 superblock": (None, "Dahua DHFS 4.1 (DHAV frames)"),  # no single brand: Dahua and OEMs such as CP Plus
}
OEM_NOTES = {
    "Honeywell Security": "The disk matches the Honeywell NVR layout published by Yoon & Hwang (2026), which they measured on one model. "
                          "Confirm the brand against the recorder's label.",
    "Uniview": "The disk starts with Uniview's UBS superblock as described in a third party's disassembly of Uniview's storage driver. "
               "No Uniview disk has been read by the team. Confirm the brand against the recorder's label.",
    "Godrej": "The disk carries Qualvision's QVFS head. Godrej's use of Qualvision software is inferred from its cloud API by a third party and "
              "is not established for every Godrej model, so the brand could be Qualvision or another rebrand. Confirm against the recorder's label.",
    "TP-Link": "The disk has TP-Link's VIGI format sector, as described in a third party's disassembly of VIGI firmware. "
               "No VIGI disk has been read by the team. Confirm the brand against the recorder's label.",
}
SUPPORTED_BRANDS = ["Dahua Technology", "CP Plus", "Honeywell Security", "TP-Link", "Godrej", "Uniview", "Hikvision", "Matrix"]
# Brand names that recorders and their export tools write into logs, headers and container metadata.
def _spellings(first, second=None):
    return [(first + sep + second).encode() for sep in ("", " ", "-", "_")] if second else [first.encode()]


# Lowercase spellings searched with plain bytes.find (a case-insensitive regex took seconds on 16 MB).
BRAND_TOKENS = {
    "Dahua Technology": _spellings("dahua"),
    "CP Plus": _spellings("cp", "plus"),
    "Honeywell Security": _spellings("honeywell"),
    "TP-Link": _spellings("tp", "link"),
    "Godrej": _spellings("godrej"),
    "Uniview": _spellings("uniview"),
    "Hikvision": _spellings("hikvision"),
    "Matrix": _spellings("matrix", "comsec") + _spellings("matrix", "security"),
}


def _vendor(reader, sample, signatures, dhav_runs=False, matrix_paths=False, extra_text=b""):
    """Which brand the footage came from, and how we know. Only evidence counts: a brand name in the data, or a
    storage-format signature. A brand with neither is never guessed (plan.md M1, §7 'over-claiming')."""
    size = len(sample)
    tail = reader.read(reader.image_size - 1024 * 1024, 1024 * 1024) if reader.image_size > size + 1024 * 1024 else b""
    hits = {}
    buffers = [("data", sample.lower(), 0), ("end of data", tail.lower(), reader.image_size - len(tail)),
               ("UTF-16 text", sample.replace(b"\x00", b"").lower(), None),
               ("a channel title in the video data", extra_text.lower(), None)]
    for brand, tokens in BRAND_TOKENS.items():
        for where, buffer, base in buffers:
            found = [(buffer.find(t), t) for t in tokens if t in buffer]
            if found:
                index, token = min(found)
                at = f" at {hex(base + index)}" if base is not None else ""
                hits[brand] = f'"{token.decode()}" found in {where}{at}'
                break
    hik = any(s["signature"] in ("HIKVISION@HANGZHOU", "HIKBTREE") or (s["signature"] in ("IMKH", "4HKH") and s["offset"] == "0x0")
              for s in signatures)
    oem = next((OEM_SIGNATURES[s["signature"]] for s in signatures if s["signature"] in OEM_SIGNATURES), None)
    dhfs_disk = bool(oem and oem[0] is None)  # a Dahua-family file system: Dahua or an OEM, so no single brand
    dhav = dhav_runs or sample.startswith(b"DHAV") or dhfs_disk
    family = ("Hikvision (HIKBTREE / IMKH)" if hik else oem[1] if dhfs_disk else "Dahua DHAV" if dhav else oem[1] if oem
              else "Matrix SATATYA recording folders (CameraNN/DD_Mon_YYYY/HH)" if matrix_paths else None)
    evidence = list(hits.values())
    if family:
        evidence.append(f"Stored in the {family} format")
    candidates = []
    if len(hits) == 1:
        brand, confidence = next(iter(hits)), "Brand name found in the data"
    elif len(hits) > 1:
        brand, confidence, candidates = None, "Several brand names found", list(hits)
    elif hik or (oem and not dhfs_disk):
        brand, confidence = "Hikvision" if hik else oem[0], "Storage-format signature"
    elif matrix_paths:
        brand, confidence = "Matrix", "Directory-layout signature"
    elif dhav:
        brand, confidence, candidates = None, "Storage-format family only", ["Dahua Technology", "CP Plus"]
    else:
        brand, confidence = None, "Not determined"
    note = {
        "Brand name found in the data": "The name appears in the evidence bytes; confirm it against the recorder's label.",
        "Several brand names found": "More than one brand name appears. Resolve it from the recorder itself.",
        "Storage-format signature": "The storage format is Hikvision's. Rebadged Hikvision units use it too, so confirm against the recorder's label."
            if hik else OEM_NOTES.get(oem[0], "") if oem else "",
        "Directory-layout signature": "The recording folders follow the Matrix SATATYA layout described in Matrix's 2018 wiki, which "
                                      "we know only from a third-party summary. It has not been validated on a real recorder, and "
                                      "other products could use similar folders. Confirm the brand against the recorder's label.",
        "Storage-format family only": ("DHFS is the Dahua-family file system, and OEM brands such as CP Plus (a listed Dahua OEM) reuse it. The data does "
                                       "not say which one: a brand name in a channel title would, and none was found.") if dhfs_disk else
                                      "DHAV is Dahua's format and OEM brands such as CP Plus reuse it. The data does not say which one.",
        "Not determined": "Standard video files carry no brand marker. Nothing here ties the footage to a brand.",
    }[confidence]
    return {"brand": brand, "confidence": confidence, "candidates": candidates, "evidence": evidence,
            "storage_format": family, "note": note, "supported_brands": SUPPORTED_BRANDS}


def _oem_signature(adapter, det):
    """The identification entry for an OEM disk: what was matched, where, and how well it checked out."""
    if adapter == "honeywell":
        offset = det["partition"]["start"]
        detail = (f"GPT, partition 1 at {hex(offset)}, header video offset {'valid' if det['header_field'] else 'absent'}, "
                  f"first custom record {'valid' if det['first_record'] else 'absent'}")
        return {"signature": "Honeywell NVR layout", "offset": hex(offset), "family": "Honeywell", "detail": detail}
    if adapter == "uniview":
        return {"signature": "Uniview UBS superblock", "offset": "0x0", "family": "Uniview",
                "detail": f"magic 0x20131031, version 0x2000, CRC-16 {'ok' if det['crc_ok'] else 'MISMATCH'}, {det['units']} data blocks"}
    if adapter == "dhfs":
        return {"signature": "Dahua DHFS 4.1 superblock", "offset": "0x0", "family": "Dahua family",
                "detail": f"{det['version']}, boot marker {'present' if det['boot_marker'] else 'absent'}, uuid {det['uuid'] or 'none'}"}
    if adapter == "godrej":
        return {"signature": "Godrej Qualvision QVFS head", "offset": hex(det["offset"]), "family": "Godrej",
                "detail": f"QVEX version 0x00010000, region bounds {'hold' if det['bounds_ok'] else 'FAIL'}"}
    return {"signature": "TP-Link VIGI format sector", "offset": hex(det["offset"]), "family": "TP-Link",
            "detail": f"{det['tag']}, CRC-32 {'ok' if det['crc32_ok'] else 'MISMATCH'}"}


def identify(reader):
    sample = reader.read(0, min(reader.image_size, 16 * 1024 * 1024))
    signatures = []
    for signature, family in [(b"HIKVISION@HANGZHOU", "Hikvision"), (b"HIKBTREE", "Hikvision"),
                              (b"IMKH", "Hikvision"), (b"4HKH", "Hikvision"),
                              (b"DHFS", "Dahua family"), (b"DHAV", "Dahua family")]:
        offset = sample.find(signature)
        if offset >= 0:
            signatures.append({"signature": signature.decode(), "offset": hex(offset), "family": family})
    families = sorted({s["family"] for s in signatures})
    # A Hikvision disk parser requires its master signature in Niriksha's search range.
    hik = b"HIKVISION@HANGZHOU" in sample[0x200:0x1200]
    dhav = sample.startswith(b"DHAV")
    container = None
    if sample[:4] == b"RIFF" and sample[8:12] == b"AVI ": container = "AVI"
    elif sample[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free"): container = "MP4/QuickTime/3GP"
    elif sample.startswith(b"IMKH") and bytes.fromhex("000001ba") in sample[:4096]: container = "Hikvision IMKH / MPEG-PS"
    elif sample[:4] == bytes.fromhex("1a45dfa3"): container = "Matroska/WebM"
    elif sample[:4] == bytes.fromhex("000001ba"): container = "MPEG-PS"
    elif len(sample) > 376 and sample[0] == sample[188] == sample[376] == 0x47: container = "MPEG-TS"
    elif sample[:3] == b"FLV": container = "FLV"
    # ASF/WMV header GUID (used by some DVR exports)
    elif sample[:16] == bytes.fromhex("3026b2758e66cf11a6d900aa0062ce6c"): container = "ASF/WMV"
    elif sample[:4] == b"OggS": container = "Ogg"
    adapter = "hikvision" if hik else "dhav" if dhav else "media" if container else None
    filesystems, probe, oem_disk = [], None, None
    if adapter is None:  # before filesystems: a Honeywell disk's second partition is plain ext4
        for name, module in OEM_ADAPTERS.items():
            if oem_disk := module.detect(reader):
                adapter = name
                signatures.append(_oem_signature(name, oem_disk))
                families = sorted({*families, signatures[-1]["family"]})
                break
    if adapter is None:
        filesystems = _detect_filesystems(reader)
        if filesystems:
            adapter = "filesystem"
        elif not reader.is_ewf and (probe := _ffmpeg_probe(reader.image_path)):
            adapter, container = "media", f"{probe['format']} (via FFmpeg)"
    vendor = _vendor(reader, sample, signatures)
    if adapter == "honeywell":
        machine = honeywell.machine_data(reader)
        vendor["model"] = machine["model"]
        vendor["evidence"] += [f"Machine data (sector 34): model {machine['model']}, device ID {machine['device_id']}"] if machine["model"] or machine["device_id"] else []
    elif adapter == "uniview" and oem_disk["device_id"]:
        vendor["evidence"].append(f"Superblock device ID: {oem_disk['device_id']}")
    elif adapter == "tplink":
        vendor["evidence"].append(f"Format sector tag: {oem_disk['tag']}")
    return {"family": ", ".join(families) or "Unknown", "container": container, "probe": probe,
            "vendor": vendor,
            "adapter": adapter, "signatures": signatures, "filesystems": filesystems, "bytes_scanned": len(sample),
            "note": "Signature evidence identifies a format family, not a specific OEM/model. No matching signature does not rule out a vendor."}


def parse(reader, work):
    identification = identify(reader)
    adapter = identification["adapter"]
    bundle = {"identification": identification, "vendor": identification["vendor"], "recordings": [], "warnings": []}
    owned = []  # byte ranges the filesystem's own entries account for
    if adapter == "hikvision":
        from dvr_scan.hikvision.master_sector import MasterSectorParser
        from dvr_scan.hikvision.hikbtree import HikbtreeParser
        from dvr_scan.hikvision.system_logs import SystemLogParser
        master = work / "master_sector.json"
        extra = MasterSectorParser(reader).run_parser(str(master))
        if extra is None:
            raise ValueError("Niriksha could not parse the Hikvision master sector")
        bundle["master_sector"] = json.loads(master.read_text(encoding="utf-8"))
        for key, parser in [("hikbtree", HikbtreeParser(reader)), ("system_logs", SystemLogParser(reader))]:
            target = work / f"{key}.json"
            if not parser.run_parser(str(master), str(target), extra):
                raise ValueError(f"Niriksha could not parse {key}")
            bundle[key] = json.loads(target.read_text(encoding="utf-8"))
        for page in bundle["hikbtree"].get("pages", {}).values():
            for entry in page.get("entries", []):
                bundle["recordings"].append({"id": str(len(bundle["recordings"])), "channel": entry["channel"],
                    "start": entry["start_time"]["readable"], "end": entry["end_time"]["readable"],
                    "offset": entry["data_block_offset"], "status": entry["existence"], "adapter": adapter,
                    "state": "live" if entry["existence"] == "Has Video Data" else "empty"})
        bundle["warnings"].append("Recorder timestamps are raw clock values; timezone and clock accuracy have not been verified.")
    elif adapter in OEM_ADAPTERS:
        module = OEM_ADAPTERS[adapter]
        found = module.parse(reader, module.detect(reader), lambda fraction: emit({"type": "progress", "progress": min(fraction, 1) * 100}))
        bundle.update({key: value for key, value in found.items() if key not in ("recordings", "warnings", "brand_text")})
        if found.get("brand_text"):  # e.g. the default channel title "CPPlusIPCam" read out of the video data
            bundle["vendor"] = _vendor(reader, reader.read(0, 16 * 1024 * 1024), identification["signatures"], extra_text=found["brand_text"])
        bundle["recordings"] = [{**row, "id": str(i), "adapter": adapter} for i, row in enumerate(found["recordings"])]
        bundle["warnings"] += found["warnings"]
        if not bundle["recordings"]:
            raise ValueError(f"Identified as a {identification['signatures'][-1]['family']} disk, but no video was found "
                "in it (it may be empty, already overwritten, or laid out differently from the published description).")
    elif adapter == "dhav":
        # Parse bounded DHAV records, checking the repeated record length in each footer.
        channels = {}
        offset = 0
        while offset < reader.image_size:
            header = reader.read(offset, 24)
            if len(header) < 24 or header[:4] != b"DHAV":
                raise ValueError(f"Invalid DHAV header at {hex(offset)}")
            length = int.from_bytes(header[12:16], "little")
            if length < 32 + header[22] or offset + length > reader.image_size:
                raise ValueError(f"Invalid DHAV record length at {hex(offset)}")
            footer = reader.read(offset + length - 8, 8)
            if footer[:4] != b"dhav" or int.from_bytes(footer[4:], "little") != length:
                raise ValueError(f"Invalid DHAV footer at {hex(offset)}")
            row = channels.setdefault(header[6], {"id": str(header[6]), "channel": header[6], "adapter": adapter,
                "start": None, "end": None, "offset": hex(offset), "status": "Recorded DHAV stream", "state": "unknown", "ranges": []})
            row["ranges"].append([offset, length])
            offset += length
        bundle["recordings"] = list(channels.values())
        bundle["warnings"].append("DHAV wrapper records are grouped by channel. This is not a DHFS disk filesystem or deleted-video parser.")
    elif adapter == "media" and identification["probe"]:
        bundle["media"] = identification["probe"]
        bundle["recordings"] = [{"id": "0", "channel": None, "start": None, "end": None,
            "offset": "0x0", "adapter": adapter, "status": "Playable media", "state": "live"}]
    elif adapter == "media":
        import cv2
        cap = cv2.VideoCapture(reader.image_path)
        try:
            ok, _ = cap.read()
            if not ok:
                raise ValueError("Container recognized but the video could not be decoded")
            fps = cap.get(cv2.CAP_PROP_FPS)
            count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            bundle["media"] = {"width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                               "fps": fps if math.isfinite(fps) else None, "frames": count}
            bundle["recordings"] = [{"id": "0", "channel": None, "start": None, "end": None,
                "offset": "0x0", "adapter": adapter, "status": "Playable media", "state": "live"}]
        finally:
            cap.release()
    elif adapter == "filesystem":
        import pytsk3
        matrix_found = uniview_named = False
        bundle["filesystems"] = identification["filesystems"]
        for fsinfo in identification["filesystems"]:
            img = _ReaderImg(reader).as_img_info()
            fs = pytsk3.FS_Info(img, offset=fsinfo["offset"])
            files = []
            _walk_fs(pytsk3, fs.open_dir(path="/"), "", files, set(), owned, fsinfo["offset"], fs.info.block_size)
            for f in files:
                matrix = _matrix_path(f["path"]) or {}
                named = {} if matrix else _uniview_name(f["path"]) or {}
                matrix_found, uniview_named = matrix_found or bool(matrix), uniview_named or bool(named)
                meta = matrix or named
                bundle["recordings"].append({"id": str(len(bundle["recordings"])), "channel": meta.get("channel"),
                    "start": meta.get("start"), "end": meta.get("end"), "offset": hex(fsinfo["offset"]),
                    "status": "Deleted (recovered)" if f["deleted"] else "Recorded file",
                    "state": "deleted" if f["deleted"] else "live",
                    "adapter": adapter, "fs_offset": fsinfo["offset"], "inode": f["inode"],
                    "path": f["path"], "size": f["size"]})
        if matrix_found:
            bundle["vendor"] = _vendor(reader, reader.read(0, 16 * 1024 * 1024), identification["signatures"], matrix_paths=True)
            bundle["warnings"].append("Camera and times for these recordings come from the Matrix folder and file names only; the "
                ".stm container itself is undocumented and has not been read, so the names are unverified against the video.")
        if uniview_named:
            bundle["warnings"].append("Channel and start time for some recordings come from file names in Uniview's documented backup format "
                "(camera name-start time.mp4/.ts). Other products can name files the same way, so the brand is not inferred from it.")
        if bundle["recordings"]:
            bundle["warnings"].append("Filesystem adapter lists standard video files stored directly on a FAT/NTFS/ext partition "
                "(common on DVR brands that don't use a proprietary block format). \"Deleted (recovered)\" entries are unallocated "
                "directory records whose data may be partially or fully overwritten; verify after extraction.")
    if adapter in (None, "filesystem"):
        # On a filesystem, carve too: footage whose directory entry is gone (reused, wiped, quick-formatted) only
        # survives as bytes no file accounts for. A run overlapping bytes a file owns is that file, not residue.
        # ponytail: carves the whole image; limit to unallocated blocks if large disks get slow
        spans = _merge(owned)
        runs = [r for r in _carve(reader) if not _overlaps(spans, r["start"], r["end"])]
        residue = adapter == "filesystem"
        bundle["carve"] = {"scanned_bytes": reader.image_size, "runs": [{"kind": r["kind"], "start": hex(r["start"]),
            "end": hex(r["end"]), "headers_found": r["hits"], "channels": sorted(r["channels"])} for r in runs]}
        for run in runs:
            size = f"{(run['end'] - run['start']) / 1024 ** 2:.1f} MB"
            base = {"start": None, "end": None, "offset": hex(run["start"]), "adapter": "carve", "kind": run["kind"],
                    "range": [run["start"], run["end"]], "state": "deleted" if residue else "unknown",
                    "status": f"Carved {run['kind'].upper()} from unallocated space, {size}" if residue
                              else f"Carved {run['kind'].upper()} run, {size}"}
            for channel, times in sorted(run["channels"].items()) or [(None, [None, None])]:
                bundle["recordings"].append({**base, "id": str(len(bundle["recordings"])), "channel": channel,
                    "start": _dhav_date(times[0]), "end": _dhav_date(times[1])})
        if any(r["kind"] == "dhav" for r in runs):  # footer-verified DHAV records found by carving
            bundle["vendor"] = _vendor(reader, reader.read(0, 16 * 1024 * 1024), identification["signatures"], True)
        if runs and residue:
            bundle["warnings"].append(f"{len(runs)} video run(s) were carved from space no file on the filesystem accounts for: "
                "footage whose directory entry was deleted, reused or wiped by a format. File names and timestamps are lost; "
                "the recovered bytes are hashed at extraction. Contiguous storage is assumed, so a fragmented file may be cut short.")
        elif runs:
            bundle["warnings"].append("No brand parser matched, so video was carved by codec/container syntax (MP4, DHAV, MPEG-PS, PES, "
                "H.264, H.265, MPEG-4). Whether a carved run is live or deleted footage cannot be told without the recorder's index; "
                "each run is marked unknown. Carved clips pass the decode gate before analysis. \"Learn layout\" can infer the record "
                "header (length, time, channel) around this video.")
    if not bundle["recordings"]:
        if identification["signatures"]:
            raise ValueError(f"Identified as {identification['family']} ({', '.join(s['signature'] for s in identification['signatures'])}), "
                "but no standard video stream was found. The footage likely uses the vendor's proprietary or scrambled codec, "
                "which only the vendor's player/SDK can decode.")
        where = "no video files on its filesystem and " if adapter == "filesystem" else ""
        raise ValueError(f"No supported parser found and {where}no MP4, DHAV, MPEG-PS, PES, H.264, H.265 or MPEG-4 video was found anywhere in "
            "the image. If this is a DVR disk, it may be encrypted or use a codec this tool does not recognise.")
    bundle["fingerprint"] = fingerprint.build(identification, bundle, reader)
    return bundle


def extract(reader, bundle, recording_id, work):
    row = next((r for r in bundle["recordings"] if r["id"] == recording_id), None)
    if row is None or row["status"] == "No Video/Recording":
        raise ValueError("Select a recording with video data")
    source = Path(reader.image_path)
    if row["adapter"] == "hikvision":
        from dvr_scan.hikvision.extractor import VideoExtractor
        master = bundle["master_sector"]
        master_path = work / "master_sector.json"
        master_path.write_text(json.dumps(master), encoding="utf-8")
        success, filename = VideoExtractor(reader, str(work)).extract_single_block(
            row["offset"], str(master_path), master["master_sector"]["extra_offset"])
        if not success: raise ValueError("Hikvision block extraction failed")
        source = Path(filename)
    elif row["adapter"] == "dhav":
        source = work / f"channel-{row['channel']}.dav"
        with source.open("wb") as target:
            for start, length in row["ranges"]:
                while length:
                    chunk = reader.read(start, min(length, 1024 * 1024))
                    if not chunk: raise IOError("Truncated DHAV record")
                    target.write(chunk)
                    start += len(chunk)
                    length -= len(chunk)
    elif row["adapter"] == "filesystem":
        import pytsk3
        img = _ReaderImg(reader).as_img_info()
        fs = pytsk3.FS_Info(img, offset=row["fs_offset"])
        tsk_file = fs.open_meta(inode=row["inode"])
        source = work / f"fs-{row['inode']}{Path(row['path']).suffix}"
        with source.open("wb") as target:
            remaining, offset = tsk_file.info.meta.size, 0
            while remaining > 0:
                chunk = tsk_file.read_random(offset, min(remaining, 1024 * 1024))
                if not chunk: break
                target.write(chunk)
                offset += len(chunk)
                remaining -= len(chunk)
    elif row["adapter"] in OEM_ADAPTERS:
        source = work / f"{row['adapter']}-{row['offset']}.h264"
        with source.open("wb") as target:
            codec = OEM_ADAPTERS[row["adapter"]].write_stream(reader, row, target)
        if codec == "h265":
            source = source.rename(source.with_suffix(".h265"))
    elif row["adapter"] == "carve":
        start, end = row["range"]
        source = work / f"carved-{row['offset']}-{row['channel']}{CARVE_SUFFIX[row['kind']]}"
        with source.open("wb") as target:
            if row["kind"] == "dhav":
                _dhav_channel(reader, start, end, row["channel"], target)
            elif row["kind"] == "pes":
                _pes_payloads(reader, start, end, target)
            else:
                while start < end:
                    chunk = reader.read(start, min(end - start, 8 * 1024 * 1024))
                    if not chunk: break
                    target.write(chunk)
                    start += len(chunk)
    output = work / f"recording-{uuid.uuid4().hex}.mp4"
    # A bare H.264/H.265 stream carries no frame times; the recorder's own timestamps give the real rate.
    rate = ["-framerate", str(row["fps"])] if row.get("adapter") in OEM_ADAPTERS and row.get("fps") else []
    def encode(*before):
        return subprocess.run([_ffmpeg(), "-y", "-v", "error", *before, *rate, "-i", str(source), "-map", "0:v:0",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(output)], capture_output=True)
    result = encode()
    if result.returncode and re.search(r"\.stm\d*$", row.get("path", ""), re.I):
        # .stm is Matrix's undocumented container; its video is H.264/H.265, so retry as a bare stream and let the gate decide.
        result = encode("-f", "h264")
    stderr = result.stderr.decode(errors="replace")
    # Hash of the recovered bytes themselves, before re-encoding: proves what came off the disk (plan.md M8).
    base = {"recording_id": recording_id, "recording": row, "recovered_sha256": hashes(source)["sha256"]}
    if result.returncode:
        # Recovered but unplayable: recorded as excluded rather than failing, so it still reaches the report.
        output.unlink(missing_ok=True)
        return {**base, "output": None, "gate": {"result": "excluded", "reason": "ffmpeg could not decode the recovered bytes",
                "frames": 0, "decoder_errors": len(stderr.splitlines()), "decoder_log": stderr.splitlines()[-20:]}}
    return {**base, "output": str(output.resolve()), "hashes": hashes(output), "gate": _decode_gate(output, stderr),
            "note": "Decoded viewing derivative; original evidence is unchanged."}


def upscale(filename, work, scale, method="lanczos"):
    import cv2
    if scale not in (2, 3, 4): raise ValueError("Scale must be 2, 3 or 4")
    image = cv2.imread(filename)
    if image is None: raise ValueError("Choose a readable image for upscaling")
    if image.shape[0] * image.shape[1] * scale * scale > 100_000_000:
        raise ValueError("Requested output exceeds 100 megapixels")
    output = work / f"upscaled-{uuid.uuid4().hex}.png"
    if method == "upscayl":
        engine = Path(__file__).resolve().parent.parent
        binary = engine / "upscayl-cli" / "bin" / ("upscayl-bin.exe" if os.name == "nt" else "upscayl-bin")
        models = engine / "models" / "upscayl"
        model = "upscayl-lite-4x"
        if not all((models / f"{model}.{extension}").is_file() for extension in ("bin", "param")):
            raise ValueError("Upscayl Lite model is missing. Run download_upscayl_models.py --model upscayl-lite-4x")
        result = subprocess.run([str(binary), "-i", filename, "-o", str(output), "-m", str(models),
            "-n", model, "-s", str(scale), "-f", "png"], capture_output=True, timeout=180)
        if result.returncode:
            output.unlink(missing_ok=True)
            raise RuntimeError("Upscayl failed: " + result.stderr.decode(errors="replace")[-1500:])
        enlarged = cv2.imread(str(output))
        if enlarged is None: raise ValueError("Upscayl produced no readable image")
        # AI enhancement is clearly marked as a viewing aid, never a recovered detail.
        label_scale = max(.25, min(.7, enlarged.shape[1] / 650))
        cv2.rectangle(enlarged, (0, max(0, enlarged.shape[0] - 24)), (enlarged.shape[1], enlarged.shape[0]), (0, 0, 0), -1)
        cv2.putText(enlarged, "AI enhanced - illustrative", (3, enlarged.shape[0] - 7), cv2.FONT_HERSHEY_SIMPLEX,
                    label_scale, (255, 255, 255), 1, cv2.LINE_AA)
    elif method == "lanczos":
        enlarged = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)
    else:
        raise ValueError("Unknown upscaling method")
    if not cv2.imwrite(str(output), enlarged): raise IOError("Could not save upscaled image")
    return {"output": str(output.resolve()), "method": "Upscayl Lite (illustrative)" if method == "upscayl" else "Lanczos interpolation", "scale": scale,
            "width": enlarged.shape[1], "height": enlarged.shape[0], "hashes": hashes(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["hash", "identify", "parse", "extract", "induce", "upscale"])
    parser.add_argument("--image", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--bundle")
    parser.add_argument("--recording")
    parser.add_argument("--scale", type=int, default=2)
    parser.add_argument("--method", choices=["lanczos", "upscayl"], default="lanczos")
    args = parser.parse_args()
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    reader = None
    try:
        if args.action == "upscale":
            data = upscale(args.image, work, args.scale, args.method)
        else:
            reader = ImageReader(args.image)
            reader.open()
            if args.action == "hash": data = hash_evidence(reader)
            elif args.action == "identify": data = identify(reader)
            elif args.action == "parse": data = parse(reader, work)
            elif args.action == "induce":
                from dvr_scan import induce
                data = induce.induce(reader, lambda fraction: emit({"type": "progress", "progress": min(fraction, 1) * 100}))
                # A verified header layout is the defining trait of an unknown recorder, so fingerprint it too.
                ident = identify(reader)
                data["fingerprint"] = fingerprint.build(ident, {"vendor": ident["vendor"]}, reader, data)
            else: data = extract(reader, json.loads(Path(args.bundle).read_text(encoding="utf-8")), args.recording, work)
        if data.get("output"):
            manifest = Path(data["output"]).with_suffix(".manifest.json")
            manifest.write_text(json.dumps({"source": args.image, "action": args.action, **data}, indent=2), encoding="utf-8")
            data["manifest"] = str(manifest.resolve())
        if isinstance(data, dict):
            data["parser"] = {"name": PARSER_NAME, "version": PARSER_VERSION, "action": args.action}
        emit({"type": "forensics_result", "action": args.action, "data": data})
    except Exception as error:
        emit({"type": "forensics_error", "message": str(error)})
        sys.exit(1)
    finally:
        if reader: reader.close()


if __name__ == "__main__":
    main()
