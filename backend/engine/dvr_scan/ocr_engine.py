# dvr-scan-py/dvr_scan/ocr_engine.py
import os
import sys
import logging
from pathlib import Path
import numpy as np

def get_resource_path(relative_path: str) -> Path:
    """models/ ships beside the executable when frozen, so it can be updated or downloaded separately
    from the engine; falls back to the PyInstaller bundle, then to the source tree beside this package."""
    roots = []
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).resolve().parent)
        if hasattr(sys, "_MEIPASS"):
            roots.append(Path(sys._MEIPASS))
    roots.append(Path(__file__).resolve().parent.parent)
    for root in roots:
        if (candidate := root / relative_path).exists():
            return candidate
    return roots[0] / relative_path


# --- Model and Environment Setup ---
try:
    MODEL_ROOT_DIR = get_resource_path('models')
    LOCAL_MODEL_DIR = MODEL_ROOT_DIR / 'ocr'

    if not LOCAL_MODEL_DIR.exists():
        raise FileNotFoundError(f"OCR models root directory not found at {LOCAL_MODEL_DIR}")

    os.environ['PADDLE_HOME'] = str(MODEL_ROOT_DIR)
    os.environ['PADDLEOCR_HOME'] = str(LOCAL_MODEL_DIR)
    
    from paddleocr import PaddleOCR

except Exception as e:
    logging.error(f"FATAL: Failed during OCR engine setup: {e}", exc_info=True)
    sys.exit(1)

class OCREngine:
    def __init__(self):
        logging.info("Initializing PaddleOCR Engine... This may take a moment.")
        try:
            # Note: These paths are relative within the bundled app
            # ponytail: the "server" det/rec models are ~85MB+82MB and took 2+ minutes per run
            # to load and warm up on CPU (no GPU, MKLDNN disabled below). The "mobile" variants
            # are ~5MB+17MB, built for exactly this (CPU, no accelerator) and finish in seconds
            # with a small accuracy trade-off. Swap back to "server" if accuracy matters more
            # than latency for a given deployment.
            det_model_path = str(LOCAL_MODEL_DIR / 'PP-OCRv5_mobile_det')
            rec_model_path = str(LOCAL_MODEL_DIR / 'PP-OCRv5_mobile_rec')

            # ponytail: paddleocr>=3.x renamed det_model_dir/rec_model_dir to
            # text_detection_model_dir/text_recognition_model_dir, and now validates the model
            # name baked into each dir's config.json against its default expected architecture
            # (PP-OCRv6) unless told the actual name explicitly — so we pass both name + dir.
            self.ocr = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_detection_model_dir=det_model_path,
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                text_recognition_model_dir=rec_model_path,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                # Paddle's Windows oneDNN executor rejects this model's PIR attributes.
                enable_mkldnn=False,
            )
            logging.info("[OK] PaddleOCR Engine initialized successfully.")
        except Exception as e:
            logging.error(f"FATAL: Failed to initialize PaddleOCR instance: {e}", exc_info=True)
            raise e

    def process_image_from_path(self, image_path: str) -> dict:
        try:
            result_data = self.ocr.predict(image_path)
            formatted_results = []
            if result_data and result_data[0]:
                # The result is a list containing one item which can be a dict or a list
                res = result_data[0]
                
                # Handle new dictionary-based format (PaddleOCR >= 2.7)
                if isinstance(res, dict):
                    for i in range(len(res.get('rec_texts', []))):
                        formatted_results.append({
                            "text": res['rec_texts'][i],
                            "confidence": float(res['rec_scores'][i]),
                            "box": res['rec_polys'][i].tolist() # Convert numpy array to list
                        })
                # Handle old list-based format for backward compatibility
                else:
                    for line in res:
                        box, (text, score) = line
                        formatted_results.append({
                            "text": text,
                            "confidence": float(score),
                            "box": [[int(p[0]), int(p[1])] for p in box]
                        })
                                      
            logging.info(f"[OK] OCR completed: found {len(formatted_results)} text lines.")
            return {"status": "success", "results": formatted_results, "count": len(formatted_results)}
        except Exception as e:
            return {"status": "error", "message": str(e)}
