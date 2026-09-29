import contextlib
import io
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from dvr_scan.ocr_video import annotate_video


class VideoOCRTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / "input.avi"
        self.output = Path(self.temp.name) / "output.mp4"
        writer = cv2.VideoWriter(str(self.input), cv2.VideoWriter_fourcc(*"MJPG"), 4, (160, 100))
        for _ in range(8):
            writer.write(np.zeros((100, 160, 3), np.uint8))
        writer.release()

    def test_confidence_filter_and_empty_sample_clear_boxes(self):
        class Engine:
            calls = 0

            def process_image_from_path(self, frame):
                self.calls += 1
                return {"status": "success", "results": [
                    {"text": "CAM 01", "confidence": .95, "box": [[10, 10], [65, 10], [65, 30], [10, 30]]},
                    {"text": "noise", "confidence": .2, "box": [[90, 60], [140, 60], [140, 85], [90, 85]]},
                ] if self.calls == 1 else []}

        engine = Engine()
        with contextlib.redirect_stdout(io.StringIO()):
            result = annotate_video(engine, self.input, self.output, 1, .8)
        self.assertEqual(engine.calls, 2)
        self.assertEqual(result["frames"], 8)
        self.assertEqual(result["detections"], 1)
        cap = cv2.VideoCapture(str(self.output))
        frames = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
        cap.release()
        self.assertEqual(len(frames), 8)
        self.assertGreater(frames[0][8:13, 15:60, 1].max(), 150)
        self.assertLess(frames[0][55:90, 85:145].max(), 30)
        self.assertLess(frames[4].max(), 30)

    def test_inference_failure_removes_partial_output(self):
        class Engine:
            def process_image_from_path(self, frame):
                return {"status": "error", "message": "OCR failed"}
        with self.assertRaisesRegex(RuntimeError, "OCR failed"):
            annotate_video(Engine(), self.input, self.output)
        self.assertFalse(self.output.exists())

    def test_invalid_options_and_input(self):
        for rate, confidence in [(0, .8), (float("nan"), .8), (1, 2)]:
            with self.assertRaises(ValueError):
                annotate_video(None, self.input, self.output, rate, confidence)
        with self.assertRaises(ValueError):
            annotate_video(None, self.input, self.input)
        with self.assertRaises(ValueError):
            annotate_video(None, "missing-video.avi", self.output)


if __name__ == "__main__":
    unittest.main()
