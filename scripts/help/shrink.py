"""Shrink the guide's screenshots: 256-colour palette PNGs look the same for UI shots at a third of the size.
Usage: python3 scripts/help/shrink.py [files...]   (default: every public/help/*.png)"""
import glob, os, sys
from PIL import Image

files = sys.argv[1:] or glob.glob(os.path.join(os.path.dirname(__file__), "../../public/help/*.png"))
before = after = 0
for f in files:
    im = Image.open(f)
    before += os.path.getsize(f)
    if im.mode != "P":
        im.convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
    after += os.path.getsize(f)
print(f"{len(files)} files: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
