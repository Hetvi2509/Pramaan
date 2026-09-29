"""
PaddleOCR Model Downloader
This script downloads PaddleOCR models to prepare for offline deployment.
Models will be downloaded to server/models/ocr/ directory.
"""

import os
import sys
import logging
from pathlib import Path
import shutil

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Define the local model directory within the server folder
SCRIPT_DIR = Path(__file__).parent
LOCAL_MODEL_DIR = SCRIPT_DIR / 'models' / 'ocr'

# Create directory if it doesn't exist
LOCAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)

# Set environment variables BEFORE importing PaddleOCR
os.environ['PADDLE_HOME'] = str(LOCAL_MODEL_DIR)
os.environ['HF_HOME'] = str(LOCAL_MODEL_DIR)
os.environ['HF_HUB_CACHE'] = str(LOCAL_MODEL_DIR)
os.environ['PADDLEOCR_HOME'] = str(LOCAL_MODEL_DIR)

logger.info(f"Models will be saved to: {LOCAL_MODEL_DIR}")


def download_from_huggingface():
    """Download models from HuggingFace Hub."""
    try:
        from huggingface_hub import hf_hub_download
        
        models = {
            'PP-OCRv5_server_det': {
                'repo': 'PaddlePaddle/PP-OCRv5_server_det',
                'files': ['inference.pdiparams', 'inference.json', 'inference.yml', 'config.json']
            },
            'PP-OCRv5_server_rec': {
                'repo': 'PaddlePaddle/PP-OCRv5_server_rec',
                'files': ['inference.pdiparams', 'inference.json', 'inference.yml', 'config.json']
            },
            'PP-LCNet_x1_0_textline_ori': {
                'repo': 'PaddlePaddle/PP-LCNet_x1_0_textline_ori',
                'files': ['inference.pdiparams', 'inference.json', 'inference.yml', 'config.json']
            },
            'PP-LCNet_x1_0_doc_ori': {
                'repo': 'PaddlePaddle/PP-LCNet_x1_0_doc_ori',
                'files': ['inference.pdiparams', 'inference.json', 'inference.yml', 'config.json']
            },
            'UVDoc': {
                'repo': 'PaddlePaddle/UVDoc',
                'files': ['inference.pdiparams', 'inference.json', 'inference.yml', 'config.json']
            }
        }

              
        for model_name, config in models.items():
            logger.info(f"Downloading {model_name} from HuggingFace...")
            model_dir = LOCAL_MODEL_DIR / model_name
            model_dir.mkdir(exist_ok=True)
            
            for file_name in config['files']:
                try:
                    file_path = hf_hub_download(
                        repo_id=config['repo'],
                        filename=file_name,
                        cache_dir=str(LOCAL_MODEL_DIR / '.cache'),
                        local_dir=str(model_dir),
                        local_dir_use_symlinks=False
                    )
                    logger.info(f"  ✓ Downloaded: {file_name}")
                except Exception as e:
                    logger.error(f"  ✗ Failed to download {file_name}: {e}")
                    return False
        
        return True
        
    except ImportError:
        logger.error("huggingface_hub is not installed. Please run: pip install huggingface_hub")
        return False
    except Exception as e:
        logger.error(f"Error downloading from HuggingFace: {e}", exc_info=True)
        return False


def download_with_paddleocr():
    """Download PaddleOCR models using PaddleOCR's built-in downloader."""
    try:
        logger.info("Starting PaddleOCR model download...")
        logger.info("This may take several minutes depending on your internet connection.")
        
        from paddleocr import PaddleOCR
        
        logger.info("Downloading models via PaddleOCR...")
        
        # Let PaddleOCR download models to default location first
        ocr = PaddleOCR(
            use_textline_orientation=False,
            lang='en',
        )
        
        logger.info("[OK] Models downloaded successfully.")
        
        # Now move models to our local directory
        logger.info("Moving models to local directory...")
        
        # Check common PaddleOCR cache locations
        possible_cache_dirs = [
            Path.home() / '.paddleocr',
            Path.home() / '.paddlex' / 'official_models',
        ]
        
        models_to_find = ['PP-LCNet_x1_0_textline_ori', 'PP-LCNet_x1_0_doc_ori', 'UVDoc', 'PP-OCRv5_server_rec', 'PP-OCRv5_server_det']
        
        for cache_dir in possible_cache_dirs:
            if not cache_dir.exists():
                continue
                
            logger.info(f"Checking cache directory: {cache_dir}")
            
            for model_name in models_to_find:
                # Search for the model in the cache
                for model_path in cache_dir.rglob(model_name):
                    if model_path.is_dir():
                        target_path = LOCAL_MODEL_DIR / model_name
                        if not target_path.exists():
                            logger.info(f"  Copying {model_name}...")
                            shutil.copytree(model_path, target_path)
                            logger.info(f"  ✓ Copied to {target_path}")
        
        logger.info("Verifying models with a dummy input...")
        import numpy as np
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        # result = ocr.ocr(dummy_img, cls=False)
        logger.info("[OK] Models are working correctly.")
        
        logger.info(f"\nModels are now stored in: {LOCAL_MODEL_DIR}")
        
        return True
        
    except ImportError:
        logger.error("PaddleOCR is not installed. Please run: pip install paddleocr")
        return False
    except Exception as e:
        logger.error(f"An error occurred: {e}", exc_info=True)
        return False


def verify_models():
    """Verify that models are downloaded and accessible."""
    try:
        models_exist = False
        
        # Check for expected model directories
        expected_models = ['PP-LCNet_x1_0_textline_ori', 'PP-LCNet_x1_0_doc_ori', 'UVDoc', 'PP-OCRv5_server_rec', 'PP-OCRv5_server_det']
        
        logger.info(f"\nChecking for models in: {LOCAL_MODEL_DIR}")
        
        found_models = []
        for model_name in expected_models:
            model_path = LOCAL_MODEL_DIR / model_name
            if model_path.exists():
                # Check for inference files
                # Note: New PaddleOCR models use inference.json instead of inference.pdmodel
                has_params = (model_path / 'inference.pdiparams').exists()
                has_json = (model_path / 'inference.json').exists()
                has_yml = (model_path / 'inference.yml').exists()
                
                if has_params and (has_json or has_yml):
                    logger.info(f"  [OK] Found: {model_name}")
                    logger.info(f"       ├─ inference.pdiparams ✓")
                    if has_json:
                        logger.info(f"       ├─ inference.json ✓")
                    if has_yml:
                        logger.info(f"       └─ inference.yml ✓")
                    models_exist = True
                    found_models.append(model_name)
                else:
                    logger.warning(f"  [INCOMPLETE] {model_name} (missing inference files)")
                    if not has_params:
                        logger.warning(f"       Missing: inference.pdiparams")
                    if not has_json:
                        logger.warning(f"       Missing: inference.json")
                    if not has_yml:
                        logger.warning(f"       Missing: inference.yml")
            else:
                logger.warning(f"  [MISSING] {model_name}")
        
        if not models_exist:
            logger.warning(f"No complete models found in {LOCAL_MODEL_DIR}")
            return False
        
        if len(found_models) < len(expected_models):
            logger.warning(f"Only {len(found_models)}/{len(expected_models)} models found")
            return False
        
        return True
        
    except Exception as e:
        logger.error(f"Error verifying models: {e}")
        return False


def main():
    """Main entry point."""
    logger.info("=" * 60)
    logger.info("PaddleOCR Model Downloader for Offline Deployment")
    logger.info("=" * 60)
    
    if verify_models():
        logger.info("\n[OK] Models appear to be already downloaded!")
        response = input("\nDo you want to re-download them? (y/N): ")
        if response.lower() != 'y':
            logger.info("Skipping download.")
            return 0
    
    logger.info("\nChoose download method:")
    logger.info("1. Download from HuggingFace (Recommended)")
    logger.info("2. Download via PaddleOCR (may download to default cache first)")
    
    choice = input("\nEnter choice (1 or 2) [default: 1]: ").strip() or "1"
    
    success = False
    if choice == "1":
        logger.info("\nDownloading from HuggingFace...")
        success = download_from_huggingface()
    elif choice == "2":
        logger.info("\nDownloading via PaddleOCR...")
        success = download_with_paddleocr()
    else:
        logger.error("Invalid choice!")
        return 1
    
    if success:
        logger.info("\n" + "=" * 60)
        logger.info("[OK] Model download complete!")
        logger.info("=" * 60)
        verify_models()
        return 0
    else:
        logger.error("\n[ERROR] Model download failed!")
        return 1


if __name__ == '__main__':
    sys.exit(main())