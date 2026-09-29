# ponytail: stub — the real interactive region-editor GUI wasn't present in the
# reference dvr-scan-py copy we ported. Our backend never passes -r/--region-editor
# (there's no desktop GUI here), so this only needs to satisfy the import in scanner.py.
# If interactive region editing is ever needed, port the real widget from upstream DVR-Scan.
class RegionEditor:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError("Interactive region editor is not available in this deployment.")

    def run(self):
        raise NotImplementedError("Interactive region editor is not available in this deployment.")
