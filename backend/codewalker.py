#!/usr/bin/env python3
"""Read-only Git review and transactional, local human/agent annotations."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import uuid

VERSION = 1
# Store schema; 2 adds messages.reply_requested, 3 adds messages.edited_at and
# message_edits (earlier bodies), 4 adds deliveries (what was sent to an agent).
# Older stores migrate in place.
STORE_VERSION = 4
DELIVERY_STATES = ("uncertain", "sent")
MAX_FILE_BYTES = 2_000_000
MAX_LINES = 50_000
MAX_FILES = 1_000
MAX_TOTAL_BYTES = 32_000_000
MAX_OUTPUT = 7_000_000
MAX_BODY_BYTES = 65_536


class Failure(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def fail(code, message, **details):
    raise Failure(code, message, **details)


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    raw = value if isinstance(value, bytes) else canonical_json(value).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")


def identifier(prefix):
    return prefix + "_" + uuid.uuid4().hex


def source_lines(raw):
    """Git counts LF-delimited lines, not Unicode separators or lone CRs."""
    if not raw:
        return []
    lines = raw.decode("utf-8").split("\n")
    return lines[:-1] if lines[-1] == "" else lines


def text(value, field, maximum=256, blank=False):
    if not isinstance(value, str) or (not blank and not value.strip()):
        fail("invalid_request", f"{field} must be a nonempty string")
    if len(value.encode("utf-8")) > maximum or "\x00" in value:
        fail("invalid_request", f"{field} is too long or contains NUL")
    return value


def positive(value, field, minimum=1):
    if type(value) is not int or value < minimum:
        fail("invalid_request", f"{field} must be an integer >= {minimum}")
    return value


def relative_path(value):
    value = text(value, "path", 4096)
    parts = PurePosixPath(value).parts
    if (value.startswith("/") or "\\" in value or re.match(r"^[A-Za-z]:", value)
            or any(p in ("..", ".git") for p in parts)
            or not parts or str(PurePosixPath(value)) != value or value == "."):
        fail("invalid_request", "path must be a normalized relative worktree file", path=value)
    return value


def actor_data(value):
    if not isinstance(value, dict) or set(value) != {"kind", "id", "name"}:
        fail("invalid_request", "actor requires kind, id and name")
    if value["kind"] not in ("human", "agent"):
        fail("invalid_request", "actor.kind must be human or agent")
    return {"kind": value["kind"], "id": text(value["id"], "actor.id", 128),
            "name": text(value["name"], "actor.name", 128)}


class Git:
    PREFIX = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false",
              "-c", "diff.autoRefreshIndex=false", "-c", "core.hooksPath=/dev/null",
              "-c", "diff.suppressBlankEmpty=false", "-c", "diff.interHunkContext=0",
              "-c", "diff.outputIndicatorNew=+", "-c", "diff.outputIndicatorOld=-",
              "-c", "diff.outputIndicatorContext= "]
    DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative",
            "--find-renames", "--ignore-submodules=dirty", "--submodule=short"]

    def __init__(self, folder):
        if not folder or not Path(folder).is_absolute():
            fail("invalid_request", "--repo must be an explicit absolute folder")
        path = Path(folder).resolve()
        if not path.is_dir():
            fail("not_repository", "repository folder does not exist")
        self.root = path
        self.reader = None
        self.prefix = list(self.PREFIX)
        out = self.run(["rev-parse", "--show-toplevel"], check=False)
        if out.returncode:
            fail("not_repository", "folder is not inside a Git worktree")
        self.root = Path(os.fsdecode(out.stdout).removesuffix("\n")).resolve()
        self.git_dir = os.fsdecode(self.run(["rev-parse", "--absolute-git-dir"]).stdout).removesuffix("\n")
        # Git diff can invoke clean/filter-process drivers even with no-textconv.
        # Disable every configured driver before any command reads worktree content.
        filters = self.run(["config", "--null", "--name-only", "--get-regexp",
                            r"^filter\..*\.(clean|process|required)$"], check=False)
        for key in filters.stdout.split(b"\0"):
            if key:
                driver = os.fsdecode(key).rsplit(".", 1)[0]
                for setting, value in (("clean", ""), ("process", ""), ("required", "false")):
                    self.prefix.extend(["-c", f"{driver}.{setting}={value}"])
        self.branch = self.line(["symbolic-ref", "--quiet", "--short", "HEAD"], optional=True)
        self.head = self.line(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], optional=True)
        self.review_id = "review_" + digest([str(self.root), self.git_dir,
                                            self.branch or "detached:" + str(self.head)])[:32]

    @staticmethod
    def environment():
        # A caller's GIT_DIR/INDEX_FILE/config-injection environment must not redirect the repo.
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
        return env

    def run(self, args, check=True):
        env = self.environment()
        try:
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                process = subprocess.run(self.prefix + args, cwd=self.root, env=env,
                                         stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=20)
                if stdout.tell() > MAX_OUTPUT:
                    fail("too_large", "Git output exceeds review limit")
                stdout.seek(0)
                stderr.seek(0)
                result = subprocess.CompletedProcess(process.args, process.returncode,
                                                     stdout.read(MAX_OUTPUT + 1), stderr.read(4096))
        except (OSError, subprocess.TimeoutExpired) as exc:
            fail("git_error", f"Git unavailable or timed out: {exc}")
        if len(result.stdout) > MAX_OUTPUT:
            fail("too_large", "Git output exceeds review limit")
        if check and result.returncode:
            fail("git_error", result.stderr.decode("utf-8", "replace").strip()[:1000] or "Git failed")
        return result

    def line(self, args, optional=False):
        result = self.run(args, check=not optional)
        if result.returncode:
            return None
        return result.stdout.decode("utf-8", "replace").strip() or None

    def endpoints(self, scope, base):
        if scope not in ("uncommitted", "branch"):
            fail("invalid_request", "scope must be uncommitted or branch")
        if scope == "uncommitted":
            if self.head:
                return "HEAD", self.head
            # Do not assume SHA-1; compute the empty tree identity without writing an object.
            empty = self.line(["hash-object", "-t", "tree", "--stdin"])
            return "HEAD", empty
        if not self.head:
            fail("invalid_base", "branch scope requires a HEAD commit")
        candidates = [base] if base else [self.line(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], optional=True), "main", "master"]
        for candidate in candidates:
            if not candidate:
                continue
            text(candidate, "base", 1024)
            if candidate.startswith("-"):
                fail("invalid_base", "base must be a Git revision, not an option")
            oid = self.line(["rev-parse", "--verify", "--quiet", "--end-of-options", candidate + "^{commit}"], optional=True)
            if oid:
                merge_base = self.line(["merge-base", oid, self.head], optional=True)
                if merge_base:
                    return candidate, merge_base
        fail("invalid_base", "base does not resolve to a commit with a common ancestor", base=base)

    def changes(self, base_oid):
        tokens = self.run(self.DIFF + ["--raw", "-z", "--no-abbrev", base_oid, "--"]).stdout.split(b"\0")
        entries = []
        i = 0
        statuses = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed",
                    "C": "copied", "T": "typechanged", "U": "typechanged"}
        while i < len(tokens) and tokens[i]:
            header = tokens[i].decode("ascii").split()
            i += 1
            if len(header) != 5 or not header[0].startswith(":") or i >= len(tokens):
                fail("git_error", "invalid Git raw change record")
            mode_old, mode_new, old_oid, _, status_code = header
            first = os.fsdecode(tokens[i])
            i += 1
            old_path = None
            if status_code[0] in ("R", "C"):
                old_path, first = first, os.fsdecode(tokens[i])
                i += 1
            entries.append({"path": first, "oldPath": old_path,
                            "status": statuses.get(status_code[0], "typechanged"),
                            "oldMode": mode_old[1:], "newMode": mode_new, "oldOid": old_oid})
        untracked = self.run(["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split(b"\0")
        known = {e["path"] for e in entries}
        for path in untracked:
            if path and os.fsdecode(path) not in known:
                entries.append({"path": os.fsdecode(path), "oldPath": None, "status": "untracked",
                                "oldMode": "000000", "newMode": "100644", "oldOid": ""})
        if len(entries) > MAX_FILES:
            fail("too_large", f"review exceeds {MAX_FILES} changed files")
        counts = self.run(self.DIFF + ["--numstat", "-z", base_oid, "--"]).stdout.split(b"\0")
        by_path = {}
        i = 0
        while i < len(counts) and counts[i]:
            fields = counts[i].split(b"\t", 2)
            i += 1
            if len(fields) != 3:
                fail("git_error", "invalid Git numstat record")
            add, delete, path = fields
            if not path:
                i += 1  # rename source
                path = counts[i]
                i += 1
            binary = add == b"-" or delete == b"-"
            by_path[os.fsdecode(path)] = (0 if binary else int(add), 0 if binary else int(delete), binary)
        for entry in entries:
            add, delete, binary = by_path.get(entry["path"], (0, 0, False))
            entry.update(additions=add, deletions=delete, binary=binary, tooLarge=False)
        # --raw can report racy cached-stat dirtiness even when numstat finds no
        # content change. Keep real mode changes/renames, not phantom M rows.
        entries = [entry for entry in entries if not (
            entry["status"] == "modified" and entry["oldMode"] == entry["newMode"]
            and entry["path"] not in by_path)]
        return sorted(entries, key=lambda e: e["path"])

    def blob(self, oid):
        # One streaming cat-file process per helper call, not two processes per
        # changed file. Objects are still read one at a time, so peak memory and
        # the aggregate budget are unchanged.
        if self.reader is None:
            self.reader = BlobReader(self)
        return self.reader.read(oid)

    def close(self):
        if self.reader is not None:
            self.reader.close()
            self.reader = None

    def disk(self, path):
        """Read only regular files, opening each directory without following symlinks."""
        relative_path(path)
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            components = PurePosixPath(path).parts
            for component in components[:-1]:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            child = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                info = os.fstat(child)
                if not stat.S_ISREG(info.st_mode):
                    return None, ["special", info.st_mode]
                if info.st_size > MAX_FILE_BYTES:
                    return None, ["large", info.st_size, info.st_mtime_ns, info.st_ino]
                with os.fdopen(child, "rb", closefd=False) as stream:
                    raw = stream.read(MAX_FILE_BYTES + 1)
                if len(raw) > MAX_FILE_BYTES:
                    return None, ["large", len(raw), info.st_mtime_ns, info.st_ino]
                return raw, digest(raw)
            finally:
                os.close(child)
        except OSError as exc:
            # A symlink, missing parent, or special file is metadata, never an external read.
            return None, ["unreadable", exc.errno]
        finally:
            os.close(fd)

    def snapshot(self, scope="uncommitted", base=None, selected=None, select_first=False):
        try:
            return self._snapshot(scope, base, selected, select_first)
        finally:
            self.close()

    def _snapshot(self, scope, base, selected, select_first):
        base_ref, base_oid = self.endpoints(scope, base)
        entries = self.changes(base_oid)
        contents = {}
        consumed = 0
        no_op_paths = set()
        for entry in entries:
            path = entry["path"]
            try:
                relative_path(path)
                if entry["oldPath"]:
                    relative_path(entry["oldPath"])
            except Failure:
                entry.update(binary=True, unsupported=True)
                contents[path] = (None, None, None, None)
                continue
            old = b""
            if entry["oldMode"] != "000000":
                if entry["oldMode"] not in ("100644", "100755"):
                    old = None
                else:
                    old = self.blob(entry["oldOid"])
            if entry["status"] == "deleted":
                new, new_mark = b"", digest(b"")
            else:
                new, new_mark = self.disk(path)
            old_mark = digest(old) if old is not None else entry["oldOid"]
            # Confirm no-op evidence before releasing any over-budget buffers.
            if (entry["status"] == "modified" and entry["oldMode"] == entry["newMode"]
                    and old is not None and old == new):
                no_op_paths.add(path)
                continue
            consumed += len(old or b"") + len(new or b"")
            too_large = (old is None and entry["oldMode"] in ("100644", "100755")) or (
                new is None and isinstance(new_mark, list) and new_mark[0] == "large")
            aggregate_limit = consumed > MAX_TOTAL_BYTES
            if aggregate_limit:
                too_large = True
                entry["aggregateLimit"] = True
            binary = entry["binary"] or any(b"\0" in raw for raw in (old, new) if raw is not None)
            unsupported = (old is None and not too_large) or (new is None and not too_large)
            # Invalid UTF-8 is not safe to anchor after lossy decoding.
            if not binary and not too_large and not unsupported:
                try:
                    old_text, new_text = old.decode("utf-8"), new.decode("utf-8")
                except UnicodeDecodeError:
                    binary = True
                else:
                    if max(len(source_lines(old)), len(source_lines(new))) > MAX_LINES:
                        too_large = True
            entry.update(binary=binary, tooLarge=bool(too_large))
            if unsupported:
                entry["unsupported"] = True
            if entry["status"] == "untracked" and new is not None:
                entry["additions"] = len(new.split(b"\n")) - int(new.endswith(b"\n")) if not binary and new else 0
            if aggregate_limit:
                # Retain stable fingerprints/metadata, not every hydrated body.
                # Peak hydration is the budget plus one bounded file pair.
                old = new = None
            contents[path] = (old, new, old_mark, new_mark)
        entries = [entry for entry in entries if entry["path"] not in no_op_paths]
        snapshot_id = "snapshot_" + digest([scope, base_oid, self.head, [
            [e["path"], e["oldPath"], e["status"], e["oldMode"], e["newMode"],
             contents[e["path"]][2], contents[e["path"]][3]] for e in entries]])
        result = {"scope": scope, "baseRef": base_ref, "baseOid": base_oid,
                  "headOid": self.head, "snapshotId": snapshot_id, "files": entries,
                  "file": None,
                  "warnings": ([f"Aggregate text budget ({MAX_TOTAL_BYTES:,} bytes) reached; remaining changes are metadata-only and existing discussion evidence is retained."]
                               if any(e.get("aggregateLimit") for e in entries) else [])}
        if selected is None and select_first and entries:
            # One call opens a review: the list plus the first changed file's hunks.
            selected = entries[0]["path"]
        if selected is not None:
            relative_path(selected)
            entry = next((e for e in entries if e["path"] == selected), None)
            if entry is None:
                fail("not_found", "file is not in the selected diff", path=selected)
            result["file"] = self.file_diff(entry, base_oid, contents[selected], snapshot_id)
        return result, contents

    def file_diff(self, entry, base_oid, content, snapshot_id):
        result = {"path": entry["path"], "binary": entry["binary"],
                  "tooLarge": entry["tooLarge"], "unsupported": entry.get("unsupported", False), "hunks": []}
        if result["binary"] or result["tooLarge"] or result["unsupported"]:
            return result
        old, new, _, _ = content
        if entry["status"] == "untracked":
            lines = source_lines(new)
            if lines:
                result["hunks"] = [{"id": "hunk_" + digest([snapshot_id, entry["path"], 0])[:24],
                                    "oldStart": 0, "oldLines": 0, "newStart": 1, "newLines": len(lines),
                                    "rows": [{"kind": "add", "oldLine": None, "newLine": i + 1, "text": line}
                                             for i, line in enumerate(lines)]}]
            return result
        paths = ([entry["oldPath"]] if entry["oldPath"] else []) + [entry["path"]]
        # Literal pathspecs prevent filenames containing [], *, ? from matching other files.
        raw = self.run(["--literal-pathspecs"] + self.DIFF + ["--unified=3", base_oid, "--"] + paths).stdout
        hunk = None
        old_line = new_line = 0
        for line in raw.decode("utf-8", "replace").split("\n"):
            match = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            if match:
                old_line, old_count, new_line, new_count = match.groups()
                old_line, new_line = int(old_line), int(new_line)
                hunk = {"id": "hunk_" + digest([snapshot_id, entry["path"], len(result["hunks"])])[:24],
                        "oldStart": old_line, "oldLines": int(old_count or 1),
                        "newStart": new_line, "newLines": int(new_count or 1), "rows": []}
                result["hunks"].append(hunk)
            elif line.startswith("diff --git "):
                hunk = None
            elif hunk is not None and line[:1] in (" ", "+", "-"):
                kind = {" ": "context", "+": "add", "-": "delete"}[line[0]]
                hunk["rows"].append({"kind": kind, "oldLine": old_line if kind != "add" else None,
                                      "newLine": new_line if kind != "delete" else None, "text": line[1:]})
                old_line += kind != "add"
                new_line += kind != "delete"
            elif hunk is not None and line.startswith("\\"):
                hunk["rows"].append({"kind": "meta", "oldLine": None, "newLine": None, "text": line})
        return result


class BlobReader:
    """Interactive `git cat-file --batch-command`: size first, contents only when bounded."""

    TIMEOUT = 20

    def __init__(self, git):
        try:
            self.process = subprocess.Popen(git.prefix + ["cat-file", "--batch-command"], cwd=git.root,
                                            env=git.environment(), stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as exc:
            fail("git_error", f"Git unavailable: {exc}")
        # Same bound as other Git calls: a stuck process is killed, and the blocked read sees EOF.
        self.watchdog = threading.Timer(self.TIMEOUT, self.process.kill)
        self.watchdog.daemon = True
        self.watchdog.start()

    def command(self, verb, oid):
        if not re.fullmatch(r"[0-9a-f]{40,64}", oid or ""):
            fail("git_error", "invalid Git object id")
        try:
            self.process.stdin.write(f"{verb} {oid}\n".encode("ascii"))
            self.process.stdin.flush()
        except OSError:
            fail("git_error", "Git object reader stopped or timed out")
        header = self.process.stdout.readline().split()
        if len(header) != 3 or header[0].decode("ascii", "replace") != oid or header[1] != b"blob":
            fail("git_error", "Git object is missing or not a file blob")
        return int(header[2])

    def read(self, oid):
        if self.command("info", oid) > MAX_FILE_BYTES:
            return None
        size = self.command("contents", oid)
        raw = self.process.stdout.read(size + 1)
        if len(raw) != size + 1 or raw[-1:] != b"\n":
            fail("git_error", "Git object reader stopped or timed out")
        return raw[:-1]

    def close(self):
        self.watchdog.cancel()
        try:
            self.process.stdin.close()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait()
        finally:
            self.process.stdout.close()


def default_store():
    if sys.platform == "darwin":
        home = Path.home() / "Library" / "Application Support"
    else:
        home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return home / "herdr-codewalker" / "reviews.sqlite3"


class Store:
    def __init__(self, git, path=None):
        self.git = git
        self.path = Path(path or default_store()).expanduser().resolve()
        if self.path == git.root or git.root in self.path.parents:
            fail("invalid_request", "review database must live outside the worktree")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=15, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if stat.S_IMODE(os.stat(self.path).st_mode) != 0o600:
            os.chmod(self.path, 0o600)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=15000")
        self.db.execute("PRAGMA synchronous=FULL")
        # Reads must not write: an initialized store with this review needs no
        # write lock or fsync, and an unchanged file does not wake store watchers.
        try:
            if (self.db.execute("PRAGMA user_version").fetchone()[0] == STORE_VERSION
                    and self.db.execute("SELECT 1 FROM reviews WHERE id=?", (git.review_id,)).fetchone()):
                return
        except sqlite3.OperationalError:
            pass  # Missing tables: initialize below under the write lock.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3, STORE_VERSION):
                fail("storage_error", "unsupported review database version", version=version)
            # Additive: existing messages keep their text, get no request and are not edited.
            if version == 1:
                self.db.execute("ALTER TABLE messages ADD COLUMN reply_requested INTEGER NOT NULL DEFAULT 0")
            if version in (1, 2):
                self.db.execute("ALTER TABLE messages ADD COLUMN edited_at TEXT")
            for sql in [
                "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, root TEXT NOT NULL, git_dir TEXT NOT NULL, branch TEXT, revision INTEGER NOT NULL DEFAULT 0)",
                "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), status TEXT NOT NULL, anchor TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id), actor TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, reply_requested INTEGER NOT NULL DEFAULT 0, edited_at TEXT)",
                # An edit keeps the body it replaced.
                "CREATE TABLE IF NOT EXISTS message_edits (message_id TEXT NOT NULL REFERENCES messages(id), body TEXT NOT NULL, replaced_at TEXT NOT NULL)",
                # "uncertain" is written before a send, "sent" after it lands.
                "CREATE TABLE IF NOT EXISTS deliveries (message_id TEXT PRIMARY KEY REFERENCES messages(id), state TEXT NOT NULL, target TEXT NOT NULL, updated_at TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS drafts (review_id TEXT NOT NULL REFERENCES reviews(id), id TEXT NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL, target TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(review_id,id))",
                "CREATE TABLE IF NOT EXISTS commands (review_id TEXT NOT NULL REFERENCES reviews(id), id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(review_id,id))",
                "CREATE INDEX IF NOT EXISTS threads_review ON threads(review_id)",
                "CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id,sequence)",
            ]:
                self.db.execute(sql)
            self.db.execute(f"PRAGMA user_version={STORE_VERSION}")
            self.db.execute("INSERT OR IGNORE INTO reviews(id,root,git_dir,branch) VALUES(?,?,?,?)",
                            (git.review_id, str(git.root), git.git_dir, git.branch))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def revision(self):
        return self.db.execute("SELECT revision FROM reviews WHERE id=?", (self.git.review_id,)).fetchone()[0]

    def context(self):
        return {"repoRoot": str(self.git.root), "gitDir": self.git.git_dir, "branch": self.git.branch,
                "headOid": self.git.head, "reviewId": self.git.review_id, "revision": self.revision(),
                "storePath": str(self.path)}

    def thread(self, thread_id, source=None, contents=None):
        row = self.db.execute("SELECT * FROM threads WHERE id=? AND review_id=?", (thread_id, self.git.review_id)).fetchone()
        if row is None:
            fail("not_found", "thread not found", threadId=thread_id)
        anchor = json.loads(row["anchor"])
        current = False
        if source is not None:
            entry = next((e for e in source["files"] if e["path"] == anchor["path"]), None)
            if (entry and source["scope"] == anchor["scope"] and source["baseOid"] == anchor["baseOid"]
                    and contents and anchor["path"] in contents):
                raw = contents[anchor["path"]][0 if anchor["side"] == "old" else 1]
                current = (raw is not None and digest(raw) == anchor["fingerprint"]
                           and digest(contents[anchor["path"]][2:]) == anchor.get("fileFingerprint")
                           and entry["oldPath"] == anchor.get("oldPath"))
        anchor["validity"] = "current" if current else "stale"
        messages = [{"id": msg["id"], "actor": json.loads(msg["actor"]), "body": msg["body"], "createdAt": msg["created_at"],
                     "replyRequested": bool(msg["reply_requested"]), "editedAt": msg["edited_at"],
                     "delivery": {"state": msg["state"], "target": msg["target"], "at": msg["updated_at"]} if msg["state"] else None}
                    for msg in self.db.execute("SELECT m.*, d.state, d.target, d.updated_at FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id "
                                               "WHERE m.thread_id=? ORDER BY m.sequence", (thread_id,))]
        # A short reply is owed while the newest message asks for one and the thread is open.
        awaiting = row["status"] == "open" and bool(messages) and messages[-1]["replyRequested"]
        return {"id": row["id"], "status": row["status"], "createdAt": row["created_at"],
                "updatedAt": row["updated_at"], "anchor": anchor, "messages": messages, "awaitingReply": awaiting}

    def draft(self, row):
        return {"id": row["id"], "actor": json.loads(row["actor"]), "body": row["body"],
                "target": json.loads(row["target"]), "updatedAt": row["updated_at"]}

    def listing(self, source, contents):
        # One read transaction keeps revision and all child rows mutually consistent.
        self.db.execute("BEGIN")
        try:
            result = {"reviewId": self.git.review_id, "revision": self.revision(),
                      "threads": [self.thread(row[0], source, contents) for row in self.db.execute(
                          "SELECT id FROM threads WHERE review_id=? ORDER BY created_at,id", (self.git.review_id,))],
                      "drafts": [self.draft(row) for row in self.db.execute(
                          "SELECT * FROM drafts WHERE review_id=? ORDER BY updated_at,id", (self.git.review_id,))]}
            self.db.commit()
            return result
        except BaseException:
            self.db.rollback()
            raise

    def mutate(self, operation, data):
        if not isinstance(data, dict):
            fail("invalid_request", "--data must be one JSON object")
        allowed = {"commandId", "reviewId", "expectedRevision", "actor"} | {
            "create": {"scope", "base", "anchor", "body", "replyRequested"}, "reply": {"threadId", "body", "replyRequested"},
            "resolve": {"threadId", "resolved"}, "edit": {"messageId", "body"}, "delete": {"messageId"}, "deliver": {"messageIds", "state", "target"}, "draft-save": {"draftId", "body", "target"},
            "draft-delete": {"draftId"}}[operation]
        if set(data) - allowed:
            fail("invalid_request", "unknown mutation fields", fields=sorted(set(data) - allowed))
        command_id = text(data.get("commandId"), "commandId", 256)
        review_id = text(data.get("reviewId"), "reviewId", 256)
        if review_id != self.git.review_id:
            fail("review_conflict", "worktree or branch changed; reload the pinned review", expectedReviewId=review_id, currentReviewId=self.git.review_id)
        expected = positive(data.get("expectedRevision"), "expectedRevision", minimum=0)
        actor = actor_data(data.get("actor"))
        requested = data.get("replyRequested", False)
        if type(requested) is not bool:
            fail("invalid_request", "replyRequested must be true or false")
        fingerprint = digest([operation, data])
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.db.execute("SELECT * FROM commands WHERE review_id=? AND id=?", (self.git.review_id, command_id)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    fail("idempotency_conflict", "commandId was used with different data")
                self.db.commit()
                return json.loads(previous["result"])
            revision = self.revision()
            if expected != revision:
                fail("revision_conflict", "review changed; reload before writing", expectedRevision=expected, currentRevision=revision)
            timestamp = now()
            result = {"reviewId": self.git.review_id, "revision": revision + 1}
            if operation == "create":
                body = text(data.get("body"), "body", MAX_BODY_BYTES)
                given = data.get("anchor")
                if not isinstance(given, dict) or set(given) != {"path", "side", "startLine", "endLine", "snapshotId"}:
                    fail("invalid_request", "anchor requires path, side, startLine, endLine and snapshotId")
                path = relative_path(given["path"])
                side = given["side"]
                if side not in ("old", "new"):
                    fail("invalid_request", "anchor.side must be old or new")
                start = positive(given["startLine"], "startLine")
                end = positive(given["endLine"], "endLine")
                if end < start:
                    fail("invalid_request", "endLine must not precede startLine")
                source, contents = self.git.snapshot(data.get("scope", "uncommitted"), data.get("base"), path)
                if given["snapshotId"] != source["snapshotId"]:
                    fail("snapshot_conflict", "diff changed; refresh before creating an annotation", snapshotId=source["snapshotId"])
                if source["file"]["binary"] or source["file"]["tooLarge"] or source["file"]["unsupported"]:
                    fail("invalid_request", "this change has no annotatable text lines")
                coordinate = "oldLine" if side == "old" else "newLine"
                available = {r[coordinate] for h in source["file"]["hunks"] for r in h["rows"] if r[coordinate] is not None}
                if end - start > MAX_LINES or not all(n in available for n in range(start, end + 1)):
                    fail("invalid_request", "anchor lines are not rendered on this side of the selected diff")
                entry = next(e for e in source["files"] if e["path"] == path)
                raw = contents[path][0 if side == "old" else 1]
                lines = source_lines(raw)
                anchor = dict(given, oldPath=entry["oldPath"], scope=source["scope"], baseRef=source["baseRef"],
                              baseOid=source["baseOid"], headOid=source["headOid"], fingerprint=digest(raw),
                              fileFingerprint=digest(contents[path][2:]),
                              snippet="\n".join(lines[start - 1:end]))
                thread_id = identifier("thread")
                self.db.execute("INSERT INTO threads VALUES(?,?,?,?,?,?)", (thread_id, self.git.review_id, "open", canonical_json(anchor), timestamp, timestamp))
                self.add_message(thread_id, actor, body, timestamp, requested)
                result["thread"] = self.thread(thread_id, source, contents)
            elif operation == "deliver":
                ids = data.get("messageIds")
                if not isinstance(ids, list) or not ids or len(ids) > 1000 or len(set(map(str, ids))) != len(ids):
                    fail("invalid_request", "messageIds must be 1 to 1000 distinct message IDs")
                state = data.get("state")
                if state not in (*DELIVERY_STATES, "none"):
                    fail("invalid_request", "state must be uncertain, sent or none")
                target = text(data.get("target", ""), "target", 256, blank=True)
                for message_id in ids:
                    message_id = text(message_id, "messageIds")
                    found = self.db.execute("SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.review_id=?",
                                            (message_id, self.git.review_id)).fetchone()
                    if found is None:
                        fail("not_found", "message not found", messageId=message_id)
                    if state == "none":
                        self.db.execute("DELETE FROM deliveries WHERE message_id=?", (message_id,))
                    else:
                        self.db.execute("INSERT OR REPLACE INTO deliveries VALUES(?,?,?,?)", (message_id, state, target, timestamp))
                result["delivered"] = {"messageIds": ids, "state": state}
            elif operation == "delete":
                message = self.own_message(data, actor)
                thread_id = message["thread_id"]
                first = self.db.execute("SELECT id FROM messages WHERE thread_id=? ORDER BY sequence LIMIT 1", (thread_id,)).fetchone()[0]
                # The first comment is the thread: deleting it removes every reply too.
                doomed = [row[0] for row in self.db.execute("SELECT id FROM messages WHERE thread_id=?", (thread_id,))] if first == message["id"] else [message["id"]]
                self.db.executemany("DELETE FROM message_edits WHERE message_id=?", [(item,) for item in doomed])
                self.db.executemany("DELETE FROM deliveries WHERE message_id=?", [(item,) for item in doomed])
                self.db.executemany("DELETE FROM messages WHERE id=?", [(item,) for item in doomed])
                result["deleted"] = {"messageId": message["id"], "threadId": thread_id, "thread": first == message["id"]}
                if first == message["id"]:
                    self.db.execute("DELETE FROM threads WHERE id=?", (thread_id,))
                else:
                    self.db.execute("UPDATE threads SET updated_at=? WHERE id=?", (timestamp, thread_id))
                    result["thread"] = self.thread(thread_id)
            elif operation in ("reply", "resolve", "edit"):
                if operation == "edit":
                    message = self.own_message(data, actor)
                    message_id = message["id"]
                    thread_id = message["thread_id"]
                else:
                    thread_id = text(data.get("threadId"), "threadId")
                thread = self.thread(thread_id)
                if operation == "edit":
                    body = text(data.get("body"), "body", MAX_BODY_BYTES)
                    if body != message["body"]:
                        self.db.execute("INSERT INTO message_edits VALUES(?,?,?)", (message_id, message["body"], timestamp))
                        self.db.execute("UPDATE messages SET body=?, edited_at=? WHERE id=?", (body, timestamp, message_id))
                elif operation == "reply":
                    body = text(data.get("body"), "body", MAX_BODY_BYTES)
                    self.add_message(thread_id, actor, body, timestamp, requested)
                else:
                    if type(data.get("resolved")) is not bool:
                        fail("invalid_request", "resolved must be true or false")
                    self.db.execute("UPDATE threads SET status=? WHERE id=?", ("resolved" if data["resolved"] else "open", thread_id))
                self.db.execute("UPDATE threads SET updated_at=? WHERE id=?", (timestamp, thread_id))
                source = contents = None
                try:
                    source, contents = self.git.snapshot(thread["anchor"]["scope"], thread["anchor"]["baseRef"])
                except Failure:
                    pass  # A missing old base cannot prevent a reply to its durable discussion.
                result["thread"] = self.thread(thread_id, source, contents)
            else:
                draft_id = text(data.get("draftId"), "draftId")
                previous_draft = self.db.execute("SELECT * FROM drafts WHERE review_id=? AND id=?", (self.git.review_id, draft_id)).fetchone()
                if previous_draft:
                    owner = json.loads(previous_draft["actor"])
                    if (owner["kind"], owner["id"]) != (actor["kind"], actor["id"]):
                        fail("invalid_request", "draft belongs to a different actor")
                if operation == "draft-save":
                    body = text(data.get("body"), "body", MAX_BODY_BYTES, blank=True)
                    target = data.get("target")
                    if not isinstance(target, dict) or len(canonical_json(target).encode("utf-8")) > 524_288:
                        fail("invalid_request", "draft target must be a JSON object of at most 512 KiB")
                    self.db.execute("INSERT OR REPLACE INTO drafts VALUES(?,?,?,?,?,?)",
                                    (self.git.review_id, draft_id, canonical_json(actor), body, canonical_json(target), timestamp))
                    result["draft"] = {"id": draft_id, "actor": actor, "body": body, "target": target, "updatedAt": timestamp}
                else:
                    self.db.execute("DELETE FROM drafts WHERE review_id=? AND id=?", (self.git.review_id, draft_id))
                    result["draftId"] = draft_id
            current_branch = self.git.line(["symbolic-ref", "--quiet", "--short", "HEAD"], optional=True)
            current_head = self.git.line(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], optional=True) if not current_branch else None
            if current_branch != self.git.branch or (not current_branch and current_head != self.git.head):
                fail("review_conflict", "branch identity changed during mutation; reload the pinned review")
            if len(canonical_json(result).encode("utf-8")) > MAX_OUTPUT - 1024:
                fail("too_large", "mutation result exceeds response limit; export/archive this discussion first")
            self.db.execute("UPDATE reviews SET revision=revision+1 WHERE id=?", (self.git.review_id,))
            self.db.execute("INSERT INTO commands VALUES(?,?,?,?)", (self.git.review_id, command_id, fingerprint, canonical_json(result)))
            self.db.commit()
            return result
        except BaseException:
            self.db.rollback()
            raise

    def own_message(self, data, actor):
        message_id = text(data.get("messageId"), "messageId")
        message = self.db.execute("SELECT m.* FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.review_id=?",
                                  (message_id, self.git.review_id)).fetchone()
        if message is None:
            fail("not_found", "message not found", messageId=message_id)
        author = json.loads(message["actor"])
        if (author["kind"], author["id"]) != (actor["kind"], actor["id"]):
            fail("invalid_request", "only the author can change a message")
        return message

    def add_message(self, thread_id, actor, body, timestamp, requested=False):
        self.db.execute("INSERT INTO messages(id,thread_id,actor,body,created_at,reply_requested) VALUES(?,?,?,?,?,?)",
                        (identifier("message"), thread_id, canonical_json(actor), body, timestamp, int(requested)))


def export_text(listing):
    blocks = []
    for thread in listing["threads"]:
        anchor = thread["anchor"]
        awaiting = "; short reply requested" if thread["awaitingReply"] else ""
        blocks.append(f"{anchor['path']}:{anchor['startLine']}-{anchor['endLine']} ({anchor['side']}) [{thread['status']}; {anchor['validity']}{awaiting}] {thread['id']}\n{anchor['snippet']}")
        blocks.extend(f"{message['actor']['name']} ({message['actor']['kind']}):\n{message['body']}" for message in thread["messages"])
    return "\n\n".join(blocks)


# Printed by `skill`: what an agent needs to answer review threads. Send to agent
# pastes only the command that prints it, so the recipes live in one place.
SKILL = """# Codewalker: answer review feedback

The reviewer uses Codewalker, a review panel in Herdr. Each comment is a thread on
lines of this checkout's diff. Answer in the thread, so that the reply shows in
their panel. An answer only in chat does not show there.

Helper: python3 {helper}
Checkout: {repo}
Each command prints one JSON value: {{"ok": true, "data": ...}}, or
{{"ok": false, "error": {{"code": ..., "message": ...}}}} with exit 1.

## Rules

- A thread marked "short reply requested" wants an answer in that thread: a few
  sentences that answer the question or say what you will change. Then continue
  your work. Do not start a long discussion in the review.
- A thread marked "code changed since" points at lines that changed after the
  comment. Its code block is the code as it was then. Read the current file
  before you act.
- For other threads, act on the comment. Reply in the thread only when you have a
  question, you disagree, or you cannot do it.
- Reply by thread ID. Do not open a new thread to answer.
- The reviewer resolves threads. Resolve one only when they ask you to.
- Change only your own messages. Never edit the SQLite store.

## Read the threads

```sh
python3 {helper_q} --repo {repo_q} list --json
```

`data.threads[]` has `id`, `status` (open or resolved), `awaitingReply`,
`anchor` (`path`, `side`, `startLine`, `endLine`, `snippet`) and `messages[]`
(`id`, `actor`, `body`). Messages with `actor.kind` "human" are the reviewer's.

## Reply, edit or delete

Set the four values at the top, then run it as is. The quoted heredoc keeps
the shell away from the text, so any characters are safe in BODY.

```sh
python3 - <<'PY'
ACTION = "reply"                 # "reply", "edit" or "delete"
TARGET = "<thread id>"           # reply: a thread ID; edit or delete: your message ID
BODY = \"\"\"<your reply>\"\"\"  # not used by delete
NAME = "<your agent name>"

import json, subprocess, uuid
cw = ["python3", {helper_r}, "--repo", {repo_r}]
def run(*args):
    return json.loads(subprocess.run(cw + list(args) + ["--json"], capture_output=True, text=True).stdout)
for _ in range(3):
    state = run("list")
    if not state["ok"]:
        break
    request = {{"commandId": uuid.uuid4().hex, "reviewId": state["data"]["reviewId"],
               "expectedRevision": state["data"]["revision"],
               "actor": {{"kind": "agent", "id": NAME.lower(), "name": NAME}},
               "threadId" if ACTION == "reply" else "messageId": TARGET}}
    if ACTION != "delete":
        request["body"] = BODY
    state = run(ACTION, "--data", json.dumps(request))
    if state["ok"] or state["error"]["code"] != "revision_conflict":
        break
print(json.dumps(state, indent=2))
PY
```

Use the same NAME every time: only the author can edit or delete a message.
Deleting the first message of a thread deletes the whole thread.

## Errors

- `revision_conflict`: another write came first. The recipe reads the threads
  again and tries up to three times. If it still fails, read the new replies
  before you try again.
- No output, or the process stopped: list the threads and look for your reply
  before you send it again. Each run makes a new command ID.
- `invalid_request` on edit or delete: the message is not yours, or the ID is wrong.
- `storage_error`: stop and tell the reviewer. Do not delete or recreate the store.

To start a thread yourself, or for all fields and errors, see docs/agent-workflow.md
and docs/protocol.md in the herdr-codewalker repository.
"""


def skill_text(repo):
    helper = os.path.abspath(__file__)
    shown = os.path.abspath(repo) if repo else "<checkout>"
    quote = lambda value: "'" + value.replace("'", "'\\\\''") + "'"
    return SKILL.format(helper=helper, repo=shown, helper_q=quote(helper), repo_q=quote(shown),
                        helper_r=repr(helper), repo_r=repr(shown))


def open_review(repo):
    """Open Review as a pane right of this terminal's pane, for its folder."""
    terminal = os.environ.get("HC_TERMINAL_ID")
    if not terminal:
        fail("not_in_herdr", "Run open in a Herdr terminal (HC_TERMINAL_ID is not set)")
    folder = os.path.abspath(repo or os.getcwd())

    def herdr(*argv):
        try:
            done = subprocess.run(["herdr-app", *argv], capture_output=True, text=True, timeout=10)
        except FileNotFoundError:
            fail("not_in_herdr", "herdr-app is not on PATH")
        except subprocess.TimeoutExpired:
            fail("herdr_error", f"herdr-app {argv[0]} did not answer")
        try:
            result = json.loads(done.stdout)
        except ValueError:
            fail("herdr_error", (done.stderr or done.stdout).strip() or f"herdr-app {argv[0]} failed")
        if done.returncode or (isinstance(result, dict) and result.get("error")):
            fail("herdr_error", str(result.get("error") if isinstance(result, dict) else result))
        return result

    panes = [t.get("pane") for space in herdr("ls").get("spaces", []) for tab in space.get("tabs", [])
             for t in tab.get("terminals", []) if t.get("terminal") == terminal]
    if not panes or not panes[0]:
        fail("herdr_error", f"terminal {terminal} has no pane; show it first")
    split = {"direction": "right", "pane": panes[0], "mod": "Codewalker", "props": {"framed": True, "folder": folder}}
    herdr("do", "pane.split", json.dumps(split))
    return {"pane": panes[0], "folder": folder}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        fail("invalid_request", message)


def parse_args(argv):
    parser = Parser(description=__doc__)
    parser.add_argument("--repo")
    parser.add_argument("--store")
    parser.add_argument("command", choices=["skill", "open", "context", "review", "list", "create", "reply", "resolve", "edit", "delete", "deliver", "export", "draft-save", "draft-delete"])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--scope", default="uncommitted", choices=["uncommitted", "branch"])
    parser.add_argument("--base")
    parser.add_argument("--file")
    parser.add_argument("--select-first", action="store_true")
    parser.add_argument("--data")
    return parser.parse_args(argv)


def execute(args):
    if args.repo is None:
        fail("invalid_request", "--repo is required")
    git = Git(args.repo)
    store = Store(git, args.store)
    try:
        if args.command == "context":
            return store.context()
        if args.command in ("review", "list", "export"):
            if args.select_first and (args.command != "review" or args.file is not None):
                fail("invalid_request", "--select-first is only for review without --file")
            source, contents = git.snapshot(args.scope, args.base, args.file if args.command == "review" else None,
                                            args.select_first)
            listing = store.listing(source, contents)
            if args.command == "review":
                context = store.context()
                context["revision"] = listing["revision"]
                # Internal old blob/mode fields are not protocol surface.
                files = [{k: v for k, v in entry.items() if k not in ("oldMode", "newMode", "oldOid")} for entry in source["files"]]
                return dict(source, context=context, files=files, threads=listing["threads"], drafts=listing["drafts"])
            if args.command == "export":
                listing["text"] = export_text(listing)
            return listing
        if args.data is None:
            fail("invalid_request", "mutation requires --data JSON")
        if len(args.data.encode("utf-8")) > 1_048_576:
            fail("too_large", "mutation JSON exceeds 1 MiB")
        try:
            data = json.loads(args.data, parse_constant=lambda value: fail("invalid_request", f"non-JSON constant: {value}"))
        except (ValueError, RecursionError):
            fail("invalid_request", "--data is not valid JSON")
        return store.mutate(args.command, data)
    finally:
        store.close()


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        if args.command == "skill":
            # Plain Markdown for an agent to read, not a JSON result.
            print(skill_text(args.repo), end="")
            return 0
        data = open_review(args.repo) if args.command == "open" else execute(args)
        result = {"ok": True, "protocolVersion": VERSION, "data": data}
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_OUTPUT:
            fail("too_large", "review result exceeds 7 MiB; select a smaller changeset")
        print(encoded)
        return 0
    except Failure as exc:
        error = {"code": exc.code, "message": exc.message}
        if exc.details:
            error["details"] = exc.details
    except (sqlite3.Error, OSError) as exc:
        error = {"code": "storage_error", "message": str(exc)}
    except (UnicodeError, ValueError, TypeError, RecursionError) as exc:
        error = {"code": "invalid_request", "message": f"invalid input: {exc}"}
    print(json.dumps({"ok": False, "protocolVersion": VERSION, "error": error}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    sys.exit(main())
