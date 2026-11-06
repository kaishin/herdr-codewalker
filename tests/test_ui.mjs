// Run: node --experimental-vm-modules --test tests/test_ui.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const review = () => ({ root: "/checkout", reviewId: "review-a", revision: 3, snapshotId: "snapshot-b", branch: "feature", files: [], threads: [] });

async function modules(overrides = {}) {
  const stored = overrides.storage ?? new Map();
  const localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) };
  const context = vm.createContext({ console, localStorage });
  const cache = new Map();
  class State {
    constructor(options) { this.text = options?.value ?? ""; this.handlers = {}; }
    value() { return this.text; }
    set_value(text) { this.text = text; }
    on(event, handler) { this.handlers[event] = handler; }
    set_auto_grow() {}
    focus() {}
  }
  const values = {
    "gpui-kit": { View: class {}, div() {}, svg() {} },
    "gpui-base": { h_flex() {}, v_flex() {}, Button: {}, Checkbox: {}, InputState: { new: options => new State(options) }, Input: {}, TextareaState: { new: options => new State(options) }, Textarea: {}, TextView: {} },
    herdr: { props: () => ({}), spaces: () => [], panes: () => [], focused: () => null, agents: () => [], hc: async () => { throw new Error("Unexpected hc call"); }, run() {}, notify() {}, appHome: () => "/app", home: () => "/home", theme: () => ({}), settings: () => ({}), closeOverlay() {}, layout: () => null, shared: () => undefined, setShared() {}, nextCommand: () => new Promise(() => {}), watchFolder: async () => { throw new Error("No folder watch in tests"); }, exec: async () => { throw new Error("Unexpected helper invocation"); }, ...overrides },
  };
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const module = values[name]
      ? new vm.SyntheticModule(Object.keys(values[name]), function () { for (const [key, value] of Object.entries(values[name])) this.setExport(key, value); }, { context, identifier: name })
      : new vm.SourceTextModule(await readFile(name, "utf8"), { context, identifier: name });
    cache.set(name, module);
    await module.link((specifier, parent) => load(specifier.startsWith(".") ? path.resolve(path.dirname(parent.identifier), specifier) : specifier));
    return module;
  }
  const main = await load(path.join(root, "mods/Codewalker/main.js"));
  await main.evaluate();
  const cx = { tasks: [], notify() {}, focus_handle: () => ({ focus() {} }), timer: { every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) }, spawn(action) { const task = Promise.resolve().then(() => action(this)); this.tasks.push(task); return { cancel() {} }; } };
  const view = new main.namespace.default();
  view.init({}, cx);
  cx.tasks = []; // The lifecycle command loop intentionally remains pending.
  view.folder = "/checkout";
  view.root = "/checkout";
  view.reviewId = "review-a";
  view.revision = 1;
  view.snapshotId = "snapshot-a";
  view.file = "a.txt";
  view.draftsLoaded = true;
  view.client = { saveDraft: async () => ({ reviewId: "review-a", revision: 2 }), deleteDraft: async () => ({}), submit: async () => ({ thread: { id: "thread-a" } }), review: async () => review(), drafts: async () => [], file: async () => ({ rows: [] }), ...overrides.client };
  view.intent = { id: "draft-a", path: "a.txt", anchor: { side: "new", startLine: 1, endLine: 1 }, snapshotId: "snapshot-a", context: view.context() };
  view.composer.set_value("Human question");
  async function drain() {
    while (cx.tasks.length) { const tasks = cx.tasks.splice(0); await Promise.all(tasks); }
  }
  return { view, cx, drain, load };
}

test("confirmed post survives a draft-cleanup conflict without leaving a retry active", async () => {
  let posts = 0;
  const { view, cx, drain } = await modules({ client: {
    submit: async () => { posts++; return { thread: { id: "thread-a" } }; },
    deleteDraft: async () => { const error = new Error("agent changed revision"); error.code = "revision_conflict"; throw error; },
  } });
  view.submit(cx);
  await drain();
  assert.equal(posts, 1);
  assert.equal(view.intent, null);
  assert.equal(view.postAttempt, null);
  assert.equal(view.composer.value(), "");
  assert.match(view.error ?? view.draftStatus, /saved/i);
  view.submit(cx);
  await drain();
  assert.equal(posts, 1, "ordinary Post after accepted message cannot duplicate it");
});

test("newer editor text is kept if a queued native edit arrives during a post", async () => {
  const gate = deferred();
  const { view, cx, drain } = await modules({ client: { submit: () => gate.promise } });
  view.submit(cx);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  view.composer.set_value("Newer unsent text");
  gate.resolve({ thread: { id: "thread-a" } });
  await drain();
  assert.equal(view.composer.value(), "Newer unsent text");
  assert.equal(view.intent.threadId, "thread-a");
  assert.notEqual(view.intent.id, "draft-a");
});

test("navigation waits for durable draft and cannot discard text typed during the save", async () => {
  const gate = deferred();
  const { view, cx, drain } = await modules({ client: { saveDraft: () => gate.promise } });
  let navigated = false;
  view.withSavedDraft(cx, () => { navigated = true; });
  view.composer.set_value("Newer text while saving");
  gate.resolve({ reviewId: "review-a", revision: 2 });
  await drain();
  assert.equal(navigated, false);
  assert.equal(view.composer.value(), "Newer text while saving");
  assert.match(view.error, /draft changed/i);
});

test("background refresh never replaces the active draft or its original review identity", async () => {
  const gate = deferred();
  const { view, cx, drain } = await modules({ client: { review: () => gate.promise } });
  const intent = view.intent;
  view.refresh(cx, true);
  view.composer.set_value("Typing while Git refreshes");
  gate.resolve({ ...review(), reviewId: "review-branch-b" });
  await drain();
  assert.equal(view.composer.value(), "Typing while Git refreshes");
  assert.equal(view.intent, intent);
  assert.equal(view.intent.context.reviewId, "review-a");
  assert.equal(view.reviewId, "review-branch-b");
});

test("remote context is rejected before any local helper execution", async () => {
  let calls = 0;
  const { load } = await modules();
  const clientModule = await load(path.join(root, "mods/Codewalker/client.js"));
  const client = new clientModule.namespace.ReviewClient({ helper: "/helper.py", execute: async () => { calls++; } });
  await assert.rejects(client.review({ root: "/same-local-path", on: "remote-host" }), /local checkouts only/);
  assert.equal(calls, 0);
});

test("manual checkout preserves a trailing space instead of selecting a neighboring root", async () => {
  let selected;
  const { view, cx, drain } = await modules({ client: { review: async context => { selected = context.root; return { ...review(), root: context.root }; } } });
  view.intent = null;
  view.rootInput.set_value("/checkout ");
  view.changeRoot(cx);
  await drain();
  assert.equal(selected, "/checkout ");
  assert.equal(view.folder, "/checkout ");
  assert.equal(view.root, "/checkout ");
});

// Two spaces; the first has a misleading name. `active` picks the shown one,
// `cwd` the focused terminal's folder (null: focus is in a mod).
function twoSpaces(state) {
  return {
    spaces: () => [
      { id: "space-a", active: state.active === "a", name: "herdr-codewalker", folder: "/projects/other", machine: null },
      { id: "space-b", active: state.active === "b", name: "b", folder: "/projects/b", machine: null },
    ],
    panes: () => [{ pane: "p1", cwd: state.cwd }],
    focused: () => state.cwd ? { pane: "p1", terminal: "t1", cwd: state.cwd } : { pane: null, terminal: null, cwd: null },
  };
}

test("docked Review follows the focused terminal's folder, else the space's, and saves the draft first", async () => {
  const state = { active: "a", cwd: null }, saved = [];
  const { view, cx, drain } = await modules({ ...twoSpaces(state), client: {
    saveDraft: async (_context, intent, body) => { saved.push({ id: intent.id, body }); return { reviewId: "review-a", revision: 2 }; },
    review: async context => ({ ...review(), root: context.root }) } });
  assert.equal(view.spaceId, "space-a");
  state.active = "b";
  view.follow(cx);
  await drain();
  assert.deepEqual(saved, [{ id: "draft-a", body: "Human question" }]);
  assert.equal(view.folder, "/projects/b", "the space's folder, never its name");
  assert.equal(view.intent, null);
  state.cwd = "/projects/herdr";
  view.follow(cx);
  await drain();
  assert.equal(view.folder, "/projects/herdr", "the focused terminal's folder wins");
  // Focus moving into Review (no folder) or a subfolder of the shown checkout keeps it.
  view.root = "/projects/herdr";
  view.intent = { id: "draft-b", path: "a.txt", anchor: { side: "new", startLine: 1, endLine: 1 } };
  state.cwd = null;
  view.follow(cx);
  state.cwd = "/projects/herdr/docs";
  view.follow(cx);
  await drain();
  assert.equal(view.intent?.id, "draft-b");
  assert.equal(view.folder, "/projects/herdr");
});

test("Change folder holds until focus moves to another folder", async () => {
  const state = { active: "a", cwd: "/projects/herdr" };
  const { view, cx, drain } = await modules({ ...twoSpaces(state), client: { review: async context => ({ ...review(), root: context.root }) } });
  view.intent = null;
  view.rootInput.set_value("/elsewhere");
  view.changeRoot(cx);
  await drain();
  view.follow(cx);
  await drain();
  assert.equal(view.folder, "/elsewhere");
  state.cwd = "/projects/other";
  view.follow(cx);
  await drain();
  assert.equal(view.folder, "/projects/other");
});

test("a failed draft save keeps the review and its text, and does not retry on every render", async () => {
  const state = { active: "a", cwd: null };
  let saves = 0;
  const { view, cx, drain } = await modules({ ...twoSpaces(state), client: { saveDraft: async () => { saves++; throw new Error("disk full"); } } });
  await settle(); // The opening read lands first.
  state.active = "b";
  view.follow(cx);
  await drain();
  view.follow(cx);
  await drain();
  assert.equal(saves, 1);
  assert.equal(view.spaceId, "space-a");
  assert.equal(view.composer.value(), "Human question");
  assert.match(view.error, /disk full/);
});

test("a window opened for one space keeps it", async () => {
  const state = { active: "a" };
  const { view, cx, drain } = await modules({ ...twoSpaces(state), props: () => ({ space: "space-a", folder: "/projects/other", overlay: "o1" }) });
  state.active = "b";
  view.follow(cx);
  await drain();
  assert.equal(view.spaceId, "space-a");
  assert.ok(view.intent);
});

test("Ask for a short reply travels with the draft and the post, and stays on for the next comment", async () => {
  const saved = [], posted = [];
  const { view, cx, drain } = await modules({ client: {
    saveDraft: async (_context, intent) => { saved.push(intent.replyRequested); return { reviewId: "review-a", revision: 2 }; },
    submit: async (_context, intent) => { posted.push(intent.replyRequested); return { reviewId: "review-a", revision: 3, thread: { id: "thread-a" } }; } } });
  view.setAskReply(true, cx);
  await drain();
  assert.deepEqual(saved, [true]);
  view.submit(cx);
  await drain();
  assert.deepEqual(posted, [true]);
  view.begin({ side: "new", startLine: 2, endLine: 2 }, cx);
  assert.equal(view.intent.replyRequested, true);
});

test("the post envelope names a reply request only when asked, so older saved posts replay unchanged", async () => {
  const { load } = await modules();
  const clientModule = await load(path.join(root, "mods/Codewalker/client.js"));
  const payloads = [];
  const execute = async (_python, argv) => {
    const command = argv[argv.indexOf("--json") - 1], data = argv.includes("--data") ? JSON.parse(argv[argv.indexOf("--data") + 1]) : null;
    if (command === "create") payloads.push(data);
    return { code: 0, stdout: JSON.stringify({ ok: true, protocolVersion: 1, data: { reviewId: "review-a", revision: data.expectedRevision } }) };
  };
  const client = new clientModule.namespace.ReviewClient({ helper: "/helper.py", execute });
  const context = { root: "/checkout", source: "uncommitted", reviewId: "review-a", revision: 1 };
  const intent = { id: "d1", path: "a.txt", anchor: { side: "new", startLine: 1, endLine: 1 }, snapshotId: "s" };
  await client.submit(context, { ...intent, replyRequested: true }, "Why?", "c1");
  await client.submit(context, { ...intent, id: "d2" }, "Why?", "c2");
  assert.equal(payloads[0].replyRequested, true);
  assert.equal("replyRequested" in payloads[1], false);
});

test("a read that began before a concurrent draft save cannot roll discussions back", async () => {
  const gates = [];
  const { view, cx, drain } = await modules({ client: {
    review: () => { const gate = deferred(); gates.push(gate); return gate.promise; },
    saveDraft: async () => ({ reviewId: "review-a", revision: 5 }),
  } });
  view.refresh(cx, true);
  view.persistDraft(cx);
  await settle();
  assert.equal(view.revision, 5);
  gates[0].resolve({ ...review(), reviewId: "review-a", revision: 3, threads: [{ id: "before-post", path: "a.txt" }] });
  await settle();
  assert.equal(gates.length, 2, "the stale read is retried once");
  await settle();
  assert.notDeepEqual(view.threads.map(thread => thread.id), ["before-post"]);
  gates[1].resolve({ ...review(), reviewId: "review-a", revision: 5, threads: [{ id: "after-post", path: "a.txt" }] });
  await drain();
  assert.deepEqual(view.threads.map(thread => thread.id), ["after-post"]);
  assert.equal(view.revision, 5);
});

test("the tab-bar button adds Review to the side panels the tab bar remembers, once", async () => {
  let current = {}, panels = ["files", "changes"];
  const writes = [];
  const { load } = await modules({ props: () => current, shared: key => key === "workspace.panels" ? panels : undefined, setShared: (key, value) => { writes.push([key, value]); panels = value; } });
  const main = await load(path.join(root, "mods/Codewalker/main.js"));
  current = { toolbar: true };
  for (let i = 0; i < 2; i++) new main.namespace.default().init({}, { spawn() { throw new Error("The button starts no work"); } });
  assert.equal(JSON.stringify(writes), JSON.stringify([["workspace.panels", ["files", "changes", "review"]]]));
});

test("the key toggles the docked side panel when the layout has one, else a pane", async () => {
  let current = {}, tree = null;
  const calls = [];
  const { load } = await modules({ props: () => current, layout: () => tree, run: (name, args) => calls.push(`${name} ${JSON.stringify(args)}`),
    panes: () => [{ pane: "p1", tab: "t1", focused: true, cwd: "/checkout" }] });
  const main = await load(path.join(root, "mods/Codewalker/main.js"));
  const press = async () => {
    calls.length = 0;
    current = { launch: true, overlay: "o1" };
    const tasks = [];
    new main.namespace.default().init({}, { spawn: action => tasks.push(action()) });
    await Promise.all(tasks);
    return [...calls];
  };
  const docked = (hidden, active) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active, children: [{ id: "files" }, { id: "review" }] }] }] });
  tree = docked(true, "files");
  assert.deepEqual(await press(), ['layout.select {"stack":"panel-body","child":"review"}', 'layout.show {"id":"panel"}']);
  tree = docked(false, "files");
  assert.deepEqual(await press(), ['layout.select {"stack":"panel-body","child":"review"}', 'layout.show {"id":"panel"}'], "another panel switches to Review");
  tree = docked(false, "review");
  assert.deepEqual(await press(), ['layout.hide {"id":"panel"}']);
  tree = { id: "root", children: [{ id: "panel", children: [{ id: "panel-body", children: [{ id: "files" }] }] }] };
  assert.deepEqual(await press(), ['pane.split {"direction":"right","pane":"p1","mod":"Codewalker","props":{"framed":true,"folder":"/checkout"}}']);
});

test("switching files keeps the shown diff until the next arrives, newest click wins, revisits are instant", async () => {
  const gates = [], calls = [];
  const detail = path => ({ path, rows: [{ kind: "+", oldLine: null, newLine: 1, text: path }], note: null });
  const { view, cx, drain } = await modules({ client: { review: (_context, path) => { calls.push(path); const gate = deferred(); gates.push(gate); return gate.promise; } } });
  view.intent = null;
  view.composer.set_value("");
  view.snapshotId = view.rowsSnapshot = "snapshot-b";
  view.show("a.txt", detail("a.txt"));
  view.pickFile("b.txt", cx);
  view.pickFile("c.txt", cx);
  assert.equal(view.pendingFile, "c.txt");
  assert.deepEqual(view.rows, detail("a.txt").rows, "no blank diff while loading");
  view.selectAnchor({ side: "new", startLine: 1, endLine: 1 }, false, cx);
  assert.equal(view.intent, null, "dimmed rows from the previous file cannot be anchored");
  await settle();
  gates[0].resolve({ ...review(), detail: detail("b.txt") });
  await settle();
  assert.equal(view.file, "a.txt", "a superseded response does not flash its file");
  await settle();
  gates[1].resolve({ ...review(), detail: detail("c.txt") });
  await drain();
  assert.deepEqual(calls, ["b.txt", "c.txt"]);
  assert.equal(view.file, "c.txt");
  assert.equal(view.pendingFile, null);
  view.pickFile("b.txt", cx);
  assert.equal(view.file, "b.txt", "a file from this snapshot reopens without a helper read");
  assert.equal(calls.length, 2);
});

test("helper reads are not queued behind an in-flight draft save", async () => {
  const { load } = await modules();
  const clientModule = await load(path.join(root, "mods/Codewalker/client.js"));
  const save = deferred();
  const response = data => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, protocolVersion: 1, data }) });
  const client = new clientModule.namespace.ReviewClient({ helper: "/helper.py", execute: async (_command, args) => args.includes("draft-save") ? save.promise
    : response({ context: { repoRoot: "/checkout", reviewId: "review-a", revision: 1 }, snapshotId: "snapshot-a", files: [], threads: [], drafts: [], file: null }) });
  const context = { root: "/checkout", source: "uncommitted", reviewId: "review-a", revision: 1 };
  const saving = client.saveDraft(context, { id: "draft-a", path: "a.txt" }, "typing");
  assert.equal((await client.review(context)).snapshotId, "snapshot-a");
  save.resolve(response({ reviewId: "review-a", revision: 2 }));
  await saving;
});

test("a checkout or scope switch drops the old identity's in-flight read", async () => {
  const gates = [], sources = [];
  const { view, cx, drain } = await modules({ client: { review: (context, path) => {
    sources.push(context.source);
    if (gates.length === 2) return Promise.resolve({ ...review(), files: [{ path: "branch.txt" }], detail: { path, rows: [], note: null } });
    const gate = deferred(); gates.push(gate); return gate.promise;
  } } });
  view.refresh(cx, true);
  view.baseInput.set_value("main");
  view.applySource("branch", cx);
  await settle();
  assert.deepEqual(sources, ["uncommitted", "branch"]);
  gates[0].resolve({ ...review(), files: [{ path: "uncommitted.txt" }] });
  await settle();
  assert.equal(view.files.length, 0, "the old scope's files never appear");
  gates[1].resolve({ ...review(), reviewId: "review-a", files: [{ path: "branch.txt" }] });
  await drain();
  assert.deepEqual(view.files.map(file => file.path), ["branch.txt"]);
  assert.equal(view.source, "branch");
});

test("a worktree change invalidates cached diffs and new anchors use the shown rows' snapshot", async () => {
  const gates = [], calls = [];
  const detail = (path, text) => ({ path, rows: [{ kind: "+", oldLine: null, newLine: 1, text }], note: null });
  const { view, cx, drain } = await modules({ client: { review: (_context, path) => { calls.push(path); const gate = deferred(); gates.push(gate); return gate.promise; } } });
  view.intent = null;
  view.composer.set_value("");
  view.snapshotId = "snapshot-b";
  view.show("a.txt", detail("a.txt", "before edit"));
  view.remember(detail("a.txt", "before edit"));
  view.pickFile("b.txt", cx);
  await settle();
  gates[0].resolve({ ...review(), snapshotId: "snapshot-edited", detail: detail("b.txt", "b") });
  await settle();
  view.pickFile("a.txt", cx);
  assert.equal(view.pendingFile, "a.txt", "a diff cached for the old snapshot is not reused");
  await settle();
  gates[1].resolve({ ...review(), snapshotId: "snapshot-edited", detail: detail("a.txt", "after edit") });
  await drain();
  assert.deepEqual(calls, ["b.txt", "a.txt"]);
  assert.equal(view.rows[0].text, "after edit");
  view.selectAnchor({ side: "new", startLine: 1, endLine: 1 }, false, cx);
  await drain();
  assert.equal(view.intent.snapshotId, "snapshot-edited");
});

function hunks(view) {
  view.intent = null;
  view.composer.set_value("");
  view.rowsSnapshot = view.snapshotId;
  view.rows = [
    { kind: "@", text: "@@ -1,3 +1,3 @@", hunkId: "h1" },
    { kind: " ", oldLine: 1, newLine: 1, text: "a", hunkId: "h1" },
    { kind: "-", oldLine: 2, newLine: null, text: "b", hunkId: "h1" },
    { kind: "+", oldLine: null, newLine: 2, text: "B", hunkId: "h1" },
    { kind: " ", oldLine: 3, newLine: 3, text: "c", hunkId: "h1" },
    { kind: "@", text: "@@ -10,1 +10,1 @@", hunkId: "h2" },
    { kind: " ", oldLine: 10, newLine: 10, text: "z", hunkId: "h2" },
  ];
}

test("dragging across line numbers opens one comment on that side, clamped to its hunk", async () => {
  const { view, cx, drain } = await modules();
  hunks(view);
  view.pressLine(1, "new", { modifiers: {} }, cx);
  view.hoverLine(3, true, cx);
  view.hoverLine(6, true, cx); // Past the hunk: the range stops at its last new line.
  assert.equal(view.drag.end, 4);
  view.release(cx);
  await drain();
  assert.equal(view.drag, null);
  assert.equal(JSON.stringify(view.intent.anchor), JSON.stringify({ side: "new", startLine: 1, endLine: 3 }));
  assert.equal(view.intent.snapshotId, view.snapshotId);

  // A deleted row has no new line: pressing its "+" anchors the old side instead.
  hunks(view);
  view.pressLine(2, "new", { modifiers: {} }, cx);
  view.release(cx);
  await drain();
  assert.equal(JSON.stringify(view.intent.anchor), JSON.stringify({ side: "old", startLine: 2, endLine: 2 }));
});

test("a drag that outlives its rows opens nothing", async () => {
  const { view, cx, drain } = await modules();
  hunks(view);
  view.pressLine(1, "new", { modifiers: {} }, cx);
  view.rowsSnapshot = "snapshot-c"; // A refresh replaced the rows mid-drag.
  view.release(cx);
  await drain();
  assert.equal(view.intent, null);
  hunks(view);
  view.pendingFile = "b.txt";
  view.pressLine(1, "new", { modifiers: {} }, cx);
  assert.equal(view.drag, null, "dimmed rows of a loading switch are inert");
});

test("Discard deletes the draft; closing keeps it", async () => {
  const deleted = [], saved = [];
  const { view, cx, drain } = await modules({ client: {
    deleteDraft: async (_context, id) => { deleted.push(id); return { reviewId: "review-a", revision: 3 }; },
    saveDraft: async (_context, intent, body) => { saved.push([intent.id, body]); return { reviewId: "review-a", revision: 2 }; },
  } });
  view.closeComposer(cx);
  await drain();
  assert.equal(view.intent, null);
  assert.equal(JSON.stringify(saved), JSON.stringify([["draft-a", "Human question"]]));
  assert.equal(deleted.length, 0);

  view.intent = { id: "draft-b", path: "a.txt", anchor: { side: "new", startLine: 1, endLine: 1 }, snapshotId: "snapshot-a", context: view.context() };
  view.composer.set_value("Never mind");
  view.discard(cx);
  await drain();
  assert.equal(view.intent, null);
  assert.equal(view.composer.value(), "");
  assert.equal(JSON.stringify(deleted), JSON.stringify(["draft-b"]));
});

// Two hunks in c.txt; the thread sits on new line 41 in the second.
const twoHunks = () => [
  { kind: "@", text: "@@ -1 +1 @@", hunkId: "h1" }, { kind: "+", oldLine: null, newLine: 1, text: "a", hunkId: "h1" },
  { kind: "@", text: "@@ -40,2 +40,2 @@", hunkId: "h2" }, { kind: " ", oldLine: 40, newLine: 40, text: "b", hunkId: "h2" }, { kind: "+", oldLine: null, newLine: 41, text: "c", hunkId: "h2" },
];
const thread = (id, path, line, extra = {}) => ({ id, path, status: "open", anchor: { side: "new", startLine: line, endLine: line }, messages: [], ...extra });

test("discussions group by file in diff order, then files no longer in the diff, by line, and filter", async () => {
  const { load } = await modules();
  const model = await load(path.join(root, "mods/Codewalker/model.js"));
  const files = [{ path: "b.txt" }, { path: "a.txt" }];
  const threads = [thread("t1", "gone.txt", 3), thread("t2", "a.txt", 9, { awaitingReply: true }), thread("t3", "b.txt", 5, { status: "resolved" }), thread("t4", "a.txt", 2)];
  // The module runs in its own realm; compare plain JSON.
  const ids = filter => JSON.stringify(model.namespace.discussionGroups(threads, files, filter).map(group => [group.path, group.threads.map(item => item.id)]));
  assert.equal(ids("all"), JSON.stringify([["b.txt", ["t3"]], ["a.txt", ["t4", "t2"]], ["gone.txt", ["t1"]]]));
  assert.equal(ids("open"), JSON.stringify([["a.txt", ["t4", "t2"]], ["gone.txt", ["t1"]]]));
  assert.equal(ids("awaiting"), JSON.stringify([["a.txt", ["t2"]]]));
});

test("Show in diff opens the thread's file, saves the draft, and starts the diff at its hunk", async () => {
  const saved = [];
  const { view, cx, drain } = await modules({ client: { saveDraft: async (_context, intent) => { saved.push(intent.id); return { reviewId: "review-a", revision: 2 }; } } });
  view.rowsSnapshot = view.snapshotId;
  view.remember({ path: "c.txt", rows: twoHunks(), note: null });
  view.threads = [thread("t1", "c.txt", 41)];
  view.mode = "discussions";
  view.showThread(view.threads[0], cx);
  await drain();
  view.settleJump();
  assert.deepEqual(saved, ["draft-a"]);
  assert.equal(view.mode, "files");
  assert.equal(view.file, "c.txt");
  assert.equal(view.from, 2, "the second hunk's header");
  assert.equal(view.focusThread, "t1");
  assert.equal(view.intent, null);
});

test("Show in diff in the same file keeps an open draft; Reply from the list opens a reply there", async () => {
  const { view, cx, drain } = await modules();
  view.file = "a.txt";
  view.rows = twoHunks();
  view.threads = [thread("t1", "a.txt", 41), thread("t2", "c.txt", 1)];
  view.showThread(view.threads[0], cx);
  view.settleJump();
  assert.equal(view.intent?.id, "draft-a");
  assert.equal(view.from, 2);
  view.showThread(view.threads[1], cx, true);
  await drain();
  assert.equal(view.intent.threadId, "t2");
  assert.equal(view.intent.path, "c.txt");
});

test("only your own messages edit; a save keeps its command until a conflict, and keeps the text on failure", async () => {
  const calls = [];
  let fail = null;
  const { view, cx, drain } = await modules({ client: { editMessage: async (_context, id, body, commandId) => {
    calls.push({ id, body, commandId });
    if (fail) { const error = new Error(fail); error.code = fail; throw error; }
    return { reviewId: "review-a", revision: 4 };
  } } });
  const mine = { id: "m1", actor: { kind: "human", id: "local", name: "You" }, body: "Why?" };
  view.startEdit({ id: "m2", actor: { kind: "agent", id: "pi", name: "Pi" }, body: "Because." }, cx);
  assert.equal(view.editing, null);
  view.startEdit(mine, cx);
  view.saveEdit(cx);
  assert.equal(calls.length, 0, "unchanged text saves nothing");
  assert.equal(view.editing, null);
  view.startEdit(mine, cx);
  view.editor.set_value("Why upper case?");
  fail = "helper_error";
  view.saveEdit(cx);
  await drain();
  fail = "revision_conflict";
  view.saveEdit(cx);
  await drain();
  assert.equal(calls[0].commandId, calls[1].commandId, "an uncertain save retries the same command");
  assert.equal(view.editor.value(), "Why upper case?");
  assert.match(view.error, /not saved/);
  fail = null;
  view.saveEdit(cx);
  await drain();
  assert.notEqual(calls[2].commandId, calls[1].commandId, "a conflict needs a fresh command");
  assert.deepEqual([calls[2].id, calls[2].body], ["m1", "Why upper case?"]);
  assert.equal(view.editing, null);
});

test("Delete asks first; deleting the comment removes its thread and keeps a reply being written as a draft", async () => {
  const deleted = [];
  const { view, cx, drain } = await modules({ client: { deleteMessage: async (_context, id) => {
    deleted.push(id);
    return { reviewId: "review-a", revision: 5, deleted: { messageId: id, threadId: "t1", thread: id === "m1" } };
  } } });
  const you = { kind: "human", id: "local", name: "You" };
  view.threads = [{ ...thread("t1", "a.txt", 1), messages: [{ id: "m1", actor: you, body: "Why?" }, { id: "m2", actor: { kind: "agent", id: "pi", name: "Pi" }, body: "Because." }] }];
  view.intent = { ...view.intent, threadId: "t1" };
  view.deleteMessage(view.threads[0].messages[1], cx);
  assert.equal(view.confirmDelete, null, "another author's message cannot be deleted");
  view.deleteMessage(view.threads[0].messages[0], cx);
  await drain();
  assert.deepEqual(deleted, [], "the first press only asks");
  assert.equal(view.confirmDelete, "m1");
  view.deleteMessage(view.threads[0].messages[0], cx);
  await drain();
  assert.deepEqual(deleted, ["m1"]);
  assert.equal(view.threads.length, 0);
  assert.equal(view.intent, null, "the reply composer closes; its text was saved as a draft");
  assert.equal(view.confirmDelete, null);
});

// Send to agent. One open thread with your unsent comment.
const you = { kind: "human", id: "local", name: "You" };
const unsentThread = (extra = {}) => ({ id: "t1", path: "a.txt", status: "open", awaitingReply: true, anchor: { side: "new", startLine: 2, endLine: 2, snippet: "TWO" }, messages: [{ id: "m1", actor: you, body: "Why upper case?" }], ...extra });
const agent = (address, extra = {}) => ({ address, pane: `p-${address}`, space: "space-a", tab: "tab-a", tab_name: "1", status: "idle", program: { name: "Agent" }, seq: 1, focused: false, ...extra });
async function sendSetup({ hcResult, agentsList, deliverFail } = {}) {
  const calls = { deliver: [], hc: [], run: [] };
  const harness = await modules({
    agents: () => agentsList ?? [agent("t7")],
    panes: () => (agentsList ?? [agent("t7")]).map(a => ({ pane: a.pane, cwd: "/checkout" })),
    focused: () => ({ space: "space-a", tab: "tab-a", pane: null, terminal: null, cwd: null }),
    hc: async args => { calls.hc.push(args); if (hcResult instanceof Error) throw hcResult; return hcResult ?? { code: 0, stdout: "{}", stderr: "" }; },
    run: (command, args) => calls.run.push([command, args]),
    client: { deliver: async (_context, ids, state, target) => { calls.deliver.push([state, ids.join(","), target]); if (deliverFail) throw new Error(deliverFail); return { reviewId: "review-a", revision: 9 }; } },
  });
  harness.view.intent = null;
  harness.view.threads = [unsentThread()];
  harness.view.client.helper = "/app/mods/Codewalker/backend.py";
  return { ...harness, calls };
}

test("the send target is the focused agent, else the only one in this checkout; never a guess between several", async () => {
  const { view } = await modules({ agents: () => [agent("t1"), agent("t2", { focused: true }), agent("t3", { space: "space-b" })],
    panes: () => [{ pane: "p-t1", cwd: "/checkout/src" }, { pane: "p-t2", cwd: "/elsewhere" }],
    focused: () => ({ space: "space-a", tab: "tab-a" }) });
  assert.deepEqual(view.candidates().map(a => a.address).join(), "t1,t2", "this space only, this checkout first");
  assert.equal(view.target().address, "t2");
  const two = await modules({ agents: () => [agent("t1"), agent("t2")], panes: () => [{ pane: "p-t1", cwd: "/checkout" }, { pane: "p-t2", cwd: "/checkout" }], focused: () => ({ space: "space-a" }) });
  two.view.root = "/checkout";
  assert.equal(two.view.target(), null);
  two.view.sendTarget = "t2";
  assert.equal(two.view.target().address, "t2");
});

test("a send records uncertain, pastes only when idle, then records sent and focuses the agent", async () => {
  const { view, cx, drain, calls } = await sendSetup();
  view.openSend(cx);
  view.send(cx);
  await drain();
  assert.deepEqual(calls.deliver.map(call => call[0]), ["uncertain", "sent"]);
  assert.deepEqual(calls.deliver[0].slice(1), ["m1", "t7"]);
  const [args] = calls.hc;
  assert.equal(JSON.stringify(args.slice(0, 5)), JSON.stringify(["send", "--json", "--if", "idle", "t7"]));
  assert.match(args[5], /thread t1 · short reply requested/);
  assert.match(args[5], /Why upper case\?/);
  assert.ok(!args.includes("--force"));
  assert.equal(JSON.stringify(calls.run), JSON.stringify([["pane.focus", { terminal: "t7" }]]));
  assert.equal(view.mode, "files");
});

test("a refused send clears the record; an unclear one keeps it uncertain; a busy agent gets nothing", async () => {
  const refused = await sendSetup({ hcResult: { code: 10, stdout: "", stderr: JSON.stringify({ error: { kind: "status_mismatch", message: "t7 is working" } }) } });
  refused.view.send(refused.cx);
  await refused.drain();
  assert.deepEqual(refused.calls.deliver.map(call => call[0]), ["uncertain", "none"]);
  assert.match(refused.view.sendNotice.error, /Not sent: t7 is working/);
  const unclear = await sendSetup({ hcResult: { code: 1, stdout: "", stderr: "" } });
  unclear.view.send(unclear.cx);
  await unclear.drain();
  assert.deepEqual(unclear.calls.deliver.map(call => call[0]), ["uncertain"]);
  assert.match(unclear.view.sendNotice.error, /unclear/);
  const busy = await sendSetup({ agentsList: [agent("t7", { status: "working" })] });
  busy.view.send(busy.cx);
  await busy.drain();
  assert.equal(busy.calls.deliver.length + busy.calls.hc.length, 0);
  const noRecord = await sendSetup({ deliverFail: "disk full" });
  noRecord.view.send(noRecord.cx);
  await noRecord.drain();
  assert.equal(noRecord.calls.hc.length, 0, "nothing is typed unless the uncertain record is durable");
});

test("only new comments in open threads are sent, also where the code changed; an unclear send goes again only on request", async () => {
  const { load } = await modules();
  const model = (await load(path.join(root, "mods/Codewalker/model.js"))).namespace;
  const sent = { id: "m0", actor: you, body: "Old", delivery: { state: "sent" } }, unsure = { id: "m2", actor: you, body: "Maybe", delivery: { state: "uncertain" } };
  const threads = [unsentThread(), unsentThread({ id: "t2", status: "resolved" }), unsentThread({ id: "t3", outdated: true }),
    unsentThread({ id: "t4", messages: [sent] }), unsentThread({ id: "t5", awaitingReply: false, messages: [unsure] })];
  assert.equal(JSON.stringify(model.sendable(threads).map(item => item.thread.id)), JSON.stringify(["t1", "t3"]));
  assert.equal(JSON.stringify(model.sendable(threads, { again: true }).map(item => item.thread.id)), JSON.stringify(["t1", "t3", "t5"]));
  assert.equal(model.uncertainCount(threads), 1);
  const text = model.sendText({ items: model.sendable([threads[4]], { again: true }), root: "/my checkout", branch: "main", helper: "/app/it's/backend.py", note: " Fix first " });
  assert.ok(!text.includes("short reply requested"), "no reply instruction unless asked");
  assert.match(text, /\nFix first\n/);
  assert.match(model.sendText({ items: model.sendable([threads[2]]), root: "/r", helper: "/h" }), /· thread t3 · code changed since/);
  assert.match(text, /python3 '\/app\/it'\\''s\/backend\.py' skill --repo '\/my checkout'$/);
  assert.equal(model.utf8Bytes("aé€😀"), 1 + 2 + 3 + 4);
  // Line breaks typed in a comment stay breaks in Markdown; fenced code is untouched.
  assert.equal(model.markdownBody("a\nb\n\n- x\n- y\n```\ncode\nmore\n```\nend"), "a  \nb\n\n- x  \n- y\n```\ncode\nmore\n```\nend");
});

test("viewed marks target the displayed fingerprint, not a pending or newer file", async () => {
  const gate = deferred(), calls = [];
  const { view, cx, drain } = await modules({ client: {
    setFileViewed: (...args) => { calls.push(args); return gate.promise; },
  } });
  view.files = [{ path: "a.txt", diffFingerprint: "diff-a", viewed: false }, { path: "b.txt", diffFingerprint: "diff-b", viewed: false }];
  view.rowsFingerprint = "old-diff-a";
  view.setViewed(true, cx);
  view.rowsFingerprint = "diff-a";
  view.pendingFile = "b.txt";
  view.setViewed(true, cx);
  await settle();
  assert.equal(calls.length, 0, "stale or dimmed rows cannot mark a newer diff viewed");
  view.pendingFile = null;
  view.setViewed(true, cx);
  view.setViewed(true, cx);
  await settle();
  assert.equal(calls.length, 1, "a pending write prevents duplicate activation");
  assert.deepEqual(calls[0].slice(1), ["a.txt", "diff-a", true]);
  assert.equal(view.files[0].viewed, false, "not marked before the save succeeds");
  view.show("b.txt", { rows: [], diffFingerprint: "diff-b" });
  view.refresh = () => {};
  gate.resolve({ reviewId: "review-a", revision: 2 });
  await drain();
  assert.equal(view.files[0].viewed, true);
  assert.equal(view.files[1].viewed, false, "finishing a save after navigation does not mark the selected file");
  assert.equal(view.composer.value(), "Human question", "marking never navigates or clears a draft");
});

test("failed or superseded viewed writes cannot overwrite the current checklist", async () => {
  const gate = deferred();
  const { view, cx, drain } = await modules({ client: { setFileViewed: () => gate.promise } });
  view.files = [{ path: "a.txt", diffFingerprint: "diff-a", viewed: false }];
  view.rowsFingerprint = "diff-a";
  view.setViewed(true, cx);
  gate.reject(new Error("response lost"));
  await drain();
  assert.equal(view.files[0].viewed, false);
  assert.match(view.error, /Refresh to check/);
  assert.equal(view.viewing, null);

  const newer = deferred();
  view.client.setFileViewed = () => newer.promise;
  view.setViewed(true, cx);
  await settle();
  view.revision = 4; // Another reader has already applied a later unview.
  view.refresh = () => {};
  newer.resolve({ reviewId: "review-a", revision: 2 });
  await drain();
  assert.equal(view.files[0].viewed, false);

  const elsewhere = deferred();
  view.client.setFileViewed = () => elsewhere.promise;
  view.setViewed(true, cx);
  await settle();
  view.resetContext();
  view.files = [{ path: "a.txt", diffFingerprint: "diff-a", viewed: false }];
  elsewhere.resolve({ reviewId: "review-a", revision: 5 });
  await drain();
  assert.equal(view.files[0].viewed, false, "an old checkout's save cannot update a new checkout");
});

test("hide viewed is reversible, preserves selection and reveals changed files on refresh", async () => {
  const { view, cx } = await modules();
  view.hideViewed = true;
  view.files = [{ path: "a.txt", diffFingerprint: "diff-a", viewed: true }, { path: "b.txt", viewed: false }];
  assert.equal(view.visibleFiles().map(file => file.path).join(), "b.txt");
  assert.equal(view.file, "a.txt", "hiding a selected file does not force navigation");
  view.hideViewed = false;
  assert.equal(view.visibleFiles().length, 2);
  view.hideViewed = true;
  view.apply({ ...review(), files: [{ path: "a.txt", diffFingerprint: "diff-new", viewed: false }],
    detail: { path: "a.txt", diffFingerprint: "diff-new", rows: [] } }, {}, cx);
  assert.equal(view.visibleFiles()[0].path, "a.txt");
  assert.equal(view.rowsFingerprint, "diff-new");
  assert.equal(view.composer.value(), "Human question");
});
