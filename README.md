# Codewalker

Native code review for Herdr: uncommitted, branch and single-commit diffs, old/new line discussions, and durable human–agent replies in one local SQLite store. **Review** opens as a pane beside your agent, with a key or a CLI command, or in the side panel of a layout you own. No webview, external review TUI, file browser, staging or committing. Comments reach an agent only when you choose **Send**.

## Requirements and boundaries

- Installed Herdr desktop with the native mod APIs; verified against `herdr-app 0.1.12` on macOS.
- Python 3.10+ standard library and Git. No npm runtime, database server, network service, API key, or downloaded helper.
- Local checkouts only. A remote space is rejected before local execution; no accidental same-path local fallback.
- Branch review compares the selected local base's **merge-base → working tree**, including committed and uncommitted changes. No automatic fetch.
- Commit review compares **first parent → selected commit**, or empty tree → root commit. Both sides come from Git objects; the index and working tree are excluded. Merge commits use their first parent, not a combined diff.
- Review shows the folder of the pane it opened beside (or `--repo`); never the space's display name. The folder button’s tooltip shows the resolved checkout and branch. Confirm that root before commenting.

## Prepare and validate without changing your app

From this checkout:

```sh
# Read-only plan; refuses occupied names or local edits.
python3 scripts/install.py

# Build a private package in this project. Does not install or activate it.
python3 scripts/install.py --prepare integration --check
```

`--check` **executes** the authored mods in Herdr's hidden initial-render checker. It does not prove layout, painting, scrolling, focus, asynchronous states, or interactions. On macOS, `/tmp` and `/var` are symlinks; use an explicit canonical path for a scratch destination (for example `/private/tmp/codewalker-check`).

The package includes:

- `mods/Codewalker/`: native review and a packaged copy of `backend/codewalker.py` named `backend.py`.
- `codewalker-install.json`: owned-file hashes used to refuse collisions and local edits on later runs.

## Install only after approval

These steps change app-home files; they are **not** performed as part of research or project checks.

```sh
# Copy into the default ~/.config/herdr-app.
python3 scripts/install.py --apply --check
```

`--home /absolute/app-home` or `HERDR_APP_HOME` selects a different app home. The default is `~/.config/herdr-app`. Never target another person's app home. The installer refuses symlinked write destinations/ancestors and unknown or locally modified target files. It does not write `settings.json` or `keys.json`, and leaves shipped mods and layouts, `.state/`, and review data untouched. No occupied private name is overwritten without a matching owned-file receipt. Installation is preflighted and atomic **per file**, not a cross-file transaction; an interrupted install may need inspection before retry. Do not delete the receipt to bypass a collision.

Earlier versions also installed a tab-bar copy (`mods/codewalker-tabs`) and a `codewalker` layout. The installer removes them when they are unchanged; switch to another layout first if `codewalker` is active.

### Open Review

Add a key to your `keys.json` yourself; the installer doesn't edit it:

```json
"cmd-r": "mod.open:Codewalker"
```

The key opens Review as a pane right of the focused pane, for that pane's folder. Press it again in the same tab to close it. In a terminal, `python3 ~/.config/herdr-app/mods/Codewalker/backend.py open` does the same for that terminal (`--repo` for another checkout). The command palette can't list mod commands, so it has no Review entry.

### Open a specific comparison from another mod

Use Herdr's `pane.split` with an explicit target pane and Codewalker's public props. This opens a new review; it does not toggle or replace an existing review or its draft.

```js
import { run } from "herdr";

run("pane.split", {
  direction: "right",
  pane: targetPaneId,
  mod: "Codewalker",
  props: {
    framed: true,
    folder: "/absolute/local/checkout",
    scope: "commit",
    commit: "abc1234", // full/short SHA, tag, or ref such as HEAD~1
  },
});
```

`scope` defaults to `"uncommitted"`. `"branch"` accepts `base`; `"commit"` requires `commit`. These props also work in a layout block. Use an explicit `folder` to pin the checkout; remote execution remains unsupported. Bare `mod.open Codewalker` remains the existing key toggle and cannot take comparison arguments.

From a local Herdr terminal:

```sh
python3 ~/.config/herdr-app/mods/Codewalker/backend.py open \
  --repo /absolute/local/checkout --scope commit --commit HEAD~1
```

`open` validates and resolves the commit before opening a pane, passes its full SHA, and returns the **new** pane ID, folder, scope and `commitOid`. To get data without opening UI, use `review --scope commit --commit <ref> --json`. See [`docs/protocol.md`](docs/protocol.md).

### Review in the side panel (your own layout)

Codewalker ships no layout. In a layout you own (a copy of `main`), it can also sit in the side panel, opened by a **Review** button beside the tab bar, like Files and Changes:

1. Replace the `tabs` block with a row that holds it and the button:

   ```json
   { "id": "tab-bar", "type": "row", "size": { "px": 42 }, "resizable": false, "children": [
     { "id": "tabs", "type": "block", "size": { "weight": 1 }, "window_drag": true, "content": { "mod": "tabs" } },
     { "id": "review-button", "type": "block", "size": { "px": 88 }, "window_drag": true, "content": { "mod": "Codewalker", "props": { "toolbar": true } } }
   ] }
   ```

2. Add Review to the `panel-body` stack, after `changes`:

   ```json
   { "id": "review", "type": "block", "content": { "mod": "Codewalker" } }
   ```

The button adds `"review"` to the shared `workspace.panels` list, so the tab bar remembers Review per space like the other panels. In such a layout the key toggles the side panel instead of a pane. In the side panel Review shows the focused terminal's checkout and follows focus.

## Review flow

1. Open Review (see above). It shows the checkout of the pane it opened beside. Drag the pane edge to widen it: below 760 px the changed files sit above the diff, wider they sit side by side. To review another local checkout, choose the folder button beside the scope controls, enter its absolute path and choose **Open**. There is no folder/file browser.
2. Choose **Uncommitted**, **Branch** (enter a local base ref and choose **Compare**), or **Commit** (enter a SHA/ref such as `HEAD~1` and choose **Show**). Returning to a loaded mode shows its last diff immediately and refreshes in the background. Commit mode displays the resolved short SHA and stays pinned to it on refresh and mode switches. **Show** resolves the input again. Scope tooltips explain the comparisons.
3. Select a changed path. Hover a line and press its **+**, or press an **old or new line number**. Drag across line numbers to select a range on one side; a range stays inside the hunk where it started. Shift-click extends an open comment's range.
4. Write a multiline message and choose **Comment** / **Reply** (⌘/Ctrl+Enter). Choose **Edit** on your own message to change it in place (⌘/Ctrl+Enter saves, Esc cancels); it shows as edited and the store keeps the earlier text. **Delete** asks first; deleting your comment removes its whole thread, replies included, while deleting a reply removes only that reply. Check **Ask for a short reply** to have the agent answer in the thread in a few sentences, then go on with its work; the thread shows **Awaiting reply** until someone answers. Messages show Human/Agent attribution. Resolve/Reopen preserves all replies; resolved discussions fold to one line until shown.
5. The 💬 button beside the scope controls (between Refresh and the folder button; the open count is in its tooltip and, when wide, its label) shows **Discussions**: every thread grouped by file, its code, the first comment and replies indented below. Filter by All, Open or Awaiting reply. **Show in diff** opens the file and starts the diff at the thread's hunk with its card marked; **Reply** does that and opens a reply. Esc or the button returns to the files.
6. **Send n** (after the folder button, icon-only in narrow panels, when you have new comments) pastes your new comments into an agent: each open discussion (marked when its code changed since), with its code, messages and thread ID, then the `backend.py skill` command that tells the agent how to reply in the thread. Pick the agent (the focused one, else the only one in this checkout; agents in this space only), add a note, read the exact message, then **Send**. It types only when the agent is idle (`hc send --if idle`, never `--force`), so a permission prompt is never answered for you. Each comment is sent once: it is recorded as unclear before typing and as sent after. If the answer is lost, Review says so; check the agent's chat, then choose **It arrived** or **I checked · Send again**. Focus moves to the agent after a send.
7. CLI/agent replies and code edits appear on their own: Review watches the checkout and the discussion store (15-second fallback), or choose Refresh. Refresh does not replace editor text. **Discussions on unchanged files** lists paths no longer in the diff; stale anchors keep their original context rather than silently moving.

### Viewed files

Check **Viewed** in the diff header when you finish a file. The file list shows a checkmark and **n of m viewed**; **Hide viewed** filters those rows, and **Show all** brings them back. Hiding the current file keeps its diff and draft open. Opening a file never marks it automatically.

Marks survive restarts in the local SQLite store, separately for each checkout/branch, scope and base ref (or full commit SHA in Commit mode). They match that file's old/new content, paths, status and modes—not the whole review snapshot. Changes to that file make it unviewed again; unrelated commits, files and discussions do not. Returning to the exact marked version restores its mark. Files without reliable content fingerprints (such as oversized worktree files or symlinks) cannot be marked. This is a local checklist, not a GitHub viewed-state sync.

Drafts autosave after 300 ms and before navigation/posting. A save conflict keeps your text and shows an error; refresh and reconcile before retrying. Esc or the composer's close button removes the composer and keeps its saved text; **Discard** deletes the draft. Saved drafts can be restored from the navigator.

Posts use durable idempotency receipts. If a helper response is lost, **Retry saved post** replays the original command, not a new message. The exact envelope is saved with the draft before dispatch, so restoring after a mod/app restart can recover the same attempt. A known accepted post is not retried because draft cleanup failed; cleanup is reported separately. This is deduplicated local mutation, not a claim of exactly-once external delivery.

Long text diffs are paged at 240 rendered rows to keep actual inline editors/buttons within native event-lifetime rules. Binary, oversized and unsupported changes display metadata instead of fake line anchors. This first version is unified diff only; split view, syntax-highlight infrastructure, file editing, forge sync, and remote execution are out of scope.

## Agents use the same store and CLI

See [`docs/agent-workflow.md`](docs/agent-workflow.md) for copyable agent commands and [`docs/protocol.md`](docs/protocol.md) for the exact JSON contract, optimistic revision checks, actor attribution, limits, and recovery rules. Native behavior and the pending manual checklist are in [`docs/ux.md`](docs/ux.md).

```sh
python3 /absolute/herdr-codewalker/backend/codewalker.py \
  --repo /absolute/checkout review --scope uncommitted --json

python3 /absolute/herdr-codewalker/backend/codewalker.py \
  --repo /absolute/checkout list --json
```

The installed copy exposes the identical CLI at `~/.config/herdr-app/mods/Codewalker/backend.py`. Mutations require `reviewId`, `expectedRevision`, a stable `commandId`, and actor metadata. Agents must call this API rather than edit SQLite or scrape a terminal. No agent is launched or authorized by the mod, and it contacts one only when you choose **Send**.

## Data and access

The helper reads local Git metadata and bounded changed-file content. It writes only local review/draft state; source and index remain read-only. On macOS the default store is `~/Library/Application Support/herdr-codewalker/reviews.sqlite3`; other platforms use user-data paths documented in the protocol. Snippets and messages are not encrypted or synchronized. Back up the database using normal SQLite-safe procedures.

Herdr mods are trusted code with the user's process permissions. This package runs `python3` and Git locally; it does not call a model, reach the network, or update itself. **Send** pastes text into the agent terminal you choose, through `hc send --if idle`.

## Verification

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --experimental-vm-modules --test tests/test_ui.mjs
python3 scripts/check-ui.py  # synthetic populated inline/retained/composer states
python3 scripts/install.py --prepare integration --check
```

The UI tests exercise async draft/navigation/post state; independent acceptance tests exercise actual CLI/SQLite/Git and lost-response/restart deduplication. Native initial/eager render checks pass for the review mod. Do not treat a hidden `check` as visual or interaction verification.
