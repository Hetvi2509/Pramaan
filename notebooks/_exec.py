import sys
import nbformat
from nbclient import NotebookClient

path = "m7_pipeline.ipynb"
nb = nbformat.read(path, as_version=4)
client = NotebookClient(nb, timeout=1200, kernel_name="python3")

with client.setup_kernel():
    for i, cell in enumerate(nb.cells):
        if cell.cell_type != "code":
            continue
        print(f"[{i}] executing...", flush=True)
        try:
            client.execute_cell(cell, i)
        except Exception as e:
            print(f"[{i}] FAILED: {e}", flush=True)
            with open(path, "w", encoding="utf-8") as f:
                nbformat.write(nb, f)
            sys.exit(1)
        print(f"[{i}] ok", flush=True)
        with open(path, "w", encoding="utf-8") as f:
            nbformat.write(nb, f)

print("ALL CELLS EXECUTED OK", flush=True)
