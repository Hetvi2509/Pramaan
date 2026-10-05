"""Builds desktop/assets/icon.ico (and icon.png) from the app's own logo, pramaan_logo.jpeg.

The app shows the logo in a rounded square (frontend/src/components/pramaan/logo.tsx: size-8, radius 10px),
so the icon uses the same shape. Run with the engine's Python, which already has Pillow:
    backend/engine/.venv/Scripts/python.exe desktop/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
source = root / "pramaan_logo.jpeg"
out = Path(__file__).resolve().parent / "assets"
out.mkdir(exist_ok=True)

RADIUS = 10 / 32  # the app's corner radius as a fraction of the logo's side
SIZES = (16, 24, 32, 48, 64, 128, 256)


def rounded(size):
    image = Image.open(source).convert("RGB").resize((size, size), Image.LANCZOS)
    scale = 4  # draw the mask larger, then shrink, so the corners are smooth
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=int(size * scale * RADIUS), fill=255)
    image = image.convert("RGBA")
    image.putalpha(mask.resize((size, size), Image.LANCZOS))
    return image


rounded(512).save(out / "icon.png")
# Pillow writes every requested size into one .ico when given the largest frame and the size list.
rounded(256).save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in SIZES])
print("wrote", out / "icon.ico", "and", out / "icon.png")
