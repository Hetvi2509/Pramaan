"""
Persistent OCR worker: loads PaddleOCR once, then serves job after job over
stdin/stdout as JSON lines, instead of paying the ~30s Python/Paddle import +
model-construction cost on every single OCR request (see dvr_scan/ocr_engine.py
and dvr_scan/controller.py's run_ocr_command, which do that per-process for the
one-shot CLI path still used elsewhere).

Protocol (newline-delimited JSON both ways):
  in:  {"cmd": "video", "video": "...", "output": "...", "sampleRate": 1, "confidence": 0.8}
       {"cmd": "image", "image": "..."}
  out: {"type": "worker_ready"}                          -- once, after models load
       {"type": "progress", "progress": 0-99}             -- zero or more, video only
       {"type": "ocr_complete", "status": "success", ...} -- terminal, one per job
       {"type": "error", "message": "..."}                -- terminal, one per job

One job runs at a time; the Node side queues concurrent requests.
"""
import json
import sys

from dvr_scan.ocr_engine import OCREngine
from dvr_scan.ocr_video import annotate_video


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    engine = OCREngine()
    emit({"type": "worker_ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except ValueError:
            emit({"type": "error", "message": f"Worker received invalid JSON: {line!r}"})
            continue

        try:
            if job.get("cmd") == "video":
                result = annotate_video(
                    engine,
                    job["video"],
                    job["output"],
                    float(job.get("sampleRate", 1.0)),
                    float(job.get("confidence", 0.8)),
                    emit=emit,
                )
                emit(result)
            elif job.get("cmd") == "image":
                result = engine.process_image_from_path(job["image"])
                if result.get("status") == "error":
                    emit({"type": "error", "message": result.get("message", "OCR failed")})
                else:
                    emit({"type": "ocr_complete", **result})
            else:
                emit({"type": "error", "message": f"Unknown worker command: {job.get('cmd')!r}"})
        except Exception as e:
            # A bad input file must not take the warm worker down with it.
            emit({"type": "error", "message": str(e)})


if __name__ == "__main__":
    main()
