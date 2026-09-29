"""Video OCR rendering. Original frames are preserved beneath text polygons."""
import json
import math
from pathlib import Path

import cv2
import numpy as np


def _print_progress(event):
    print(json.dumps(event), flush=True)


def annotate_video(engine, video, output, sample_rate=1.0, confidence=0.8, emit=_print_progress):
    if not output or Path(video).resolve() == Path(output).resolve():
        raise ValueError("A separate output video path is required")
    if not math.isfinite(sample_rate) or not 0 < sample_rate <= 60:
        raise ValueError("Sample rate must be greater than 0 and at most 60")
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError("Confidence must be between 0 and 1")
    cap = cv2.VideoCapture(str(video))
    writer = None
    try:
        if not cap.isOpened():
            raise ValueError("Could not open the input video")
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("Input video has no valid frame rate")
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        if not writer.isOpened():
            raise RuntimeError("Could not create the OCR output video")
        interval = max(1, round(fps / sample_rate))
        index, count = 0, 0
        detections = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index % interval == 0:
                result = engine.process_image_from_path(frame)
                if result.get("status") != "success":
                    raise RuntimeError(result.get("message", "Frame OCR failed"))
                detections = [d for d in result["results"] if d["text"].strip() and d["confidence"] >= confidence]
                count += len(detections)
                emit({"type": "progress", "progress": min(99, index * 100 / max(total, 1))})
            # Keep the source text readable; outline only recognized text regions.
            # Sampled boxes persist until the next OCR sample, which also clears misses.
            for detection in detections:
                points = np.asarray(detection["box"], dtype=np.int32).reshape((-1, 1, 2))
                cv2.polylines(frame, [points], True, (60, 220, 80), 2, cv2.LINE_AA)
            writer.write(frame)
            index += 1
        if index == 0:
            raise ValueError("The video contains no readable frames")
    except Exception:
        if writer is not None:
            writer.release()
        Path(output).unlink(missing_ok=True)
        raise
    finally:
        cap.release()
        if writer is not None:
            writer.release()
    return {"type": "ocr_complete", "status": "success", "output": str(Path(output).resolve()), "frames": index, "detections": count}
