"""Dahua-family DHFS 4.1 adapter (Dahua Technology, and CP Plus and other Dahua OEMs).

Layout from the DHFS notes of github.com/victorysingh/dvr-forensics-toolkit, read off one real disk: a Seagate SkyHawk 1 TB, first 20 GiB
imaged, three cameras, one firmware. The notes say nothing has been byte-matched against the recorder's own export, and nobody involved had
the recorder, so this adapter is checked only against a synthetic image built from that description. The frame layout (DHAV) is published
(FFmpeg libavformat/dhav.c); the header checksum byte is observed. CP Plus is listed as a Dahua OEM by IPVM, and that disk's cameras
carried the default channel title "CPPlusIPCam", but no CP Plus recorder was ever imaged.

  0x0000      superblock: "DHFS4.1" @0, "uuid:{...}" @0x20, AA 55 AA 55 @0x1F4
  0x3C00      partition table (backup at 0x7C00): 0x40-byte entries from 0x3C40, start sector u32 @+0x24, sector count u32 @+0x2C
  volume+0x4400  volume header: earliest/latest packed dates @0x10/0x14, sector size @0x2C, sectors per cluster @0x30, first data cluster @0x38,
                 cluster-table start sector @0x44, cluster slots @0x4C
  cluster table  32-byte records, one per cluster (2 MiB on the real disk): kind @0 (01 head, 02 continuation, FE reserved, 00 empty), camera as
                 an ASCII digit @1, sequence/count @2, start/end packed dates @4/@8, next cluster @0xC (0 ends), previous @0x14, head @0x18
  data area      cluster N at data_base + N x cluster size. The base is not decoded from the header: it is calibrated by timing (below).
A recording is a head record plus its chain of continuation clusters: one file per camera per hour. Frames inside are DHAV (24-byte header: type,
counter @8, length @0xC, packed date @0x10, ms @0x14, extension length @0x16, checksum @0x17 = sum of bytes 0..0x16 mod 256; trailer "dhav"+length).
Packed date: sec 0-5, min 6-11, hour 12-16, day 17-21, month 22-25, year-2000 26-31, the recorder's wall clock with no timezone.
"""
import calendar
import struct
from datetime import datetime


SB_MAGIC, PTABLE, PENTRY0, PENTRY, PMAX = b"DHFS", 0x3C00, 0x40, 0x40, 16
VHDR, REC = 0x4400, 32
HEAD, CONT, RESERVED, EMPTY = 0x01, 0x02, 0xFE, 0x00
I_FRAME, P_FRAME, B_FRAME, AUDIO, AUX = 0xFD, 0xFC, 0xFB, 0xF0, 0xF1
VIDEO, KNOWN = {I_FRAME, P_FRAME, B_FRAME}, {I_FRAME, P_FRAME, B_FRAME, AUDIO, AUX}
HDR, TAIL, MAX_FRAME, SPILL = 24, 8, 4 << 20, 1 << 20
CODECS = {0x01: "mpeg4", 0x02: "h264", 0x08: "h264", 0x0C: "h265"}
SCAN_LEN, SAMPLE, FN_FWD = 96 << 20, 30, 8


def _read(reader, offset, n):
    return reader.read(offset, n) if 0 <= offset < reader.image_size else b""


def _date(value):
    try:
        return datetime((value >> 26 & 0x3F) + 2000, value >> 22 & 0x0F, value >> 17 & 0x1F, value >> 12 & 0x1F, value >> 6 & 0x3F, value & 0x3F)
    except ValueError:
        return None


def _secs(value):
    when = _date(value)
    return calendar.timegm(when.timetuple()) if when else None


def _label(value):
    when = _date(value)
    return when.strftime("%Y-%m-%d %H:%M:%S (recorder clock)") if when else None


def _frames(buf, limit):
    """Complete, validated DHAV frames whose header starts before limit. On overwritten media a bare 'DHAV' is no evidence: the header
    checksum must hold and the trailer must repeat the length."""
    out, i, n = [], 0, len(buf)
    while i < limit:
        p = buf.find(b"DHAV", i, limit + 3)
        if p < 0 or p + HDR > n:
            break
        h = buf[p:p + HDR]
        if sum(h[:23]) & 0xFF != h[23]:
            i = p + 1
            continue
        ftype, fn, length, date, ms, ext = h[4], *struct.unpack_from("<IIIH", h, 8), h[22]
        if ftype not in KNOWN or not HDR + TAIL <= length <= MAX_FRAME or HDR + ext > length - TAIL:
            i = p + 1
            continue
        if p + length > n:
            break
        if buf[p + length - 8:p + length - 4] != b"dhav" or struct.unpack_from("<I", buf, p + length - 4)[0] != length:
            i = p + 1
            continue
        out.append({"at": p, "type": ftype, "fn": fn, "length": length, "date": date, "secs": _secs(date), "ext": ext})
        i = p + length
    return out


def _ext_info(buf, frame):
    """Resolution, codec and fps from the extension tags FFmpeg documents (0x80 resolution/8, 0x81 codec + fps)."""
    info, tags = {}, buf[frame["at"] + HDR:frame["at"] + HDR + frame["ext"]]
    i = 0
    while i + 4 <= len(tags):
        tag = tags[i]
        size = {0x80: 4, 0x81: 4, 0x82: 8, 0x83: 4, 0x88: 8, 0x8C: 8}.get(tag)
        if not size:
            break
        if tag == 0x80:
            info["width"], info["height"] = tags[i + 2] * 8, tags[i + 3] * 8
        elif tag == 0x81:
            info["codec"], info["fps"] = CODECS.get(tags[i + 2], ""), tags[i + 3]
        i += size
    return info


def _accept(last, frame):
    """Is this video frame the next one of the stream whose last frame is `last`? Cameras that started together keep near-identical
    counters, so the check is strict: the counter (video frames keep their own) must advance by a few, and the date barely move."""
    if frame["type"] not in VIDEO:
        return False
    if last is None:
        return frame["type"] == I_FRAME
    ds = None if frame["secs"] is None or last["secs"] is None else frame["secs"] - last["secs"]
    return 1 <= (frame["fn"] - last["fn"]) & 0xFFFFFFFF <= FN_FWD and ds is not None and -1 <= ds <= 4


def _video(buf, cluster_bytes, last):
    out = []
    for frame in _frames(buf, cluster_bytes):
        if _accept(last, frame):
            out.append(frame)
            last = frame
    return out, last


def detect(reader):
    raw = _read(reader, 0, 512)
    if len(raw) < 512 or raw[:4] != SB_MAGIC:
        return None
    boot = raw[0x1F4:0x1F8] == b"\xaa\x55\xaa\x55"
    table = _read(reader, PTABLE + PENTRY0, PENTRY)
    sectors = struct.unpack_from("<I", table, 0x2C)[0] if len(table) == PENTRY else 0
    if not (boot or sectors):
        return None
    return {"version": raw[:16].split(b"\x00", 1)[0].decode("ascii", "replace"), "boot_marker": boot,
            "uuid": raw[0x20:0x60].split(b"\x00", 1)[0].decode("ascii", "replace").removeprefix("uuid:")}


def _volumes(reader, notes):
    table = _read(reader, PTABLE, 0x400)
    out = []
    for k in range(PMAX):
        e = PENTRY0 + k * PENTRY
        if e + PENTRY > len(table):
            break
        start, count = struct.unpack_from("<I", table, e + 0x24)[0], struct.unpack_from("<I", table, e + 0x2C)[0]
        if not count:
            break
        if out and start * 512 < out[-1]["start"] + out[-1]["length"]:
            notes.append(f"partition entry {k} overlaps the previous one; the table is read up to here")
            break
        out.append({"number": k + 1, "start": start * 512, "length": count * 512})
    return out


def _read_volume(reader, vol, notes):
    raw = _read(reader, vol["start"] + VHDR, 512)
    if len(raw) < 512:
        notes.append(f"volume {vol['number']}: header lies beyond the image")
        return False
    u32 = lambda o: struct.unpack_from("<I", raw, o)[0]
    sector, per_cluster = u32(0x2C), u32(0x30)
    if sector != 512 or not 0 < per_cluster <= 0x10000:
        notes.append(f"volume {vol['number']}: implausible sector/cluster size {sector}/{per_cluster}; not parsed")
        return False
    vol.update(cluster_bytes=per_cluster * sector, first_cluster=u32(0x38), earliest=_label(u32(0x10)), latest=_label(u32(0x14)),
               header={"table_start_sector": u32(0x44), "cluster_slots": u32(0x4C)})
    slots = min(u32(0x4C), vol["length"] // vol["cluster_bytes"] + 1)
    table = _read(reader, vol["start"] + u32(0x44) * 512, slots * REC)
    if len(table) < slots * REC:
        notes.append(f"volume {vol['number']}: cluster table cut short by the end of the image ({len(table) // REC} of {slots} records)")
    vol["records"] = []
    for i in range(len(table) // REC):
        kind, cam, seq, start, end, nxt, _f, prev, head = struct.unpack_from("<BBHIIIIII", table, i * REC)
        vol["records"].append({"i": i, "kind": kind, "camera": cam - 0x30 if 0x30 <= cam <= 0x39 else -1, "seq": seq,
                               "start": start, "end": end, "next": nxt, "prev": prev, "head": head})
    return True


def _chains(vol):
    recs, files = vol["records"], []
    for r in recs:
        if r["kind"] != HEAD:
            continue
        chain, seen, c, prev, notes = [], {r["i"]}, r["next"], r["i"], []
        while c:
            if c >= len(recs) or c in seen or recs[c]["kind"] != CONT or recs[c]["head"] != r["i"]:
                notes.append(f"chain stops at cluster {c}: not a continuation of this head")
                break
            if recs[c]["prev"] != prev:
                notes.append(f"cluster {c}: previous-link mismatch")
            seen.add(c)
            chain.append(c)
            prev, c = c, recs[c]["next"]
        if r["seq"] != len(chain):
            notes.append(f"head declares {r['seq']} continuations, chain has {len(chain)}")
        files.append({"head": r, "clusters": chain, "notes": notes})
    return files


def _calibrate(reader, vol):
    """Where cluster 0 of the data area sits. Cluster-aligned I-frames dated inside an index record's window each propose
    base = offset - record x cluster size; the proposals and their neighbours up to three clusters either side are then scored by how
    closely the frames found in sampled clusters match the index times. A base is kept only if it finds footage; otherwise extraction refuses."""
    cs, first = vol["cluster_bytes"], vol["first_cluster"]
    windows = [(r, _secs(r["start"]), _secs(r["end"])) for r in vol["records"] if r["kind"] in (HEAD, CONT)]
    windows = [w for w in windows if w[1] is not None and w[2] is not None]
    scan_from = vol["start"] + first * cs
    buf = _read(reader, scan_from, SCAN_LEN)
    votes = {}
    for frame in _frames(buf, len(buf)):
        at = scan_from + frame["at"]
        if frame["type"] != I_FRAME or at % 512 or frame["secs"] is None:
            continue
        for r, rs, re_ in windows:
            if rs - 2 <= frame["secs"] <= re_ + 2 and at - r["i"] * cs >= vol["start"]:
                votes[at - r["i"] * cs] = votes.get(at - r["i"] * cs, 0) + 1
    if not votes:
        return {"data_base": None, "reason": f"no cluster-aligned I-frame in the first {SCAN_LEN >> 20} MiB of data"}
    sample = [r for r in vol["records"][first:first + SCAN_LEN // cs + 8] if r["kind"] == CONT][:SAMPLE]
    candidates = {b + k * cs for b in sorted(votes, key=votes.get, reverse=True)[:8] for k in range(-3, 4) if b + k * cs >= vol["start"]}
    scored = []
    for base in candidates:
        found, total = 0, 0.0
        for r in sample:
            rs, re_ = _secs(r["start"]), _secs(r["end"])
            buf = _read(reader, base + r["i"] * cs, cs + SPILL)
            own = [f for f in _frames(buf, cs) if f["type"] in VIDEO and f["secs"] is not None and rs is not None and rs - 3 <= f["secs"] <= re_ + 3]
            if own:
                found += 1
                total += abs(own[0]["secs"] - rs) + abs(own[-1]["secs"] - re_)
        scored.append({"base": base, "found": found, "error": total / (2 * found) if found else float("inf"), "votes": votes.get(base, 0)})
    most = max(s["found"] for s in scored)
    eligible = sorted((s for s in scored if s["found"] and s["found"] >= most * 0.8), key=lambda s: (s["error"], -s["votes"]))
    if not eligible:
        return {"data_base": None, "reason": "no candidate base finds footage matching the index times"}
    best, runner = eligible[0], eligible[1] if len(eligible) > 1 else None
    margin = runner["error"] - best["error"] if runner else None
    return {"data_base": best["base"], "mean_timing_error_s": round(best["error"], 2), "clusters_with_footage": best["found"],
            "clusters_sampled": len(sample), "runner_up_error_s": round(runner["error"], 2) if runner else None,
            "weak": best["error"] > 2.0 or (margin is not None and margin < 0.5)}


def _titles(reader, vol, base):
    """Channel titles from auxiliary frames (type 0xF1 carries a 'TEXT' block): printable strings, a few samples."""
    out = []
    cs = vol["cluster_bytes"]
    for r in [r for r in vol["records"] if r["kind"] == CONT][:6]:
        buf = _read(reader, base + r["i"] * cs, cs + SPILL)
        for f in _frames(buf, cs):
            if f["type"] != AUX:
                continue
            run = bytearray()
            for byte in buf[f["at"] + HDR + f["ext"]:f["at"] + f["length"] - TAIL] + b"\0":
                if 0x20 <= byte < 0x7F:
                    run.append(byte)
                else:
                    text = run.decode().removeprefix("TEXT")  # the block's tag may run straight into the title
                    if len(text) >= 4 and text not in out:
                        out.append(text)
                    run.clear()
        if len(out) >= 6:
            break
    return out[:6]


def _row(vol, base, clusters, camera, start, end, state, reason, source):
    cs = vol["cluster_bytes"]
    first = (base + clusters[0] * cs) if base is not None else vol["start"] + vol["header"]["table_start_sector"] * 512 + clusters[0] * REC
    return {"channel": camera + 1 if camera is not None and camera >= 0 else None, "volume": vol["number"], "start": start, "end": end,
            "offset": hex(first), "clusters": clusters, "data_base": base, "cluster_size": cs,
            "range": [first, first + cs * len(clusters)] if base is not None else [first, first], "fps": None, "codec": "",
            "source": source, "state": state, "state_reason": reason,
            "status": f"Dahua DHFS {'recording' if state == 'live' else 'remnant'}, {len(clusters)} clusters"}


def parse(reader, det, progress=lambda fraction: None):
    notes, rows, volumes, titles = [], [], [], []
    vols = _volumes(reader, notes)
    for vol in vols:
        info = {"number": vol["number"], "start": hex(vol["start"]), "length": vol["length"]}
        volumes.append(info)
        if not _read_volume(reader, vol, notes):
            continue
        files = _chains(vol)
        cal = _calibrate(reader, vol) if files else {"data_base": None, "reason": "no recordings in the cluster table"}
        base = cal["data_base"]
        info.update(cluster_bytes=vol["cluster_bytes"], earliest=vol["earliest"], latest=vol["latest"], header=vol["header"], calibration=cal,
                    recordings=len(files), broken_chains=sum(bool(f["notes"]) for f in files))
        if base is None:
            notes.append(f"volume {vol['number']}: data base not established ({cal['reason']}); recordings are listed from the index only and cannot be extracted")
        elif cal.get("weak"):
            notes.append(f"volume {vol['number']}: data-base calibration is weak (timing error {cal['mean_timing_error_s']} s); treat extents with caution")
        for f in files:
            h = f["head"]
            clusters = f["clusters"]
            if not clusters:
                continue
            rows.append(_row(vol, base, clusters, h["camera"], _label(h["start"]), _label(h["end"]), "live",
                             "named by the volume's cluster table", "cluster table"))
        if base is None:
            continue
        titles += _titles(reader, vol, base)
        # Footage in clusters the table calls empty: its recording was deleted or the table reset, but the frames were not cleared.
        run, empties = None, [r for r in vol["records"] if r["kind"] == EMPTY and r["i"] >= vol["first_cluster"]]
        for n, r in enumerate(empties):
            off = base + r["i"] * vol["cluster_bytes"]
            if off >= reader.image_size:
                break
            buf = _read(reader, off, vol["cluster_bytes"] + SPILL)
            frames, last = _video(buf, vol["cluster_bytes"], run["last"] if run and run["clusters"][-1] == r["i"] - 1 else None) \
                if b"DHAV" in buf else ([], None)
            if not frames:
                run = _flush(rows, vol, base, run)
                continue
            if run and run["clusters"][-1] == r["i"] - 1 and frames:
                run["clusters"].append(r["i"])
            else:
                _flush(rows, vol, base, run)
                run = {"clusters": [r["i"]], "first": frames[0]["date"]}
            run["last"], run["end"] = last, last["date"]
            progress(n / max(len(empties), 1))
        _flush(rows, vol, base, run)
    rows.sort(key=lambda r: (r["range"][0], r["offset"]))
    return {"superblock": det, "volumes": volumes, "channel_titles": titles, "brand_text": " ".join(titles).encode(), "recordings": rows,
            "warnings": ["DHFS layout taken from a third party's notes on one real Dahua-family disk (Seagate SkyHawk 1 TB, first 20 GiB, "
                         "three cameras, one firmware), never byte-matched against the recorder's own export and not validated on this device "
                         "or firmware. Times are the recorder's wall clock with no timezone check. Extraction takes video frames that continue "
                         "their recording's counter: a frame cut at a cluster end and finished in the chain's next cluster is lost, so a few "
                         "frames per hour can be missing. Head clusters are listed but not extracted. Footage still sitting in clusters of "
                         "recordings that were overwritten is not scanned." + ("".join(" " + n for n in notes))]}


def _flush(rows, vol, base, run):
    if run:
        rows.append(_row(vol, base, run["clusters"], None, _label(run["first"]), _label(run["end"]), "deleted",
                         "clusters the table marks empty still hold video frames: their recording was deleted or the table was reset",
                         "empty clusters"))
    return None


def write_stream(reader, row, target):
    """Video frames of a recording, cluster by cluster, as one H.264/H.265 stream. Updates row['fps'] and row['codec'] from the first frame."""
    if row["data_base"] is None:
        raise ValueError("The data area's position could not be established for this volume, so its footage cannot be extracted.")
    cs, last, codec = row["cluster_size"], None, ""
    for c in row["clusters"]:
        buf = _read(reader, row["data_base"] + c * cs, cs + SPILL)
        frames, last = _video(buf, cs, last)
        for f in frames:
            if not codec:
                info = _ext_info(buf, f)
                codec = info.get("codec", "") or "h264"
                row["fps"], row["codec"] = (info.get("fps") if info.get("fps") and 1 <= info["fps"] <= 120 else None), codec
            target.write(buf[f["at"] + HDR + f["ext"]:f["at"] + f["length"] - TAIL])
    return codec
