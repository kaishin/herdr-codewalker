#!/usr/bin/env python3
"""Plan/install the Codewalker Review mod without editing shipped files or user settings."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROJECT = Path(__file__).resolve().parents[1]
GENERATED = {"gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json", ".DS_Store"}
OWNER = "herdr-codewalker-local-v1"
MOD = "mods/Codewalker"
# Earlier versions installed the mod as mods/codewalker, plus a tab-bar copy and
# a layout. A new install removes them when the receipt shows they are unchanged.
LEGACY_DIRS = ("mods/codewalker", "mods/codewalker-tabs")
LEGACY_LAYOUT = "layouts/codewalker.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def regular_tree(folder):
    result = {}
    for path in sorted(folder.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Refusing source symlink: {path}")
        if path.is_file() and path.name not in GENERATED and "__pycache__" not in path.parts:
            result[path.relative_to(folder).as_posix()] = path.read_bytes()
    return result


def prepare():
    """The Review mod with its packaged Python backend. Nothing else."""
    runtime = regular_tree(PROJECT / MOD)
    return {f"{MOD}/{name}": data for name, data in runtime.items()}


def no_symlink_ancestors(root, relative):
    path = root
    for ancestor in (root, *root.parents):
        if ancestor.is_symlink():
            raise ValueError(f"Refusing a symlinked destination ancestor: {ancestor}; use its explicit canonical path")
    for part in Path(relative).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Refusing to replace a symlink: {path}")


def validate_targets(root, files):
    manifest_path = root / "codewalker-install.json"
    no_symlink_ancestors(root, "codewalker-install.json")
    previous = None
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if not isinstance(previous, dict) or previous.get("owner") != OWNER:
            raise ValueError(f"Unrecognized install receipt: {manifest_path}")
    owned = previous.get("files", {}) if previous else {}
    if not isinstance(owned, dict):
        raise ValueError("Install receipt files must be an object")
    # A receipt is untrusted input. Validate scope BEFORE reading or deleting any named path.
    for name, checksum in owned.items():
        parts = Path(name).parts
        permitted = name == LEGACY_LAYOUT or any(name.startswith(folder + "/") for folder in (MOD, *LEGACY_DIRS))
        if str(Path(name)) != name or Path(name).is_absolute() or ".." in parts or "." in parts or not permitted or not isinstance(checksum, str) or len(checksum) != 64 or any(char not in "0123456789abcdef" for char in checksum):
            raise ValueError(f"Unsafe install receipt entry: {name}")
    # Compare names without case: on a case-insensitive disk (macOS) mods/codewalker
    # and mods/Codewalker are one folder.
    known = {key.lower(): checksum for key, checksum in owned.items()}
    for name in (MOD, *LEGACY_DIRS, LEGACY_LAYOUT):
        no_symlink_ancestors(root, name)
        target = root / name
        if target.exists() and not any(key == name.lower() or key.startswith(name.lower() + "/") for key in known):
            raise ValueError(f"Name collision; no Codewalker ownership receipt: {target}")
    for name in set(files) | set(owned):
        no_symlink_ancestors(root, name)
        path = root / name
        if path.exists() and (name.lower() not in known or digest(path.read_bytes()) != known[name.lower()]):
            raise ValueError(f"Local edit or unowned file; left untouched: {path}")
    # Refuse to overwrite a directory with extra human-managed files, even if target names match.
    for name in (MOD, *LEGACY_DIRS):
        if (root / name).exists():
            for relative in regular_tree(root / name):
                if f"{name}/{relative}".lower() not in known:
                    raise ValueError(f"Unowned file in destination: {root / name / relative}")
    return owned


def install(root, files):
    owned = validate_targets(root, files)
    root.mkdir(parents=True, exist_ok=True)
    # Preflight is complete before any write. Atomic replacement is per file, not a multi-file transaction.
    # Remove old files first: on a case-insensitive disk an old name can be a new file.
    for name in set(owned) - set(files):
        (root / name).unlink(missing_ok=True)
    # A legacy folder left with only files Herdr generates (and empty folders) goes too.
    for name in LEGACY_DIRS:
        folder = root / name
        if not folder.is_dir() or folder.is_symlink():
            continue
        entries = sorted(folder.rglob("*"), key=lambda path: len(path.parts), reverse=True)
        if any(path.is_symlink() or (path.is_file() and path.name not in GENERATED) for path in entries):
            continue
        for path in entries:
            path.unlink() if path.is_file() else path.rmdir()
        folder.rmdir()
    for name, data in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() == data:
            continue
        fd, temp = tempfile.mkstemp(prefix=".codewalker-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.replace(temp, target)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    receipt = {"owner": OWNER, "files": {name: digest(data) for name, data in files.items()}}
    (root / "codewalker-install.json").write_bytes(json_bytes(receipt))


def active_layout(home):
    """The running app's layout for this home, or None when it can't tell."""
    try:
        done = subprocess.run(["herdr-app", "status"], env={**os.environ, "HERDR_APP_HOME": str(home)},
                              capture_output=True, text=True, timeout=10)
        return json.loads(done.stdout).get("layout")
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app")))
    parser.add_argument("--prepare", type=Path, help="write a project/scratch package, not the live home")
    parser.add_argument("--apply", action="store_true", help="install into --home")
    parser.add_argument("--check", action="store_true", help="execute native mod initial-render checks after writing")
    args = parser.parse_args(argv)
    if args.prepare and args.apply:
        parser.error("choose --prepare or --apply")
    if args.check and not (args.prepare or args.apply):
        parser.error("--check requires an explicit write destination")
    home = args.home.expanduser().absolute()
    files = prepare()
    destination = args.prepare.expanduser().absolute() if args.prepare else home
    owned = validate_targets(destination, files)
    removed = sorted(set(owned) - set(files))
    if args.apply and LEGACY_LAYOUT in removed and active_layout(home) == "codewalker":
        raise ValueError("The codewalker layout is active; switch to another layout first (herdr-app do layout.switch --name main)")
    summary = {"mode": "prepare" if args.prepare else "apply" if args.apply else "plan", "destination": str(destination),
               "files": sorted(files), "removes": removed,
               "untouched": ["settings.json", "keys.json", "shipped mods", "shipped layouts", "layouts/.state", "review database"]}
    if args.prepare or args.apply:
        install(destination, files)
        if args.check:
            subprocess.run(["herdr-app", "check", str(destination / MOD)], check=True)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Codewalker install refused: {error}", file=sys.stderr)
        sys.exit(1)
