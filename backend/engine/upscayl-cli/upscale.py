import argparse
import sys
import subprocess
import shutil
from pathlib import Path

# --- Platform-specific executable name ---
IS_WINDOWS = sys.platform == "win32"
EXECUTABLE_NAME = "upscayl-bin.exe" if IS_WINDOWS else "upscayl-bin"

# --- Path Configuration (relative to the script's location) ---
SCRIPT_DIR = Path(__file__).resolve().parent
BIN_DIR = SCRIPT_DIR / "bin"
EXECUTABLE_PATH = BIN_DIR / EXECUTABLE_NAME
REAL_MODELS_DIR = SCRIPT_DIR.parent / "models" / "upscayl"
OUTPUT_DIR = SCRIPT_DIR / "output"
TEMP_MODELS_DIR = BIN_DIR / "models" # The temporary folder we will create inside 'bin'

def list_models():
    """Prints a list of available models."""
    print("Available Models:")
    if not REAL_MODELS_DIR.exists():
        print(f"  Error: Models directory not found at '{REAL_MODELS_DIR}'")
        return
    for param_file in REAL_MODELS_DIR.glob("*.param"):
        print(f"  - {param_file.stem}")

def main():
    """Main function to handle argument parsing and the upscaling process."""
    parser = argparse.ArgumentParser(
        description="Upscayl CLI Wrapper: Upscales an image using a specified model.",
        epilog="Example: python upscale.py \"C:\\Users\\User\\Desktop\\test.png\" upscayl-lite-4x"
    )
    parser.add_argument(
        "input_file",
        nargs='?', # Make positional argument optional
        help="Path to the input image file."
    )
    parser.add_argument(
        "model_name",
        nargs='?', # Make positional argument optional
        help="The name of the model to use (e.g., 'upscayl-high-fidelity-4x')."
    )
    parser.add_argument(
        '--list-models',
        action='store_true',
        help="List all available models and exit."
    )
    args = parser.parse_args()

    # If --list-models is used, list them and exit.
    if args.list_models:
        list_models()
        sys.exit(0)

    # If arguments are missing, print help and exit.
    if not all([args.input_file, args.model_name]):
        parser.print_help()
        sys.exit(1)

    # --- Path and File Validation ---
    absolute_input_path = Path(args.input_file).resolve()
    if not absolute_input_path.is_file():
        print(f"[FAIL] Error: Input file not found at '{absolute_input_path}'")
        sys.exit(1)
        
    source_model_param = REAL_MODELS_DIR / f"{args.model_name}.param"
    source_model_bin = REAL_MODELS_DIR / f"{args.model_name}.bin"

    if not source_model_param.exists() or not source_model_bin.exists():
        print(f"[FAIL] Error: Model '{args.model_name}' not found in '{REAL_MODELS_DIR}'")
        list_models()
        sys.exit(1)

    # --- Prepare for execution ---
    base_name = absolute_input_path.stem
    absolute_output_path = OUTPUT_DIR / f"{base_name}_{args.model_name}_upscaled.png"

    # Command arguments for the executable (NO -m flag!)
    command = [
        str(EXECUTABLE_PATH),
        "-i", str(absolute_input_path),
        "-o", str(absolute_output_path),
        "-n", args.model_name,
        "-f", "png"
    ]
    
    # --- Main Execution Block ---
    try:
        # 1. Create temporary 'models' directory inside 'bin'
        TEMP_MODELS_DIR.mkdir(exist_ok=True)
        
        # 2. Copy the required model files
        shutil.copy2(source_model_param, TEMP_MODELS_DIR)
        shutil.copy2(source_model_bin, TEMP_MODELS_DIR)

        print("\nProcessing...")
        
        # 3. Run the executable. It will find the models in its local 'models' folder.
        #    The 'cwd' argument ensures the executable runs from its own directory.
        process = subprocess.run(
            command, 
            capture_output=True, 
            text=True, 
            check=True,
            cwd=BIN_DIR # Run from the 'bin' directory
        )
        print(process.stdout) # Print any standard output from the tool
        if process.stderr:
            print(process.stderr) # Print any standard error from the tool

    except subprocess.CalledProcessError as e:
        print("[FAIL] The upscaling process failed.")
        print("--- Error Output ---")
        print(e.stderr) # Print the error output from the failed command
        sys.exit(1)
    except Exception as e:
        print(f"[FAIL] An unexpected Python error occurred: {e}")
        sys.exit(1)
    finally:
        # 4. ALWAYS clean up the temporary directory, even if errors occurred.
        if TEMP_MODELS_DIR.exists():
            print("Cleaning up temporary files...")
            shutil.rmtree(TEMP_MODELS_DIR)

    print(f"[SUCCESS] Done! Saved to '{absolute_output_path}'")

if __name__ == "__main__":
    main()