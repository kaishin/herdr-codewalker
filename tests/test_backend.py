"""Behavior contracts at the real CLI/Git/SQLite boundary; no mocked persistence."""
import concurrent.futures
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / "backend" / "codewalker.py"
HUMAN = {"kind": "human", "id": "user", "name": "You"}
AGENT = {"kind": "agent", "id": "pi", "name": "Pi"}


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.store = Path(self.temp.name) / "state" / "reviews.sqlite3"
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.root / "a.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "base")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, text=True, capture_output=True, check=True).stdout.strip()

    def cli(self, command, *args, data=None, error=None):
        argv = [sys.executable, str(HELPER), "--repo", str(self.root), "--store", str(self.store), command, "--json", *args]
        if data is not None:
            data.setdefault("reviewId", self.cli("context")["reviewId"])
            argv.extend(["--data", json.dumps(data)])
        process = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        response = json.loads(process.stdout)
        if error:
            self.assertEqual(process.returncode, 1, process.stderr)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], error, response)
            return response
        self.assertEqual(process.returncode, 0, (response, process.stderr))
        self.assertTrue(response["ok"])
        self.assertEqual(response["protocolVersion"], 1)
        return response["data"]

    def changed(self):
        (self.root / "a.txt").write_text("one\nTWO\nthree\n", encoding="utf-8")
        return self.cli("review", "--file", "a.txt")

    def create(self, review=None, command="create1", actor=HUMAN, body="Why?\n\nKeep the blank line."):
        review = review or self.changed()
        data = {"commandId": command, "expectedRevision": review["context"]["revision"], "actor": actor,
                "scope": review["scope"], "anchor": {"path": "a.txt", "side": "new", "startLine": 2,
                "endLine": 2, "snapshotId": review["snapshotId"]}, "body": body}
        return self.cli("create", data=data), data

    def mark_file(self, review, path="a.txt", viewed=True, command="view1"):
        file = next(f for f in review["files"] if f["path"] == path)
        data = {"commandId": command, "expectedRevision": review["context"]["revision"], "actor": HUMAN,
                "scope": review["scope"], "base": review["baseRef"], "path": path,
                "diffFingerprint": file["diffFingerprint"], "viewed": viewed}
        return self.cli("file-view", data=data), data

    def test_viewed_marks_survive_restart_unrelated_changes_and_explicit_retries(self):
        review = self.changed()
        self.assertFalse(review["files"][0]["viewed"], "reading a file never marks it")
        marked, data = self.mark_file(review)
        self.assertEqual(self.cli("file-view", data=data), marked)
        self.assertEqual(self.cli("context")["revision"], 1)
        (self.root / "other.txt").write_text("unrelated\n")
        again = self.cli("review", "--file", "a.txt")
        self.assertNotEqual(again["snapshotId"], review["snapshotId"])
        self.assertTrue(next(f for f in again["files"] if f["path"] == "a.txt")["viewed"])
        self.assertEqual(again["file"]["diffFingerprint"], review["file"]["diffFingerprint"])
        self.create(again)
        again = self.cli("review", "--file", "a.txt")
        self.assertTrue(again["files"][0]["viewed"], "a discussion is not a code change")
        before = self.store.read_bytes()
        self.cli("review")
        self.assertEqual(self.store.read_bytes(), before, "viewed reads must not wake the store watcher")
        unmarked, data = self.mark_file(again, viewed=False, command="unview")
        self.assertEqual(self.cli("file-view", data=data), unmarked)
        self.assertFalse(self.cli("review")["files"][0]["viewed"])

    def test_viewed_fingerprints_follow_both_sides_not_commit_ids_or_other_comparisons(self):
        original_base = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "feature")
        self.changed()
        branch = self.cli("review", "--scope", "branch", "--base", "main")
        self.mark_file(branch)
        self.assertFalse(self.cli("review")["files"][0]["viewed"], "uncommitted has its own checklist")
        self.git("branch", "other-base", "main")
        self.assertFalse(self.cli("review", "--scope", "branch", "--base", "other-base")["files"][0]["viewed"])
        # The new side stays fixed while HEAD and then the base move.
        self.git("add", "a.txt")
        self.git("commit", "-qm", "feature")
        self.assertTrue(self.cli("review", "--scope", "branch", "--base", "main")["files"][0]["viewed"])
        self.git("switch", "main")
        (self.root / "other.txt").write_text("unrelated\n")
        self.git("add", ".")
        self.git("commit", "-qm", "unrelated base change")
        self.git("switch", "feature")
        self.git("merge", "--no-edit", "main")
        same = self.cli("review", "--scope", "branch", "--base", "main")
        self.assertTrue(same["files"][0]["viewed"], "moving the base elsewhere preserves this file's mark")
        # A new base has the same working file, but a different removed side.
        self.git("branch", "-f", "main", "feature")
        (self.root / "a.txt").write_text("one\nthree\n")
        fresh = self.cli("review", "--scope", "branch", "--base", "main")
        self.mark_file(fresh, command="view-new-diff")
        self.git("branch", "-f", "main", original_base)
        changed_base = self.cli("review", "--scope", "branch", "--base", "main")
        self.assertFalse(changed_base["files"][0]["viewed"], "changing only the old side invalidates a mark")

    def test_viewed_rejects_stale_file_but_not_unrelated_file_edits(self):
        review = self.changed()
        (self.root / "other.txt").write_text("unrelated\n")
        _, data = self.mark_file(review)
        (self.root / "a.txt").write_text("one\nnewer\nthree\n")
        fresh = self.cli("review")
        self.assertFalse(fresh["files"][0]["viewed"])
        data.update(commandId="stale-view", expectedRevision=fresh["context"]["revision"])
        self.cli("file-view", data=data, error="snapshot_conflict")
        self.assertEqual(self.cli("context")["revision"], 1, "a refused mark leaves no receipt or revision")
        self.mark_file(fresh, command="new-view")
        # File modes are part of the review even when the bytes do not change.
        self.git("config", "core.filemode", "true")
        (self.root / "a.txt").chmod(0o755)
        self.assertFalse(self.cli("review")["files"][0]["viewed"])
        self.git("switch", "-c", "other-review")
        self.assertFalse(self.cli("review")["files"][0]["viewed"], "a different branch starts unviewed")

    def test_viewed_handles_binary_deleted_renamed_and_unfingerprinted_files(self):
        for name, raw in (("binary", b"old\0"), ("deleted", b"delete me\n"), ("rename", b"rename me\n")):
            (self.root / name).write_bytes(raw)
        self.git("add", ".")
        self.git("commit", "-qm", "fixtures")
        (self.root / "binary").write_bytes(b"new\0")
        (self.root / "deleted").unlink()
        self.git("mv", "rename", "renamed")
        (self.root / "untracked").write_text("new\n")
        (self.root / "huge").write_bytes(b"x" * 2_000_001)
        (self.root / "link").symlink_to("a.txt")
        for path in ("binary", "deleted", "renamed", "untracked"):
            result = self.cli("review")
            self.mark_file(result, path, command="view-" + path)
        files = {f["path"]: f for f in self.cli("review")["files"]}
        self.assertTrue(all(files[p]["viewed"] for p in ("binary", "deleted", "renamed", "untracked")))
        for path in ("huge", "link"):
            self.assertIsNone(files[path]["diffFingerprint"])
            self.assertFalse(files[path]["viewed"])
            self.cli("file-view", data={"commandId": path, "expectedRevision": 4, "actor": HUMAN,
                     "path": path, "diffFingerprint": "invented", "viewed": True}, error="invalid_request")

    def test_v4_store_adds_viewed_marks_without_changing_existing_discussions(self):
        created, _ = self.create()
        with sqlite3.connect(self.store) as db:
            db.execute("DROP TABLE file_views")
            db.execute("PRAGMA user_version=4")
        review = self.cli("review")
        self.assertEqual(review["threads"][0]["id"], created["thread"]["id"])
        self.assertFalse(review["files"][0]["viewed"])
        self.mark_file(review)
        self.assertTrue(self.cli("review")["files"][0]["viewed"])

    def test_uncommitted_coordinates_untracked_and_index_are_read_only(self):
        (self.root / "a.txt").write_text("one\nstaged\nthree\n", encoding="utf-8")
        self.git("add", "a.txt")
        (self.root / "a.txt").write_text("one\nnet worktree\nthree\n", encoding="utf-8")
        (self.root / "new [x].txt").write_text("new\n", encoding="utf-8")
        (self.root / "ignored.txt").write_text("secret\n", encoding="utf-8")
        index = (self.root / ".git/index").read_bytes()
        result = self.cli("review", "--file", "a.txt")
        self.assertEqual({f["path"] for f in result["files"]}, {"a.txt", "new [x].txt"})
        rows = result["file"]["hunks"][0]["rows"]
        self.assertIn({"kind": "delete", "oldLine": 2, "newLine": None, "text": "two"}, rows)
        self.assertIn({"kind": "add", "oldLine": None, "newLine": 2, "text": "net worktree"}, rows)
        self.assertEqual((self.root / ".git/index").read_bytes(), index)
        untracked = self.cli("review", "--file", "new [x].txt")
        self.assertEqual(untracked["file"]["hunks"][0]["rows"], [{"kind": "add", "oldLine": None, "newLine": 1, "text": "new"}])

    def test_branch_includes_commits_and_worktree_using_merge_base(self):
        base = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "feature")
        (self.root / "a.txt").write_text("one\ncommitted\nthree\n", encoding="utf-8")
        self.git("add", "a.txt")
        self.git("commit", "-qm", "feature")
        (self.root / "working.txt").write_text("uncommitted\n", encoding="utf-8")
        result = self.cli("review", "--scope", "branch", "--base", "main")
        self.assertEqual(result["baseOid"], base)
        self.assertEqual({f["path"] for f in result["files"]}, {"a.txt", "working.txt"})
        self.cli("review", "--scope", "branch", "--base", "missing", error="invalid_base")

    def test_two_way_durable_threads_resolution_exact_body_and_export(self):
        created, _ = self.create()
        thread_id = created["thread"]["id"]
        message_id = created["thread"]["messages"][0]["id"]
        reply_body = "Because:\n\n  preserve indentation\n"
        replied = self.cli("reply", data={"commandId": "reply1", "expectedRevision": 1, "actor": AGENT,
                                          "threadId": thread_id, "body": reply_body})
        self.assertEqual(replied["thread"]["messages"][1]["actor"], AGENT)
        self.assertEqual(replied["thread"]["messages"][1]["body"], reply_body)
        resolved = self.cli("resolve", data={"commandId": "resolve1", "expectedRevision": 2, "actor": HUMAN,
                                             "threadId": thread_id, "resolved": True})
        self.assertEqual(resolved["thread"]["status"], "resolved")
        listed = self.cli("list")
        self.assertEqual(listed["threads"][0]["messages"][0]["id"], message_id)
        self.assertEqual(listed["threads"][0]["anchor"]["validity"], "current")
        self.assertEqual(listed["revision"], 3)
        exported = self.cli("export")
        self.assertIn("Why?\n\nKeep the blank line.", exported["text"])
        self.assertIn(reply_body, exported["text"])
        self.assertEqual(self.cli("list")["revision"], 3)
        self.assertFalse(self.store.is_relative_to(self.root))
        self.assertEqual(os.stat(self.store).st_mode & 0o777, 0o600)

    def test_retry_dedup_and_concurrent_revision_conflict(self):
        created, data = self.create()
        self.assertEqual(self.cli("create", data=data), created)
        self.cli("create", data=dict(data, body="different"), error="idempotency_conflict")
        thread_id = created["thread"]["id"]
        commands = [{"commandId": f"reply{i}", "reviewId": created["reviewId"], "expectedRevision": 1, "actor": actor,
                     "threadId": thread_id, "body": f"message {i}"} for i, actor in enumerate((HUMAN, AGENT))]
        def invoke(payload):
            argv = [sys.executable, str(HELPER), "--repo", str(self.root), "--store", str(self.store),
                    "reply", "--data", json.dumps(payload)]
            return json.loads(subprocess.run(argv, text=True, capture_output=True, timeout=30).stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(invoke, commands))
        self.assertEqual(sum(o["ok"] for o in outcomes), 1, outcomes)
        loser = next(i for i, o in enumerate(outcomes) if not o["ok"])
        self.assertEqual(outcomes[loser]["error"]["code"], "revision_conflict")
        self.cli("reply", data=dict(commands[loser], commandId="reconciled", expectedRevision=2))
        listed = self.cli("list")
        self.assertEqual(listed["revision"], 3)
        self.assertEqual(len(listed["threads"][0]["messages"]), 3)

    def test_anchor_staleness_and_snapshot_conflict_never_retarget(self):
        review = self.changed()
        created, data = self.create(review)
        (self.root / "a.txt").write_text("inserted\none\nTWO\nthree\n", encoding="utf-8")
        self.cli("create", data=dict(data, commandId="old-snapshot", expectedRevision=1), error="snapshot_conflict")
        thread = self.cli("list")["threads"][0]
        self.assertEqual(thread["anchor"]["startLine"], 2)
        self.assertEqual(thread["anchor"]["snippet"], "TWO")
        self.assertEqual(thread["anchor"]["validity"], "stale")
        (self.root / "a.txt").unlink()
        self.assertEqual(self.cli("list")["threads"][0]["id"], created["thread"]["id"])

    def test_old_side_and_deletion_notes(self):
        (self.root / "a.txt").unlink()
        review = self.cli("review", "--file", "a.txt")
        data = {"commandId": "old", "expectedRevision": 0, "actor": AGENT, "scope": "uncommitted",
                "anchor": {"path": "a.txt", "side": "old", "startLine": 1, "endLine": 3, "snapshotId": review["snapshotId"]}, "body": "This deletion changes the contract."}
        result = self.cli("create", data=data)
        self.assertEqual(result["thread"]["anchor"]["snippet"], "one\ntwo\nthree")
        self.assertEqual(self.cli("list")["threads"][0]["anchor"]["validity"], "current")

    def test_reject_outside_paths_and_symlinks_and_preserve_binary_metadata(self):
        self.changed()
        for path in ("../outside", "/tmp/outside", ".git/config", "ignored.txt", "./a.txt"):
            self.cli("review", "--file", path, error="invalid_request" if path != "ignored.txt" else "not_found")
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("private\n", encoding="utf-8")
        (self.root / "link.txt").symlink_to(outside)
        (self.root / "binary.dat").write_bytes(b"binary\0file")
        result = self.cli("review", "--file", "link.txt")
        self.assertTrue(result["file"]["unsupported"])
        self.assertEqual(result["file"]["hunks"], [])
        result = self.cli("review", "--file", "binary.dat")
        self.assertTrue(result["file"]["binary"])
        self.assertEqual(result["file"]["hunks"], [])

    def test_drafts_actor_ownership_and_restart(self):
        self.cli("draft-save", data={"commandId": "draft1", "expectedRevision": 0, "actor": HUMAN,
                                     "draftId": "composer", "body": "unfinished\n\n", "target": {"threadId": "future"}})
        listed = self.cli("list")
        self.assertEqual(listed["drafts"][0]["body"], "unfinished\n\n")
        self.cli("draft-delete", data={"commandId": "steal", "expectedRevision": 1, "actor": AGENT,
                                       "draftId": "composer"}, error="invalid_request")
        self.cli("draft-delete", data={"commandId": "delete1", "expectedRevision": 1, "actor": HUMAN,
                                       "draftId": "composer"})
        self.assertEqual(self.cli("list")["drafts"], [])

    def test_rename_source_and_literal_pathspec(self):
        (self.root / "a.txt").rename(self.root / "renamed [x].txt")
        self.git("add", "-A")
        (self.root / "renamed [x].txt").write_text("one\nTWO\nthree\n", encoding="utf-8")
        review = self.cli("review", "--file", "renamed [x].txt")
        entry = review["files"][0]
        self.assertEqual(entry["status"], "renamed")
        self.assertEqual(entry["oldPath"], "a.txt")
        rows = review["file"]["hunks"][0]["rows"]
        self.assertTrue(any(r["text"] == "two" and r["kind"] == "delete" for r in rows))

    def test_unborn_and_detached_head_persist_explicit_context(self):
        self.git("switch", "--orphan", "unborn")
        (self.root / "new.txt").write_text("new\n", encoding="utf-8")
        result = self.cli("review", "--file", "new.txt")
        self.assertIsNone(result["context"]["headOid"])
        self.assertEqual(result["file"]["hunks"][0]["newLines"], 1)
        self.git("switch", "--detach", "main")
        self.assertIsNone(self.cli("context")["branch"])
        created, _ = self.create()
        self.assertEqual(self.cli("list")["threads"][0]["id"], created["thread"]["id"])

    @unittest.skipUnless(sys.platform == "darwin", "worst-case argv uses macOS budget; Linux caps one argument at 128 KiB")
    def test_draft_can_retain_max_escaped_post_receipt_and_retry_after_restart(self):
        # Every allowed U+0001 byte needs six JSON bytes. Two exact copies live in
        # draft.body and target.pendingPost.payload.body: ~786 KiB on the wire.
        unit = '"\\\n\x01日本語'
        unit_bytes = len(unit.encode("utf-8"))
        mixed = unit * (65_536 // unit_bytes) + "x" * (65_536 % unit_bytes)
        for index, body in enumerate(("\x01" * 65_536, mixed)):
            with self.subTest(body_kind="worst-case-controls" if index == 0 else "mixed-escaped-unicode"):
                self.assertEqual(len(body.encode("utf-8")), 65_536)
                pending = {"commandId": f"post-after-draft-{index}", "context": {"reviewId": self.cli("context")["reviewId"]},
                           "operation": "reply", "payload": {"threadId": "pending-thread", "body": body}}
                request = {"commandId": f"receipt-draft-{index}", "expectedRevision": index, "actor": HUMAN,
                           "draftId": f"pending-post-{index}", "body": body, "target": {"pendingPost": pending}}
                result = self.cli("draft-save", data=request)
                self.assertEqual(self.cli("draft-save", data=request), result)
                restored = next(d for d in self.cli("list")["drafts"] if d["id"] == request["draftId"])
                self.assertEqual(restored["target"]["pendingPost"], pending)
                self.assertEqual(restored["body"], body)
                self.assertEqual(result["revision"], index + 1)

    def test_git_clean_filter_is_not_executed_by_read_only_review(self):
        marker = Path(self.temp.name) / "executed"
        driver = Path(self.temp.name) / "driver.sh"
        driver.write_text(f'#!/bin/sh\ntouch "{marker}"\ncat\n', encoding="utf-8")
        driver.chmod(0o755)
        self.git("config", "filter.hostile.clean", str(driver))
        self.git("config", "filter.hostile.process", str(driver))
        self.git("config", "filter.hostile.required", "true")
        (self.root / ".gitattributes").write_text("a.txt filter=hostile\n", encoding="utf-8")
        result = self.changed()
        self.assertTrue(result["file"]["hunks"])
        self.assertFalse(marker.exists(), "Git conversion filter ran during review")

    def test_git_line_coordinates_do_not_split_unicode_separators_or_lone_cr(self):
        (self.root / "unicode.txt").write_text("a\u2028b\rc\nsecond\n", encoding="utf-8")
        review = self.cli("review", "--file", "unicode.txt")
        rows = review["file"]["hunks"][0]["rows"]
        self.assertEqual([(r["newLine"], r["text"]) for r in rows], [(1, "a\u2028b\rc"), (2, "second")])
        result = self.cli("create", data={
            "commandId": "unicode", "expectedRevision": 0, "actor": HUMAN, "scope": "uncommitted",
            "anchor": {"path": "unicode.txt", "side": "new", "startLine": 2, "endLine": 2,
                       "snapshotId": review["snapshotId"]}, "body": "Second Git line"})
        self.assertEqual(result["thread"]["anchor"]["snippet"], "second")

    def test_aggregate_budget_releases_bodies_but_retains_stable_evidence_and_warning(self):
        # Exercise the actual hydration boundary with a small configured budget;
        # no fake Git/content provider can accidentally implement the invariant.
        from backend import codewalker
        from unittest.mock import patch
        for name in ("01.txt", "02.txt", "03.txt"):
            (self.root / name).write_bytes(b"x" * 48)
        git = codewalker.Git(str(self.root))
        with patch.object(codewalker, "MAX_TOTAL_BYTES", 64):
            review, contents = git.snapshot(selected="03.txt")
            repeated, _ = git.snapshot(selected="03.txt")
        retained = sum(len(raw) for sides in contents.values() for raw in sides[:2] if raw is not None)
        self.assertLessEqual(retained, 64)
        self.assertIsNone(contents["03.txt"][1])
        self.assertEqual(len(contents["03.txt"][3]), 64)
        self.assertEqual(review["snapshotId"], repeated["snapshotId"])
        self.assertTrue(review["warnings"])
        self.assertTrue(review["file"]["tooLarge"])
        self.assertEqual(review["file"]["hunks"], [])
        self.assertTrue(next(f for f in review["files"] if f["path"] == "03.txt")["aggregateLimit"])

    def test_oversized_file_reports_metadata_without_line_anchors(self):
        (self.root / "large.txt").write_bytes(b"x" * 2_000_001)
        result = self.cli("review", "--file", "large.txt")
        self.assertTrue(result["file"]["tooLarge"])
        self.assertEqual(result["file"]["hunks"], [])
        self.cli("create", data={
            "commandId": "large", "expectedRevision": 0, "actor": HUMAN, "scope": "uncommitted",
            "anchor": {"path": "large.txt", "side": "new", "startLine": 1, "endLine": 1,
                       "snapshotId": result["snapshotId"]}, "body": "Not a fake line"}, error="invalid_request")

    def test_shared_blob_reader_stays_bounded_and_in_step_across_odd_inputs(self):
        # One cat-file reader serves every old side. Skipped large bodies, binary
        # bodies and unusual names must not shift the bytes later files receive.
        odd = "a [odd] ünï\tname.txt"
        (self.root / "a-large.txt").write_bytes(b"x\n" * 1_000_001)
        (self.root / "a-binary.bin").write_bytes(b"\0old\n" * 64)
        (self.root / odd).write_text("old odd\n", encoding="utf-8")
        (self.root / "b.txt").write_text("old b\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "odd inputs")
        (self.root / "a-large.txt").write_bytes(b"y\n" * 1_000_001)
        (self.root / "a-binary.bin").write_bytes(b"\0new\n" * 64)
        (self.root / odd).write_text("new odd\n", encoding="utf-8")
        (self.root / "b.txt").write_text("new b\n", encoding="utf-8")
        self.assertTrue(self.cli("review", "--file", "a-large.txt")["file"]["tooLarge"])
        binary = self.cli("review", "--file", "a-binary.bin")["file"]
        self.assertTrue(binary["binary"])
        self.assertEqual(binary["hunks"], [])
        for path, name in ((odd, "odd"), ("b.txt", "b")):
            rows = self.cli("review", "--file", path)["file"]["hunks"][0]["rows"]
            self.assertEqual([(r["kind"], r["text"]) for r in rows], [("delete", f"old {name}"), ("add", f"new {name}")])

    def test_reads_do_not_write_the_store(self):
        # Store watchers refresh the GUI; a read that writes would wake itself forever.
        self.changed()
        before = (self.store.stat().st_mtime_ns, self.store.read_bytes())
        self.cli("review", "--select-first")
        self.cli("list")
        self.cli("context")
        self.assertEqual((self.store.stat().st_mtime_ns, self.store.read_bytes()), before)

    def test_select_first_opens_the_first_changed_file_in_one_read(self):
        (self.root / "z.txt").write_text("last\n", encoding="utf-8")
        review = self.changed()
        first = self.cli("review", "--select-first")
        self.assertEqual(first["file"]["path"], "a.txt")
        self.assertEqual(first["file"]["hunks"], review["file"]["hunks"])
        self.assertEqual(first["snapshotId"], review["snapshotId"])
        self.cli("review", "--select-first", "--file", "a.txt", error="invalid_request")

    def test_reply_request_is_owed_until_someone_answers(self):
        review = self.changed()
        data = {"commandId": "ask", "expectedRevision": review["context"]["revision"], "actor": HUMAN, "scope": review["scope"],
                "anchor": {"path": "a.txt", "side": "new", "startLine": 2, "endLine": 2, "snapshotId": review["snapshotId"]},
                "body": "Why upper case?", "replyRequested": "yes"}
        self.cli("create", data=dict(data), error="invalid_request")
        created = self.cli("create", data={**data, "replyRequested": True})["thread"]
        self.assertTrue(created["messages"][0]["replyRequested"])
        self.assertTrue(created["awaitingReply"])
        self.assertIn("short reply requested", self.cli("export")["text"])
        answered = self.cli("reply", data={"commandId": "answer", "expectedRevision": 1, "actor": AGENT,
                                           "threadId": created["id"], "body": "It matches the header."})["thread"]
        self.assertFalse(answered["messages"][1]["replyRequested"])
        self.assertFalse(answered["awaitingReply"])
        asked = self.cli("reply", data={"commandId": "again", "expectedRevision": 2, "actor": HUMAN, "threadId": created["id"],
                                        "body": "And the footer?", "replyRequested": True})["thread"]
        self.assertTrue(asked["awaitingReply"])
        resolved = self.cli("resolve", data={"commandId": "close", "expectedRevision": 3, "actor": HUMAN,
                                             "threadId": created["id"], "resolved": True})["thread"]
        self.assertFalse(resolved["awaitingReply"])

    def test_skill_recipe_replies_and_edits_as_printed(self):
        # Send to agent pastes only `skill --repo`; agents run its recipe as printed.
        created, _ = self.create()
        thread = created["thread"]["id"]
        text = subprocess.run([sys.executable, str(HELPER), "skill", "--repo", str(self.root)], capture_output=True, text=True, check=True).stdout
        self.assertIn(str(self.root), text)
        recipe = text.split("python3 - <<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        # The temp store only; the printed recipe uses the default store.
        recipe = recipe.replace('"--repo", ', f'"--store", {str(self.store)!r}, "--repo", ', 1)

        def run(action, target, body):
            filled = (recipe.replace('ACTION = "reply"', f"ACTION = {action!r}", 1).replace('"<thread id>"', repr(target), 1)
                      .replace('\"\"\"<your reply>\"\"\"', repr(body), 1).replace('"<your agent name>"', '"Test agent"', 1))
            return json.loads(subprocess.run([sys.executable, "-c", filled], capture_output=True, text=True, check=True).stdout)

        body = "It's `$HOME` and \"quoted\".\n\nKept."
        replied = run("reply", thread, body)
        self.assertTrue(replied["ok"], replied)
        message = replied["data"]["thread"]["messages"][1]
        self.assertEqual((message["body"], message["actor"]["name"]), (body, "Test agent"))
        edited = run("edit", message["id"], "Short answer.")
        self.assertEqual(edited["data"]["thread"]["messages"][1]["body"], "Short answer.")
        self.assertIn("--repo is required", subprocess.run([sys.executable, str(HELPER), "list", "--json"], capture_output=True, text=True).stdout)

    def test_older_stores_migrate_and_keep_messages(self):
        # Rebuild the messages table as version 1 and 2 had it: same rows, fewer columns.
        for version, columns, extra in ((1, "sequence,id,thread_id,actor,body,created_at", ""),
                                        (2, "sequence,id,thread_id,actor,body,created_at,reply_requested", ", reply_requested INTEGER NOT NULL DEFAULT 0")):
            with self.subTest(version=version):
                self.store.unlink(missing_ok=True)
                created, _ = self.create(command=f"create-v{version}")
                with sqlite3.connect(self.store) as db:
                    db.executescript(f"""
                        DROP TABLE message_edits; DROP TABLE deliveries;
                        CREATE TABLE old AS SELECT {columns} FROM messages;
                        DROP TABLE messages;
                        CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id), actor TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL{extra});
                        INSERT INTO messages SELECT * FROM old; DROP TABLE old;
                        CREATE INDEX messages_thread ON messages(thread_id,sequence);
                        PRAGMA user_version={version};""")
                thread = self.cli("list")["threads"][0]
                self.assertEqual(thread["messages"][0]["body"], created["thread"]["messages"][0]["body"])
                self.assertFalse(thread["messages"][0]["replyRequested"])
                self.assertIsNone(thread["messages"][0]["editedAt"])
                self.assertFalse(thread["awaitingReply"])
                with sqlite3.connect(self.store) as db:
                    self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
                # The migrated store takes edits.
                message = thread["messages"][0]["id"]
                self.cli("edit", data={"commandId": f"edit-v{version}", "expectedRevision": 1, "actor": HUMAN, "messageId": message, "body": "Edited"})

    def test_deleting_a_reply_keeps_the_thread_deleting_the_comment_removes_it(self):
        created, _ = self.create()
        thread_id, first = created["thread"]["id"], created["thread"]["messages"][0]["id"]
        reply = self.cli("reply", data={"commandId": "r1", "expectedRevision": 1, "actor": AGENT, "threadId": thread_id, "body": "Agent note"})["thread"]["messages"][1]["id"]
        mine = self.cli("reply", data={"commandId": "r2", "expectedRevision": 2, "actor": HUMAN, "threadId": thread_id, "body": "Thanks", "replyRequested": True})["thread"]["messages"][2]["id"]
        self.cli("edit", data={"commandId": "e1", "expectedRevision": 3, "actor": HUMAN, "messageId": first, "body": "Edited"})
        self.cli("delete", data={"commandId": "d0", "expectedRevision": 4, "actor": HUMAN, "messageId": reply}, error="invalid_request")
        kept = self.cli("delete", data={"commandId": "d1", "expectedRevision": 4, "actor": HUMAN, "messageId": mine})
        self.assertEqual(kept["deleted"], {"messageId": mine, "threadId": thread_id, "thread": False})
        self.assertEqual([m["id"] for m in kept["thread"]["messages"]], [first, reply])
        self.assertFalse(kept["thread"]["awaitingReply"])
        gone = self.cli("delete", data={"commandId": "d2", "expectedRevision": 5, "actor": HUMAN, "messageId": first})
        self.assertEqual(gone["deleted"], {"messageId": first, "threadId": thread_id, "thread": True})
        self.assertEqual(self.cli("list")["threads"], [])
        with sqlite3.connect(self.store) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM messages").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM message_edits").fetchone()[0], 0)
        self.cli("delete", data={"commandId": "d3", "expectedRevision": 6, "actor": HUMAN, "messageId": first}, error="not_found")

    def test_delivery_is_recorded_per_message_and_goes_with_it(self):
        created, _ = self.create()
        message = created["thread"]["messages"][0]["id"]
        deliver = {"commandId": "s1", "expectedRevision": 1, "actor": HUMAN, "messageIds": [message], "state": "uncertain", "target": "t7"}
        self.cli("deliver", data={**deliver, "state": "maybe"}, error="invalid_request")
        self.cli("deliver", data={**deliver, "messageIds": ["message_missing"]}, error="not_found")
        self.cli("deliver", data=deliver)
        self.assertEqual(self.cli("list")["threads"][0]["messages"][0]["delivery"]["state"], "uncertain")
        self.cli("deliver", data={**deliver, "commandId": "s2", "expectedRevision": 2, "state": "sent"})
        delivery = self.cli("list")["threads"][0]["messages"][0]["delivery"]
        self.assertEqual((delivery["state"], delivery["target"]), ("sent", "t7"))
        self.cli("deliver", data={**deliver, "commandId": "s3", "expectedRevision": 3, "state": "none"})
        self.assertIsNone(self.cli("list")["threads"][0]["messages"][0]["delivery"])
        self.cli("deliver", data={**deliver, "commandId": "s4", "expectedRevision": 4, "state": "sent"})
        self.cli("delete", data={"commandId": "d1", "expectedRevision": 5, "actor": HUMAN, "messageId": message})
        with sqlite3.connect(self.store) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM deliveries").fetchone()[0], 0)

    def test_only_the_author_edits_a_message_and_the_old_body_is_kept(self):
        created, _ = self.create()
        message = created["thread"]["messages"][0]
        edit = {"commandId": "edit1", "expectedRevision": 1, "actor": AGENT, "messageId": message["id"], "body": "Hijacked"}
        self.cli("edit", data=dict(edit), error="invalid_request")
        self.cli("edit", data={**edit, "commandId": "edit2", "messageId": "message_missing", "actor": HUMAN}, error="not_found")
        edited = self.cli("edit", data={**edit, "commandId": "edit3", "actor": HUMAN, "body": "Why upper case?"})["thread"]
        self.assertEqual(edited["messages"][0]["id"], message["id"])
        self.assertEqual(edited["messages"][0]["body"], "Why upper case?")
        self.assertIsNotNone(edited["messages"][0]["editedAt"])
        self.assertEqual(self.cli("list")["revision"], 2)
        with sqlite3.connect(self.store) as db:
            self.assertEqual(db.execute("SELECT body FROM message_edits WHERE message_id=?", (message["id"],)).fetchall(), [(message["body"],)])

    def test_corrupt_and_newer_stores_fail_without_reset(self):
        self.store.parent.mkdir()
        self.store.write_bytes(b"not a sqlite database")
        self.cli("context", error="storage_error")
        self.assertEqual(self.store.read_bytes(), b"not a sqlite database")
        self.store.unlink()
        with sqlite3.connect(self.store) as db:
            db.execute("PRAGMA user_version=99")
        self.cli("context", error="storage_error")
        with sqlite3.connect(self.store) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 99)


if __name__ == "__main__":
    unittest.main()
