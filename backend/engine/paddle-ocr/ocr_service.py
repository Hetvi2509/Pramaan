# Niriksha Server - OCR Service
# dvr-scan-py/paddle-ocr/ocr_service.py

import os
import sys
import logging
from pathlib import Path
import codecs

# --- FIX for UnicodeEncodeError on Windows ---
# Force stdout and stderr to use UTF-8 encoding.
if sys.stdout.encoding != 'utf-8':
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')
# ---------------------------------------------

# prevent PaddleOCR from downloading models automatically
os.environ["PADDLEOCR_NO_MODEL_DOWNLOAD"] = "1"
os.environ["PADDLEOCR_HOME"] = os.path.abspath("./models")
os.environ["PADDLE_HOME"] = os.path.abspath("./models")


# Set up logging FIRST
logging.basicConfig(stream=sys.stdout, level=logging.INFO, format='[OCR Service] %(asctime)s - %(message)s')

try:
    SERVER_DIR = Path(__file__).parent.parent
    LOCAL_MODEL_DIR = SERVER_DIR / 'models' / 'ocr'

    if not LOCAL_MODEL_DIR.exists():
        logging.error(f"Local model directory not found at {LOCAL_MODEL_DIR}")
        logging.error("Please run 'python download_models.py' first to download the models.")
        sys.exit(1)

    logging.info(f"Using local model directory: {LOCAL_MODEL_DIR}")

    os.environ['PADDLE_HOME'] = str(LOCAL_MODEL_DIR)
    os.environ['HF_HOME'] = str(LOCAL_MODEL_DIR)
    os.environ['HF_HUB_CACHE'] = str(LOCAL_MODEL_DIR)
    os.environ['PADDLEOCR_HOME'] = str(LOCAL_MODEL_DIR)
    
    cache_dir = SERVER_DIR / 'cache'
    os.makedirs(cache_dir, exist_ok=True)
    os.environ['HOME'] = str(cache_dir)
    if os.name == 'nt':
        os.environ['USERPROFILE'] = str(cache_dir)
    
    paddlex_cache = cache_dir / '.paddlex' / 'official_models'
    os.makedirs(paddlex_cache, exist_ok=True)

except Exception as e:
    logging.error(f"Error setting up model paths: {e}")
    sys.exit(1)

from flask import Flask, request, jsonify
from PIL import Image
import io
import numpy as np
from paddleocr import PaddleOCR

app = Flask(__name__)
logging.info("Flask app initialized.")

logging.info("Initializing PaddleOCR... This may take a moment.")
try:
    det_model_path = LOCAL_MODEL_DIR / 'PP-OCRv5_server_det'
    rec_model_path = LOCAL_MODEL_DIR / 'PP-OCRv5_server_rec'
    doc_cls_model_path = LOCAL_MODEL_DIR / 'PP-LCNet_x1_0_doc_ori'
    uv_model_path = LOCAL_MODEL_DIR / 'UVDoc'
    
    if not all([p.exists() for p in [det_model_path, rec_model_path, doc_cls_model_path, uv_model_path]]):
        raise FileNotFoundError("One or more OCR model directories are missing.")

    logging.info(f"[OK] Detection model: {det_model_path}")
    logging.info(f"[OK] Recognition model: {rec_model_path}")
    logging.info(f"[OK] Document classification model: {doc_cls_model_path}")
    logging.info(f"[OK] Unwarping model: {uv_model_path}")
    
    # FIXED: Removed show_log parameter that doesn't exist in this version
    ocr = PaddleOCR(
        use_doc_orientation_classify=True,
        use_doc_unwarping=True,
        use_textline_orientation=False,
        text_detection_model_dir=str(det_model_path),
        text_recognition_model_dir=str(rec_model_path),
        doc_orientation_classify_model_dir=str(doc_cls_model_path),
        doc_unwarping_model_dir=str(uv_model_path)
    )
    logging.info("[OK] PaddleOCR initialized successfully with local models.")
    
except Exception as e:
    logging.error(f"FATAL: Failed to initialize PaddleOCR: {e}", exc_info=True)
    sys.exit(1)


@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    if 'image' not in request.files:
        return jsonify({"status": "error", "message": "No image provided in request"}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No image selected"}), 400
    try:
        img_bytes = file.read()
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        img_np = np.array(img)
        logging.info(f"Processing OCR for image: {file.filename} ({len(img_bytes)} bytes)")
        result_data = ocr.predict(img_np)
        formatted_results = []
        if result_data and result_data[0]:
            res = result_data[0]
            if isinstance(res, dict): # New format
                for i in range(len(res.get('rec_texts', []))):
                    formatted_results.append({
                        "text": res['rec_texts'][i],
                        "confidence": float(res['rec_scores'][i]),
                        "box": res['rec_polys'][i].tolist()
                    })
            else: # Old format
                for line in res:
                    formatted_results.append({
                        "text": line[1][0],
                        "confidence": float(line[1][1]),
                        "box": line[0]
                    })
        logging.info(f"[OK] OCR completed: found {len(formatted_results)} text lines")
        return jsonify({"status": "success", "results": formatted_results, "count": len(formatted_results)})
    except Exception as e:
        logging.error(f"Error during OCR processing: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "healthy", "service": "PaddleOCR v5",
        "models": { "detection": "PP-OCRv5_server_det", "recognition": "PP-OCRv5_server_rec", "doc_classification": "PP-LCNet_x1_0_doc_ori", "unwarping": "UVDoc" }
    })


if __name__ == '__main__':
    logging.info("=" * 60)
    logging.info("Starting OCR Service on http://127.0.0.1:5000")
    logging.info("=" * 60)
    app.run(debug=False, host='127.0.0.1', port=5000)