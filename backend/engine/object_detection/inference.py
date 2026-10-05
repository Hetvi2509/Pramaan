# dvr-scan-py/object_detection/inference.py

import argparse
import cv2
import torch
import supervision as sv
from tqdm import tqdm
from rfdetr import RFDETRNano, RFDETRSmall, RFDETRMedium, RFDETRBase
try:
    from rfdetr.util.coco_classes import COCO_CLASSES  # rfdetr < 1.9
except ImportError:
    from rfdetr.assets.coco_classes import COCO_CLASSES  # ponytail: rfdetr >= 1.9 moved this module

MODEL_MAP = {
    "nano": RFDETRNano,
    "small": RFDETRSmall,
    "medium": RFDETRMedium,
    "base": RFDETRBase,
}

def run_video_detection(weights_path: str, model_name: str, video_path: str, output_path: str, batch_size: int = 4):
    """
    Performs object detection on a video using local model weights, batching frames
    through RF-DETR instead of one prediction call per frame.
    """
    if model_name not in MODEL_MAP:
        print(f"Error: Model '{model_name}' not recognized. Available: {list(MODEL_MAP.keys())}")
        return

    print(f"Loading RF-DETR-{model_name} model from local weights: {weights_path}")

    model_class = MODEL_MAP[model_name]
    model = model_class(pretrain_weights=weights_path)
    print("Model loaded successfully.")

    # Traces the model once for a fixed batch size (torchscript by default, works on CPU and GPU
    # alike) instead of re-dispatching the eager graph on every single frame. RF-DETR's own docs
    # cite this as the main lever before touching hardware/precision. Some checkpoints use control
    # flow the tracer can't follow, so fall back to eager (still correct, just as fast as before).
    try:
        model.inference(compile=True, batch_size=batch_size)
        print(f"Model optimized for inference (batch size {batch_size}).")
    except Exception as e:
        print(f"Could not compile model for batched inference ({e}); continuing without compilation.")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Could not open video file at {video_path}")
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = int(cap.get(cv2.CAP_PROP_FPS)) or 25
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    box_annotator = sv.BoxAnnotator()
    label_annotator = sv.LabelAnnotator()

    print(f"Processing video: {video_path}")
    progress = tqdm(total=total_frames, desc="Detecting Objects")
    batch_frames = []
    seen = []  # (frame_number, class name, confidence), kept so the results can be listed, not only drawn
    counted = [0]

    def flush(batch):
        if not batch:
            return
        # RF-DETR accepts RGB numpy arrays directly, so skip the extra PIL round-trip per frame.
        rgb_batch = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in batch]
        # The compiled graph is traced for a fixed batch size; pad a short final batch by
        # repeating the last frame, then drop the padding from the results below.
        pad = batch_size - len(rgb_batch)
        if pad > 0:
            rgb_batch = rgb_batch + [rgb_batch[-1]] * pad
        results = model.predict(rgb_batch, threshold=0.5)
        if not isinstance(results, list):
            results = [results]
        for frame, detections in zip(batch, results[: len(batch)]):
            labels = [
                f"{COCO_CLASSES.get(class_id, 'Unknown')} {confidence:.2f}"
                for class_id, confidence
                in zip(detections.class_id, detections.confidence)
            ]
            seen.extend((counted[0], COCO_CLASSES.get(int(c), "Unknown"), float(p))
                        for c, p in zip(detections.class_id, detections.confidence))
            counted[0] += 1
            annotated_frame = box_annotator.annotate(scene=frame.copy(), detections=detections)
            annotated_frame = label_annotator.annotate(scene=annotated_frame, detections=detections, labels=labels)
            out.write(annotated_frame)
        progress.update(len(batch))

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        batch_frames.append(frame)
        if len(batch_frames) == batch_size:
            flush(batch_frames)
            batch_frames = []
    flush(batch_frames)  # last partial batch, if any

    progress.close()
    cap.release()
    out.release()
    # --- FIX: Removed the line below which causes crashes in headless environments ---
    # cv2.destroyAllWindows()
    # -------------------------------------------------------------------------------

    print(f"Video processing complete. Annotated video saved to: {output_path}")
    return write_appearances(seen, fps, counted[0], video_path, output_path)


def write_appearances(seen, fps, frames, video_path, output_path, max_gap_s=1.0):
    """Merge per-frame detections into appearances: the same class seen again within max_gap_s is one
    appearance. Times are seconds into the clip; the clip's own start time is the caller's to add."""
    import json
    last = {}
    appearances = []
    for frame, name, confidence in sorted(seen):
        current = last.get(name)
        if current and (frame - current["_last"]) / fps <= max_gap_s:
            current["_last"] = frame
            current["frames"] += 1
            current["confidence"] = max(current["confidence"], confidence)
        else:
            current = {"class": name, "_first": frame, "_last": frame, "frames": 1, "confidence": confidence}
            last[name] = current
            appearances.append(current)
    for a in appearances:
        a["start_s"], a["end_s"] = round(a.pop("_first") / fps, 2), round((a.pop("_last") + 1) / fps, 2)
        a["confidence"] = round(a["confidence"], 3)
    sidecar = output_path + ".detections.json"
    with open(sidecar, "w", encoding="utf-8") as handle:
        json.dump({"video": video_path, "fps": fps, "frames": frames, "duration_s": round(frames / fps, 2),
                   "appearances": appearances}, handle, indent=1)
    return sidecar

def main():
    parser = argparse.ArgumentParser(
        description="Run object detection on a video using a local RF-DETR model."
    )
    parser.add_argument("--weights", type=str, required=True, help="Path to the local model weights (.pth) file.")
    parser.add_argument("--model", type=str, default="base", choices=MODEL_MAP.keys(), help="Model architecture.")
    parser.add_argument("--video", type=str, required=True, help="Path to the input video file.")
    parser.add_argument("--output", type=str, required=True, help="Path to save the output annotated video.")
    parser.add_argument("--batch-size", type=int, default=4, help="Frames per inference call (higher uses more RAM, fewer Python/model-dispatch round trips).")
    args = parser.parse_args()

    run_video_detection(args.weights, args.model, args.video, args.output, args.batch_size)

if __name__ == "__main__":
    main()
