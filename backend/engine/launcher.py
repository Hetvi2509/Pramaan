"""Frozen entry point. Accepts the same command forms the backend already spawns:
    pramaan-engine -m dvr_scan.forensics parse ...     (startTask)
    pramaan-engine -u ocr_worker.py                    (warm OCR worker)
so backend/src/engine.ts and ocrWorker.ts need no changes.
"""
import multiprocessing
import runpy
import sys
from pathlib import Path


def main():
    args = sys.argv[1:]
    while args and args[0] in ("-u", "-B", "-E"):  # interpreter flags; irrelevant once frozen
        args = args[1:]
    if not args:
        sys.exit("usage: pramaan-engine [-m <module> | <script.py>] [args...]")
    if args[0] == "-m":
        module, rest = args[1], args[2:]
    else:
        # A script path: the frozen build has no .py files, so run the module of the same name.
        module, rest = Path(args[0]).stem, args[1:]
    sys.argv = [module] + rest
    runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
