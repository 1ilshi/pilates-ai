#!/usr/bin/env python3
"""Rebuild the 1024x1024 master app icon from the measured geometry.

The shipped `icons/icon.png` is a 512px flat raster. Tauri needs a 1024px
master to generate the full set (including `icon.icns` for macOS). Rather than
upscaling the raster, this redraws the same artwork at 4x supersampling so the
generated 16-512px icons stay crisp.

Geometry was measured from `icons/icon.png` on a 512px basis:
  rounded square  (0,0)-(511,511), corner radius 102
  five bars, width 45, left edges at x = 94, 164, 234, 304, 374
  bar heights     79, 144, 233, 154, 93   (vertically centred on y = 256)

Usage:
    python tools/make_app_icon.py            # writes assets/app-icon.png
    python tools/make_app_icon.py --out X    # custom destination
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "assets" / "app-icon.png"

MASTER = 1024
SUPERSAMPLE = 4

BACKGROUND = (11, 18, 32, 255)          # #0B1220
BAR_COLORS = [
    (45, 200, 222, 255),                # #2DC8DE
    (94, 234, 212, 255),                # #5EEAD4
    (45, 212, 191, 255),                # #2DD4BF
    (94, 234, 212, 255),                # #5EEAD4
    (45, 200, 222, 255),                # #2DC8DE
]

# 512px-basis geometry
BASE = 512.0
CORNER_RADIUS = 102.0
BAR_WIDTH = 45.0
BAR_LEFT = [94.0, 164.0, 234.0, 304.0, 374.0]
BAR_HEIGHT = [79.0, 144.0, 233.0, 154.0, 93.0]
CENTER_Y = 256.0


def draw_master() -> Image.Image:
    scale = (MASTER * SUPERSAMPLE) / BASE
    size = MASTER * SUPERSAMPLE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = CORNER_RADIUS * scale
    draw.rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=radius, fill=BACKGROUND
    )

    for left, height, color in zip(BAR_LEFT, BAR_HEIGHT, BAR_COLORS):
        x0 = left * scale
        x1 = (left + BAR_WIDTH) * scale
        y0 = (CENTER_Y - height / 2) * scale
        y1 = (CENTER_Y + height / 2) * scale
        draw.rounded_rectangle(
            [(x0, y0), (x1, y1)],
            radius=(BAR_WIDTH * scale) / 2,
            fill=color,
        )

    return image.resize((MASTER, MASTER), Image.LANCZOS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the master app icon")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output PNG path")
    args = parser.parse_args()

    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)

    icon = draw_master()
    icon.save(destination, "PNG")
    print(f"wrote {destination} ({icon.width}x{icon.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
