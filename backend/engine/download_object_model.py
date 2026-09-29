import argparse
import torch
import os
import shutil
from rfdetr import RFDETRNano, RFDETRSmall, RFDETRMedium, RFDETRBase

# Model selection mapping
MODEL_MAP = {
    "nano": RFDETRNano,
    "small": RFDETRSmall,
    "medium": RFDETRMedium,
    "base": RFDETRBase,  # Best and most accurate model
}

def find_and_copy_weights(model_name: str, output_path: str):
    """
    Downloads the pretrained RF-DETR weights via model instantiation, and copies new weights from torch.hub cache to output_path.
    """
    if model_name not in MODEL_MAP:
        print(f"Error: Model '{model_name}' not recognized. Choose from: {list(MODEL_MAP.keys())}")
        return

    try:
        torch_hub_dir = torch.hub.get_dir()
        checkpoints_dir = os.path.join(torch_hub_dir, 'checkpoints')
        os.makedirs(checkpoints_dir, exist_ok=True)

        files_before = set(os.listdir(checkpoints_dir))
        print(f"Downloading RF-DETR {model_name} weights if not cached...")
        # Download triggered by instantiating model (pretrained on COCO)
        model_class = MODEL_MAP[model_name]
        model_instance = model_class()

        files_after = set(os.listdir(checkpoints_dir))
        new_files = files_after - files_before

        if len(new_files) == 1:
            new_filename = new_files.pop()
            source_path = os.path.join(checkpoints_dir, new_filename)
            shutil.copy(source_path, output_path)
            print(f"\nSuccess! Weights saved as: {output_path}")
        elif len(new_files) == 0:
            print("\nNo new weights downloaded; they are already cached.")
            print("Check these files in torch.hub cache for RF-DETR:")
            for fname in os.listdir(checkpoints_dir):
                print(f"- {fname}")
            print(f"Copy the correct weights file from: {checkpoints_dir}")
        else:
            print("Multiple new files detected, can't automatically select weights:")
            for fname in new_files:
                print(f"- {fname}")
    except Exception as e:
        print("\nError occurred:", e)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Download and save pretrained RF-DETR model weights."
    )
    parser.add_argument("--model", type=str, default="base", choices=list(MODEL_MAP.keys()), help="RF-DETR model variant (default: base)")
    parser.add_argument("--output", type=str, required=True, help="Output file path for saving weights")
    args = parser.parse_args()

    find_and_copy_weights(args.model, args.output)
