# Codewalker local CLI protocol v1

Implementation owner: backend worker; files `backend/codewalker.py`, `tests/test_backend.py`, `pyproject.toml`, `docs/protocol.md`. Native UI owns its own adapter. Python 3 stdlib only, SQLite transactions, no daemon/network. This document is the implementation contract.

## Invocation and envelope

```text
python3 <absolute-project>/backend/codewalker.py --repo <explicit-folder> <command> --json [options]
```

Arguments are argv entries, never a shell string. `--repo` accepts a folder inside a Git worktree and resolves its canonical root. `--json` is accepted for every command; output is always JSON, except `skill`: it prints Markdown for agents (how to answer review threads, with the helper path and an optional `--repo` filled in), needs no review and never touches the store. `open` (in a Herdr terminal) opens Review as a pane right of that terminal, for `--repo` or the current folder; it returns `{pane, folder}`. Global `--store <absolute-db-path>` is an optional test/backup override. Default DB: OS user-data directory (`~/Library/Application Support/herdr-codewalker/reviews.sqlite3` on macOS; `$XDG_DATA_HOME/herdr-codewalker/reviews.sqlite3` or `~/.local/share/herdr-codewalker/reviews.sqlite3` elsewhere). Never put canonical data in overlay localStorage/cache. No tracked-source/index mutations.

Exactly one stdout JSON value per invocation:

- Success, exit 0: `{ "ok": true, "protocolVersion": 1, "data": <command-result> }`.
- Failure, exit 1: `{ "ok": false, "protocolVersion": 1, "error": { "code": "revision_conflict", "message": "...", "details": { "expectedRevision": 2, "currentRevision": 3 } } }`.
- Error codes: `invalid_request`, `not_repository`, `not_found`, `invalid_base`, `snapshot_conflict`, `review_conflict`, `revision_conflict`, `idempotency_conflict`, `storage_error`, `git_error`, `too_large`. Do not parse stderr for protocol state.

## Read commands

### `context`

Returns `{repoRoot, gitDir, branch, headOid, reviewId, revision, storePath}`. `branch` and `headOid` can be null (detached/unborn). `reviewId` is durable and scoped to actual canonical worktree and branch (detached HEAD has explicit identity), independent of GUI overlay/session and diff scope.

### `review --scope uncommitted|branch [--base <ref>] [--file <repo-relative-path> | --select-first]`

Default scope: uncommitted. Uncommitted is HEAD → net worktree (staged + unstaged + nonignored untracked). Branch is merge-base(selected base, HEAD) → worktree; includes commits **and uncommitted** changes. Base default tries origin/HEAD, main, master; no network fetch. Explicit invalid base fails. Nonignored untracked included; ignored excluded. Paths outside current diff fail rather than opening a browser.

Result:

```json
{
  "context": {"repoRoot":"/repo","gitDir":"/repo/.git","branch":"feature","headOid":"...","reviewId":"review_...","revision":0,"storePath":"..."},
  "scope":"uncommitted", "baseRef":"HEAD", "baseOid":"...", "headOid":"...",
  "snapshotId":"snapshot_...",
  "files":[{"path":"src/a.py","oldPath":null,"status":"modified","additions":1,"deletions":1,"binary":false,"tooLarge":false}],
  "file": {
    "path":"src/a.py", "binary":false,"tooLarge":false,
    "hunks":[{"id":"hunk_...","oldStart":1,"oldLines":1,"newStart":1,"newLines":1,
      "rows":[{"kind":"delete","oldLine":1,"newLine":null,"text":"old"},{"kind":"add","oldLine":null,"newLine":1,"text":"new"}]}]
  },
  "threads":[], "drafts":[]
}
```

Without `--file`, `file` is null (file-list load; no hunks). With `--file`, load that changed file only. `--select-first` (not with `--file`) loads the first changed path in list order, so one read opens a review; `file` stays null when nothing changed. Reads (`context`, `review`, `list`, `export`) never write the store: an initialized store is opened without a write lock and its file is unchanged, so a folder watch on the store wakes only for real writes. `kind` is `context|add|delete|meta`; line coordinates are nullable 1-based Git coordinates, never display-row indices. File status: `added|modified|deleted|renamed|copied|untracked|typechanged`. Hunk rows use 3 context lines; old/new range counts follow unified diff conventions (including zero). Binary/oversized/special-file changes have no fake text rows; surface the flags. Limits and warnings may be added as fields without changing v1.

`threads` contains **all** discussions in this worktree/branch review, not just the selected file. Each thread includes current anchor validity; UI filters by `anchor.path` and side but must keep stale/out-of-diff discussions accessible. `snapshotId` identifies diff content, not discussion revision; reply writes do not change snapshot.

### `list [--scope uncommitted|branch] [--base <ref>]`

Returns `{reviewId,revision,threads,drafts}` with freshly checked anchor validity against the selected scope. Uses the same source semantics as review.

### `export [--scope ...] [--base <ref>]`

Returns the list result plus `text` (readable review with locations, author, messages, resolution and stale labels). Export is nonconsuming and never sends/submits chat or posts to a forge.

## Thread data

```json
{
  "id":"thread_...", "status":"open", "createdAt":"UTC ISO timestamp", "updatedAt":"UTC ISO timestamp",
  "anchor":{"path":"src/a.py","oldPath":null,"side":"new","startLine":1,"endLine":1,
    "snapshotId":"snapshot_...","scope":"uncommitted","baseRef":"HEAD","baseOid":"...","headOid":"...",
    "fingerprint":"sha256...","fileFingerprint":"sha256-of-both-side-identities...","snippet":"new","validity":"current"},
  "messages":[{"id":"message_...","actor":{"kind":"human","id":"local","name":"You"},"body":"Question?","createdAt":"UTC ISO timestamp","replyRequested":true,"editedAt":null,"delivery":null}],
  "awaitingReply":true
}
```

`replyRequested` is true when the author asked for a short reply in this thread. `awaitingReply` is true while the thread is open and its newest message has `replyRequested`. Any later message (normally the agent's reply) or resolving the thread clears it. An agent that sees `awaitingReply` posts a short `reply` (a few sentences) and then continues its work; a long discussion belongs in the agent's own session, not in the review.

`status`: `open|resolved`. `anchor.validity`: `current|stale`; staleness is derived by checking scope, comparison base and both original file-side fingerprints/range evidence, not a destructive retarget. A changed file can be stale. Deleted old-side anchors remain valid while the same diff still applies. Discussions survive a file leaving the diff and can still receive replies.

## Mutations (same for native UI and agents)

All mutations accept `--data <one-JSON-object>` as an argv entry. No stdin dependency in the UI. Required common fields: `reviewId` (the pinned identity from context/review; a worktree/branch mismatch fails `review_conflict`), `commandId` (caller-generated stable unique string; reuse on retry), `expectedRevision` (last read durable review revision), `actor:{kind:"human"|"agent",id:"...",name:"..."}`. Local trusted tool: actor metadata is attribution, not authentication.

Serialize/coalesce native draft writes and thread mutations in one GUI write queue. Reads are not queued behind writes. The GUI runs at most one read and queues only the newest; it drops a read from an earlier checkout/source generation and rereads once when a read reports an older revision than the GUI's own last write. Draft changes increment the same revision as threads; refresh revision after every success. On conflict preserve the unsaved local draft, reload canonical state, and explicitly reconcile instead of overwriting it. Never start a draft autosave from a stale view while a create/reply/resolve is in flight.\n\nEvery accepted mutation increments review revision once, atomically with data and persisted dedup result. Identical `commandId`/semantic JSON replay returns original result even after restart; different payload with the same ID fails. Dedup check precedes expected-revision check. No mutation is acknowledged until SQLite commit succeeds. `review`/`list` do not increment revision.

| Command | Additional `--data` fields | Success data |
| --- | --- | --- |
| `create` | `scope`, optional `base`, `anchor:{path,side,startLine,endLine,snapshotId}`, `body`, optional `replyRequested:true|false` | `{reviewId,revision,thread}` |
| `reply` | `threadId`, `body`, optional `replyRequested:true|false` | `{reviewId,revision,thread}` |
| `resolve` | `threadId`, `resolved:true|false` (explicit set, not toggle) | `{reviewId,revision,thread}` |
| `edit` | `messageId`, `body` | `{reviewId,revision,thread}` |
| `delete` | `messageId` | `{reviewId,revision,deleted:{messageId,threadId,thread},thread?}` |
| `deliver` | `messageIds` (1–1000 distinct), `state:"uncertain"|"sent"|"none"`, optional `target` (terminal address) | `{reviewId,revision,delivered:{messageIds,state}}` |
| `draft-save` | `draftId` (caller-chosen stable ID), `body`, `target` (JSON object: e.g. threadId or creation anchor/scope/base) | `{reviewId,revision,draft}` |
| `draft-delete` | `draftId` | `{reviewId,revision,draftId}` |

Draft: `{id,actor,body,target,updatedAt}`; same durable database, no overlay identity dependency. `target` is an arbitrary JSON object capped at 512 KiB (at least 6× a valid 64 KiB body plus envelope/context allowance), enough to retain an exact pending-post receipt (`commandId`, context, operation, payload) across UI restart. The entire encoded mutation JSON is capped at 1 MiB. This MVP targets this Mac/native Herdr: macOS supports the tested maximum escaped payload. Linux can impose a 128 KiB single-argument ceiling even below the helper budget; no alternate transport is provided in this pass. Exec failures must retain drafts/receipts rather than regenerate a post ID. Native UI must measure encoded JSON size before execution and preserve input on transport rejection. Empty draft body is allowed. Draft deletion is idempotent state-setting (unknown ID succeeds). Drafts belong to an actor ID/kind; one actor cannot overwrite/delete another actor's draft.

`create` verifies the supplied snapshot against fresh source state and validates all anchor lines exist on that side in the selected diff. It computes/persists snippet/fingerprint itself; caller cannot supply invented evidence. Start/end must be positive ordered integers. Mixed old/new selections become one explicit side. `reply` does not retarget the anchor; `resolve` preserves all messages. Plain-text bodies are preserved exactly and must contain non-whitespace content (max 64 KiB UTF-8). Thread resolution is reversible. `edit` replaces the body of the actor's own message (same `actor.kind` and `actor.id`; otherwise `invalid_request`) and sets `editedAt`; the replaced body is kept in `message_edits`. An unchanged body records nothing. `delete` removes the actor's own message for good, with its edit history. Deleting a thread's first message deletes the thread and every reply (`deleted.thread:true`, no `thread` in the result); deleting a later message keeps the thread. No author changes another author's message. `delivery` is `{state, target, at}` or null: Send to agent records `uncertain` before it types and `sent` after; `none` clears a refused send. Deleting a message removes its delivery.

Native UI flow: context → review files → review selected file → mutation using returned context.revision/snapshotId → refresh list/review. Keep failed drafts on conflict; reload and ask/retry with a **new** command ID after reconciling a revision conflict. For a timeout retry the **same** command ID and identical data; do not duplicate the message. Agent flow is identical; polling list/review by revision provides two-way feedback without a broker/event daemon.

## Storage and safety

SQLite schema version 4 (2 adds `messages.reply_requested`; 3 adds `messages.edited_at` and `message_edits`, the bodies that edits replaced; 4 adds `deliveries`, what Send to agent sent; older stores migrate in place, existing messages unchanged); foreign keys, busy timeout, transaction-serialized writers, private user-data path. Retain author/message/thread identity and original anchors across process restart, view close and disconnect. Corrupt/unsupported stores return storage errors instead of resetting state. Schema and unsupported-version errors are not auto-migrated destructively. Read-only Git argv disables optional locks, fsmonitor, hooks, external diff/textconv and configured clean/filter-process drivers (diff itself can invoke conversion filters). Submodules expose gitlink-commit changes only, not dirty nested-worktree contents. Git output capture uses bounded reads from temporary files, a 20 s per-command timeout, and controlled empty stdin; output is capped at 7 MiB. Text is bounded to 2,000,000 bytes / 50,000 Git LF-delimited lines per side; reviews have at most 1,000 changed paths and a 32 MiB aggregate text budget. Over-budget files retain stable fingerprints/stat evidence, explicit metadata/tooLarge/aggregateLimit flags, and a review-level warning. Their raw bodies are released rather than retained; peak hydration is bounded by the aggregate budget plus one bounded file pair. Existing durable snippets are preserved and anchors whose source body is unavailable are conservatively stale. Unsupported encodings/symlinks/special files have no line anchors; repository paths are literal and separated from revisions. Never follow a worktree symlink to read arbitrary external content; represent unsupported/special content explicitly. No automatic checkout/stage/commit/chat submission. Native remote execution requires the helper/Python to exist on that machine; do not fall back to a local database for remote repos.
