"""Independent CLI acceptance: real Git, real SQLite, fresh helper processes."""

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid


HELPER = Path(__file__).resolve().parents[1] / "backend" / "codewalker.py"
HUMAN = {"kind": "human", "id": "person", "name": "Human reviewer"}
AGENT = {"kind": "agent", "id": "worker-17", "name": "Agent reviewer"}
PATH = "src/example.txt"
ORIGINAL = "alpha\nold value\nomega\n"
MODIFIED = "alpha\nnew value\nomega\n"


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codewalker-acceptance-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / "checkout"
        self.repo.mkdir()
        self.store = self.base / "state" / "review.sqlite3"
        self.env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Acceptance fixture")
        self.git("config", "user.email", "acceptance@example.invalid")
        self.put(PATH, ORIGINAL)
        self.put("unchanged.txt", "Not part of the review\n")
        self.git("add", "--", PATH, "unchanged.txt")
        self.git("commit", "-qm", "fixture baseline")
        self.put(PATH, MODIFIED)

    def git(self, *args, repo=None):
        result = subprocess.run(
            ["git", "-C", str(repo or self.repo), *args],
            env=self.env, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def put(self, path, text):
        destination = self.repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text, encoding="utf-8")

    def invoke(self, command, *args, data=None, root=None, include_root=True):
        argv = [sys.executable, str(HELPER)]
        if include_root:
            argv += ["--repo", str(root or self.repo)]
        argv += ["--store", str(self.store), command, "--json", *args]
        if data is not None:
            argv += ["--data", json.dumps(data, ensure_ascii=False)]
        result = subprocess.run(
            argv, cwd=self.base, env=self.env,
            capture_output=True, text=True, timeout=15,
        )
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            self.fail(f"Non-JSON result: {argv!r}: {result.stdout!r}; {result.stderr!r}: {error}")
        self.assertEqual(response.get("protocolVersion"), 1, response)
        self.assertEqual(result.returncode, 0 if response.get("ok") else 1, response)
        return response

    def call(self, command, *args, **kwargs):
        response = self.invoke(command, *args, **kwargs)
        self.assertTrue(response.get("ok"), response)
        return response["data"]

    def failure(self, command, *args, codes, **kwargs):
        response = self.invoke(command, *args, **kwargs)
        self.assertFalse(response.get("ok"), response)
        self.assertIn(response["error"]["code"], codes, response)
        return response

    def mutation(self, revision, actor=HUMAN, review_id=None, **fields):
        return {
            "commandId": uuid.uuid4().hex,
            "expectedRevision": revision,
            "reviewId": review_id or self.call("context")["reviewId"],
            "actor": dict(actor),
            **fields,
        }

    def review(self, path=PATH, scope="uncommitted", base=None):
        args = ["--scope", scope]
        if base:
            args += ["--base", base]
        if path is not None:
            args += ["--file", path]
        return self.call("review", *args)

    def create(self, *, side="new", path=PATH, line=2, body="Please explain.", actor=HUMAN):
        review = self.review(path)
        payload = self.mutation(
            review["context"]["revision"], actor,
            scope="uncommitted", body=body,
            anchor={"path": path, "side": side, "startLine": line,
                    "endLine": line, "snapshotId": review["snapshotId"]},
        )
        return self.call("create", data=payload), payload

    def source_digest(self):
        entries = []
        for path in sorted(self.repo.rglob("*")):
            relative = path.relative_to(self.repo)
            if relative.parts[0] == ".git":
                continue
            if path.is_symlink():
                entries.append((str(relative), "link", os.readlink(path)))
            elif path.is_file():
                entries.append((str(relative), "file", hashlib.sha256(path.read_bytes()).hexdigest()))
        return entries, (self.repo / ".git/index").read_bytes()

    def test_human_agent_human_round_trip_persists_ids_authors_bodies_and_status(self):
        body = "  Why this change?\n\nKeep this blank line. 日本語\n"
        created, _ = self.create(body=body)
        thread = created["thread"]
        self.assertEqual(thread["messages"][0]["body"], body)
        self.assertEqual(thread["messages"][0]["actor"], HUMAN)
        observed = self.call("list")
        self.assertEqual(observed["threads"][0]["id"], thread["id"])
        reply = self.call("reply", data=self.mutation(
            observed["revision"], AGENT, threadId=thread["id"], body="Rationale.\n\nProposed fix."))
        final = self.call("reply", data=self.mutation(
            reply["revision"], HUMAN, threadId=thread["id"], body="Accepted after that fix."))
        messages = final["thread"]["messages"]
        self.assertEqual([m["actor"]["kind"] for m in messages], ["human", "agent", "human"])
        self.assertEqual(len({m["id"] for m in messages}), 3)
        resolved = self.call("resolve", data=self.mutation(
            final["revision"], threadId=thread["id"], resolved=True))
        restarted = self.call("list")
        self.assertEqual(restarted["threads"][0]["status"], "resolved")
        self.assertEqual(restarted["threads"][0]["messages"], messages)
        reopened = self.call("resolve", data=self.mutation(
            resolved["revision"], AGENT, threadId=thread["id"], resolved=False))
        self.assertEqual(reopened["thread"]["status"], "open")
        agent_root, _ = self.create(actor=AGENT, body="Agent-originated question")
        response = self.call("reply", data=self.mutation(
            agent_root["revision"], HUMAN, threadId=agent_root["thread"]["id"], body="Human answer"))
        self.assertEqual([m["actor"]["kind"] for m in response["thread"]["messages"]], ["agent", "human"])
        self.assertEqual(self.call("context")["reviewId"], created["reviewId"])

    def test_restart_idempotency_and_changed_payload_conflict(self):
        created, payload = self.create(body="Exactly once")
        self.assertEqual(self.call("create", data=payload), created)
        reordered = dict(reversed(list(payload.items())))
        self.assertEqual(self.call("create", data=reordered), created)
        self.failure("create", data={**payload, "body": "Changed content"}, codes={"idempotency_conflict"})
        after = self.call("list")
        self.assertEqual(after["revision"], created["revision"])
        self.assertEqual(len(after["threads"]), 1)
        self.assertEqual(len(after["threads"][0]["messages"]), 1)
        self.assertEqual(self.review()["snapshotId"], payload["anchor"]["snapshotId"])

    def test_review_identity_isolates_branches_and_checkouts_not_processes(self):
        created, _ = self.create()
        stale_reply = self.mutation(created["revision"], AGENT,
                                    threadId=created["thread"]["id"], body="Stale branch reply")
        stale_draft = self.mutation(created["revision"], draftId="stale-draft", body="Old branch text", target={})
        self.git("checkout", "-qb", "other-review")
        self.failure("reply", data=stale_reply, codes={"review_conflict"})
        self.failure("draft-save", data=stale_draft, codes={"review_conflict"})
        other_branch = self.call("list")
        self.assertNotEqual(other_branch["reviewId"], created["reviewId"])
        self.assertEqual(other_branch["threads"], [])
        self.git("checkout", "-q", "main")
        self.assertEqual(self.call("list")["threads"][0]["id"], created["thread"]["id"])
        other_repo = self.base / "other-checkout"
        other_repo.mkdir()
        self.git("init", "-b", "main", repo=other_repo)
        other_context = self.call("context", root=other_repo)
        self.assertNotEqual(other_context["reviewId"], created["reviewId"])
        self.assertEqual(self.call("list", root=other_repo)["threads"], [])

    def test_concurrent_writers_conflict_then_retry_without_lost_messages(self):
        created, _ = self.create()
        requests = [self.mutation(created["revision"], actor,
                                 threadId=created["thread"]["id"], body=body)
                    for actor, body in [(HUMAN, "Concurrent human"), (AGENT, "Concurrent agent")]]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda request: self.invoke("reply", data=request), requests))
        winners = [r for r in results if r["ok"]]
        self.assertEqual(len(winners), 1, results)
        loser_index = next(i for i, result in enumerate(results) if not result["ok"])
        self.assertEqual(results[loser_index]["error"]["code"], "revision_conflict")
        observed = self.call("list")
        retried = {**requests[loser_index], "commandId": uuid.uuid4().hex,
                   "expectedRevision": observed["revision"]}
        self.call("reply", data=retried)
        after = self.call("list")
        self.assertEqual(after["revision"], created["revision"] + 2)
        self.assertCountEqual([m["body"] for m in after["threads"][0]["messages"]],
                              ["Please explain.", "Concurrent human", "Concurrent agent"])

    def test_old_new_anchors_keep_original_evidence_through_edit_rename_delete(self):
        old, _ = self.create(side="old", body="Old-side concern")
        new, _ = self.create(side="new", body="New-side concern")
        ids = {old["thread"]["id"], new["thread"]["id"]}
        self.assertEqual(old["thread"]["anchor"]["snippet"], "old value")
        self.assertEqual(new["thread"]["anchor"]["snippet"], "new value")
        self.put(PATH, "inserted\nalpha\nunrelated replacement\nomega\n")
        after_edit = self.call("list")
        new_thread = next(t for t in after_edit["threads"] if t["id"] == new["thread"]["id"])
        self.assertEqual(new_thread["anchor"]["validity"], "stale")
        self.assertEqual(new_thread["anchor"]["startLine"], 2)
        self.assertEqual(new_thread["anchor"]["snippet"], "new value")
        renamed = self.repo / "src/renamed.txt"
        (self.repo / PATH).rename(renamed)
        self.git("add", "-A")
        after_rename = self.call("list")
        self.assertEqual({t["id"] for t in after_rename["threads"]}, ids)
        self.assertTrue(all(t["anchor"]["path"] == PATH for t in after_rename["threads"]))
        renamed.unlink()
        after_delete = self.call("list")
        self.assertEqual({t["id"] for t in after_delete["threads"]}, ids)
        stale = next(t for t in after_delete["threads"] if t["id"] == new["thread"]["id"])
        self.assertEqual(stale["anchor"]["validity"], "stale")
        replied = self.call("reply", data=self.mutation(
            after_delete["revision"], AGENT, threadId=stale["id"], body="Still discussing the original change"))
        self.assertEqual(replied["thread"]["anchor"]["snippet"], "new value")
        self.assertEqual(len(replied["thread"]["messages"]), 2)

    def test_removed_diff_retains_thread_and_rejects_stale_snapshot_create(self):
        created, payload = self.create()
        # Staged edit cancelled by an unstaged revert is still a net-empty HEAD→worktree diff.
        self.git("add", "--", PATH)
        self.put(PATH, ORIGINAL)
        empty = self.review(path=None)
        self.assertEqual(empty["files"], [])
        self.assertEqual(empty["threads"][0]["id"], created["thread"]["id"])
        self.assertEqual(empty["threads"][0]["anchor"]["validity"], "stale")
        payload = {**payload, "commandId": uuid.uuid4().hex, "expectedRevision": created["revision"]}
        self.failure("create", data=payload, codes={"snapshot_conflict", "invalid_request", "not_found"})
        self.assertEqual(len(self.call("list")["threads"]), 1)

    def test_uncommitted_net_staged_unstaged_untracked_and_ignored(self):
        self.put(PATH, "alpha\nstaged value\nomega\n")
        self.git("add", "--", PATH)
        self.put(PATH, MODIFIED)
        self.put("new [file].txt", "nonignored\n")
        self.put(".gitignore", "ignored.txt\n")
        self.put("ignored.txt", "must stay hidden\n")
        review = self.review()
        self.assertEqual({f["path"] for f in review["files"]},
                         {PATH, "new [file].txt", ".gitignore"})
        rows = [r for h in review["file"]["hunks"] for r in h["rows"]]
        self.assertIn({"kind": "delete", "oldLine": 2, "newLine": None, "text": "old value"}, rows)
        self.assertIn({"kind": "add", "oldLine": None, "newLine": 2, "text": "new value"}, rows)
        self.assertNotIn("staged value", [r["text"] for r in rows])
        untracked = self.review("new [file].txt")
        self.assertEqual(untracked["file"]["hunks"][0]["rows"][0]["newLine"], 1)

    def test_branch_uses_merge_base_and_includes_worktree(self):
        self.put(PATH, ORIGINAL)
        baseline = self.git("rev-parse", "HEAD")
        self.git("checkout", "-qb", "feature")
        self.put("feature.txt", "committed on feature\n")
        self.git("add", "--", "feature.txt")
        self.git("commit", "-qm", "feature fixture")
        self.git("checkout", "-q", "main")
        self.put("base-only.txt", "newer base content\n")
        self.git("add", "--", "base-only.txt")
        self.git("commit", "-qm", "advanced base fixture")
        self.git("checkout", "-q", "feature")
        self.put(PATH, MODIFIED)
        self.put("untracked.txt", "worktree addition\n")
        review = self.review(scope="branch", base="main")
        self.assertEqual(review["baseOid"], baseline)
        self.assertEqual(review["baseRef"], "main")
        self.assertEqual({f["path"] for f in review["files"]}, {PATH, "feature.txt", "untracked.txt"})
        feature = self.review("feature.txt", scope="branch", base="main")
        created = self.call("create", data=self.mutation(
            feature["context"]["revision"], scope="branch", base="main", body="Committed branch discussion",
            anchor={"path": "feature.txt", "side": "new", "startLine": 1, "endLine": 1,
                    "snapshotId": feature["snapshotId"]}))
        local_scope = self.call("list")
        self.assertEqual(local_scope["threads"][0]["id"], created["thread"]["id"])
        self.assertEqual(local_scope["threads"][0]["anchor"]["validity"], "stale")
        restored_scope = self.call("list", "--scope", "branch", "--base", "main")
        self.assertEqual(restored_scope["threads"][0]["anchor"]["validity"], "current")
        self.failure("review", "--scope", "branch", "--base", "missing-ref", codes={"invalid_base"})

    def test_unborn_repository_has_untracked_diff_and_durable_thread(self):
        unborn = self.base / "unborn"
        unborn.mkdir()
        self.git("init", "-b", "main", repo=unborn)
        (unborn / "first.txt").write_text("first line\n", encoding="utf-8")
        review = self.call("review", "--file", "first.txt", root=unborn)
        self.assertIsNone(review["context"]["headOid"])
        self.assertEqual(review["file"]["hunks"][0]["rows"][0]["newLine"], 1)
        payload = self.mutation(review["context"]["revision"], review_id=review["context"]["reviewId"],
                                scope="uncommitted", body="Unborn review",
                                anchor={"path": "first.txt", "side": "new", "startLine": 1,
                                        "endLine": 1, "snapshotId": review["snapshotId"]})
        thread = self.call("create", data=payload, root=unborn)["thread"]
        self.assertEqual(self.call("list", root=unborn)["threads"][0]["id"], thread["id"])

    def test_explicit_root_and_unsafe_paths_never_fall_back_to_browsing(self):
        self.failure("context", include_root=False, codes={"invalid_request"})
        outside = self.base / "not-a-repository"
        outside.mkdir()
        self.failure("context", root=outside, codes={"not_repository"})
        context = self.call("context", root=self.repo / "src")
        self.assertEqual(context["repoRoot"], str(self.repo.resolve()))
        spaced = self.base / "checkout "
        spaced.mkdir()
        self.git("init", "-b", "main", repo=spaced)
        self.assertEqual(self.call("context", root=spaced)["repoRoot"], str(spaced.resolve()))
        self.put(".gitignore", "ignored.txt\n")
        self.put("ignored.txt", "secret ignored file\n")
        snapshot = self.review()
        for path in ["../outside.txt", str(self.repo / PATH), ".git/config", "ignored.txt", "unchanged.txt", "no-such.txt"]:
            with self.subTest(path=path):
                payload = self.mutation(snapshot["context"]["revision"], scope="uncommitted", body="Invalid target",
                                        anchor={"path": path, "side": "new", "startLine": 1,
                                                "endLine": 1, "snapshotId": snapshot["snapshotId"]})
                self.failure("create", data=payload, codes={"invalid_request", "not_found"})
                self.failure("review", "--file", path, codes={"invalid_request", "not_found"})
        self.assertEqual(self.call("list")["threads"], [])

    def test_symlink_binary_and_invalid_range_cannot_expose_or_fake_source(self):
        secret = self.base / "outside-secret.txt"
        secret.write_text("NEVER-EXPOSE-THIS-CONTENT\n", encoding="utf-8")
        (self.repo / "external.txt").symlink_to(secret)
        symlink = self.review("external.txt")
        self.assertNotIn("NEVER-EXPOSE-THIS-CONTENT", json.dumps(symlink))
        (self.repo / "binary.bin").write_bytes(b"\x00binary\xff\n")
        binary = self.review("binary.bin")
        self.assertTrue(binary["file"]["binary"])
        self.assertEqual(binary["file"]["hunks"], [])
        snapshot = self.review()
        for side, start, end in [("new", 0, 1), ("new", 2, 1), ("new", 500, 500), ("invalid", 2, 2)]:
            with self.subTest(side=side, start=start, end=end):
                payload = self.mutation(snapshot["context"]["revision"], scope="uncommitted", body="Invalid range",
                                        anchor={"path": PATH, "side": side, "startLine": start,
                                                "endLine": end, "snapshotId": snapshot["snapshotId"]})
                self.failure("create", data=payload, codes={"invalid_request"})

    def test_review_and_discussion_never_mutate_index_source_or_execute_git_helpers(self):
        marker = self.base / "EXECUTED"
        hook = self.base / "malicious-helper"
        hook.write_text(f"#!/bin/sh\nprintf executed > '{marker}'\n", encoding="utf-8")
        hook.chmod(0o700)
        self.git("config", "diff.external", str(hook))
        self.git("config", "core.fsmonitor", str(hook))
        self.git("config", "diff.probe.textconv", str(hook))
        self.put(".gitattributes", "*.txt diff=probe\n")
        before = self.source_digest()
        created, _ = self.create()
        self.call("reply", data=self.mutation(created["revision"], AGENT,
                                               threadId=created["thread"]["id"], body="No source mutation"))
        self.call("review", "--file", PATH)
        exported = self.call("export")
        self.assertIn("No source mutation", exported["text"])
        self.assertEqual(self.source_digest(), before)
        self.assertFalse(marker.exists(), "Repository-configured executable ran")

    def test_copied_mod_reviews_commits_without_the_source_checkout_or_installer(self):
        # The public distribution boundary is the folder, not the build script.
        copied = self.base / "download" / "mods" / "Codewalker"
        shutil.copytree(HELPER.parent.parent / "mods/Codewalker", copied,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        helper = copied / "backend.py"
        env = {**self.env, "PYTHONPATH": ""}
        result = subprocess.run(
            [sys.executable, str(helper), "--repo", str(self.repo), "--store", str(self.store),
             "review", "--scope", "commit", "--commit", "HEAD", "--file", PATH],
            cwd=self.base, env=env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        review = json.loads(result.stdout)["data"]
        self.assertEqual(review["commitOid"], self.git("rev-parse", "HEAD"))
        rows = review["file"]["hunks"][0]["rows"]
        self.assertIn("old value", [row["text"] for row in rows])
        self.assertNotIn("new value", [row["text"] for row in rows], "working-tree changes are not the selected commit")
        skill = subprocess.run([sys.executable, str(helper), "skill", "--repo", str(self.repo)],
                               cwd=self.base, env=env, capture_output=True, text=True, check=True).stdout
        self.assertIn(str(helper), skill, "agent instructions must point to the distributed helper")
        self.assertNotIn(str(HELPER), skill)

    def test_installer_is_plan_only_preserves_edits_and_rejects_receipt_escape(self):
        scratch = self.base / "fixture" / "home"
        (scratch / "layouts").mkdir(parents=True)
        (scratch / "layouts/main.json").write_text('{"shipped":"layout"}', encoding="utf-8")
        (scratch / "settings.json").write_text('{"unrelated":"preserve"}', encoding="utf-8")
        key_target = self.base / "keys.json"
        key_target.write_text('{"key":"preserve"}', encoding="utf-8")
        (scratch / "keys.json").symlink_to(key_target)
        # An earlier install: the mod as mods/codewalker, a tab-bar copy and a layout.
        legacy = {"layouts/codewalker.json": b"{}\n", "mods/codewalker-tabs/main.js": b"// old\n",
                  "mods/codewalker/main.js": b"// old mod\n", "mods/codewalker/icons/x.svg": b"<svg/>\n"}
        for name, data in legacy.items():
            (scratch / name).parent.mkdir(parents=True, exist_ok=True)
            (scratch / name).write_bytes(data)
        (scratch / "mods/codewalker-tabs/jsconfig.json").write_text("{}", encoding="utf-8")  # Herdr writes this
        (scratch / "codewalker-install.json").write_text(json.dumps({"owner": "herdr-codewalker-local-v1",
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in legacy.items()}}), encoding="utf-8")
        installer = HELPER.parent.parent / "scripts/install.py"

        def run_installer():
            return subprocess.run(
                [sys.executable, str(installer), "--home", str(scratch), *options],
                cwd=self.base, env=self.env, capture_output=True, text=True, timeout=15,
            )

        original_layout = (scratch / "layouts/main.json").read_bytes()
        original_paths = sorted(str(p.relative_to(scratch)) for p in scratch.rglob("*"))
        options = []
        plan = run_installer()
        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(json.loads(plan.stdout)["mode"], "plan")
        self.assertEqual(sorted(str(p.relative_to(scratch)) for p in scratch.rglob("*")), original_paths)
        options = ["--apply"]
        applied = run_installer()
        self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
        self.assertFalse((scratch / "layouts/codewalker.json").exists(), "The old layout stays")
        self.assertFalse((scratch / "mods/codewalker-tabs").exists(), "The old tab-bar copy stays")
        self.assertEqual(sorted(os.listdir(scratch / "mods")), ["Codewalker"], "The mod folder is named Codewalker, with that case")
        self.assertEqual((scratch / "layouts/main.json").read_bytes(), original_layout)
        self.assertEqual((scratch / "settings.json").read_text(), '{"unrelated":"preserve"}')
        self.assertTrue((scratch / "keys.json").is_symlink())
        self.assertEqual(key_target.read_text(), '{"key":"preserve"}')
        self.assertTrue((scratch / "mods/Codewalker/backend.py").is_file())
        private = scratch / "mods/Codewalker/main.js"
        saved = private.read_bytes()
        private.write_bytes(saved + b"\n// user edit\n")
        refused = run_installer()
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(private.read_bytes(), saved + b"\n// user edit\n")
        private.write_bytes(saved)
        victim = self.base / "victim.txt"
        victim.write_bytes(b"Must remain outside installer ownership")
        receipt_path = scratch / "codewalker-install.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["files"]["../../victim.txt"] = hashlib.sha256(victim.read_bytes()).hexdigest()
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        refused = run_installer()
        self.assertNotEqual(refused.returncode, 0, "Unsafe receipt path was accepted")
        self.assertTrue(victim.exists(), "Installer deleted an outside file from a forged receipt")
        self.assertEqual(victim.read_bytes(), b"Must remain outside installer ownership")

    def test_native_adapter_replays_persisted_post_after_transport_loss(self):
        # Only the Herdr process bridge is replaced. Git, protocol, store and adapter are real.
        script = r'''
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const config = JSON.parse(process.argv[1]);
const body = config.body;
const scope = vm.createContext({ console });
const modules = new Map();
const host = new vm.SyntheticModule(["exec"], function () {
  this.setExport("exec", () => { throw new Error("Unexpected real Herdr invocation"); });
}, { context: scope });
async function load(filename) {
  if (modules.has(filename)) return modules.get(filename);
  const module = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), { context: scope, identifier: filename });
  modules.set(filename, module);
  await module.link(specifier => specifier === "herdr" ? host : load(path.resolve(path.dirname(filename), specifier)));
  return module;
}
const module = await load(config.client);
await module.evaluate();
const Client = module.namespace.ReviewClient;
let loseResponse = true;
async function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000 });
  if (result.error) throw result.error;
  const response = { code: result.status, stdout: result.stdout, stderr: result.stderr };
  if (loseResponse && args.includes("create") && JSON.parse(result.stdout).ok) {
    loseResponse = false;
    throw new Error("Simulated transport loss AFTER database commit");
  }
  return response;
}
const first = new Client({ helper: config.helper, execute, store: config.store });
const context = { root: config.root, source: "uncommitted", on: null };
const review = await first.review(context);
Object.assign(context, { reviewId: review.reviewId, revision: review.revision, snapshotId: review.snapshotId });
const file = await first.file(context, "src/example.txt");
context.snapshotId = file.snapshotId;
const intent = { id: "ui-restart-draft", path: "src/example.txt", snapshotId: context.snapshotId,
  anchor: { side: "new", startLine: 2, endLine: 2 }, context: { ...context } };
await first.saveDraft(context, intent, body);
await assert.rejects(first.submit(context, intent, body, "post-survives-restart"), /Simulated transport loss/);
// An independent agent changes the review before recovery; replay must not regress cached revision.
const prefix = [config.helper, "--repo", config.root, "--store", config.store];
const observed = JSON.parse((await execute("python3", [...prefix, "list", "--json"])).stdout).data;
const agentReply = { commandId: "intervening-agent", reviewId: observed.reviewId, expectedRevision: observed.revision,
  actor: { kind: "agent", id: "independent-agent", name: "Independent agent" },
  threadId: observed.threads[0].id, body: "Agent replied before recovery" };
assert.ok(JSON.parse((await execute("python3", [...prefix, "reply", "--json", "--data", JSON.stringify(agentReply)])).stdout).ok);
// New adapter instance models a mod reload: no pending map, promise queue or revision cache survives.
const restarted = new Client({ helper: config.helper, execute, store: config.store });
const fresh = await restarted.review(context);
context.revision = fresh.revision;
const drafts = await restarted.drafts(context);
assert.equal(drafts.length, 1);
const recovered = drafts[0].intent.pendingPost;
assert.ok(recovered, "Exact pending post must survive in the durable draft");
assert.equal(recovered.commandId, "post-survives-restart");
const saved = await restarted.submit(recovered.context, drafts[0].intent, recovered.payload.body, recovered.commandId);
assert.equal(saved.thread.messages.length, 1);
await restarted.deleteDraft(context, drafts[0].id);
const final = await restarted.review(context);
assert.equal(final.threads.length, 1);
assert.equal(final.threads[0].messages.length, 2);
assert.equal(final.threads[0].messages.filter(message => message.body === body).length, 1);
assert.equal((await restarted.drafts(context)).length, 0);
console.log(JSON.stringify({ threadId: final.threads[0].id, messages: final.threads[0].messages.length }));
'''
        body = "Native durable post:\n" + "Detailed reasoning α\n" * 700
        result = subprocess.run(
            ["node", "--experimental-vm-modules", "--input-type=module", "-e", script,
             json.dumps({"client": str(HELPER.parent.parent / "mods/Codewalker/client.js"),
                         "helper": str(HELPER), "root": str(self.repo), "store": str(self.store), "body": body})],
            cwd=self.base, env=self.env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["messages"], 2)
        final = self.call("list")
        self.assertEqual(len(final["threads"]), 1)
        self.assertEqual(final["threads"][0]["messages"][0]["body"], body)

    def test_drafts_are_durable_actor_owned_and_corrupt_store_is_not_reset(self):
        context = self.call("context")
        draft = self.call("draft-save", data=self.mutation(
            context["revision"], draftId="human-draft", body="Unfinished\n\nreply", target={"path": PATH}))
        restarted = self.call("list")
        self.assertEqual(restarted["drafts"][0]["body"], "Unfinished\n\nreply")
        self.failure("draft-save", data=self.mutation(
            draft["revision"], AGENT, draftId="human-draft", body="Overwrite", target={}),
            codes={"invalid_request"})
        self.assertEqual(self.call("list")["drafts"][0]["body"], "Unfinished\n\nreply")
        self.store.write_bytes(b"corrupt database sentinel")
        self.failure("context", codes={"storage_error"})
        self.assertEqual(self.store.read_bytes(), b"corrupt database sentinel")


if __name__ == "__main__":
    unittest.main()
