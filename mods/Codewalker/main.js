import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Checkbox, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { props, spaces, panes, focused, agents, hc, run, notify, appHome, theme, settings, closeOverlay, nextCommand, watchFolder, layout, shared, setShared } from "herdr";
import { ReviewClient, HUMAN } from "./client.js";
import { dockExpand, RESTORE_TIMEOUT } from "./dock-expand.js";
import { PAGE_ROWS, newId, anchorLabel, rowAnchor, lineOf, splitPath, tint, actorLabel, threadLine, threadIsOutdated, timestamp, readableError, pageRows, discussionGroups, sendable, uncertainCount, sendText, utf8Bytes, markdownBody } from "./model.js";

const stop = (_event, cx) => cx.stop_propagation();
// Recently viewed diffs for the current snapshot only; bounded by files and rows.
const CACHE_FILES = 24, CACHE_ROWS = 60_000;
// One last comparison per scope, only for this checkout. Never cache an editor,
// pending mutation or draft receipt. Cached discussions stay read-only until refreshed.
const COMPARISON_FIELDS = ["root", "reviewId", "snapshotId", "revision", "branch", "resolvedBase",
  "commitOid", "commitParents", "files", "threads", "note", "file", "rows", "fileNote",
  "rowsSnapshot", "rowsFingerprint", "page", "from"];
// Git's object/log writes never change a review; everything else may.
const GIT_NOISE = /\/\.git\/(?:objects|logs)\//;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICON = Object.fromEntries(["git-branch", "plus", "message", "refresh", "folder", "x", "check", "pencil", "reply", "trash", "send", "maximize-2", "minimize-2"].map(name => [name, `mods/Codewalker/icons/${name}.svg`]));
const REVIEW_DOCK = { panel: "panel", stack: "panel-body", child: "review" };
const panelExpander = dockExpand({ layout, run, shared, setShared });
// Icons are Lucide (ISC), written by scripts/lucide_icons.py; see icons/LICENSE.
// Diff columns: old and new line numbers, the hover comment button, the +/− sign.
const MARK_W = 22, SIGN_W = 16, ROW_H = 22;
// Docked beside the agent, Review stacks files above the diff. Wider, they sit side by side.
const SPLIT_W = 760, COMPACT_W = 560;

// Like Changes: the focused terminal's folder, else the active space's. Focus
// in a mod (Review itself) has no folder; then only a space switch moves it.
function location(shownSpace) {
  const space = spaces().find(s => s.active), f = focused();
  if (!space) return null;
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const cwd = pane?.cwd || f?.cwd || null;
  const on = f?.pane === null && cwd ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space.machine ?? null;
  const folder = cwd ?? (space.id !== shownSpace ? space.folder : null);
  return folder ? { space: space.id, folder, on, key: JSON.stringify([folder, on]) } : null;
}
// hc send exit codes that refuse before typing anything: not_found,
// needs_target, blocked, status_mismatch, finished. Anything else is unclear.
const REFUSED = new Set([3, 7, 9, 10, 11]);
const SEND_WARN_BYTES = 8192;
const READY = new Set(["idle", "done"]);
const within = (folder, root) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);

// Review as a pane right of the focused pane, with that pane's folder; if this
// tab already has one, close it instead.
function toggleReviewPane() {
  const all = panes(), here = all.find(p => p.focused);
  if (!here) return;
  const open = all.find(p => p.mod === "Codewalker" && p.tab === here.tab);
  if (open) return run("pane.close", { pane: open.pane });
  run("pane.split", { direction: "right", pane: here.pane, mod: "Codewalker", props: { framed: true, ...(here.cwd ? { folder: here.cwd } : {}) } });
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// The side panel ("panel" / "panel-body") when this layout docks Review in it.
function reviewPanel() {
  const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
  if (!panel || !body?.children?.some(c => c.id === "review")) return null;
  return { on: !panel.hidden && body.active === "review" };
}

function toggleReviewPanel(on) {
  if (on && panelExpander.state(REVIEW_DOCK).expanded) {
    const error = panelExpander.restore();
    if (error) { notify({ title: "Could not restore panel", body: error, level: "error" }); return; }
  }
  if (on) run("layout.hide", { id: "panel" });
  else { run("layout.select", { stack: "panel-body", child: "review" }); run("layout.show", { id: "panel" }); }
}

// The key: the side panel when the layout docks Review, else a pane.
function toggleReview() {
  const docked = reviewPanel();
  if (docked) toggleReviewPanel(docked.on);
  else toggleReviewPane();
}

// A Review button for a layout's tab bar: a block beside the shipped tabs mod,
// the same control as its Files and Changes buttons.
function reviewButton() {
  const t = theme(), on = Boolean(reviewPanel()?.on);
  return h_flex().size_full().pr(10).justify_end().items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("panel-review").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => toggleReviewPanel(on))
      .child(svg("mods/Codewalker/review.svg").size(14)).child("Review"));
}

export default class Codewalker extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // props {toolbar: true}: only the tab-bar button. The shipped tab bar
    // remembers the side panel per space for the panels in "workspace.panels".
    if (p.toolbar) {
      this.toolbar = true;
      const panels = shared("workspace.panels") ?? ["files", "changes"];
      if (!panels.includes("review")) setShared("workspace.panels", [...panels, "review"]);
      return;
    }
    // mod.open Codewalker (a key): only a launcher. It toggles Review (the side
    // panel when the layout docks it, else a pane), then closes itself.
    if (p.launch) {
      this.launcher = true;
      cx.spawn(async () => { toggleReview(); closeOverlay(p.overlay); });
      return;
    }
    // A window opened for one space keeps it. The docked panel follows focus.
    this.fixed = Boolean(p.space || p.folder);
    // Opened as a pane (pane.split with props {framed: true}): Herdr draws the
    // frame and a header with the name, so Review draws neither.
    this.framed = p.framed === true;
    const space = spaces().find(s => s.id === p.space) ?? spaces().find(s => s.active);
    const here = this.fixed ? null : location(null);
    this.spaceId = here?.space ?? space?.id ?? null;
    this.followed = here?.key ?? null;
    this.folder = p.folder ?? here?.folder ?? space?.folder ?? "";
    this.on = p.on ?? here?.on ?? space?.machine ?? null;
    this.askReply = false;
    // Public pane/layout props: folder, scope, base (branch), commit (commit).
    this.source = p.scope ?? "uncommitted";
    this.base = typeof p.base === "string" ? p.base : "";
    this.commitRef = typeof p.commit === "string" ? p.commit : "";
    this.commitOid = null;
    this.file = null;
    this.pendingFile = null;
    this.rowsSnapshot = null;
    this.rowsFingerprint = null;
    this.viewing = null;
    this.cache = new Map();
    this.comparisons = new Map();
    this.cachedComparison = false;
    this.reading = false;
    this.queued = null;
    this.watched = new Set();
    this.expanded = new Set();
    this.hoverRow = null;
    this.drag = null;
    this.page = 0;
    // "files": changed files and a diff. "discussions": every thread, by file.
    this.mode = "files";
    this.filter = "all";
    this.hideViewed = false;
    // Show in diff: the row the diff starts at, the thread to place, the card to mark.
    this.from = null;
    this.jumpTo = null;
    this.focusThread = null;
    this.files = [];
    this.threads = [];
    this.rows = [];
    // Until the first size report: a docked panel is narrow, a window wide.
    this.width = this.fixed || p.overlay ? 1100 : 400;
    this.height = 800;
    this.cols = { num: 46, inset: 46 * 2 + MARK_W, edge: 16 };
    this.loading = false;
    this.saving = false;
    this.draftStatus = "";
    this.contextVersion = 0;
    this.handle = cx.focus_handle();
    this.client = new ReviewClient({ helper: p.helper ?? `${appHome()}/mods/Codewalker/backend.py` });
    this.rootInput = InputState.new({ placeholder: "Absolute path of a local Git checkout", value: this.folder });
    this.baseInput = InputState.new({ placeholder: "Base ref, e.g. main", value: this.base });
    this.commitInput = InputState.new({ placeholder: "Commit SHA or ref, e.g. HEAD~1", value: this.commitRef || "HEAD" });
    this.commitInput.on("change", (_event, cx) => cx.notify());
    this.composer = TextareaState.new({ placeholder: "Leave a comment", rows: 3 });
    this.composer.set_auto_grow(3, 7);
    this.composer.on("change", (_event, cx) => {
      this.draftStatus = "Saving draft…";
      this.draftTimer?.cancel();
      this.draftTimer = cx.timer.after(300, cx => this.persistDraft(cx));
      cx.notify();
    });
    this.composer.on("submit", (event, cx) => { if (event.secondary && !event.shift) this.submit(cx); });
    // Send to agent: the chosen terminal, an optional note, and the last outcome.
    this.sendTarget = null;
    this.sendAgain = false;
    this.sending = false;
    this.sendNotice = null;
    this.sendNote = InputState.new({ placeholder: "Optional note for the agent" });
    this.sendNote.on("change", (_event, cx) => cx.notify());
    // One message edit at a time, in place of the message body.
    this.editing = null;
    this.confirmDelete = null;
    this.editor = TextareaState.new({ rows: 3 });
    this.editor.set_auto_grow(2, 8);
    this.editor.on("change", (_event, cx) => cx.notify());
    this.editor.on("submit", (event, cx) => { if (event.secondary && !event.shift) this.saveEdit(cx); });
    this.rootInput.on("submit", (_event, cx) => this.changeRoot(cx));
    this.baseInput.on("submit", (_event, cx) => this.applySource("branch", cx));
    this.commitInput.on("submit", (_event, cx) => this.applySource("commit", cx));
    this.refresh(cx);
    // Folder watches drive refresh (see watch); this slow timer only covers missed events.
    cx.timer.every(15000, cx => { if (!this.reading) this.refresh(cx, true); });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "refresh") this.refresh(cx);
        if (command === "expand") this.toggleExpansion(cx);
        cx.notify();
      }
    });
  }

  // One control family: 26px (22px small), like Herdr's toolbar. Ghost buttons sit inside cards.
  button(id, label, action, o = {}) {
    const t = theme(), enabled = o.enabled !== false, size = o.small ? 22 : 26;
    const fg = !enabled ? t.dim : o.danger ? t.ansi1 : o.primary ? t.solid_foreground : o.selected ? t.foreground : t.muted;
    const bg = o.danger ? tint(t.ansi1, 0x1a) : o.primary ? (enabled ? t.solid : t.raised) : o.selected ? t.selected : "#00000000";
    const body = h_flex().gap(5).items_center().justify_center().text_color(fg)
      .when(Boolean(o.icon), el => el.child(svg(o.icon).size(o.small ? 12 : 13).flex_none().text_color(fg)))
      .when(Boolean(label), el => el.child(label));
    return Button.new(id).h(size).flex_none().rounded(6).text_size(o.small ? 11 : 12).text_color(fg).bg(bg)
      .when(Boolean(label), el => el.px(o.small ? 7 : 10)).when(!label, el => el.w(size))
      // A labelled button always shows its edge; only icon-only ghosts are bare.
      .when(!o.primary && (!o.ghost || Boolean(label)), el => el.border_1().border_color(o.danger ? tint(t.ansi1, 0x66) : t.border))
      .when(enabled, el => el.cursor_pointer().hover(s => o.danger ? s.bg(tint(t.ansi1, 0x33)) : s.bg(o.primary ? t.solid : t.hover).text_color(o.primary ? t.solid_foreground : t.foreground)))
      .when(Boolean(o.tooltip), el => el.tooltip(o.tooltip))
      .disabled(!enabled).accessibility_label(o.label ?? o.tooltip ?? label)
      .on_mouse_down("left", stop)
      .on_click((_event, cx) => { if (enabled) action(cx); }).child(body);
  }

  expansionState() {
    if (this.toolbar || this.framed || props()?.overlay || !reviewPanel()?.on) return null;
    return panelExpander.state(REVIEW_DOCK);
  }

  watchExpansion(cx) {
    this.expansionTimer?.cancel();
    this.expansionTimer = cx.timer.after(RESTORE_TIMEOUT + 250, cx => {
      this.expansionTimer = null;
      panelExpander.reconcile();
      const error = panelExpander.state(REVIEW_DOCK).error;
      if (error) this.error = error;
      cx.notify();
    });
  }

  reconcileExpansion(cx) {
    if (this.expansionChecking || !panelExpander.needsReconcile()) return;
    this.expansionChecking = true;
    cx.spawn(async cx => {
      try {
        const outcome = panelExpander.reconcile();
        if (outcome === "restored") { this.expansionTimer?.cancel(); this.expansionTimer = null; }
        else if (outcome === "timeout") this.error = panelExpander.state(REVIEW_DOCK).error;
        else if (outcome) this.watchExpansion(cx);
      } finally { this.expansionChecking = false; }
      // Shared state and layout changes already redraw us. In particular, do
      // not notify for "waiting": commands may not have reached Herdr yet.
    });
  }

  toggleExpansion(cx) {
    const state = this.expansionState();
    if (!state?.supported || state.restoring || state.reason === "at-max") return;
    const error = state.expanded ? panelExpander.restore() : panelExpander.expand(REVIEW_DOCK, "Codewalker");
    if (error) this.error = error;
    this.watchExpansion(cx);
    cx.notify();
  }

  async close() {
    this.expansionTimer?.cancel();
    this.draftTimer?.cancel();
    if (this.intent && this.composer.value().trim()) {
      try { await this.client.saveDraft(this.intent.context ?? this.context(), this.intent, this.composer.value()); }
      catch (error) { console.log(`Codewalker draft was not saved on close: ${readableError(error)}`); }
    }
  }

  context() {
    return { root: this.root ?? this.folder, on: this.on, source: this.source, baseRef: this.base || undefined, commitRef: this.commitOid ?? this.commitRef, reviewId: this.reviewId, snapshotId: this.snapshotId, revision: this.revision };
  }

  refresh(cx, quiet = false) {
    this.read(cx, { quiet });
  }

  // One helper read returns the file list, discussions, drafts and one file's
  // hunks. At most one read runs; a newer request replaces the queued one.
  read(cx, { path, quiet = true, retry = false, resolveCommit = false } = {}) {
    if (!this.folder) return;
    const want = { path: path === undefined ? this.pendingFile ?? this.file : path, quiet, retry, resolveCommit };
    if (!quiet) { this.loading = true; this.error = null; }
    if (this.reading) {
      this.queued = { ...want, quiet: quiet && (this.queued?.quiet ?? true) };
      return;
    }
    this.reading = true;
    const version = this.contextVersion, context = this.context();
    if (resolveCommit && this.source === "commit") context.commitRef = this.commitRef;
    cx.spawn(async cx => {
      let next = null;
      try {
        const review = await this.client.review(context, want.path);
        if (version !== this.contextVersion) return;
        // A read that began before our own write must not roll discussions back. Retry once.
        if (!this.apply(review, want, cx)) next = { ...want, quiet: true, retry: true };
      } catch (error) {
        if (version === this.contextVersion) this.error = `${this.cachedComparison ? "Showing the last loaded comparison. Refresh before making changes. " : ""}${readableError(error)}`;
      }
      finally {
        if (version === this.contextVersion) {
          this.reading = false;
          next = this.queued ?? next;
          this.queued = null;
          if (next) this.read(cx, next);
          else this.loading = false;
        }
        cx.notify();
      }
    });
    if (!quiet) cx.notify();
  }

  apply(review, want, cx) {
    const same = review.reviewId === this.reviewId;
    if (same && !want.retry && Number.isInteger(this.revision) && review.revision < this.revision) return false;
    if (!same || review.snapshotId !== this.snapshotId) this.cache.clear();
    this.comparisons.delete(this.source);
    this.cachedComparison = false;
    this.root = review.root;
    this.reviewId = review.reviewId;
    this.snapshotId = review.snapshotId;
    this.revision = review.revision;
    this.branch = review.branch;
    this.resolvedBase = review.baseOid;
    if (this.source === "commit") {
      this.commitOid = review.commitOid;
      this.commitParents = review.parentCount;
    }
    if (this.source === "branch") this.base = review.baseRef ?? this.base;
    if (this.source === "branch" && !this.baseInput.value()) this.baseInput.set_value(this.base);
    this.files = review.files;
    this.threads = review.threads;
    this.note = review.note;
    this.error = null;
    if (!this.intent && !this.draftsLoaded && review.drafts) {
      this.drafts = review.drafts;
      this.draftsLoaded = true;
    }
    if (review.detail) this.remember(review.detail);
    this.watch(cx, review.root, review.storePath);
    const wanted = this.pendingFile ?? this.file ?? review.detail?.path ?? this.files[0]?.path ?? this.threads[0]?.path ?? null;
    if (!wanted) {
      this.file = this.pendingFile = this.rowsSnapshot = this.rowsFingerprint = null;
      this.rows = [];
      this.fileNote = null;
      return true;
    }
    const detail = review.detail?.path === wanted ? review.detail : want.path === wanted ? { path: wanted, rows: [], note: null } : this.cached(wanted);
    if (detail) { this.show(wanted, detail); return true; }
    // Still waiting for the selected file: keep showing the previous one, fresh if this read covered it.
    if (review.detail && review.detail.path === this.file) this.show(this.file, review.detail);
    this.pendingFile = wanted;
    this.queued ??= { path: wanted, quiet: true };
    return true;
  }

  show(path, detail) {
    if (this.file !== path) { this.page = 0; this.from = null; this.hoverRow = null; this.drag = null; }
    this.file = path;
    this.pendingFile = null;
    this.rows = detail.rows;
    this.fileNote = detail.note;
    // Anchors use the snapshot of the rows the person saw, so a changed diff is rejected.
    this.rowsSnapshot = this.snapshotId;
    this.rowsFingerprint = detail.diffFingerprint ?? null;
  }

  remember(detail) {
    const key = `${this.snapshotId}\u0000${detail.path}`;
    this.cache.delete(key);
    this.cache.set(key, detail);
    let rows = 0;
    for (const entry of this.cache.values()) rows += entry.rows.length;
    for (const [old, entry] of this.cache) {
      if (this.cache.size <= CACHE_FILES && rows <= CACHE_ROWS) break;
      if (old === key) continue;
      this.cache.delete(old);
      rows -= entry.rows.length;
    }
  }

  cached(path) {
    return this.cache.get(`${this.snapshotId}\u0000${path}`) ?? null;
  }

  // Like Herdr's Changes sidebar: refresh when the checkout changes, and when
  // the discussion store changes so agent replies appear without polling.
  watch(cx, root, storePath) {
    if (this.on) return;
    const store = storePath ? storePath.slice(0, storePath.lastIndexOf("/")) : null;
    const watched = this.watched, version = this.contextVersion;
    for (const folder of [root, store]) {
      if (!folder || watched.has(folder)) continue;
      watched.add(folder);
      cx.spawn(async cx => {
        try {
          while (version === this.contextVersion) {
            const paths = await watchFolder(folder);
            if (version !== this.contextVersion) break;
            if (folder === root && paths.every(path => GIT_NOISE.test(path))) continue;
            // Our own draft saves need no reread; a post or resolve rereads explicitly.
            if (folder === store && Date.now() - (this.client.lastWrite ?? 0) < 1500) continue;
            this.soon(cx);
          }
        } catch { /* The fallback timer still refreshes. */ }
        finally { watched.delete(folder); }
      });
    }
  }

  soon(cx) {
    if (this.soonTimer) return;
    this.soonTimer = cx.timer.after(500, cx => { this.soonTimer = null; this.refresh(cx, true); });
  }

  wrote(result) {
    if (result?.reviewId === this.reviewId && Number.isInteger(result.revision)) this.revision = Math.max(this.revision ?? 0, result.revision);
  }

  // Mark only the diff actually displayed, never the newer list's fingerprint
  // while a file read is pending. No optimistic mark: a failed save stays unseen.
  setViewed(viewed, cx) {
    const file = this.files.find(file => file.path === this.file);
    if (this.cachedComparison || !file || !this.rowsFingerprint || file.diffFingerprint !== this.rowsFingerprint
        || this.pendingFile || this.viewing || this.saving || this.leaving || this.postAttempt) return;
    const context = this.context(), version = this.contextVersion;
    const attempt = { path: file.path, fingerprint: this.rowsFingerprint, viewed };
    this.viewing = attempt;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.setFileViewed(context, attempt.path, attempt.fingerprint, viewed);
        if (version !== this.contextVersion || context.reviewId !== this.reviewId) return;
        // Another writer's newer read may already have undone this mark.
        if (result.revision >= this.revision) {
          this.files = this.files.map(file => file.path === attempt.path && file.diffFingerprint === attempt.fingerprint
            ? { ...file, viewed } : file);
        }
        this.wrote(result);
        this.refresh(cx, true);
      } catch (error) {
        if (version === this.contextVersion) this.error = `Could not save viewed state. Refresh to check it before retrying. ${readableError(error)}`;
      } finally {
        if (this.viewing === attempt) this.viewing = null;
        cx.notify();
      }
    });
  }

  visibleFiles() {
    return this.hideViewed ? this.files.filter(file => !file.viewed) : this.files;
  }

  viewedBox(file) {
    const t = theme(), checked = file.viewed === true;
    const enabled = !this.cachedComparison && Boolean(this.rowsFingerprint) && file.diffFingerprint === this.rowsFingerprint
      && !this.pendingFile && !this.viewing && !this.saving && !this.leaving && !this.postAttempt;
    const hint = !file.diffFingerprint ? "This change has no reliable content fingerprint"
      : "Mark this version of the file as viewed; new changes clear the mark";
    return div().id("viewed-tip").flex_none().tooltip(hint).child(Checkbox.new("file-viewed").checked(checked).disabled(!enabled)
      .accessibility_label(`Viewed ${file.path}`)
      .when(enabled, el => el.cursor_pointer())
      .on_mouse_down("left", stop).on_change((value, cx) => this.setViewed(value, cx))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(enabled ? t.foreground : t.dim)
        .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
          .border_color(checked ? t.accent : t.border).bg(checked ? t.accent : t.background)
          .when(checked, el => el.child(svg(ICON.check).size(11).text_color(t.accent_foreground))))
        .child(this.viewing?.path === file.path ? "Saving…" : "Viewed")));
  }

  // The docked panel shows the focused terminal's checkout, like Changes. A
  // folder inside the shown checkout is the same review. A draft is saved
  // before switching; a failed save keeps this review and its text.
  follow(cx) {
    if (this.fixed) return;
    const here = location(this.spaceId);
    if (!here || here.key === this.followed) { this.following = null; return; }
    if (this.root && here.on === this.on && within(here.folder, this.root)) { this.followed = here.key; this.spaceId = here.space; return; }
    if (this.following === here.key) return;
    this.following = here.key;
    this.withSavedDraft(cx, cx => {
      this.following = null;
      this.followed = here.key;
      this.spaceId = here.space;
      this.folder = here.folder;
      this.on = here.on;
      this.editRoot = false;
      this.rootInput.set_value(this.folder);
      this.resetContext();
      this.refresh(cx);
    });
  }

  changeRoot(cx) {
    const folder = this.rootInput.value();
    if (!folder.trim()) return;
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(folder)) { this.error = "Use an absolute local checkout path so review targeting does not depend on a shell's folder."; cx.notify(); return; }
    if (folder === this.folder && !this.on) { this.editRoot = false; cx.notify(); return; }
    this.withSavedDraft(cx, cx => {
      // Holds until focus moves to another folder.
      this.folder = folder;
      this.followed = location(this.spaceId)?.key ?? this.followed;
      this.on = null;
      this.editRoot = false;
      this.resetContext();
      this.refresh(cx);
    });
  }

  comparisonKey() {
    return JSON.stringify([this.folder, this.on, this.source, this.source === "branch" ? this.base : this.source === "commit" ? this.commitRef : null]);
  }

  rememberComparison() {
    if (!this.reviewId || !this.snapshotId || this.cachedComparison) return;
    this.comparisons.set(this.source, {
      key: this.comparisonKey(),
      state: Object.fromEntries(COMPARISON_FIELDS.map(field => [field, this[field]])),
      cache: new Map(this.cache), expanded: new Set(this.expanded),
    });
  }

  restoreComparison() {
    const saved = this.comparisons.get(this.source);
    if (!saved || saved.key !== this.comparisonKey()) return false;
    Object.assign(this, saved.state);
    this.cache = new Map(saved.cache);
    this.expanded = new Set(saved.expanded);
    this.cachedComparison = true;
    return true;
  }

  applySource(source, cx, { resolveCommit = true } = {}) {
    if (this.saving || this.leaving || this.sending || this.viewing || this.editing?.saving) return;
    const base = this.baseInput.value().trim(), commit = this.commitInput.value().trim();
    if (source === "commit" && !commit) { this.error = "Enter a commit SHA or ref."; cx.notify(); return; }
    if (source === "branch" && !base) { this.error = "Enter a local base ref before opening a branch comparison."; cx.notify(); return; }
    if (source === this.source && (source === "commit" ? !resolveCommit && this.commitRef === commit : source !== "branch" || this.base === base)) {
      this.pickBase = false;
      cx.notify();
      return;
    }
    this.withSavedDraft(cx, cx => {
      this.rememberComparison();
      this.source = source;
      this.pickBase = false;
      this.base = base;
      this.commitRef = commit;
      this.resetContext({ keepComparisons: true });
      const restored = this.restoreComparison();
      this.read(cx, { quiet: restored, resolveCommit });
      cx.notify();
    });
  }

  resetContext({ keepComparisons = false } = {}) {
    this.contextVersion++;
    if (!keepComparisons) this.comparisons.clear();
    this.cachedComparison = false;
    this.commitOid = null;
    this.commitParents = null;
    this.loading = false;
    this.reading = false;
    this.queued = null;
    this.soonTimer?.cancel();
    this.soonTimer = null;
    this.watched = new Set();
    this.cache.clear();
    this.pendingFile = null;
    this.rowsSnapshot = null;
    this.rowsFingerprint = null;
    this.viewing = null;
    this.root = null;
    this.reviewId = null;
    this.snapshotId = null;
    this.revision = null;
    this.file = null;
    this.files = [];
    this.rows = [];
    this.threads = [];
    this.note = this.fileNote = this.branch = this.resolvedBase = null;
    this.page = 0;
    this.from = null;
    this.jumpTo = null;
    this.focusThread = null;
    this.editing = null;
    this.confirmDelete = null;
    this.editor.set_value("");
    this.hoverRow = null;
    this.drag = null;
    this.expanded = new Set();
    this.intent = null;
    this.composer.set_value("");
    this.drafts = [];
    this.draftsLoaded = false;
    this.draftStatus = "";
    this.error = null;
  }

  withSavedDraft(cx, action) {
    if (!this.intent || !this.composer.value().trim()) { action(cx); return; }
    if (this.postAttempt) { this.error = "A post has an uncertain result. Retry that post before changing checkout, source, or draft."; cx.notify(); return; }
    const context = this.intent.context ?? this.context(), intent = this.intent, body = this.composer.value();
    this.leaving = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.wrote(await this.client.saveDraft(context, intent, body));
        if (this.intent?.id === intent.id && this.composer.value() === body) action(cx);
        else this.error = "The draft changed while saving. Your newer text is still here; try again.";
      }
      catch (error) { this.error = `Cannot leave this draft yet: ${readableError(error)}`; }
      finally { this.leaving = false; cx.notify(); }
    });
  }

  pickFile(path, cx) {
    this.withSavedDraft(cx, cx => {
      this.focusThread = null;
      this.intent = null;
      this.composer.set_value("");
      this.open(path, cx);
      cx.notify();
    });
  }

  // A recently viewed file shows at once; otherwise the previous diff stays,
  // dimmed, until the new one arrives. No blank flash between files.
  open(path, cx) {
    const hit = this.cached(path);
    if (hit) this.show(path, hit);
    else if (path !== this.file || this.rowsSnapshot !== this.snapshotId) {
      this.pendingFile = path;
      this.read(cx, { path });
    } else this.pendingFile = null;
  }

  begin(anchor, cx, thread = null) {
    if (this.cachedComparison) return;
    this.withSavedDraft(cx, cx => {
      this.intent = { id: newId(), path: thread?.path ?? this.file, anchor, threadId: thread?.id ?? null, snapshotId: this.rowsSnapshot ?? this.snapshotId, context: this.context(), replyRequested: this.askReply };
      this.composer.set_value("");
      this.composer.focus();
      this.draftStatus = "";
      this.mutationId = null;
      cx.notify();
    });
  }

  // Show in diff: the thread's file, starting at its hunk, its card marked.
  // A reply opens the composer there too. The same file keeps an open draft.
  showThread(thread, cx, reply = false) {
    const go = cx => {
      this.mode = "files";
      this.focusThread = thread.id;
      this.jumpTo = { id: thread.id, path: thread.path };
      if (thread.path !== (this.pendingFile ?? this.file)) this.open(thread.path, cx);
      if (reply) this.begin(thread.anchor, cx, thread);
      cx.notify();
    };
    if (reply || thread.path === (this.pendingFile ?? this.file)) go(cx);
    else this.withSavedDraft(cx, cx => { this.intent = null; this.composer.set_value(""); go(cx); });
  }

  // Once the thread's rows are shown, start the diff at its hunk. A thread
  // whose code changed has no row; it is listed first instead.
  settleJump() {
    const jump = this.jumpTo;
    if (!jump || this.pendingFile || this.file !== jump.path) return;
    this.jumpTo = null;
    this.from = null;
    const thread = this.threads.find(item => item.id === jump.id);
    if (!thread || threadIsOutdated(thread)) return;
    const { side, line } = threadLine(thread);
    let at = this.rows.findIndex(row => lineOf(row, side) === line);
    if (at < 0) return;
    while (at > 0 && this.rows[at].kind !== "@") at--;
    this.from = at;
  }

  canAnchor() {
    return !(this.cachedComparison || this.saving || this.leaving || this.postAttempt || this.pendingFile);
  }

  selectAnchor(anchor, extend, cx) {
    if (!this.canAnchor()) return;
    const open = this.intent && !this.intent.threadId && this.intent.path === this.file ? this.intent.anchor : null;
    if (!extend && open && open.side === anchor.side && open.startLine === anchor.startLine && open.endLine === anchor.endLine) { this.composer.focus(); return; }
    if (extend && this.intent && !this.intent.threadId && this.intent.path === this.file && this.intent.anchor.side === anchor.side) {
      const startLine = Math.min(this.intent.anchor.startLine, anchor.startLine), endLine = Math.max(this.intent.anchor.endLine, anchor.endLine);
      const available = new Set(this.rows.map(row => anchor.side === "old" ? row.oldLine : row.newLine));
      for (let line = startLine; line <= endLine; line++) {
        if (!available.has(line)) { this.error = "A range cannot span hidden or missing diff lines. Choose lines within the same visible context."; cx.notify(); return; }
      }
      this.intent.anchor = { side: anchor.side, startLine, endLine };
      this.persistDraft(cx);
      cx.notify();
      return;
    }
    this.begin(anchor, cx);
  }

  // Press a line number (or the hover "+"), drag across lines, release: one
  // range on one side, kept inside the hunk where it started.
  pressLine(index, side, event, cx) {
    const row = this.rows[index];
    if (!this.canAnchor() || !row) return;
    if (!lineOf(row, side)) side = side === "old" ? "new" : "old";
    if (!lineOf(row, side)) return;
    if (event.modifiers?.shift) { this.selectAnchor(rowAnchor(row, side), true, cx); return; }
    this.drag = { side, start: index, end: index, file: this.file, snapshot: this.rowsSnapshot };
    cx.notify();
  }

  hoverLine(index, hovered, cx) {
    if (!hovered) {
      if (this.hoverRow === index) { this.hoverRow = null; cx.notify(); }
      return;
    }
    let changed = this.hoverRow !== index;
    this.hoverRow = index;
    if (this.drag) {
      const end = this.reach(index);
      if (end !== this.drag.end) { this.drag = { ...this.drag, end }; changed = true; }
    }
    if (changed) cx.notify();
  }

  reach(target) {
    const { side, start } = this.drag, hunk = this.rows[start]?.hunkId, step = target >= start ? 1 : -1;
    let end = start;
    for (let i = start + step; step > 0 ? i <= target : i >= target; i += step) {
      const row = this.rows[i];
      if (!row || row.kind === "@" || row.hunkId !== hunk) break;
      if (lineOf(row, side)) end = i;
    }
    return end;
  }

  release(cx) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const a = lineOf(this.rows[drag.start], drag.side), b = lineOf(this.rows[drag.end], drag.side);
    if (a && b && drag.file === this.file && drag.snapshot === this.rowsSnapshot) this.selectAnchor({ side: drag.side, startLine: Math.min(a, b), endLine: Math.max(a, b) }, false, cx);
    cx.notify();
  }

  // Esc and the close button keep the draft; Discard deletes it.
  closeComposer(cx) {
    this.withSavedDraft(cx, cx => { this.intent = null; this.composer.set_value(""); this.draftsLoaded = false; this.handle.focus(); this.refresh(cx, true); cx.notify(); });
  }

  discard(cx) {
    const intent = this.intent;
    if (!intent || this.saving || this.leaving || this.postAttempt) return;
    this.draftTimer?.cancel();
    this.intent = null;
    this.composer.set_value("");
    this.draftStatus = "";
    this.handle.focus();
    cx.spawn(async cx => {
      try { this.wrote(await this.client.deleteDraft(intent.context ?? this.context(), intent.id)); }
      catch (error) { if (error.code !== "not_found") this.error = `The draft closed but was not deleted: ${readableError(error)}`; }
      this.draftsLoaded = false;
      this.refresh(cx, true);
      cx.notify();
    });
    cx.notify();
  }

  // The agent answers this comment in a few sentences here, then goes on with its work.
  setAskReply(checked, cx) {
    if (!this.intent || this.saving || this.leaving || this.postAttempt) return;
    this.askReply = checked;
    this.intent = { ...this.intent, replyRequested: checked };
    if (this.composer.value().trim()) this.persistDraft(cx);
    cx.notify();
  }

  persistDraft(cx) {
    if (!this.intent || !this.reviewId) return;
    const context = this.intent.context ?? this.context(), intent = { ...this.intent }, body = this.composer.value();
    cx.spawn(async cx => {
      try {
        const saved = await this.client.saveDraft(context, intent, body);
        this.wrote(saved);
        if (this.intent?.id === intent.id && this.composer.value() === body) this.draftStatus = body.trim() ? "Draft saved locally" : "";
      } catch (error) { if (this.intent?.id === intent.id) this.draftStatus = `Draft not saved: ${readableError(error)}`; }
      cx.notify();
    });
  }

  restoreDraft(draft, cx) {
    if (this.cachedComparison) return;
    this.withSavedDraft(cx, cx => {
      this.intent = draft.intent ?? { id: draft.id, path: draft.path, anchor: draft.anchor, threadId: draft.threadId };
      const receipt = this.intent.pendingPost;
      this.postAttempt = receipt ? { context: receipt.context, intent: this.intent, body: receipt.payload.body, commandId: receipt.commandId } : null;
      this.composer.set_value(draft.body);
      this.open(draft.path, cx);
      this.draftStatus = receipt ? "An earlier post may have succeeded. Post again to recover its exact saved command." : "Restored local draft";
      this.composer.focus();
      cx.notify();
    });
  }

  submit(cx) {
    if (!this.intent || !this.composer.value().trim() || this.saving || this.leaving || !this.reviewId) return;
    const attempt = this.postAttempt ?? { context: this.intent.context ?? this.context(), intent: { ...this.intent }, body: this.composer.value(), commandId: newId() };
    const { context, intent, body, commandId } = attempt;
    this.saving = true;
    this.error = null;
    this.postNotice = null;
    this.draftTimer?.cancel();
    cx.spawn(async cx => {
      try {
        // Before the first post, make its body durable. Never regenerate an uncertain post's envelope.
        if (!this.postAttempt) await this.client.saveDraft(context, intent, body);
        this.postAttempt = attempt;
        const saved = await this.client.submit(context, intent, body, commandId);
        this.postAttempt = null;
        this.wrote(saved);
        if (this.intent?.id === intent.id && this.composer.value() === body) {
          this.intent = null;
          this.composer.set_value("");
          this.draftStatus = "Discussion saved";
          try { await this.client.deleteDraft(context, intent.id); }
          catch (error) { this.postNotice = `Discussion saved. Its saved retry draft remains because cleanup failed: ${readableError(error)}`; }
        } else if (this.intent?.id === intent.id) {
          // Native input should be disabled while posting; still defend programmatic/queued changes.
          this.intent = { ...intent, id: newId(), threadId: saved.thread.id, context: this.context() };
          this.draftStatus = "Posted the earlier text. Your newer text is kept as a reply draft.";
          await this.client.saveDraft(this.intent.context, this.intent, this.composer.value());
        }
        this.draftsLoaded = false;
        this.refresh(cx, true);
      } catch (error) {
        this.error = readableError(error);
        if (["revision_conflict", "snapshot_conflict", "review_conflict", "invalid_request", "not_found"].includes(error.code)) this.postAttempt = null;
        else if (this.postAttempt) this.error += " The post may have succeeded. Post again to retry the same command, without duplication.";
      } finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  mine(message) {
    return message.actor?.kind === HUMAN.kind && message.actor?.id === HUMAN.id;
  }

  startEdit(message, cx) {
    if (this.cachedComparison || !this.mine(message) || this.editing?.id === message.id) return;
    if (this.editing && this.editor.value() !== this.editing.body) { this.error = "Save or cancel the open edit first."; cx.notify(); return; }
    this.editing = { id: message.id, body: message.body, commandId: newId() };
    this.editor.set_value(message.body);
    this.editor.focus();
    cx.notify();
  }

  cancelEdit(cx) {
    if (!this.editing || this.editing.saving) return;
    this.editing = null;
    this.editor.set_value("");
    this.handle.focus();
    cx.notify();
  }

  // The same command retries an uncertain save; a conflict needs a fresh one.
  saveEdit(cx) {
    const edit = this.editing, body = this.editor.value();
    if (!edit || edit.saving || !body.trim()) return;
    if (body === edit.body) { this.cancelEdit(cx); return; }
    edit.saving = true;
    this.error = null;
    cx.spawn(async cx => {
      try {
        this.wrote(await this.client.editMessage(this.context(), edit.id, body, edit.commandId));
        if (this.editing === edit) { this.editing = null; this.editor.set_value(""); this.handle.focus(); }
        this.refresh(cx, true);
      } catch (error) {
        this.error = `The edit was not saved; your text is kept. ${readableError(error)}`;
        if (["revision_conflict", "idempotency_conflict"].includes(error.code)) edit.commandId = newId();
      } finally { edit.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  // Two steps: Delete asks, the red Delete removes. The first comment takes
  // its thread (and every reply) with it.
  deleteMessage(message, cx) {
    if (this.cachedComparison || !this.mine(message) || this.saving) return;
    if (this.confirmDelete !== message.id) { this.confirmDelete = message.id; cx.notify(); return; }
    this.saving = true;
    this.error = null;
    cx.spawn(async cx => {
      try {
        const result = await this.client.deleteMessage(this.context(), message.id, newId());
        this.wrote(result);
        this.confirmDelete = null;
        if (this.editing?.id === message.id) { this.editing = null; this.editor.set_value(""); }
        const gone = result?.deleted?.thread ? result.deleted.threadId : null;
        if (gone) {
          this.threads = this.threads.filter(thread => thread.id !== gone);
          if (this.focusThread === gone) this.focusThread = null;
          // A reply being written to it stays a saved draft.
          if (this.intent?.threadId === gone) this.closeComposer(cx);
        }
        this.refresh(cx, true);
      } catch (error) { this.error = `Not deleted: ${readableError(error)}`; }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  // Agents in the active space. Ones working in this checkout come first,
  // then the active tab, then the most recent.
  candidates() {
    const f = focused(), space = f?.space ?? spaces().find(s => s.active)?.id;
    return agents().filter(agent => agent.space === space).map(agent => {
      const cwd = panes().find(pane => pane.pane === agent.pane)?.cwd ?? null;
      return { ...agent, cwd, here: Boolean(this.root && cwd && within(cwd, this.root)), sameTab: agent.tab === f?.tab };
    }).sort((a, b) => (b.here - a.here) || (b.sameTab - a.sameTab) || (b.seq - a.seq));
  }

  // The picked agent while it exists; else the focused one; else the only
  // one in this checkout. Never a guess between several.
  target(list = this.candidates()) {
    const picked = list.find(agent => agent.address === this.sendTarget);
    if (picked) return picked;
    const here = list.filter(agent => agent.here);
    return list.find(agent => agent.focused) ?? (here.length === 1 ? here[0] : list.length === 1 ? list[0] : null);
  }

  openSend(cx) {
    if (this.mode !== "send") this.backMode = this.mode;
    this.mode = "send";
    this.sendAgain = false;
    this.sendNotice = null;
    cx.notify();
  }

  // "uncertain" is recorded before typing, "sent" after; a refusal clears it.
  // A lost answer stays uncertain until the person checks the agent's chat.
  send(cx) {
    const target = this.target(), items = sendable(this.threads, { again: this.sendAgain });
    if (this.cachedComparison || !target || !READY.has(target.status) || !items.length || this.sending || !this.reviewId) return;
    const ids = items.flatMap(item => item.messageIds), context = this.context();
    const text = sendText({ items, root: this.root, branch: this.branch, helper: this.client.helper, note: this.sendNote.value() });
    const name = target.program?.name ?? target.title ?? target.address;
    this.sending = true;
    this.sendNotice = null;
    cx.spawn(async cx => {
      try {
        try { this.wrote(await this.client.deliver(context, ids, "uncertain", target.address, newId())); }
        catch (error) { this.sendNotice = { error: `Nothing was sent: ${readableError(error)}` }; return; }
        let result;
        try { result = await hc(["send", "--json", "--if", "idle", target.address, text]); }
        catch (error) { this.sendNotice = { error: `Delivery is unclear (${readableError(error)}). Check ${name}'s chat.` }; return; }
        if (result.code !== 0) {
          const reason = (() => { try { return JSON.parse(result.stderr || result.stdout).error?.message; } catch { return null; } })() ?? `hc exited ${result.code}`;
          if (!REFUSED.has(result.code)) { this.sendNotice = { error: `Delivery is unclear (${reason}). Check ${name}'s chat.` }; return; }
          try { this.wrote(await this.client.deliver(context, ids, "none", target.address, newId())); } catch { /* Stays uncertain: the person can check. */ }
          this.sendNotice = { error: `Not sent: ${reason}.` };
          return;
        }
        try { this.wrote(await this.client.deliver(context, ids, "sent", target.address, newId())); }
        catch (error) { this.sendNotice = { error: `Sent to ${name}, but not recorded (${readableError(error)}). It shows as unclear.` }; return; }
        this.sendNote.set_value("");
        this.sendAgain = false;
        this.mode = this.backMode ?? "files";
        notify({ title: "Sent to agent", body: `${items.length} ${items.length === 1 ? "discussion" : "discussions"} to ${name}` });
        run("pane.focus", { terminal: target.address });
      } finally { this.sending = false; this.refresh(cx, true); cx.notify(); }
    });
    cx.notify();
  }

  // After checking the agent's chat: the unclear send did arrive.
  markArrived(cx) {
    const ids = this.threads.flatMap(thread => thread.messages.filter(message => this.mine(message) && message.delivery?.state === "uncertain").map(message => message.id));
    if (this.cachedComparison || !ids.length || this.sending) return;
    this.sending = true;
    cx.spawn(async cx => {
      try { this.wrote(await this.client.deliver(this.context(), ids, "sent", this.threads.flatMap(t => t.messages).find(m => ids.includes(m.id))?.delivery?.target ?? "", newId())); this.sendNotice = null; }
      catch (error) { this.sendNotice = { error: readableError(error) }; }
      finally { this.sending = false; this.refresh(cx, true); cx.notify(); }
    });
    cx.notify();
  }

  setStatus(thread, cx) {
    if (this.cachedComparison || this.saving) return;
    this.saving = true;
    cx.spawn(async cx => {
      try { this.wrote(await this.client.setStatus(this.context(), thread.id, thread.status === "resolved" ? "open" : "resolved", newId())); this.refresh(cx, true); }
      catch (error) { this.error = readableError(error); }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  cardHeader(t, children) {
    return h_flex().min_h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border).children(children);
  }

  threadCard(thread, cx, orphan = false) {
    const t = theme(), outdated = threadIsOutdated(thread), resolved = thread.status === "resolved";
    // Resolved discussions fold to one line until opened; history is never removed.
    const open = !resolved || this.expanded.has(thread.id), count = thread.messages.length;
    const toggle = cx => { if (this.expanded.has(thread.id)) this.expanded.delete(thread.id); else this.expanded.add(thread.id); cx.notify(); };
    return v_flex().id(`thread-${thread.id}`).ml(orphan ? 12 : this.cols.inset).mr(this.cols.edge).my(6).rounded(8).border_1().border_color(this.focusThread === thread.id ? t.accent : t.border).bg(t.surface).text_size(12).overflow_hidden()
      .child(this.cardHeader(t, [
        svg(ICON.message).size(13).flex_none().text_color(resolved ? t.dim : t.muted),
        div().flex_none().font_semibold().text_color(resolved ? t.muted : t.foreground).child(anchorLabel(thread.anchor)),
        div().flex_none().px(6).py(1).rounded(4).text_size(10).bg(resolved ? t.raised : tint(t.accent, 0x26)).text_color(resolved ? t.muted : t.accent).child(resolved ? "Resolved" : "Open"),
        ...(thread.awaitingReply ? [div().flex_none().px(6).py(1).rounded(4).text_size(10).bg(tint(t.working, 0x26)).text_color(t.working).child("Awaiting reply")] : []),
        ...(outdated ? [this.pill("Code changed since", t.ansi1)] : orphan ? [div().flex_none().text_size(11).text_color(t.blocked).child("Outside this page")] : []),
        div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(open ? "" : `${count} ${count === 1 ? "message" : "messages"}`),
        ...(resolved ? [this.button(`toggle-${thread.id}`, open ? "Hide" : "Show", toggle, { small: true, ghost: true })] : []),
        this.button(`status-${thread.id}`, resolved ? "Reopen" : "Resolve", cx => this.setStatus(thread, cx), { small: true, icon: resolved ? null : ICON.check, enabled: !this.cachedComparison && !this.saving }),
      ]))
      .when(open && outdated && Boolean(thread.anchor?.snippet), el => el.child(div().px(12).py(8).border_b(1).border_color(t.border).bg(t.background).font_family(settings().font_family).text_size(11).text_color(t.muted)
        .child(Array.isArray(thread.anchor.snippet) ? thread.anchor.snippet.join("\n") : thread.anchor.snippet)))
      .when(open, el => el.child(v_flex().px(12).py(10).gap(12).children(thread.messages.map((message, index) => this.messageView(message, "message", index === 0))))
        .when(!resolved || this.commentActions(thread, "message").length > 0, el => el.child(h_flex().px(12).pb(10).gap(6).items_center()
          .when(!resolved, el => el.child(this.button(`reply-${thread.id}`, "Reply", cx => this.begin(thread.anchor, cx, thread), { small: true, ghost: true, icon: ICON.reply, enabled: !this.cachedComparison && !this.saving })))
          .children(this.commentActions(thread, "message")))));
  }

  // Edit and Delete for the thread's first comment sit with Reply; later
  // replies carry their own.
  commentActions(thread, prefix) {
    const first = thread.messages[0];
    if (this.cachedComparison || !first || !this.mine(first) || this.editing?.id === first.id || this.confirmDelete === first.id || this.saving || this.postAttempt) return [];
    return [
      this.button(`${prefix}-edit-${first.id}`, "Edit", cx => this.startEdit(first, cx), { small: true, ghost: true, icon: ICON.pencil, label: "Edit your comment" }),
      this.button(`${prefix}-delete-${first.id}`, "Delete", cx => this.deleteMessage(first, cx), { small: true, ghost: true, icon: ICON.trash, label: "Delete this comment and its thread" }),
    ];
  }

  messageView(message, prefix = "message", first = false) {
    const t = theme(), actor = actorLabel(message), edit = this.editing?.id === message.id ? this.editing : null;
    const canEdit = !this.cachedComparison && this.mine(message) && !edit && !this.saving && !this.postAttempt, confirming = this.confirmDelete === message.id;
    return v_flex().id(`${prefix}-${message.id}`).gap(3).text_size(12)
      .child(h_flex().gap(6).items_center()
        .child(div().font_semibold().text_color(t.foreground).child(actor.name))
        .when(actor.kind === "Agent", el => el.child(div().px(5).rounded(4).text_size(10).bg(tint(t.accent, 0x26)).text_color(t.accent).child("Agent")))
        .child(div().text_size(10).text_color(t.dim).child(timestamp(message.createdAt)))
        .when(Boolean(message.editedAt), el => el.child(div().text_size(10).text_color(t.dim).child("· edited")))
        .when(message.replyRequested === true, el => el.child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child("· asked for a short reply")))
        .child(div().flex_1())
        .when(canEdit && !confirming && !first, el => el
          .child(this.button(`${prefix}-edit-${message.id}`, "Edit", cx => this.startEdit(message, cx), { small: true, ghost: true, icon: ICON.pencil, label: "Edit your message" }))
          .child(this.button(`${prefix}-delete-${message.id}`, "Delete", cx => this.deleteMessage(message, cx), { small: true, ghost: true, icon: ICON.trash, label: first ? "Delete this comment and its thread" : "Delete this reply" }))))
      // Markdown, selectable so text can be copied. Links open only on http(s).
      .when(!edit, el => el.child(TextView.markdown(`${prefix}-body-${message.id}`, markdownBody(message.body)).selectable(true).w_full().text_size(12).text_color(t.foreground)
        .on_link_click((url, cx) => { if (/^https?:\/\//i.test(url)) cx.open_url(url); })))
      .when(confirming && !edit, el => el.child(h_flex().gap(8).pt(4).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi1).child(first ? "Delete this comment and its whole thread, replies included?" : "Delete this reply?"))
        .child(this.button(`${prefix}-keep-${message.id}`, "Keep", cx => { this.confirmDelete = null; cx.notify(); }, { small: true, ghost: true, enabled: !this.saving }))
        .child(this.button(`${prefix}-confirm-delete-${message.id}`, this.saving ? "Deleting…" : first ? "Delete thread" : "Delete", cx => this.deleteMessage(message, cx), { small: true, danger: true, icon: ICON.trash, enabled: !this.saving }))))
      .when(Boolean(edit), el => el
        .child(div().mt(2).px(10).py(8).rounded(6).bg(t.background).border_1().border_color(t.accent).cursor_text().on_mouse_down("left", stop)
          .child(Textarea.new(this.editor).w_full().text_size(12).text_color(t.foreground).disabled(edit.saving)))
        .child(h_flex().gap(8).pt(4).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.width >= COMPACT_W ? "⌘/Ctrl+Enter saves · Esc cancels" : ""))
          .child(this.button(`${prefix}-cancel-edit`, "Cancel", cx => this.cancelEdit(cx), { small: true, ghost: true, enabled: !edit.saving }))
          .child(this.button(`${prefix}-save-edit`, edit.saving ? "Saving…" : "Save", cx => this.saveEdit(cx), { small: true, primary: true, enabled: !edit.saving && Boolean(this.editor.value().trim()) }))));
  }

  pill(text, color) {
    return div().flex_none().px(6).py(1).rounded(4).text_size(10).bg(tint(color, 0x26)).text_color(color).child(text);
  }

  // Every discussion, by file: the first comment, replies indented under it.
  discussionsView(cx) {
    const t = theme(), compact = this.width < COMPACT_W;
    const count = filter => discussionGroups(this.threads, this.files, filter).reduce((sum, group) => sum + group.threads.length, 0);
    const groups = discussionGroups(this.threads, this.files, this.filter);
    const filters = [["all", "All"], ["open", "Open"], ["awaiting", compact ? "Awaiting" : "Awaiting reply"]];
    const items = [];
    for (const group of groups) {
      const { name, dir } = splitPath(group.path), status = group.file?.status;
      const statusColor = status === "A" ? t.ansi2 : status === "D" ? t.ansi1 : status ? t.ansi3 : t.dim;
      items.push(Button.new(`group-${group.path}`).w_full().h(32).flex_none().px(14).cursor_pointer().bg(t.raised).border_y(1).border_color(t.border)
        .hover(s => s.bg(t.hover)).accessibility_label(`Show ${group.path} in the diff`).tooltip("Show this file's diff")
        .on_mouse_down("left", stop).on_click((_event, cx) => { this.mode = "files"; this.pickFile(group.path, cx); })
        .child(h_flex().w_full().gap(7).items_center()
          .child(div().w(12).flex_none().text_size(11).font_family(settings().font_family).text_color(statusColor).child(status ?? "•"))
          .child(div().flex_none().font_semibold().text_size(12).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(group.file ? dir : `${dir ? `${dir} · ` : ""}not in this diff`))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(group.threads.length)))));
      for (const thread of group.threads) items.push(this.discussionItem(thread));
    }
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_none().h(26).p(2).gap(2).items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
          .children(filters.map(([filter, label]) => {
            const on = this.filter === filter;
            return Button.new(`filter-${filter}`).h(20).px(8).rounded(5).text_size(12).bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
              .cursor_pointer().hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).accessibility_label(`Show ${label.toLowerCase()} discussions`)
              .on_mouse_down("left", stop).on_click((_event, cx) => { this.filter = filter; cx.notify(); })
              .child(h_flex().gap(5).items_center().child(label).child(div().text_size(11).text_color(t.dim).child(String(count(filter)))));
          })))
        .child(div().flex_1()))
      .child(v_flex().id("review-discussions").flex_1().min_h(0).overflow_y_scrollbar().pb(16).children(items)
        .when(!items.length, el => el.child(this.threads.length
          ? this.emptyState(this.filter === "open" ? "No open discussions" : "No discussions awaiting a reply", "Choose All to see every discussion.")
          : this.emptyState("No discussions yet", "Drag across line numbers in a diff to start one."))));
  }

  sendView() {
    const t = theme(), list = this.candidates(), target = this.target(list), unclear = uncertainCount(this.threads);
    const items = sendable(this.threads, { again: this.sendAgain });
    const text = items.length ? sendText({ items, root: this.root, branch: this.branch, helper: this.client.helper, note: this.sendNote.value() }) : "";
    const bytes = utf8Bytes(text), ready = Boolean(target) && READY.has(target.status);
    const status = agent => READY.has(agent.status) ? ["Ready", t.idle] : agent.status === "working" ? ["Working", t.working] : agent.status === "blocked" ? ["Needs you", t.blocked] : [agent.status, t.dim];
    const why = !items.length ? (unclear ? "Nothing new. Check the unclear send below." : "Nothing new to send. Comments you write are sent once.")
      : !target ? (list.length ? "Choose an agent." : "No agent in this space. Start one, then come back.")
      : !ready ? `${target.program?.name ?? "The agent"} is ${status(target)[0].toLowerCase()}. Send when it is ready; prompts are never answered for you.` : "";
    const section = text => div().px(14).pt(14).pb(6).text_size(11).font_semibold().text_color(t.dim).child(text);
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON.send).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(items.length ? `Send ${items.length} ${items.length === 1 ? "discussion" : "discussions"} to an agent` : "Send to agent"))
        .child(this.button("close-send", "", cx => { this.mode = this.backMode ?? "files"; cx.notify(); }, { small: true, ghost: true, icon: ICON.x, tooltip: "Back" })))
      .child(v_flex().id("review-send").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
        .when(unclear > 0, el => el.child(v_flex().mx(14).mt(12).p(10).gap(8).rounded(8).border_1().border_color(tint(t.blocked, 0x66)).bg(tint(t.blocked, 0x14))
          .child(div().text_size(12).text_color(t.blocked).child(`${unclear} ${unclear === 1 ? "discussion was" : "discussions were"} sent, but delivery is unclear. Check the agent's chat first.`))
          .child(h_flex().gap(6)
            .child(this.button("mark-arrived", "It arrived", cx => this.markArrived(cx), { small: true, icon: ICON.check, enabled: !this.cachedComparison && !this.sending }))
            .child(this.button("send-again", this.sendAgain ? "Included below" : "I checked · Send again", cx => { this.sendAgain = !this.sendAgain; cx.notify(); }, { small: true, selected: this.sendAgain, enabled: !this.sending })))))
        .child(section("Agent"))
        .child(v_flex().px(8).gap(1)
          .children(list.map(agent => {
            const [label, color] = status(agent), on = target?.address === agent.address;
            return Button.new(`agent-${agent.address}`).w_full().min_h(32).flex_none().px(8).rounded(6).cursor_pointer()
              .bg(on ? t.selected : "#00000000").hover(s => s.bg(on ? t.selected : t.hover)).accessibility_label(`Send to ${agent.program?.name ?? agent.address}`)
              .on_mouse_down("left", stop).on_click((_event, cx) => { this.sendTarget = agent.address; cx.notify(); })
              .child(h_flex().w_full().gap(8).items_center().text_size(12)
                .child(div().size(14).flex_none().flex().items_center().justify_center().rounded_full().border_1().border_color(on ? t.accent : t.border)
                  .when(on, el => el.child(div().size(6).rounded_full().bg(t.accent))))
                .child(div().flex_none().font_semibold().text_color(t.foreground).child(agent.program?.name ?? agent.app ?? "Agent"))
                .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child([agent.tab_name, agent.here ? "" : "other folder"].filter(Boolean).join(" · ")))
                .child(this.pill(label, color)));
          }))
          .when(!list.length, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted).child("No agent in this space."))))
        .child(section("Note"))
        .child(div().mx(14).h(28).px(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
          .child(Input.new(this.sendNote).h_full().text_size(12).text_color(t.foreground)))
        .child(section(text ? `Message · ${(bytes / 1024).toFixed(1)} KB` : "Message"))
        .when(bytes > SEND_WARN_BYTES, el => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).child("Long message: agents read it all at once. Consider resolving or sending fewer discussions.")))
        .child(div().mx(14).px(10).py(8).rounded(6).bg(t.surface).border_1().border_color(t.border).font_family(settings().font_family).text_size(11).text_color(t.muted)
          .child(text || "Nothing to send.")))
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11).text_color(this.sendNotice?.error ? t.blocked : t.dim)
          .child(this.sendNotice?.error ?? (why || "Pastes into the agent only when it is idle.")))
        .child(this.button("send-to-agent", this.sending ? "Sending…" : "Send", cx => this.send(cx), { small: true, primary: true, icon: ICON.send, enabled: !this.cachedComparison && !this.sending && ready && items.length > 0 })));
  }

  // Toolbar Send: shown while there is something new (or unclear) to send, and in the Send view.
  sendButton() {
    const count = sendable(this.threads).length, on = this.mode === "send";
    return this.button("open-send", this.width < COMPACT_W ? "" : count ? `Send ${count}` : "Unclear", cx => { if (on) { this.mode = this.backMode ?? "files"; cx.notify(); } else this.openSend(cx); },
      { primary: count > 0 && !on, selected: on, icon: ICON.send, label: "Send to agent", tooltip: on ? "Back" : count ? `Send ${count} new ${count === 1 ? "discussion" : "discussions"} to an agent` : "A send is unclear; check it" });
  }

  discussionItem(thread) {
    const t = theme(), resolved = thread.status === "resolved", outdated = threadIsOutdated(thread);
    const open = !resolved || this.expanded.has(thread.id), [first, ...replies] = thread.messages;
    const lines = String(thread.anchor?.snippet ?? "").split("\n"), last = thread.messages.at(-1);
    const toggle = cx => { if (this.expanded.has(thread.id)) this.expanded.delete(thread.id); else this.expanded.add(thread.id); cx.notify(); };
    return v_flex().id(`discussion-${thread.id}`).px(14).py(10).gap(8).border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().text_color(resolved ? t.muted : t.foreground).child(anchorLabel(thread.anchor)))
        .child(resolved ? div().flex_none().px(6).py(1).rounded(4).text_size(10).bg(t.raised).text_color(t.muted).child("Resolved") : this.pill("Open", t.accent))
        .when(thread.awaitingReply === true, el => el.child(this.pill("Awaiting reply", t.working)))
        .when(outdated, el => el.child(this.pill("Code changed since", t.ansi1)))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(open ? (last ? timestamp(last.createdAt) : "") : `${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`))
        .child(this.button(`list-status-${thread.id}`, resolved ? "Reopen" : "Resolve", cx => this.setStatus(thread, cx), { small: true, icon: resolved ? null : ICON.check, enabled: !this.cachedComparison && !this.saving })))
      .when(open && Boolean(lines[0]), el => el.child(v_flex().px(8).py(6).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(settings().font_family).text_size(11).text_color(t.muted)
        .children(lines.slice(0, 3).map(line => div().truncate().child(line || " ")))
        .when(lines.length > 3, el => el.child(div().text_color(t.dim).child(`… ${lines.length - 3} more ${lines.length - 3 === 1 ? "line" : "lines"}`)))))
      .when(open && Boolean(first), el => el.child(this.messageView(first, "list", true)))
      .when(open && replies.length > 0, el => el.child(v_flex().ml(2).pl(12).gap(10).border_l(2).border_color(t.border)
        .children(replies.map(message => this.messageView(message, "list")))))
      .child(h_flex().gap(6).items_center()
        .child(this.button(`show-${thread.id}`, "Show in diff", cx => this.showThread(thread, cx), { small: true, ghost: true }))
        .when(!resolved, el => el.child(this.button(`list-reply-${thread.id}`, "Reply", cx => this.showThread(thread, cx, true), { small: true, ghost: true, icon: ICON.reply, enabled: !this.cachedComparison && !this.saving })))
        .when(open, el => el.children(this.commentActions(thread, "list")))
        .when(resolved, el => el.child(this.button(`list-toggle-${thread.id}`, open ? "Hide" : "Show", toggle, { small: true, ghost: true }))));
  }

  composerView(inline = true) {
    const t = theme(), intent = this.intent, text = Boolean(this.composer.value().trim());
    const busy = this.saving || this.leaving, failed = this.draftStatus.startsWith("Draft not saved");
    return v_flex().id("discussion-composer").ml(inline ? this.cols.inset : 12).mr(this.cols.edge).my(6).rounded(8).border_1().border_color(t.accent).bg(t.surface).overflow_hidden()
      .child(this.cardHeader(t, [
        div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(intent.threadId ? `Reply · ${anchorLabel(intent.anchor)}` : `Comment on ${anchorLabel(intent.anchor).replace(/^[A-Z]/, c => c.toLowerCase())}`),
        ...(intent.path !== this.file ? [div().flex_none().text_size(11).text_color(t.dim).child(splitPath(intent.path ?? "").name)] : []),
        this.button("close-draft", "", cx => this.closeComposer(cx), { small: true, ghost: true, icon: ICON.x, tooltip: "Close · the draft is kept", enabled: !busy }),
      ]))
      .when(!intent.threadId && intent.snapshotId !== this.snapshotId, el => el.child(div().px(12).pt(8).text_size(11).text_color(t.blocked)
        .child("The code changed since this draft began. Choose the lines again before posting; the text is kept.")))
      .child(div().mx(12).mt(10).h(96).px(10).py(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
        .child(Textarea.new(this.composer).size_full().text_size(12).text_color(t.foreground).disabled(busy || Boolean(this.postAttempt))))
      .child(h_flex().px(12).py(10).gap(8).items_center()
        .child(this.askReplyBox(busy))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(failed ? t.blocked : t.dim).child(this.draftStatus || (this.width >= COMPACT_W ? "⌘/Ctrl+Enter posts · Esc keeps the draft" : "")))
        .when(text && !this.postAttempt, el => el.child(this.button("discard-draft", "Discard", cx => this.discard(cx), { small: true, ghost: true, enabled: !busy })))
        .child(this.button("post-discussion", this.saving ? "Posting…" : this.postAttempt ? "Retry post" : intent.threadId ? "Reply" : "Comment", cx => this.submit(cx), { small: true, primary: true, enabled: !busy && text })));
  }

  askReplyBox(busy) {
    const t = theme(), checked = this.intent?.replyRequested === true, enabled = !busy && !this.postAttempt;
    // Tooltips need a plain element; a Checkbox does not take one.
    return div().id("ask-reply-tip").flex_none().tooltip("The agent answers here in a few sentences, then goes on with its work").child(Checkbox.new("ask-reply").checked(checked).disabled(!enabled)
      .accessibility_label("Ask the agent for a short reply here")
      .when(enabled, el => el.cursor_pointer())
      .on_mouse_down("left", stop).on_change((value, cx) => this.setAskReply(value, cx))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(checked ? t.foreground : t.muted)
        .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
          .border_color(checked ? t.accent : t.border).bg(checked ? t.accent : t.background)
          .when(checked, el => el.child(svg(ICON.check).size(11).text_color(t.accent_foreground))))
        .child("Ask for a short reply")));
  }

  // The range being dragged, else the open draft's lines in this file.
  marking() {
    if (this.drag) {
      const lo = Math.min(this.drag.start, this.drag.end), hi = Math.max(this.drag.start, this.drag.end), side = this.drag.side;
      return (row, index) => index >= lo && index <= hi && Boolean(lineOf(row, side));
    }
    const intent = this.intent;
    if (!intent?.anchor || intent.path !== this.file) return () => false;
    const { side, startLine, endLine } = intent.anchor;
    return row => { const line = lineOf(row, side); return Boolean(line) && line >= startLine && line <= endLine; };
  }

  diffRow(row, index, marked, live) {
    const t = theme(), mono = settings().font_family, minus = row.kind === "-", plus = row.kind === "+";
    if (row.kind === "@") return h_flex().id(`hunk-${index}`).h(26).px(12).items_center().bg(t.raised).border_y(1).border_color(t.border)
      .font_family(mono).text_size(11).text_color(t.dim).child(div().truncate().child(row.text));
    const tone = plus ? t.ansi2 : minus ? t.ansi1 : null, hovered = live && !this.drag && this.hoverRow === index;
    const number = (side, line) => div().id(`line-${index}-${side}`).w(this.cols.num).h(ROW_H).flex_none().flex().items_center().justify_end().pr(this.cols.num > 40 ? 8 : 5)
      .text_size(11).text_color(marked ? t.foreground : t.dim)
      .when(live, el => el.cursor_pointer().hover(s => s.text_color(t.foreground)))
      .on_mouse_down("left", (event, cx) => { cx.stop_propagation(); if (live) this.pressLine(index, side, event, cx); })
      .child(line ? String(line) : "");
    const comment = div().id(`comment-${index}`).w(MARK_W).h(ROW_H).flex_none().flex().items_center().justify_center()
      .on_mouse_down("left", (event, cx) => { cx.stop_propagation(); if (live) this.pressLine(index, lineOf(row, "new") ? "new" : "old", event, cx); })
      .when(hovered, el => el.cursor_pointer().child(div().size(16).rounded(4).flex().items_center().justify_center().bg(t.accent)
        .child(svg(ICON.plus).size(11).text_color(t.accent_foreground))));
    return h_flex().id(`row-${index}`).min_h(ROW_H).items_stretch().font_family(mono).text_size(12)
      .bg(marked ? tint(t.accent, 0x24) : tone ? tint(tone, 0x14) : t.background)
      .when(live && !marked, el => el.hover(s => s.bg(tone ? tint(tone, 0x26) : t.hover)))
      .when(live, el => el.on_hover((inside, cx) => this.hoverLine(index, inside, cx)))
      .child(h_flex().flex_none().items_start().bg(marked ? tint(t.accent, 0x48) : tone ? tint(tone, 0x26) : "#00000000")
        .child(number("old", row.oldLine)).child(number("new", row.newLine)))
      .child(comment)
      .child(div().w(SIGN_W).flex_none().text_color(tone ?? t.dim).child(plus ? "+" : minus ? "−" : ""))
      .child(div().flex_1().min_w(0).pr(this.cols.edge).text_color(t.foreground).child(row.text || " "));
  }

  // Path rows share one shape: status, name, folder, then discussion and line counts.
  pathRow(id, path, o, action) {
    const t = theme(), { name, dir } = splitPath(path);
    const statusColor = o.status === "A" ? t.ansi2 : o.status === "D" ? t.ansi1 : o.status ? t.ansi3 : t.dim;
    return Button.new(id).w_full().h(28).flex_none().px(8).rounded(6).cursor_pointer()
      .bg(o.selected ? t.selected : "#00000000").text_color(o.selected ? t.foreground : t.muted)
      .hover(s => s.bg(o.selected ? t.selected : t.hover).text_color(t.foreground))
      .accessibility_label(o.label ?? `Review ${path}${o.viewed ? ", viewed" : ""}`).on_mouse_down("left", stop).on_click((_event, cx) => action(cx))
      .child(h_flex().w_full().gap(7).items_center()
        .child(div().w(12).flex_none().text_size(11).font_family(settings().font_family).text_color(statusColor).child(o.status ?? "•"))
        .child(div().min_w(0).truncate().text_size(12).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(o.detail ?? dir))
        .when(o.viewed, el => el.child(svg(ICON.check).size(12).flex_none().text_color(t.muted)))
        .when(o.threads > 0, el => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(o.open ? t.accent : t.dim)
          .child(svg(ICON.message).size(11).text_color(o.open ? t.accent : t.dim)).child(String(o.threads))))
        .when(o.additions > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${o.additions}`)))
        .when(o.deletions > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${o.deletions}`))));
  }

  sectionLabel(text) {
    const t = theme();
    return div().px(8).pt(16).pb(4).text_size(11).font_semibold().text_color(t.dim).child(text);
  }

  emptyState(title, body, spinning = false) {
    const t = theme();
    return v_flex().px(14).py(12).gap(6)
      .child(h_flex().gap(8).items_center()
        .when(spinning, el => el.child(div().w(12).text_size(12).text_color(t.muted).frames(SPIN, 90).child(SPIN[0])))
        .child(div().font_semibold().text_size(13).child(title)))
      .when(Boolean(body), el => el.child(div().text_size(12).text_color(t.muted).child(body)));
  }

  render(cx) {
    if (this.launcher) return div();
    if (this.toolbar || (!this.framed && !props()?.overlay)) this.reconcileExpansion(cx);
    if (this.toolbar) return reviewButton();
    // Following focus can save a draft and reread, which notifies; render may not.
    if (!this.fixed) {
      const here = location(this.spaceId);
      if (here && here.key !== this.followed && here.key !== this.following) cx.spawn(async cx => this.follow(cx));
    }
    this.settleJump();
    const t = theme(), width = this.width, wide = width >= SPLIT_W, compact = width < COMPACT_W;
    const expansion = this.expansionState();
    const expandLabel = expansion?.restoring ? "Restoring panel…" : expansion?.expanded ? "Restore panel width"
      : expansion?.reason === "at-max" ? `Already at the layout's maximum width (${expansion.max}px)`
      : expansion?.mode === "max" ? `Widen to the layout's maximum (${expansion.max}px)` : "Expand to fill the workspace";
    const sideW = width >= 1000 ? 280 : 240, diffW = wide ? width - sideW : width, num = compact ? 34 : 46;
    this.cols = { num, inset: compact ? 12 : num * 2 + MARK_W, edge: compact ? 10 : 16 };
    const currentThreads = this.threads.filter(thread => thread.path === this.file);
    const visible = pageRows(this.rows, this.page, PAGE_ROWS, this.from), rendered = new Set(), live = this.canAnchor(), marked = this.marking();
    const content = [];
    for (let i = 0; i < visible.rows.length; i++) {
      const row = visible.rows[i], index = visible.start + i;
      content.push(this.diffRow(row, index, row.kind !== "@" && marked(row, index), live && !this.pendingFile));
      for (const thread of currentThreads) {
        const anchor = threadLine(thread);
        if (!threadIsOutdated(thread) && anchor.line && anchor.line === lineOf(row, anchor.side)) {
          content.push(this.threadCard(thread, cx));
          rendered.add(thread.id);
          if (this.intent?.threadId === thread.id) content.push(this.composerView());
        }
      }
      if (this.intent && !this.intent.threadId && this.intent.path === this.file && this.intent.anchor.endLine === lineOf(row, this.intent.anchor.side)) content.push(this.composerView());
    }
    const other = currentThreads.filter(thread => !rendered.has(thread.id)), outside = [];
    if (other.length) outside.push(div().px(12).pt(18).pb(4).text_size(11).font_semibold().text_color(t.dim).child("Discussions outside the shown lines"));
    for (const thread of other) {
      outside.push(this.threadCard(thread, cx, true));
      if (this.intent?.threadId === thread.id) outside.push(this.composerView(false));
    }
    // A placed thread without a diff row comes first, where Show in diff lands.
    if (other.some(thread => thread.id === this.focusThread)) content.unshift(...outside);
    else content.push(...outside);
    const intentVisible = this.intent && (this.intent.threadId ? currentThreads.some(thread => thread.id === this.intent.threadId) : this.intent.path === this.file && visible.rows.some(row => lineOf(row, this.intent.anchor.side) === this.intent.anchor.endLine));
    if (this.intent && !intentVisible) content.push(this.composerView(false));

    const selected = this.pendingFile ?? this.file;
    const changed = new Set(this.files.map(file => file.path));
    const threadsAt = path => this.threads.filter(thread => thread.path === path);
    const openAt = path => threadsAt(path).some(thread => thread.status !== "resolved");
    const retainedPaths = [...new Set(this.threads.map(thread => thread.path).filter(path => !changed.has(path)))];
    // Side by side, a 240px list has no room for line counts; stacked, it spans the panel.
    const counts = !wide || width >= 1000;
    const shownFiles = this.visibleFiles(), viewedCount = this.files.filter(file => file.viewed).length;
    const pathItems = shownFiles.map(file => this.pathRow(`file-${file.path}`, file.path, { status: file.status, viewed: file.viewed, selected: selected === file.path, threads: threadsAt(file.path).length, open: openAt(file.path), additions: counts ? file.additions : 0, deletions: counts ? file.deletions : 0 }, cx => this.pickFile(file.path, cx)));
    const totals = this.files.reduce((sum, file) => ({ add: sum.add + (file.additions ?? 0), del: sum.del + (file.deletions ?? 0) }), { add: 0, del: 0 });
    const current = this.files.find(file => file.path === selected);
    const openCount = this.threads.filter(thread => thread.status !== "resolved").length, draftCount = this.drafts?.length ?? 0;
    const awaiting = this.threads.filter(thread => thread.awaitingReply).length;

    const root = this.root ?? this.folder;
    const { name: fileName, dir: fileDir } = splitPath(selected ?? "");
    const pickingBase = this.source === "branch" || this.pickBase;
    const baseText = this.baseInput.value().trim(), commitText = this.commitInput.value().trim();
    // Stacked: the file list takes what its rows need, at most about a third of the height.
    const listRows = Math.max(1, shownFiles.length + retainedPaths.length + draftCount) + (retainedPaths.length ? 1.25 : 0) + (draftCount ? 1.25 : 0);
    const listH = Math.round(Math.min(78 + listRows * 29, Math.max(120, this.height * 0.34)));

    const navigator = v_flex().flex_none().min_h(0).border_color(t.border)
      .when(wide, el => el.w(sideW).border_r(1))
      .when(!wide, el => el.h(listH).border_b(1))
      .child(h_flex().h(36).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(12).child("Changed files"))
        .child(div().text_size(11).text_color(t.dim).child(String(this.files.length)))
        .child(div().flex_1())
        .when(totals.add > 0, el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${totals.add}`)))
        .when(totals.del > 0, el => el.child(div().text_size(11).text_color(t.ansi1).child(`−${totals.del}`))))
      .when(this.files.length > 0, el => el.child(h_flex().h(30).flex_none().px(14).gap(6).items_center()
        .child(div().flex_1().text_size(11).text_color(t.muted).child(`${viewedCount} of ${this.files.length} viewed`))
        .child(this.button("hide-viewed", this.hideViewed ? "Show all" : "Hide viewed", cx => { this.hideViewed = !this.hideViewed; cx.notify(); },
          { small: true, selected: this.hideViewed, label: this.hideViewed ? "Show all changed files" : "Hide viewed files" }))))
      .child(v_flex().id("review-changed-paths").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6).gap(1)
        .children(pathItems)
        .when(this.files.length > 0 && !shownFiles.length, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted).child("All files viewed.")))
        .when(!this.files.length, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted)
          .child(this.reading && !this.root ? "Reading changes…" : this.root ? "No changes in this comparison." : "Open a checkout to see its changes.")))
        .when(retainedPaths.length > 0, el => el.child(this.sectionLabel("Discussions on unchanged files")))
        .children(retainedPaths.map(path => this.pathRow(`retained-${path}`, path, { selected: selected === path, threads: threadsAt(path).length, open: openAt(path) }, cx => this.pickFile(path, cx))))
        .when(draftCount > 0, el => el.child(this.sectionLabel("Saved drafts")))
        .children((this.drafts ?? []).map(draft => this.pathRow(`draft-${draft.id}`, draft.path, { detail: draft.intent?.anchor ? anchorLabel(draft.intent.anchor) : "", label: `Restore draft for ${draft.path}`, selected: this.intent?.id === draft.id }, cx => this.restoreDraft(draft, cx)))));

    const diff = v_flex().flex_1().min_h(0).min_w(0)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.pendingFile), el => el.child(div().w(12).flex_none().text_size(12).text_color(t.muted).frames(SPIN, 90).child(SPIN[0])))
        .child(div().min_w(0).truncate().font_semibold().text_size(12).child(fileName || "No file selected"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(fileDir))
        .when(current?.additions > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${current.additions}`)))
        .when(current?.deletions > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${current.deletions}`)))
        .when(Boolean(current), el => el.child(this.viewedBox(current)))
        .when(diffW >= 760 && !this.intent && !this.pendingFile && this.rows.length > 0, el => el.child(div().flex_none().pl(8).text_size(11).text_color(t.dim).child("Drag across line numbers to comment"))))
      .when(Boolean(this.fileNote), el => el.child(div().flex_none().px(14).py(8).text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(this.fileNote)))
      // While another file loads, the previous diff stays in place, dimmed and inert.
      .child(v_flex().id(`review-diff-${this.file ?? "empty"}-${visible.start}`).flex_1().min_h(0).overflow_y_scrollbar().pb(16).children(content)
        .when(Boolean(this.pendingFile) && content.length > 0, el => el.opacity(0.45))
        .when(!content.length, el => el.child(
          this.pendingFile ? this.emptyState("Loading diff…", "", true)
          : this.reading && !this.root ? this.emptyState("Reading changes…", "", true)
          : this.file ? this.emptyState("No line changes to show", this.fileNote ? "" : "Binary, mode-only and unchanged files have no lines to comment on.")
          : this.root && !this.files.length ? this.emptyState("Nothing to review", this.source === "commit" ? "This commit has no changes against its first parent." : this.source === "branch" ? `The working tree matches ${this.base}.` : "The working tree matches HEAD.")
          : this.root ? this.emptyState("Select a file", wide ? "Choose a changed file on the left." : "Choose a changed file above.")
          : this.emptyState("Open a checkout", "Enter the absolute path of a local Git checkout above."))))
      .when(visible.pages > 1 || visible.start > 0, el => el.child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.button("previous-page", "Previous", cx => { this.page = Math.max(0, Math.ceil(visible.start / PAGE_ROWS) - 1); this.from = null; cx.notify(); }, { small: true, enabled: visible.start > 0 }))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(`Rows ${visible.start + 1}–${visible.start + visible.rows.length} of ${this.rows.length}`))
        .child(this.button("next-page", "Next", cx => { this.page = Math.floor(visible.start / PAGE_ROWS) + 1; this.from = null; cx.notify(); }, { small: true, enabled: visible.start + visible.rows.length < this.rows.length }))));

    return v_flex().id("codewalker").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      // Docked beside the agent it is a card, like Changes; a window or pane has Herdr's frame.
      .when(!props()?.overlay && !this.framed, el => el.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_size_change((size, cx) => {
        if (this.width === size.width && this.height === size.height) return;
        this.width = size.width; this.height = size.height; cx.notify();
      })
      .on_mouse_down("left", stop)
      .on_mouse_up("left", (_event, cx) => this.release(cx))
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        if (this.drag) { this.drag = null; cx.notify(); cx.stop_propagation(); }
        else if (this.confirmDelete) { this.confirmDelete = null; cx.notify(); cx.stop_propagation(); }
        else if (this.editing) { this.cancelEdit(cx); cx.stop_propagation(); }
        else if (this.intent) { this.closeComposer(cx); cx.stop_propagation(); }
        else if (this.mode === "send") { this.mode = this.backMode ?? "files"; cx.notify(); cx.stop_propagation(); }
        else if (this.mode === "discussions") { this.mode = "files"; cx.notify(); cx.stop_propagation(); }
      })
      // One compact toolbar; comparison details live in tooltips, not a title row.
      .child(h_flex().id("review-controls").min_h(40).flex_none().px(compact ? 10 : 14).py(7).gap(compact ? 4 : 6).flex_wrap().items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_none().h(26).p(2).gap(2).items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
          .children([["uncommitted", "Uncommitted"], ["branch", "Branch"], ["commit", "Commit"]].map(([source, label]) => {
            const on = source === (pickingBase ? "branch" : this.source);
            return Button.new(`scope-${source}`).h(20).px(compact ? 7 : 10).rounded(5).text_size(12).bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
              .cursor_pointer().hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).disabled(this.saving).accessibility_label(`Compare ${label.toLowerCase()} changes`)
              .tooltip(source === "commit" ? "First parent → selected commit · no working-tree changes"
                : source === "uncommitted" ? "HEAD → working tree · staged, unstaged and untracked files" : `${this.base || "Choose a base ref"} → working tree · merge base ${this.resolvedBase?.slice(0, 8) ?? "…"}`)
              .on_mouse_down("left", stop).on_click((_event, cx) => {
                if (source === "commit") { this.applySource("commit", cx, { resolveCommit: false }); return; }
                if (source === "uncommitted") { this.pickBase = false; this.applySource("uncommitted", cx); cx.notify(); return; }
                if (baseText) this.applySource("branch", cx);
                else { this.pickBase = true; this.baseInput.focus(); cx.notify(); }
              }).child(label);
          })))
        .child(div().flex_1())
        .child(this.button("refresh", "", cx => this.refresh(cx), { icon: ICON.refresh, tooltip: this.loading ? "Refreshing…" : "Refresh", enabled: !this.loading && !this.saving }))
        .child(this.button("toggle-discussions", !compact && openCount ? String(openCount) : "", cx => { this.mode = this.mode === "discussions" ? "files" : "discussions"; cx.notify(); },
          { icon: ICON.message, selected: this.mode === "discussions", label: "Discussions", tooltip: this.mode === "discussions" ? "Back to changed files" : `All discussions · ${openCount} open` }))
        .child(this.button("choose-checkout", "", cx => { this.editRoot = !this.editRoot; if (this.editRoot) this.rootInput.focus(); cx.notify(); }, { icon: ICON.folder, tooltip: `${root || "No checkout"}${this.branch ? ` (${this.branch})` : ""} · Change folder`, selected: this.editRoot, enabled: !this.saving, label: "Change folder" }))
        .when(this.mode === "send" || sendable(this.threads).length > 0 || uncertainCount(this.threads) > 0, el => el.child(this.sendButton()))
        .when(Boolean(props()?.overlay), el => el.child(this.button("close-review", "", cx => this.withSavedDraft(cx, cx => closeOverlay(props().overlay)), { icon: ICON.x, tooltip: "Close Review · drafts are kept", enabled: !this.saving })))
        .when(Boolean(expansion?.supported), el => el.child(this.button("expand-review", "", cx => this.toggleExpansion(cx), {
          icon: ICON[expansion.expanded ? "minimize-2" : "maximize-2"], tooltip: expandLabel, selected: expansion.expanded,
          enabled: !expansion.restoring && expansion.reason !== "at-max",
        }))))
      .when(pickingBase, el => el.child(h_flex().min_h(40).flex_none().px(14).py(7).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().h(26).px(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
            .flex_1().min_w(0)
            .child(Input.new(this.baseInput).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button("apply-base", "Compare", cx => this.applySource("branch", cx), { enabled: !this.saving && Boolean(baseText) && (this.source !== "branch" || baseText !== this.base) }))))
      .when(this.source === "commit" && !pickingBase, el => el.child(h_flex().min_h(40).flex_none().px(14).py(7).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().h(26).flex_1().min_w(0).px(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
          .child(Input.new(this.commitInput).h_full().text_size(12).text_color(t.foreground).accessibility_label("Commit SHA or ref")))
        .when(Boolean(this.commitOid), el => el.child(div().flex_none().text_size(11).text_color(t.muted)
          .tooltip(`${this.commitOid} · ${this.commitParents === 0 ? "empty tree" : "first parent"} → commit`)
          .child(this.commitOid.slice(0, 8))))
        .child(this.button("apply-commit", "Show", cx => this.applySource("commit", cx), { enabled: !this.saving && !this.leaving && Boolean(commitText), tooltip: "Resolve this SHA or ref and show its commit diff" }))))
      // Folder entry: on request, or until a checkout loads.
      .when(this.editRoot || (!this.root && !this.reading), el => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).h(26).px(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
          .child(Input.new(this.rootInput).h_full().text_size(12).text_color(t.foreground)))
        .when(this.editRoot && Boolean(this.root), el => el.child(this.button("cancel-root", "Cancel", cx => { this.editRoot = false; cx.notify(); }, { ghost: true })))
        .child(this.button("pin-root", "Open", cx => this.changeRoot(cx), { primary: true, enabled: !this.saving && Boolean(this.rootInput.value().trim()) }))))
      .when(Boolean(this.error), el => el.child(h_flex().id("review-error").flex_none().px(14).py(7).gap(8).items_center().bg(tint(t.blocked, 0x1a)).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked).child(this.error))
        .child(this.button("dismiss-error", "", cx => { this.error = null; cx.notify(); }, { small: true, ghost: true, icon: ICON.x, tooltip: "Dismiss" }))))
      .when(Boolean(this.postNotice), el => el.child(div().flex_none().px(14).py(7).text_size(11).text_color(t.blocked).border_b(1).border_color(t.border).child(this.postNotice)))
      .when(Boolean(this.note), el => el.child(div().flex_none().px(14).py(6).text_size(11).text_color(t.muted).border_b(1).border_color(t.border).child(this.note)))
      // Side by side: h_flex centers by default, so stretch both columns or their scroll regions
      // collapse. Stacked: the list has a fixed height and the diff takes the rest.
      .child(this.mode === "send" ? this.sendView() : this.mode === "discussions" ? this.discussionsView(cx) : (wide ? h_flex().items_stretch() : v_flex()).flex_1().min_h(0).min_w(0).child(navigator).child(diff))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11)
        .child(div().size(6).flex_none().rounded_full().bg(this.error ? t.blocked : this.reading ? t.working : t.idle))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.on ? "Remote checkouts are not supported yet" : !this.reviewId ? "Not connected"
          : [`${this.files.length} ${this.files.length === 1 ? "file" : "files"}`, `${openCount} open`, ...(awaiting ? [`${awaiting} awaiting reply`] : []), ...(draftCount ? [`${draftCount} ${draftCount === 1 ? "draft" : "drafts"}`] : [])].join(" · "))));
  }
}
