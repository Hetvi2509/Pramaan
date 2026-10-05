# -*- mode: python ; coding: utf-8 -*-
"""Full Pramaan engine: forensics + motion + OCR + face + object detection + upscaling.

models/ and upscayl-cli/ are NOT bundled: they are copied beside the executable by the desktop
build, because the code already looks there first and it keeps them replaceable.
"""

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs, collect_submodules

HIDDEN = [
    # entry points the backend spawns
    "dvr_scan.__main__", "ocr_worker",
    "dvr_scan.forensics", "dvr_scan.induce", "dvr_scan.fingerprint", "dvr_scan.controller",
    "dvr_scan.ocr_engine", "dvr_scan.oem_common",
    "dvr_scan.dhfs", "dvr_scan.godrej", "dvr_scan.honeywell", "dvr_scan.tplink", "dvr_scan.uniview",
    "dvr_scan.hikvision.helpers", "dvr_scan.hikvision.master_sector", "dvr_scan.hikvision.hikbtree",
    "dvr_scan.hikvision.system_logs", "dvr_scan.hikvision.extractor",
    "pytsk3", "pyewf", "face_recognition", "face_recognition_models", "sklearn.neighbors",
]
HIDDEN += collect_submodules("numpy") + collect_submodules("cv2") + collect_submodules("scenedetect")

DATAS, BINARIES = [], collect_dynamic_libs("numpy") + collect_dynamic_libs("cv2")
# These ship data files and plugins that static analysis misses entirely.
# scipy/sklearn/torch/cv2 contain compiled extension modules that static analysis cannot see.
for pkg in ("scipy", "sklearn", "torch", "torchvision", "paddle", "paddleocr", "paddlex", "rfdetr",
            "supervision", "transformers", "face_recognition_models", "pycocotools", "lightning_utilities"):
    try:
        d, b, h = collect_all(pkg)
        DATAS += d; BINARIES += b; HIDDEN += h
    except Exception:
        pass

EXCLUDE = [
    "tkinter", "pytest", "IPython", "notebook", "jupyter",
    # setuptools ships a vendored jaraco/backports that PyInstaller cannot resolve; nothing here imports it
    "pkg_resources", "setuptools", "jaraco", "backports",
    # chardet 7 is mypyc-compiled and its runtime helper is not collected; requests falls back to
    # charset_normalizer, which is bundled.
    "chardet",
]

# These packages enumerate their own folders on disk at import time (transformers lists models/), which
# fails when their modules live only inside the PYZ archive. Collect them as real .py files instead.
MODULE_MODE = {pkg: "py" for pkg in ("transformers", "paddlex", "paddleocr", "rfdetr")}

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=BINARIES,
    datas=DATAS,
    hiddenimports=HIDDEN,
    hookspath=[],
    runtime_hooks=["rthook_pkgres.py"],
    module_collection_mode=MODULE_MODE,
    excludes=EXCLUDE,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="pramaan-engine",
          debug=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="pramaan-engine")
