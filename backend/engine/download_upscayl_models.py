#!/usr/bin/env python3
"""
Download Upscayl models for the upscaling functionality.
This script downloads the necessary model files from the official Upscayl repository.
"""

import os
import requests
import zipfile
from pathlib import Path
import argparse

# Base URL for Upscayl models
BASE_URL = "https://raw.githubusercontent.com/upscayl/upscayl/a00d55fee90e0f9435d5eaa86e76700df8199af8/resources/models/"

# Available models and their file names
MODELS = {
    "upscayl-lite-4x": {
        "param": "upscayl-lite-4x.param",
        "bin": "upscayl-lite-4x.bin"
    },
    "upscayl-high-fidelity-4x": {
        "param": "upscayl-high-fidelity-4x.param",
        "bin": "upscayl-high-fidelity-4x.bin"
    },
    "upscayl-standard-4x": {
        "param": "upscayl-standard-4x.param",
        "bin": "upscayl-standard-4x.bin"
    },
    "upscayl-ultra-sharp-4x": {
        "param": "upscayl-ultra-sharp-4x.param",
        "bin": "upscayl-ultra-sharp-4x.bin"
    }
}

def download_file(url, dest_path):
    """Download a file from URL to destination path."""
    print(f"Downloading {url} to {dest_path}")
    response = requests.get(url, stream=True, timeout=60)
    response.raise_for_status()

    with open(dest_path, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"Downloaded {dest_path}")

def download_model(model_name, models_dir):
    """Download a specific model."""
    if model_name not in MODELS:
        print(f"Error: Model '{model_name}' not found. Available models: {', '.join(MODELS.keys())}")
        return False

    model_info = MODELS[model_name]

    try:
        # Download param file
        param_url = BASE_URL + model_info["param"]
        param_path = models_dir / model_info["param"]
        download_file(param_url, param_path)

        # Download bin file
        bin_url = BASE_URL + model_info["bin"]
        bin_path = models_dir / model_info["bin"]
        download_file(bin_url, bin_path)

        print(f"Successfully downloaded model '{model_name}'")
        return True

    except Exception as e:
        print(f"Error downloading model '{model_name}': {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Download Upscayl models")
    parser.add_argument(
        "--model",
        choices=list(MODELS.keys()),
        help="Specific model to download"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Download all available models"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="models/upscayl",
        help="Output directory for models"
    )

    args = parser.parse_args()

    models_dir = Path(args.output_dir)
    models_dir.mkdir(parents=True, exist_ok=True)

    if args.all:
        print("Downloading all models...")
        success_count = 0
        for model_name in MODELS.keys():
            if download_model(model_name, models_dir):
                success_count += 1
        print(f"Downloaded {success_count}/{len(MODELS)} models successfully")
    elif args.model:
        download_model(args.model, models_dir)
    else:
        # Default: download the lite model
        print("No model specified, downloading upscayl-lite-4x (recommended for most users)...")
        download_model("upscayl-lite-4x", models_dir)

if __name__ == "__main__":
    main()
