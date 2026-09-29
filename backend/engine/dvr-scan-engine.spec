# dvr-scan-py/dvr-scan-engine.spec (VERIFIED & HARDENED VERSION)
import sys
sys.setrecursionlimit(sys.getrecursionlimit() * 5)

import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

block_cipher = None
# --- Validate Critical Files ---
print("[Build] Validating required files...")
required_files = {
    'dvr_scan/__main__.py': 'Entry point',
    'dvr-scan.cfg': 'Configuration file',
}

for filepath, description in required_files.items():
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"{description} not found: {filepath}")
    print(f"[Build] ✓ Found {description}: {filepath}")

# --- Prepare Data Files ---
datas_list = []

# Add required config file
datas_list.append(('dvr-scan.cfg', '.'))

# Conditionally add optional files
if os.path.exists('dvr_scan/dvr-scan.ico'):
    datas_list.append(('dvr_scan/dvr-scan.ico', 'dvr_scan'))
    print("[Build] ✓ Found icon file")
else:
    print("[Build] ⚠ Icon file not found (dvr_scan/dvr-scan.ico)")

if os.path.exists('models/ocr'):
    datas_list.append(('models/ocr', 'models/ocr'))
    print("[Build] ✓ Found OCR models directory")
else:
    print("[Build] ⚠ OCR models directory not found (models/ocr)")

if os.path.exists('models/upscayl'):
    datas_list.append(('models/upscayl', 'models/upscayl'))
    print("[Build] ✓ Found upscayl models directory")
else:
    print("[Build] ⚠ Upscayl models directory not found (models/upscayl)")

if os.path.exists('upscayl-cli'):
    datas_list.append(('upscayl-cli', 'upscayl-cli'))
    print("[Build] ✓ Found upscayl-cli directory")
else:
    print("[Build] ⚠ Upscayl-cli directory not found (upscayl-cli)")

# Collect data from installed packages
print("[Build] Collecting package data files...")
datas_list.extend(collect_data_files('paddlex'))
datas_list.extend(collect_data_files('paddleocr'))
datas_list.extend(collect_data_files('Cython'))
datas_list.extend(collect_data_files('face_recognition_models'))
datas_list.extend(collect_data_files('rfdetr'))  # RF-DETR config files

# --- Collect Dynamic Libraries ---
print("[Build] Collecting dynamic libraries...")
binaries_list = []
binaries_list.extend(collect_dynamic_libs('torch'))
binaries_list.extend(collect_dynamic_libs('paddle'))

# --- Main Analysis Block ---
a = Analysis(
    ['dvr_scan/__main__.py'],
    pathex=['.'],
    binaries=binaries_list,
    datas=datas_list,
    hiddenimports=[
        # Python 3.13 stdlib fixes
        'glob',
        'fnmatch',
        're',
        'posixpath',
        # Core dependencies
        'pkg_resources', 
        'jaraco.text',
        'dvr_scan', 
        'cv2', 
        'PIL._imaging',
        # DVR-Scan core
        'scenedetect',
        'scenedetect.video_stream',
        'scenedetect.frame_timecode',
        'scenedetect.platform',
        'scenedetect.backends',
        # Paddle ecosystem
        'paddle', 
        'paddlex', 
        'paddleocr', 
        'pyclipper',
        # Scientific/ML libraries
        'shapely', 
        'shapely.geometry', 
        'sklearn.utils._cython_blas',
        'torch',
        # Object detection dependencies
        'matplotlib',
        'matplotlib.pyplot',
        'supervision',
        'rfdetr',
        'rfdetr.detr',
        'rfdetr.main',
        'rfdetr.util',
        'peft',
        'peft.auto',
        'transformers',
    ] + collect_submodules('dvr_scan') + collect_submodules('scenedetect'),
    hookspath=[],
    runtime_hooks=['pyi_rth_paddlex.py'],
    excludes=[
        # Exclude unnecessary packages
        'tkinter', 
        'pytest', 
        'IPython', 
        'jupyter',
        'PyQt5', 
        'PySide2', 
        'PySide6',
        'notebook',
        'tensorflow', 
        'keras',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='dvr-scan-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    icon='dvr_scan/dvr-scan.ico' if os.path.exists('dvr_scan/dvr-scan.ico') else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='dvr-scan-engine'
)

print("[Build] Specification file processed successfully!")