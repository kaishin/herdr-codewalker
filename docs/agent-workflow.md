# Agent workflow

Codewalker is a local Python 3 CLI shared with the native Herdr review mod. No Pi extension, daemon, MCP server, browser, or chat scraping is needed. Commands read Git; only the separate annotation database is written. They do not stage files, submit chat, or post PR comments.

## 1. Pin the checkout and read a changed file

Replace the three paths below. `FILE` must be in the selected diff; this is not a file browser. Arguments remain separate argv entries, including JSON and paths with spaces.

```sh
CW="$HOME/.config/herdr-app/mods/Codewalker/backend.py"  # installed copy; or <project>/backend/codewalker.py
REPO=/absolute/path/to/checkout
FILE=src/example.py
cw() { python3 "$CW" --repo "$REPO" "$@" --json; }

# Keep exact mutation requests across process restarts until their outcome is known.
REQUESTS="$HOME/.local/state/herdr-codewalker/requests"
mkdir -p "$REQUESTS"
chmod 700 "$REQUESTS"
WORK=$(mktemp -d "$REQUESTS/review.XXXXXX")

cw context
cw review --scope uncommitted                  # Changed paths, pinned identity and revision
cw review --scope uncommitted --file "$FILE" > "$WORK/review.json"
# Alternative: committed + uncommitted branch work since the merge-base with main:
# cw review --scope branch --base main --file "$FILE" > "$WORK/review.json"
```

Each result is one JSON value: `{ok:true,protocolVersion:1,data:...}`. Failures have `ok:false`, `error.code`, `error.message`, optional `error.details`, and exit 1. Check `ok` before using data.

The saved review contains `data.context.{repoRoot,branch,reviewId,revision}`, `data.snapshotId`, explicit comparison refs/OIDs, changed-file summaries, and `data.file.hunks[].rows[]` with old/new Git coordinates. Pin `reviewId`; never infer it from an overlay ID, space title, terminal cwd, or branch label alone. Snapshot IDs identify source content, not discussion revision.

## 2. Create an agent-authored inline thread

This example chooses the first added line, otherwise a deleted/context line. Use a specific inspected range for real review findings; never invent line numbers or rely on display-row indices.

```sh
python3 - "$WORK" <<'PY'
import json, pathlib, sys, uuid
work = pathlib.Path(sys.argv[1])
response = json.loads((work / "review.json").read_text())
assert response["ok"], response
r = response["data"]
rows = [row for hunk in r["file"]["hunks"] for row in hunk["rows"]]
row = next((row for row in rows if row["kind"] == "add"), None)
if row is None:
    row = next((row for row in rows if row["kind"] == "delete"), None)
if row is None:
    row = next((row for row in rows if row["newLine"] is not None), None)
if row is None:
    raise SystemExit("No annotatable text lines in this change")
side = "old" if row["kind"] == "delete" else "new"
line = row["oldLine"] if side == "old" else row["newLine"]
request = {
    "commandId": uuid.uuid4().hex,
    "reviewId": r["context"]["reviewId"],
    "expectedRevision": r["context"]["revision"],
    "actor": {"kind": "agent", "id": "example-agent", "name": "Example agent"},
    "scope": r["scope"], "base": r["baseRef"],
    "anchor": {"path": r["file"]["path"], "side": side,
               "startLine": line, "endLine": line, "snapshotId": r["snapshotId"]},
    "body": "Please confirm the intended behavior at this boundary.\n\nI will preserve this discussion while checking the implementation."
}
(work / "create.json").write_text(json.dumps(request, ensure_ascii=False))
PY
cw create --data "$(cat "$WORK/create.json")" > "$WORK/created.json"
cat "$WORK/created.json"
```

Success returns `data.thread.id`, persistent message IDs/author metadata, original anchor evidence, and the resulting revision. The native mod displays the same thread. Bodies, including blank lines and indentation, are preserved. The backend computes snippet/fingerprints itself. Binary, oversized, unsupported and non-rendered-side targets are rejected rather than assigned fake coordinates.

## 3. Read human feedback and reply in the same thread

`list` returns all discussions for the pinned worktree/branch, including stale/out-of-diff discussions and durable drafts. Polling the revision is sufficient for two-way feedback; there is no ephemeral event subscription to lose.

```sh
cw list --scope uncommitted > "$WORK/list.json"
# Use --scope branch --base main when reviewing that scope.
python3 - "$WORK" <<'PY'
import json, pathlib, sys, uuid
work = pathlib.Path(sys.argv[1])
response = json.loads((work / "list.json").read_text())
assert response["ok"], response
state = response["data"]
thread = next((t for t in state["threads"] if t["status"] == "open"
               and t["messages"][0]["actor"]["kind"] == "human"), None)
if thread is None:
    raise SystemExit("No open human-authored thread; ask the reviewer to add one")
request = {
    "commandId": uuid.uuid4().hex,
    "reviewId": state["reviewId"], "expectedRevision": state["revision"],
    "actor": {"kind": "agent", "id": "example-agent", "name": "Example agent"},
    "threadId": thread["id"],
    "body": "I have read your comment. I will verify this case before proposing a change."
}
(work / "reply.json").write_text(json.dumps(request, ensure_ascii=False))
print("Reply target:", thread["id"], thread["anchor"]["path"])
PY
# Run only after reply.json was produced successfully:
cw reply --data "$(cat "$WORK/reply.json")"
```

### Short replies the reviewer asked for

When the reviewer checks **Ask for a short reply** on a comment, its thread has `awaitingReply: true` in `list`, and `export` marks it `short reply requested`. For each such thread:

1. Read the comment and the anchored code.
2. Post one `reply` in that thread: a few sentences that answer the question or say what you will change. Do not start a long discussion in the review.
3. Continue your work. The reply clears `awaitingReply`.

```sh
cw list --scope uncommitted | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; [print(t["id"], t["anchor"]["path"], t["anchor"]["startLine"]) for t in d["threads"] if t["awaitingReply"]]'
```

To correct your own message, `edit` takes the same mutation envelope plus `messageId` and the new `body`. Only the author can edit; the earlier text is kept in the store and the message shows as edited. `delete` with `messageId` removes your own message for good; deleting the first message of a thread removes the whole thread.

Reply by persistent thread ID, not by creating another line note. Both human and agent can initiate/reply. `anchor.validity:"stale"` preserves the original side/range/snippet; it does not prevent discussion. Do not silently move it to new code. Resolution is explicit and reversible: `resolve --data` takes the same mutation envelope plus `threadId` and `resolved:true|false`.

```sh
cw list --scope uncommitted
cw export --scope uncommitted > "$WORK/export.json"
python3 - "$WORK/export.json" <<'PY'
import json, sys
response = json.load(open(sys.argv[1]))
assert response["ok"], response
print(response["data"]["text"])
PY
```

Export is nonconsuming; it never clears notes or sends/submits agent input.

## Feedback the reviewer sends you

**Send** in Review pastes a message into your terminal: one `###` section per discussion with its path, lines, thread ID, code and messages, then one command: `python3 <helper> skill --repo <checkout>`. It prints how to answer in a thread (rules and a reply/edit/delete recipe, with the paths filled in). `skill` needs no review and returns Markdown, not JSON. Act on the comments. Answer in the thread when it says `short reply requested` (a few sentences), then continue. The reviewer's later sends contain only new comments.

## Show Review to the reviewer

`python3 "$CW" open` in a Herdr terminal opens Review as a pane right of that terminal, for its folder (or `--repo`).

## Conflicts and uncertain outcomes

- **Timeout, interrupted process, or lost response:** first retry the **same command with exactly the saved JSON**, including the same `commandId`, `reviewId`, `expectedRevision`, actor and body. For the create above: `cw create --data "$(cat "$WORK/create.json")"`. Durable deduplication returns the original outcome if it committed; it never appends a second message. The original result may contain an older revision: reload `list` after replay before another mutation.
- **`revision_conflict`:** another actor or draft write advanced the review. Preserve your unsaved text, reload `list`/`review`, inspect any new replies, and reconcile. A newly accepted operation uses the refreshed revision and a **new** command ID. Do not overwrite another actor's draft or automatically resubmit an obsolete conclusion.
- **`snapshot_conflict`:** the source changed. Reload the actual file diff and select the intended current side/range. A new anchor needs the new snapshot and a new command ID; never merely swap the snapshot string without rereading code.
- **`review_conflict`:** checkout/branch identity changed. Keep the original request attached to its original review, return to that context or ask the human. Do not replace its review ID to force the write into another branch.
- **`idempotency_conflict`:** that command ID was reused with different data. Recover the original request or make a deliberate new operation with a new ID; do not retry blindly.
- **`storage_error`:** retain request/draft text and investigate the store/permissions. Never delete or recreate a corrupt database to make the error disappear.

Draft save/delete, thread creation, replies and resolution all share one durable revision. Queue native writes and coalesce autosaves; agents must likewise refresh after accepted mutations. Actor fields provide local attribution, not authentication; the local CLI/store are trusted-user interfaces.

## Store location and backup

`cw context` reports the exact `storePath`. Default: `~/Library/Application Support/herdr-codewalker/reviews.sqlite3` on macOS; `$XDG_DATA_HOME/herdr-codewalker/reviews.sqlite3` or `~/.local/share/herdr-codewalker/reviews.sqlite3` elsewhere. A global `--store /absolute/private/path.sqlite3` override must remain outside the reviewed worktree. Detached HEAD also has durable review identity/storage. Reviews are keyed by actual canonical worktree + branch/detached identity: moving the checkout or renaming the branch does not automatically remap history.

Back up with SQLite's online backup API, not an arbitrary live file copy:

```sh
cw context > "$WORK/context.json"
BACKUP=/absolute/private/path/codewalker-backup.sqlite3
python3 - "$WORK/context.json" "$BACKUP" <<'PY'
import json, os, sqlite3, sys
response = json.load(open(sys.argv[1]))
assert response["ok"], response
source = sqlite3.connect(response["data"]["storePath"])
backup = sqlite3.connect(sys.argv[2])
try:
    source.backup(backup)
finally:
    backup.close()
    source.close()
os.chmod(sys.argv[2], 0o600)
PY
```

The database can contain reviews for several checkouts and private source snippets. Keep backups and saved request JSON private; never commit them. See [protocol.md](protocol.md) for complete field/error/limit contracts and durable draft commands.
