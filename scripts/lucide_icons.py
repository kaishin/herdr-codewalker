#!/usr/bin/env python3
"""Write Codewalker's icons from a local lucide-react package (ISC).

The package is read as text and never run: each icon module's `__iconNode`
array is parsed with a strict pattern, only known SVG shapes and geometry
attributes are kept, and every value must be plain numbers and path letters.

    python3 -I scripts/lucide_icons.py /path/to/lucide-react
"""
from pathlib import Path
import json
import re
import sys

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / "mods/Codewalker/icons"
# Codewalker name -> Lucide name.
ICONS = {
    "check": "check", "folder": "folder", "git-branch": "git-branch", "message": "message-square",
    "pencil": "pencil", "plus": "plus", "refresh": "refresh-cw", "reply": "reply", "send": "send", "trash": "trash-2", "x": "x",
    "maximize-2": "maximize-2", "minimize-2": "minimize-2",
}
SHAPES = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse"}
GEOMETRY = {"d", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "x1", "y1", "x2", "y2", "points"}
SAFE = re.compile(r"[0-9A-Za-z .,\-]*")
NODE = re.compile(r"const __iconNode = (\[.*?\]);\n", re.S)
ENTRY = re.compile(r'\[\s*"(\w+)",\s*\{(.*?)\}\s*\]', re.S)
ATTR = re.compile(r'(\w+):\s*"([^"]*)"')


def svg(module):
    match = NODE.search(module)
    if not match:
        raise ValueError("no __iconNode array")
    shapes = []
    for tag, body in ENTRY.findall(match.group(1)):
        if tag not in SHAPES:
            raise ValueError(f"unexpected element {tag!r}")
        attrs = [(name, value) for name, value in ATTR.findall(body) if name != "key"]
        for name, value in attrs:
            if name not in GEOMETRY or not SAFE.fullmatch(value):
                raise ValueError(f"unexpected attribute {name}={value!r}")
        shapes.append("<" + tag + "".join(f' {name}="{value}"' for name, value in attrs) + "/>")
    if not shapes:
        raise ValueError("empty icon")
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + "".join(shapes) + "</svg>\n")


def main(package):
    package = Path(package).expanduser().resolve()
    meta = json.loads((package / "package.json").read_text())
    if meta.get("name") != "lucide-react" or meta.get("license") != "ISC":
        raise ValueError("expected the ISC-licensed lucide-react package")
    for name, source in ICONS.items():
        (OUT / f"{name}.svg").write_text(svg((package / "dist/esm/icons" / f"{source}.mjs").read_text()))
    notice = f"Icons in this folder are from Lucide {meta['version']} (https://lucide.dev), unchanged.\n\n"
    (OUT / "LICENSE").write_text(notice + (package / "LICENSE").read_text())
    print(f"Wrote {len(ICONS)} icons from lucide-react {meta['version']}")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except (IndexError, OSError, ValueError) as error:
        print(f"Icons not written: {error}", file=sys.stderr)
        sys.exit(1)
