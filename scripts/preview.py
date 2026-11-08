#!/usr/bin/env python3
"""Open a non-writing native demo or compose preview.png from its sanitized crop.

The live window is shared with other agents. Reserve a capture slot before --open.
Pillow is needed only for --crop/--compose; it is not a mod runtime dependency.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from install import no_symlink_ancestors, regular_tree

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs/preview-assets"
NAME = "Codewalker-Distribution-Preview"
HOME = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app")).expanduser().absolute()
DESTINATION = HOME / "mods" / NAME
OWNER = ".codewalker-preview"


def app(*args):
    return subprocess.run(["herdr-app", *args], check=True, capture_output=True, text=True).stdout


def fixture(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in regular_tree(ROOT / "mods/Codewalker").items():
        if name.endswith(".py") or name == "mod.json":
            continue
        target = destination / ("view.js" if name == "main.js" else name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if name.endswith(".js"):
            data = data.replace(b"mods/Codewalker/", f"mods/{NAME}/".encode())
        target.write_bytes(data)
    (destination / "main.js").write_bytes((ASSETS / "fixture.js").read_bytes())
    (destination / "mod.json").write_text(json.dumps({
        "place": "none", "title": "Codewalker · synthetic demo",
        "overlay": {"kind": "window", "width": 900, "height": 620, "props": {"launch": False}},
    }) + "\n")


def compose():
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    scale = 2
    size = (1280 * scale, 640 * scale)
    # Blue-to-purple paper, with the requested notebook dot grid. The actual
    # native screenshot stays untinted so its diff colors remain truthful.
    ramp = Image.new("L", (32, 16))
    ramp.putdata([round(255 * (x / 31 + y / 15) / 2) for y in range(16) for x in range(32)])
    image = Image.composite(Image.new("RGB", size, "#302044"), Image.new("RGB", size, "#142440"),
                            ramp.resize(size, Image.Resampling.BILINEAR)).convert("RGBA")
    paper = Image.new("RGBA", size)
    dots = ImageDraw.Draw(paper)
    for y in range(16, 640, 24):
        for x in range(16, 1280, 24):
            mix = (x / 1280 + y / 640) / 2
            color = (round(120 + 50 * mix), round(158 - 20 * mix), 230, 58)
            radius = scale
            dots.ellipse((x * scale - radius, y * scale - radius,
                          x * scale + radius, y * scale + radius), fill=color)
    image = Image.alpha_composite(image, paper)
    draw = ImageDraw.Draw(image)

    def font(size, weight):
        result = ImageFont.truetype(str(ASSETS / "InterVariable.ttf"), size * scale)
        result.set_variation_by_axes([32 if size >= 24 else 14, weight])
        return result

    draw.text((48 * scale, 217 * scale), "Codewalker", font=font(50, 700), fill="#d4e0ff", anchor="lt")
    draw.multiline_text((50 * scale, 295 * scale), "Review code.\nKeep the conversation\non the exact lines.",
                        font=font(25, 400), fill="#c8c9e8", spacing=9 * scale, anchor="la")
    draw.text((50 * scale, 553 * scale), "Native code review for Herdr", font=font(16, 500), fill="#bda9f5", anchor="lt")

    source = Image.open(ASSETS / "review.png").convert("RGB")
    width, height = 800 * scale, round(800 * scale * source.height / source.width)
    if height > 560 * scale:
        raise ValueError("Screenshot crop is too tall: capture the 900×620 native demo")
    shot = source.resize((width, height), Image.Resampling.LANCZOS)
    x, y = 432 * scale, (640 * scale - height) // 2
    shadow = Image.new("RGBA", image.size)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 12 * scale, x + width, y + height + 12 * scale),
                                             radius=12 * scale, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18 * scale))
    image = Image.alpha_composite(image.convert("RGBA"), shadow)
    mask = Image.new("L", shot.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=10 * scale, fill=255)
    image.paste(shot, (x, y), mask)
    image.convert("RGB").save(ROOT / "preview.png", optimize=True)
    print(ROOT / "preview.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--open", action="store_true", help="install and open only the temporary native demo")
    action.add_argument("--check", action="store_true", help="hidden native materialization, no live overlay")
    action.add_argument("--clean", action="store_true", help="remove the owned preview folder after closing its overlay")
    action.add_argument("--crop", type=Path, metavar="WINDOW_SHOT", help="save only the specified sanitized UI rectangle")
    action.add_argument("--compose", action="store_true", help="rebuild preview.png from the kept native screenshot")
    parser.add_argument("--rect", nargs=4, type=int, metavar=("X", "Y", "WIDTH", "HEIGHT"))
    args = parser.parse_args()
    if args.open:
        no_symlink_ancestors(HOME, f"mods/{NAME}")
        if DESTINATION.exists():
            raise SystemExit(f"Preview folder already exists; inspect it before cleanup: {DESTINATION}")
        fixture(DESTINATION)
        (DESTINATION / OWNER).write_text(str(ROOT))
        print(app("check", str(DESTINATION)))
        print(app("do", "mod.open", "--name", NAME))
        print(f"Capture with herdr-app shot. While status lists {NAME}, close it with: herdr-app do mod.open --name {NAME}. Then --clean.")
    elif args.check:
        with tempfile.TemporaryDirectory(prefix="codewalker-preview-check-") as temp:
            target = Path(temp).resolve() / "mod"
            fixture(target)
            print(app("check", str(target)))
    elif args.clean:
        no_symlink_ancestors(HOME, f"mods/{NAME}")
        if not DESTINATION.exists():
            return
        if not (DESTINATION / OWNER).is_file() or (DESTINATION / OWNER).read_text() != str(ROOT):
            raise SystemExit("Refusing to remove an unowned preview folder")
        if NAME in app("status"):
            raise SystemExit("Close the preview overlay before removing its files")
        shutil.rmtree(DESTINATION)
    elif args.crop:
        from PIL import Image
        if not args.rect:
            parser.error("--crop requires --rect X Y WIDTH HEIGHT (pixels, not logical units)")
        with Image.open(args.crop) as image:
            x, y, width, height = args.rect
            if min(x, y) < 0 or min(width, height) <= 0 or x + width > image.width or y + height > image.height:
                parser.error("crop must fit wholly inside the source image")
            image.crop((x, y, x + width, y + height)).convert("RGB").save(ASSETS / "review.png", optimize=True)
        print(ASSETS / "review.png")
    else:
        compose()


if __name__ == "__main__":
    main()
