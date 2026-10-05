"""Helpers shared by the OEM disk adapters (Honeywell, Uniview, Godrej, TP-Link)."""
import bisect
import struct
from datetime import datetime, timezone

SECTOR = 512
TIME_LO, TIME_HI = 946684800, 4102444800  # 2000-01-01 .. 2100-01-01: a plausible recorder clock


class Window:
    """Read cache: walking a chain of headers issues many small reads, and each reader.read is a seek."""
    def __init__(self, reader, size=4 * 1024 * 1024):
        self.reader, self.size, self.start, self.data = reader, size, 0, b""

    def read(self, offset, n):
        if not (self.start <= offset and offset + n <= self.start + len(self.data)):
            self.start, self.data = offset, self.reader.read(offset, max(n, self.size))
        i = offset - self.start
        return self.data[i:i + n]


def clock(seconds, ms=0):
    """A recorder-clock time as text, or None when the value is no plausible time (0 must never become 1970)."""
    if not TIME_LO <= seconds <= TIME_HI:
        return None
    text = datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return f"{text}.{ms:03d} (recorder clock)" if ms else f"{text} (recorder clock)"


H265_NALS = {0, 1, 19, 20, 21, 32, 33, 34, 35, 39}


def guess_codec(payload):
    """h264 / h265 from the first NAL header after a start code, else ''."""
    i = payload.find(b"\x00\x00\x01")
    if i < 0 or i + 4 >= len(payload):
        return ""
    nal = payload[i + 3]
    if not nal & 0x81 and (nal >> 1) & 0x3F in H265_NALS and payload[i + 4] in range(1, 8):
        return "h265"
    return "h264" if nal & 0x1F in (1, 5, 6, 7, 8, 9) else ""


def merge(ranges):
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def overlaps(merged, start, end):
    i = bisect.bisect_right(merged, [end]) - 1
    return i >= 0 and merged[i][1] > start


def gpt(reader):
    """Partitions of a GPT disk, or None."""
    if reader.image_size < 2 * SECTOR + 92:
        return None
    head = reader.read(SECTOR, 92)
    if len(head) < 92 or head[:8] != b"EFI PART":
        return None
    entries_lba, count, size = struct.unpack_from("<QII", head, 72)
    if not (0 < count <= 128 and 128 <= size <= 512 and entries_lba * SECTOR < reader.image_size):
        return None
    raw = reader.read(entries_lba * SECTOR, count * size)
    parts = []
    for i in range(count):
        entry = raw[i * size:(i + 1) * size]
        if len(entry) < 128 or not any(entry[:16]):
            continue
        first, last = struct.unpack_from("<QQ", entry, 32)
        if last >= first:
            parts.append({"index": i + 1, "first_lba": first, "last_lba": last, "start": first * SECTOR,
                          "size": (last - first + 1) * SECTOR, "name": entry[56:128].decode("utf-16-le", "replace").rstrip("\0")})
    return parts


def partition_starts(reader):
    """Byte offsets where a file system could begin: the disk start, then every GPT or MBR partition start."""
    starts = [0]
    parts = gpt(reader)
    if parts:
        starts += [p["start"] for p in parts]
    elif reader.image_size >= SECTOR:
        mbr = reader.read(0, SECTOR)
        if mbr[510:512] == b"\x55\xaa":
            for i in range(4):
                entry = mbr[446 + 16 * i:462 + 16 * i]
                lba = struct.unpack_from("<I", entry, 8)[0]
                if entry[4] and lba:
                    starts.append(lba * SECTOR)
    return [s for s in dict.fromkeys(starts) if s < reader.image_size]
