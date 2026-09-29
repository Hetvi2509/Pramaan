"""Pramaan adapter for Niriksha's Hikvision parsers and local evidence tools.

Original parser implementations remain in dvr_scan/hikvision. Results retain
their raw fields and addresses; this adapter adds a common recordings list.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import uuid

from dvr_scan.hikvision.helpers import ImageReader

VIDEO_EXTENSIONS = {".mp4", ".avi", ".h264", ".264", ".h265", ".265", ".dav", ".mkv",
                     ".ts", ".mov", ".3gp", ".flv", ".wmv", ".asf", ".mpg", ".mpeg"}


def emit(data):
    print(json.dumps(data), flush=True)


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


def _walk_fs(pytsk3, directory, path, out, seen):
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
                _walk_fs(pytsk3, entry.as_directory(), full_path, out, seen)
            elif os.path.splitext(name)[1].lower() in VIDEO_EXTENSIONS:
                out.append({"path": full_path, "inode": meta.addr, "size": meta.size, "deleted": deleted})
        except Exception:
            continue  # unreadable/corrupt directory entry; skip rather than abort the whole walk


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


def identify(reader):
    sample = reader.read(0, min(reader.image_size, 16 * 1024 * 1024))
    signatures = []
    for signature, family in [(b"HIKVISION@HANGZHOU", "Hikvision"), (b"HIKBTREE", "Hikvision"),
                              (b"IMKH", "Hikvision"),
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
    filesystems = []
    if adapter is None:
        filesystems = _detect_filesystems(reader)
        if filesystems:
            adapter = "filesystem"
    return {"family": ", ".join(families) or "Unknown", "container": container,
            "adapter": adapter, "signatures": signatures, "filesystems": filesystems, "bytes_scanned": len(sample),
            "note": "Signature evidence identifies a format family, not a specific OEM/model. No matching signature does not rule out a vendor."}


def parse(reader, work):
    identification = identify(reader)
    adapter = identification["adapter"]
    bundle = {"identification": identification, "recordings": [], "warnings": []}
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
                    "offset": entry["data_block_offset"], "status": entry["existence"], "adapter": adapter})
        bundle["warnings"].append("Recorder timestamps are raw clock values; timezone and clock accuracy have not been verified.")
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
                "start": None, "end": None, "offset": hex(offset), "status": "Recorded DHAV stream", "ranges": []})
            row["ranges"].append([offset, length])
            offset += length
        bundle["recordings"] = list(channels.values())
        bundle["warnings"].append("DHAV wrapper records are grouped by channel. This is not a DHFS disk filesystem or deleted-video parser.")
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
                "offset": "0x0", "adapter": adapter, "status": "Playable media"}]
        finally:
            cap.release()
    elif adapter == "filesystem":
        import pytsk3
        bundle["filesystems"] = identification["filesystems"]
        for fsinfo in identification["filesystems"]:
            img = _ReaderImg(reader).as_img_info()
            fs = pytsk3.FS_Info(img, offset=fsinfo["offset"])
            files = []
            _walk_fs(pytsk3, fs.open_dir(path="/"), "", files, set())
            for f in files:
                bundle["recordings"].append({"id": str(len(bundle["recordings"])), "channel": None,
                    "start": None, "end": None, "offset": hex(fsinfo["offset"]),
                    "status": "Deleted (recovered)" if f["deleted"] else "Recorded file",
                    "adapter": adapter, "fs_offset": fsinfo["offset"], "inode": f["inode"],
                    "path": f["path"], "size": f["size"]})
        if not bundle["recordings"]:
            raise ValueError("A filesystem was recognized but no video files were found on it")
        bundle["warnings"].append("Filesystem adapter lists standard video files stored directly on a FAT/NTFS/ext partition "
            "(common on DVR brands that don't use a proprietary block format). \"Deleted (recovered)\" entries are unallocated "
            "directory records whose data may be partially or fully overwritten; verify after extraction.")
    else:
        raise ValueError("No supported parser found. Supported: Hikvision disks, DHAV record streams, standard filesystems "
            "(FAT/NTFS/ext) holding video files, and standard playable video containers. Unrecognized proprietary block "
            "formats are not yet supported.")
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
    output = work / f"recording-{uuid.uuid4().hex}.mp4"
    ffmpeg = Path(__file__).resolve().parent.parent / "ffmpeg.exe"
    command = str(ffmpeg) if ffmpeg.exists() else "ffmpeg"
    result = subprocess.run([command, "-y", "-v", "error", "-i", str(source), "-map", "0:v:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(output)], capture_output=True)
    if result.returncode:
        output.unlink(missing_ok=True)
        raise RuntimeError("Video decode/export failed: " + result.stderr.decode(errors="replace")[-2000:])
    return {"output": str(output.resolve()), "hashes": hashes(output), "recording_id": recording_id,
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
    parser.add_argument("action", choices=["hash", "identify", "parse", "extract", "upscale"])
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
            else: data = extract(reader, json.loads(Path(args.bundle).read_text(encoding="utf-8")), args.recording, work)
        if "output" in data:
            manifest = Path(data["output"]).with_suffix(".manifest.json")
            manifest.write_text(json.dumps({"source": args.image, "action": args.action, **data}, indent=2), encoding="utf-8")
            data["manifest"] = str(manifest.resolve())
        emit({"type": "forensics_result", "action": args.action, "data": data})
    except Exception as error:
        emit({"type": "forensics_error", "message": str(error)})
        sys.exit(1)
    finally:
        if reader: reader.close()


if __name__ == "__main__":
    main()
