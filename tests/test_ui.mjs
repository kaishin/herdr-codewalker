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
  view.client = { saveDraft: async () => ({ reviewId: "review-a", revision: 2 }), deleteDraft: async () => ({}), submit: async () => ({ thread: { id: "thread-a" } }), review: async () => review(), drafts: async () => [], file: async () => ({ rows: [] }), helperPath: () => "/app/mods/Codewalker/backend.py", ...overrides.client };
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

// Machines that share one checkout path and review ID. `machines[name]` is
// { helper, capabilities?, revision, hello? }; "" is this computer.
// `hello`: "missing" (no file), "old" (a helper without hello) or "down" (cannot start).
function fakeMachines(machines) {
  const calls = [];
  const reply = (data, code = 0) => ({ code, stdout: JSON.stringify(data), stderr: "" });
  const execute = async (command, args, options) => {
    const name = options?.on ?? "", machine = machines[name];
    calls.push({ command, args, on: options?.on ?? null });
    if (!machine || machine.hello === "down") throw new Error(`machine ${name} is not connected`);
    if (args[1] === "hello") {
      if (machine.hello === "missing" || (name && !machine.helper.endsWith(args[0]))) return { code: 2, stdout: "", stderr: `python3: can't open file '/home/${args[0]}': [Errno 2] No such file or directory` };
      if (machine.hello === "old") return reply({ ok: false, protocolVersion: 1, error: { code: "invalid_request", message: "argument command: invalid choice: 'hello'" } }, 1);
      return reply({ ok: true, protocolVersion: 1, data: { helper: machine.helper, helperVersion: 2, capabilities: machine.capabilities ?? [], git: "/usr/bin/git", storePath: `/home/${name}/reviews.sqlite3` } });
    }
    assert.equal(args[0], machine.helper, `only ${name || "this computer"}'s own helper may run there`);
    if (args.includes("--data")) {
      const payload = JSON.parse(args.filter((_arg, index) => args[index - 1] === "--data").join(""));
      (machine.writes ??= []).push(payload);
      return reply({ ok: true, protocolVersion: 1, data: { reviewId: "review-a", revision: ++machine.revision } });
    }
    return reply({ ok: true, protocolVersion: 1, data: { context: { repoRoot: "/checkout", reviewId: "review-a", revision: machine.revision, branch: "main", storePath: `/home/${name}/reviews.sqlite3` },
      scope: "uncommitted", snapshotId: `snap-${name}`, files: [], file: null, threads: [], drafts: [] } });
  };
  return { calls, execute };
}

async function remoteClient(machines, options = {}) {
  const { load } = await modules();
  const { ReviewClient } = (await load(path.join(root, "mods/Codewalker/client.js"))).namespace;
  const fake = fakeMachines(machines);
  return { ...fake, client: new ReviewClient({ helper: "/app/mods/Codewalker/backend.py", execute: fake.execute, ...options }) };
}

test("a remote checkout is read by that machine's own helper and store, never this computer's", async () => {
  const { client, calls } = await remoteClient({ vps: { helper: "/home/vps/.local/share/herdr-codewalker/backend.py", revision: 4 } }, { store: "/local/override.sqlite3" });
  const context = { root: "/checkout", on: "vps", source: "uncommitted" };
  const first = await client.review(context);
  await client.review(context);
  assert.equal(first.machine, "vps");
  assert.equal(first.storePath, "/home/vps/reviews.sqlite3");
  assert.ok(calls.every(call => call.on === "vps" && call.command === "python3"), "every process starts on the checkout's machine");
  assert.deepEqual(calls.map(call => call.args[1] === "hello" ? `hello ${call.args[0]}` : call.args.slice(0, 4).join(" ")), [
    "hello .local/share/herdr-codewalker/backend.py",
    "/home/vps/.local/share/herdr-codewalker/backend.py --repo /checkout review",
    "/home/vps/.local/share/herdr-codewalker/backend.py --repo /checkout review",
  ], "one probe, then the path the remote helper reported");
  assert.ok(!calls.some(call => call.args.includes("/app/mods/Codewalker/backend.py") || call.args.includes("--store")), "no local helper or store path crosses over");
  assert.equal(client.helperPath(context), "/home/vps/.local/share/herdr-codewalker/backend.py");
  assert.equal(client.helperPath({ root: "/checkout", on: "other" }), null, "an unprobed machine has no helper path to send");
});

test("a missing helper, an outdated helper and an unreachable machine are told apart; none falls back to this computer", async () => {
  const machines = { missing: { hello: "missing", helper: "" }, old: { hello: "old", helper: "/home/old/.config/herdr-app/mods/Codewalker/backend.py" }, down: { hello: "down" } };
  const { client, calls } = await remoteClient(machines);
  const code = async on => (await client.review({ root: "/checkout", on }).then(() => null, error => error));
  const missing = await code("missing");
  assert.equal(missing.code, "remote_helper_missing");
  assert.equal(missing.details.install, "hc file write --on 'missing' .local/share/herdr-codewalker/backend.py < '/app/mods/Codewalker/backend.py'");
  assert.match(missing.message, /does not copy code/);
  assert.equal((await code("old")).code, "remote_helper_outdated");
  assert.equal((await code("down")).code, "remote_unavailable");
  assert.equal((await code("never-added")).code, "remote_unavailable");
  assert.ok(calls.length && calls.every(call => call.on && call.args[1] === "hello"), "only probes ran, each on its own machine");
  // Installing the helper needs no restart: a failed probe is asked again.
  Object.assign(machines.missing, { hello: null, helper: "/home/missing/.local/share/herdr-codewalker/backend.py", revision: 0 });
  assert.equal((await client.review({ root: "/checkout", on: "missing" })).machine, "missing");
});

test("the same path and branch on two machines keep separate revisions, commands and saved posts", async () => {
  const machines = { "": { helper: "/app/mods/Codewalker/backend.py", revision: 2 }, vps: { helper: "/home/vps/backend.py", revision: 40 } };
  machines.vps.helper = "/home/vps/.local/share/herdr-codewalker/backend.py";
  const { client } = await remoteClient(machines);
  const local = { root: "/checkout", on: null, source: "uncommitted" }, remote = { ...local, on: "vps" };
  for (const context of [local, remote]) Object.assign(context, { reviewId: (await client.review(context)).reviewId });
  assert.equal(local.reviewId, remote.reviewId, "the fixture models the real collision: one review ID on both machines");
  const intent = { id: "draft-a", path: "a.txt", snapshotId: "snap", anchor: { side: "new", startLine: 1, endLine: 1 } };
  await client.saveDraft(local, intent, "local text");
  assert.equal(machines[""].writes[0].expectedRevision, 2, "the remote review's newer revision is not borrowed");
  assert.equal(machines.vps.writes, undefined);
  await client.setFileViewed(remote, "a.txt", "diff-a", true, "same-command-id");
  await client.setFileViewed(local, "a.txt", "diff-a", true, "same-command-id");
  assert.equal(machines.vps.writes[0].expectedRevision, 40);
  assert.equal(machines[""].writes[1].expectedRevision, 3, "one command ID on two machines is two commands");
  // A post saved for the remote checkout cannot be replayed into the local store.
  const receipt = { commandId: "post-a", context: remote, operation: "create", payload: { commandId: "post-a", reviewId: remote.reviewId, body: "Remote question" } };
  await assert.rejects(client.submit(local, { ...intent, pendingPost: receipt }, "Remote question", "post-a"), error => error.code === "review_conflict");
  assert.equal(machines[""].writes.length, 2);
  await client.submit(remote, { ...intent, pendingPost: receipt }, "Remote question", "post-a");
  assert.deepEqual(machines.vps.writes.at(-1), receipt.payload, "the exact saved envelope goes to its own machine");
});

test("large mutation JSON is split only for a helper that says it joins --data parts", async () => {
  const body = "α😀".repeat(20_000);
  const send = async machine => {
    const { client, calls } = await remoteClient({ vps: { helper: "/home/vps/.local/share/herdr-codewalker/backend.py", revision: 1, ...machine } });
    const context = { root: "/checkout", on: "vps", source: "uncommitted", reviewId: "review-a", revision: 1 };
    await client.saveDraft(context, { id: "draft-a", path: "a.txt" }, body);
    await client.saveDraft(context, { id: "draft-b", path: "a.txt" }, "short");
    return calls.filter(call => call.args.includes("--data")).map(call => call.args.filter((_arg, index) => call.args[index - 1] === "--data"));
  };
  const [large, small] = await send({ capabilities: ["data-parts"] });
  assert.ok(large.length > 1 && large.every(part => part.length <= 30_000 && part.isWellFormed()), "bounded entries, no split surrogate pair");
  assert.equal(JSON.parse(large.join("")).body, body);
  assert.equal(small.length, 1, "an ordinary payload keeps the single --data entry");
  const [whole] = await send({ capabilities: [] });
  assert.equal(whole.length, 1, "a helper without the capability gets one entry, as before");
  assert.equal(JSON.parse(whole[0]).body, body);
});

test("the view keeps machines apart: late answers, a typed folder, and a pane beside a remote terminal", async () => {
  const state = { active: "a", cwd: "/projects/x" }, reads = [], calls = [];
  let current = {};
  const { view, cx, drain, load } = await modules({
    props: () => current,
    spaces: () => [{ id: "space-a", active: state.active === "a", folder: "/projects/x", machine: null }, { id: "space-b", active: state.active === "b", folder: "/projects/x", machine: "vps" }],
    panes: () => [{ pane: state.active === "b" ? "vps/p1" : "p1", tab: "t1", focused: true, cwd: state.cwd }],
    focused: () => ({ pane: state.active === "b" ? "vps/p1" : "p1", terminal: "t1", cwd: state.cwd }),
    run: (name, args) => calls.push([name, args]),
    client: { review: async context => { reads.push(`${context.on ?? "local"} ${context.root}`); return { ...review(), root: context.root, machine: context.on ?? null }; } } });
  view.intent = null;
  view.root = "/projects/x";
  view.on = null;
  // The same path in a remote space is another checkout: the review is read again, there.
  state.active = "b";
  view.follow(cx);
  await drain();
  assert.equal(view.on, "vps");
  assert.equal(reads.at(-1), "vps /projects/x");
  // A write to this computer's review that answers late has the same review ID. It must not count here.
  view.revision = 3;
  view.wrote({ reviewId: view.reviewId, revision: 50, machine: null });
  assert.equal(view.revision, 3);
  view.wrote({ reviewId: view.reviewId, revision: 4, machine: "vps" });
  assert.equal(view.revision, 4);
  // A typed path stays on the machine in view; it is never silently read on this computer.
  view.rootInput.set_value("/srv/other");
  view.changeRoot(cx);
  await drain();
  assert.equal(reads.at(-1), "vps /srv/other");
  // The key beside a remote terminal pins that machine in the new pane's stored props.
  const main = await load(path.join(root, "mods/Codewalker/main.js"));
  const open = async (props, active) => { state.active = active; current = props; const next = new main.namespace.default(); next.init({}, cx); if (!props.launch) cx.tasks.pop(); await drain(); return next; };
  await open({ launch: true, overlay: "o1" }, "b");
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["pane.split", { direction: "right", pane: "vps/p1", mod: "Codewalker", props: { framed: true, folder: "/projects/x", on: "vps" } }]));
  assert.equal((await open({ framed: true, folder: "/projects/x", on: "vps" }, "a")).on, "vps", "the stored machine wins over the active space");
  assert.equal((await open({ framed: true, folder: "/projects/x" }, "b")).on, null, "a pinned folder without a machine is this computer, whatever space is active");
});

test("Send reaches only an agent on the checkout's machine and names that machine's helper", async () => {
  const calls = { hc: [], deliver: [] };
  const { view, cx, drain } = await modules({
    agents: () => [agent("t7", { focused: true }), agent("vps/t7"), agent("vps/t9", { space: "space-b" })],
    panes: () => [{ pane: "p-t7", cwd: "/checkout" }, { pane: "p-vps/t7", cwd: "/checkout" }],
    focused: () => ({ space: "space-a", tab: "tab-a", pane: null, terminal: null, cwd: null }),
    exec: async (command, args) => { assert.equal(command, "hc"); calls.hc.push(args); return { code: 0, stdout: "{}", stderr: "" }; },
    client: { helperPath: context => context.on === "vps" ? "/home/vps/.local/share/herdr-codewalker/backend.py" : null,
      deliver: async (context, _ids, state, target) => { calls.deliver.push([context.on, state, target]); return { reviewId: "review-a", revision: 9, machine: context.on }; } } });
  view.intent = null;
  view.on = "vps";
  view.files = [{ path: "a.txt" }];
  view.threads = [unsentThread()];
  assert.deepEqual(view.candidates().map(a => a.address), ["vps/t7"], "the focused local agent at the same path is not offered");
  view.sendTarget = "t7";
  assert.equal(view.target().address, "vps/t7");
  view.send(cx);
  await drain();
  assert.deepEqual(calls.deliver, [["vps", "uncertain", "vps/t7"], ["vps", "sent", "vps/t7"]]);
  assert.equal(calls.hc[0][2], "vps/t7");
  assert.match(calls.hc[0][3], /python3 '\/home\/vps\/\.local\/share\/herdr-codewalker\/backend\.py' skill --repo '\/checkout'/);
  // Before that machine's helper has answered there is no path to give an agent: nothing is sent.
  view.on = "other";
  view.threads = [unsentThread()];
  view.send(cx);
  await drain();
  assert.equal(calls.hc.length, 1);
});

test("a restored draft and its saved post stay on the machine whose store returned them", async () => {
  const posts = [];
  const { view, cx, drain } = await modules({ client: { submit: async (context, intent, _body, commandId) => { posts.push([context.on, intent.pendingPost.context.on, commandId]); return { thread: { id: "t1" }, machine: context.on }; } } });
  view.intent = null;
  view.composer.set_value("");
  view.on = "vps";
  // Saved by a Herdr on that machine itself, which calls it "this computer".
  const saved = { root: "/checkout", on: null, reviewId: "review-a" };
  view.restoreDraft({ id: "draft-r", path: "a.txt", body: "Question", intent: { id: "draft-r", path: "a.txt", context: saved,
    pendingPost: { commandId: "post-r", context: saved, operation: "create", payload: { commandId: "post-r", reviewId: "review-a", body: "Question" } } } }, cx);
  await drain();
  assert.equal(view.intent.context.on, "vps");
  view.submit(cx);
  await drain();
  assert.deepEqual(posts, [["vps", "vps", "post-r"]], "the same command is retried in the store it came from, not on this computer");
});

test("without a remote folder watch, an agent's turn on that machine refreshes Review", async () => {
  let list = [agent("vps/t7", { status: "working" }), agent("t1", { status: "working" })];
  const { view, cx, drain } = await modules({ agents: () => list });
  const refreshes = () => Boolean(view.soonTimer);
  view.on = "vps";
  view.watchAgents(cx);
  list = [list[0], agent("t1", { status: "idle" })];
  view.watchAgents(cx);
  await drain();
  assert.equal(refreshes(), false, "an agent on this computer says nothing about the remote store");
  list = [agent("vps/t7", { status: "done" }), list[1]];
  view.watchAgents(cx);
  await drain();
  assert.equal(refreshes(), true);
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

test("active discussions hide resolved and absent files, keep outdated anchors, and All restores history in diff order", async () => {
  const { load } = await modules();
  const model = await load(path.join(root, "mods/Codewalker/model.js"));
  const files = [{ path: "b.txt" }, { path: "a.txt" }];
  const threads = [thread("t1", "gone.txt", 3, { awaitingReply: true }), thread("t2", "a.txt", 9, { awaitingReply: true }), thread("t3", "b.txt", 5, { status: "resolved" }), thread("t4", "a.txt", 2), thread("t5", "b.txt", 7, { outdated: true })];
  // The module runs in its own realm; compare plain JSON.
  const ids = filter => JSON.stringify(model.namespace.discussionGroups(threads, files, filter).map(group => [group.path, group.threads.map(item => item.id)]));
  assert.equal(ids(), JSON.stringify([["b.txt", ["t5"]], ["a.txt", ["t4", "t2"]]]));
  assert.equal(ids("active"), ids());
  assert.equal(ids("all"), JSON.stringify([["b.txt", ["t3", "t5"]], ["a.txt", ["t4", "t2"]], ["gone.txt", ["t1"]]]));
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
// hcResult: what `hc send` answers (an Error: exec rejects; a function: awaited per call).
async function sendSetup({ hcResult, agentsList, deliverFail } = {}) {
  const calls = { deliver: [], hc: [], run: [], notify: [], options: [] };
  const harness = await modules({
    agents: () => agentsList ?? [agent("t7")],
    panes: () => (agentsList ?? [agent("t7")]).map(a => ({ pane: a.pane, cwd: "/checkout" })),
    focused: () => ({ space: "space-a", tab: "tab-a", pane: null, terminal: null, cwd: null }),
    exec: async (command, args, options) => {
      assert.equal(command, "hc", "Send runs hc through exec, the only call with a time limit");
      calls.hc.push(args); calls.options.push(options);
      const answer = typeof hcResult === "function" ? await hcResult() : hcResult;
      if (answer instanceof Error) throw answer;
      return answer ?? { code: 0, stdout: JSON.stringify({ started: true, status: "idle", turn: 4 }), stderr: "" };
    },
    run: (command, args) => calls.run.push([command, args]),
    notify: note => calls.notify.push(note),
    client: { deliver: async (_context, ids, state, target) => { calls.deliver.push([state, ids.join(","), target]); if (deliverFail) throw new Error(deliverFail); return { reviewId: "review-a", revision: 9 }; } },
  });
  harness.view.intent = null;
  harness.view.files = [{ path: "a.txt" }];
  harness.view.threads = [unsentThread()];
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

test("a send records uncertain, runs plain hc send, then records sent and focuses the agent", async () => {
  const { view, cx, drain, calls } = await sendSetup();
  view.threads.push(unsentThread({ id: "gone", path: "gone.txt", messages: [{ id: "gone-message", actor: you, body: "Historical question" }] }));
  view.openSend(cx);
  view.send(cx);
  await drain();
  assert.deepEqual(calls.deliver.map(call => call[0]), ["uncertain", "sent"]);
  assert.deepEqual(calls.deliver[0].slice(1), ["m1", "t7"]);
  const [args] = calls.hc;
  // Plain send: herdr-core still refuses a blocked agent and waits for a draft; never --force.
  assert.equal(JSON.stringify(args.slice(0, 3)), JSON.stringify(["send", "--json", "t7"]));
  assert.equal(args.length, 4);
  // hc send waits while a person types there (60 s or more): hc()'s fixed 30 s would cut it off.
  assert.equal(calls.options[0].timeout, 600000);
  assert.match(args[3], /thread t1 · short reply requested/);
  assert.match(args[3], /Why upper case\?/);
  assert.ok(!args.includes("--force") && !args.includes("--if"));
  assert.equal(JSON.stringify(calls.run), JSON.stringify([["pane.focus", { terminal: "t7" }]]));
  assert.equal(view.mode, "files");
  assert.equal(view.sendNotice, null);
  assert.equal(calls.notify[0].title, "Delivered to agent");
  assert.match(calls.notify[0].body, /1 discussion to Agent \(t7\)/);
});

test("a refused send clears the record; an unclear one keeps it uncertain; a busy agent gets nothing", async () => {
  const refused = await sendSetup({ hcResult: { code: 10, stdout: "", stderr: JSON.stringify({ error: { kind: "status_mismatch", message: "t7 is working" } }) } });
  refused.view.send(refused.cx);
  await refused.drain();
  assert.deepEqual(refused.calls.deliver.map(call => call[0]), ["uncertain", "none"]);
  assert.equal(refused.view.sendNotice.state, "refused");
  assert.match(refused.view.sendNotice.error, /^Not sent to Agent \(t7\): t7 is working\. Nothing was typed\./);
  const unclear = await sendSetup({ hcResult: { code: 1, stdout: "", stderr: "" } });
  unclear.view.send(unclear.cx);
  await unclear.drain();
  assert.deepEqual(unclear.calls.deliver.map(call => call[0]), ["uncertain"]);
  assert.equal(unclear.view.sendNotice.state, "unconfirmed");
  assert.match(unclear.view.sendNotice.error, /^No confirmation from Agent \(t7\): hc exited 1\. It may have arrived\./);
  const busy = await sendSetup({ agentsList: [agent("t7", { status: "working" })] });
  busy.view.send(busy.cx);
  await busy.drain();
  assert.equal(busy.calls.deliver.length + busy.calls.hc.length, 0);
  const noRecord = await sendSetup({ deliverFail: "disk full" });
  noRecord.view.send(noRecord.cx);
  await noRecord.drain();
  assert.equal(noRecord.calls.hc.length, 0, "nothing is typed unless the uncertain record is durable");
});

test("only a send hc refused before typing clears the record; a lost answer stays unconfirmed and is not sent again", async () => {
  const failure = (code, kind, message, hint) => ({ code, stdout: "", stderr: JSON.stringify({ error: { kind, message, hint } }) });
  const cases = [
    [new Error("hc took longer than 600 s and was stopped"), "unconfirmed", /^No confirmation from Agent \(t7\): no answer after 10 minutes\. It may have arrived\. Check that chat before you send again\.$/],
    [failure(5, "unavailable", "studio didn't answer within 95 s", "it may still have been typed; check with hc read before retrying"), "unconfirmed", /studio didn't answer within 95 s\. It may have arrived/],
    [failure(5, "unavailable", "t7 is still starting: its output has not settled", "nothing was typed; check hc read t7, then retry"), "refused", /^Not sent to Agent \(t7\): t7 is still starting.*Nothing was typed\.$/],
    // A cancel prints no kind, and a signal can end hc with 130 too: not proof.
    [{ code: 130, stdout: "", stderr: "" }, "unconfirmed", /hc exited 130\. It may have arrived/],
    // A refusal code alone, without the kind herdr-core prints for it, is not proof either.
    [{ code: 10, stdout: "", stderr: "Killed" }, "unconfirmed", /hc exited 10\. It may have arrived/],
    [new Error("cannot run hc: No such file or directory (os error 2)"), "refused", /cannot run hc/],
  ];
  for (const [hcResult, state, text] of cases) {
    const { view, cx, drain, calls } = await sendSetup({ hcResult });
    view.openSend(cx);
    view.send(cx);
    await drain();
    assert.deepEqual(calls.deliver.map(call => call[0]), state === "refused" ? ["uncertain", "none"] : ["uncertain"], text.source);
    assert.equal(view.sendNotice.state, state);
    assert.match(view.sendNotice.error, text);
    assert.equal(calls.hc.length, 1, "never retried on its own");
    assert.equal(calls.notify.length + calls.run.length, 0, "no success toast or focus");
    assert.equal(view.mode, "send");
  }
});

test("an idle or done agent gets a plain send; hc's refusal of a blocked one types nothing and clears the record", async () => {
  // The app's "idle" includes a seen finished turn (core word "done"), and --if has no idle-or-done.
  for (const status of ["idle", "done"]) {
    const { view, cx, drain, calls } = await sendSetup({ agentsList: [agent("studio/t16d", { status })] });
    view.on = "studio";
    view.client.helperPath = () => "/home/studio/backend.py";
    view.send(cx);
    await drain();
    assert.equal(JSON.stringify(calls.hc[0].slice(0, 3)), JSON.stringify(["send", "--json", "studio/t16d"]), status);
    assert.ok(!calls.hc[0].includes("--if") && !calls.hc[0].includes("--force"));
    assert.deepEqual(calls.deliver.map(call => call[0] + " " + call[2]), ["uncertain studio/t16d", "sent studio/t16d"]);
  }
  // It turned blocked after the click: herdr-core refuses at typing time.
  const blocked = { code: 9, stdout: "", stderr: JSON.stringify({ error: { kind: "blocked", message: "t16d is blocked (permission)", hint: "typing would answer its dialog; read its screen first (hc read t16d), or --force" } }) };
  const { view, cx, drain, calls } = await sendSetup({ agentsList: [agent("studio/t16d", { status: "done" })], hcResult: blocked });
  view.on = "studio";
  view.client.helperPath = () => "/home/studio/backend.py";
  view.send(cx);
  await drain();
  assert.deepEqual(calls.deliver.map(call => call[0]), ["uncertain", "none"]);
  assert.equal(view.sendNotice.error, "Not sent to Agent (studio/t16d): t16d is blocked (permission). Nothing was typed.");
});

test("a send shows Sending while hc waits, and an answer after the checkout changed only notifies", async () => {
  const answers = [deferred(), deferred()];
  let call = 0;
  const { view, cx, drain, calls } = await sendSetup({ hcResult: () => answers[call++].promise });
  view.sendNote.set_value("Fix first");
  view.openSend(cx);
  view.send(cx);
  await settle();
  assert.equal(view.sending, true);
  assert.deepEqual({ ...view.sendNotice }, { state: "sending", target: "t7", name: "Agent" });
  view.openSend(cx);
  assert.equal(view.sendNotice?.state, "sending", "reopening Send keeps showing the send in progress");
  view.send(cx);
  assert.equal(calls.hc.length, 1, "no second send while one waits");
  view.resetContext();
  answers[0].resolve({ code: 0, stdout: "{}", stderr: "" });
  await drain();
  assert.deepEqual(calls.deliver.map(call => call[0]), ["uncertain", "sent"], "the outcome is recorded in the checkout it was sent from");
  assert.equal(calls.notify[0].title, "Delivered to agent");
  assert.equal(calls.run.length, 0, "no focus jump after the person moved on");
  assert.equal(view.mode, "send");
  assert.equal(view.sendNote.value(), "Fix first");
  assert.equal(view.sendNotice, null);
  assert.equal(view.sending, false);
  Object.assign(view, { root: "/checkout", reviewId: "review-a", files: [{ path: "a.txt" }], threads: [unsentThread()] }); // The next checkout loaded.
  view.send(cx);
  await settle();
  assert.equal(calls.hc.length, 2);
  view.resetContext();
  answers[1].reject(new Error("hc took longer than 600 s and was stopped"));
  await drain();
  assert.equal(calls.notify[1].title, "Confirmation missing");
  assert.match(calls.notify[1].body, /^No confirmation from Agent \(t7\)/);
  assert.equal(view.sendNotice, null, "the other checkout's view shows no stale notice");
});

test("only new comments in open threads are sent, also where the code changed; an unclear send goes again only on request", async () => {
  const { load } = await modules();
  const model = (await load(path.join(root, "mods/Codewalker/model.js"))).namespace;
  const sent = { id: "m0", actor: you, body: "Old", delivery: { state: "sent", target: "t1" } }, unsure = { id: "m2", actor: you, body: "Maybe", delivery: { state: "uncertain", target: "studio/t16d" } };
  const threads = [unsentThread(), unsentThread({ id: "t2", status: "resolved" }), unsentThread({ id: "t3", outdated: true }),
    unsentThread({ id: "t4", messages: [sent] }), unsentThread({ id: "t5", awaitingReply: false, messages: [unsure] })];
  assert.equal(JSON.stringify(model.sendable(threads).map(item => item.thread.id)), JSON.stringify(["t1", "t3"]));
  assert.equal(JSON.stringify(model.sendable(threads, { again: true }).map(item => item.thread.id)), JSON.stringify(["t1", "t3", "t5"]));
  assert.equal(model.uncertainCount(threads), 1);
  assert.equal(model.unconfirmedTargets(threads), "studio/t16d", "the banner names where the unconfirmed send went");
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

test("other mods can open a pinned commit review with props, and refresh keeps the resolved SHA", async () => {
  const reads = [];
  const { view, cx, drain } = await modules({
    props: () => ({ framed: true, folder: "/caller/checkout", scope: "commit", commit: "HEAD~1" }),
    client: { review: async context => { reads.push({ ...context }); return { ...review(), root: context.root, commitOid: "commit-a", parentCount: 1 }; } },
  });
  await settle(); // init's opening read starts before the test harness takes over.
  await drain();
  assert.equal(reads[0].root, "/caller/checkout");
  assert.equal(reads[0].source, "commit");
  assert.equal(reads[0].commitRef, "HEAD~1");
  assert.equal(view.fixed, true);
  assert.equal(view.commitOid, "commit-a");
  view.refresh(cx);
  await drain();
  assert.equal(reads.at(-1).commitRef, "commit-a", "a moving ref cannot silently change the commit on refresh");
  view.intent = null;
  view.commitInput.set_value("HEAD");
  view.applySource("commit", cx);
  await drain();
  assert.equal(reads.at(-1).commitRef, "HEAD", "Show explicitly resolves the input again");
  view.rootInput.set_value("/another/checkout");
  view.changeRoot(cx);
  await drain();
  assert.equal(reads.at(-1).commitRef, "HEAD", "a different checkout resolves its own commit, not the old checkout's SHA");
});

test("switching to a commit waits for the draft save and keeps the source on failure", async () => {
  const gate = deferred(), reads = [];
  const { view, cx, drain } = await modules({ client: {
    saveDraft: () => gate.promise,
    review: async context => { reads.push(context); return { ...review(), commitOid: "commit-a" }; },
  } });
  view.commitInput.set_value("HEAD~2");
  view.applySource("commit", cx);
  await settle();
  assert.equal(view.source, "uncommitted");
  gate.reject(new Error("save failed"));
  await drain();
  assert.equal(view.source, "uncommitted");
  assert.equal(reads.length, 0);
  assert.equal(view.composer.value(), "Human question");
  view.client.saveDraft = async () => ({});
  view.applySource("commit", cx);
  await drain();
  assert.equal(view.source, "commit");
  assert.equal(reads[0].commitRef, "HEAD~2");
});

test("the client carries a commit through reads, viewed writes and durable comment receipts", async () => {
  const { load } = await modules();
  const { ReviewClient } = (await load(path.join(root, "mods/Codewalker/client.js"))).namespace;
  const calls = [], writes = [];
  let revision = 1;
  const client = new ReviewClient({ helper: "/helper.py", execute: async (_command, args) => {
    calls.push(args);
    let data;
    if (args.includes("review")) data = { context: { repoRoot: "/checkout", reviewId: "review-a", revision },
      scope: "commit", commitOid: "commit-a", snapshotId: "snap-a", files: [{ path: "historical.txt", status: "modified", viewed: false, diffFingerprint: "diff-a" }],
      file: { path: "historical.txt", diffFingerprint: "diff-a", hunks: [] }, threads: [], drafts: [] };
    else { const payload = JSON.parse(args[args.indexOf("--data") + 1]); writes.push(payload); data = { reviewId: "review-a", revision: ++revision }; }
    return { code: 0, stdout: JSON.stringify({ ok: true, protocolVersion: 1, data }) };
  } });
  const context = { root: "/checkout", reviewId: "review-a", revision, source: "commit", commitRef: "commit-a", baseRef: "unrelated-branch-base" };
  // A previous comparison lacked this file. It must not trigger a retained-file fallback here.
  client.latest = { context: { reviewId: "review-a" }, scope: "uncommitted", files: [] };
  const result = await client.review(context, "historical.txt");
  assert.equal(calls[0].includes("--file"), true);
  assert.equal(calls[0][calls[0].indexOf("--commit") + 1], "commit-a");
  assert.equal(calls[0].includes("--base"), false);
  assert.equal(result.detail.diffFingerprint, "diff-a");
  assert.equal(result.commitOid, "commit-a");
  await client.setFileViewed(context, "historical.txt", "diff-a", true);
  await client.submit(context, { id: "draft-a", path: "historical.txt", snapshotId: "snap-a", anchor: { side: "new", startLine: 1, endLine: 1 } }, "Historical question", "post-a");
  assert.equal(writes[0].commit, "commit-a");
  assert.equal(writes[1].target.pendingPost.payload.commit, "commit-a", "the persisted receipt survives a moving ref or restart");
  assert.equal(writes[2].commit, "commit-a");
  assert.equal(writes[2].base, undefined);

  const model = (await load(path.join(root, "mods/Codewalker/model.js"))).namespace;
  const historical = unsentThread({ anchor: { side: "new", startLine: 1, endLine: 1, commitOid: "commit-a" } });
  const sent = model.sendText({ items: model.sendable([historical]), root: "/checkout", helper: "/helper.py" });
  assert.match(sent, /Historical commit commit-a; inspect the current code/);
});

test("returning to a mode restores its selected diff immediately and refreshes without blanking it", async () => {
  const reads = [], gate = deferred();
  const detail = (path, text) => ({ path, diffFingerprint: text, rows: [{ kind: "+", newLine: 1, text }] });
  const { view, cx, drain } = await modules({ client: { review: async context => {
    reads.push(context);
    if (context.source === "uncommitted") return gate.promise;
    return { ...review(), snapshotId: "branch-snapshot", baseRef: "main", files: [{ path: "branch.txt" }], detail: detail("branch.txt", "branch") };
  } } });
  view.intent = null;
  view.composer.set_value("");
  view.apply({ ...review(), files: [{ path: "a.txt", diffFingerprint: "original", viewed: true }], detail: detail("a.txt", "original") }, {}, cx);
  view.page = 2;
  view.baseInput.set_value("main");
  view.applySource("branch", cx);
  await drain();
  view.applySource("uncommitted", cx);
  assert.equal(view.file, "a.txt");
  assert.equal(view.rows[0]?.text, "original", "the diff is available in the switch callback, before any helper response");
  assert.equal(view.rowsSnapshot, "snapshot-b");
  assert.equal(view.rowsFingerprint, "original");
  assert.equal(view.files[0].viewed, true);
  assert.equal(view.page, 2);
  assert.equal(view.loading, false);
  await settle();
  assert.equal(reads.at(-1).source, "uncommitted");
  gate.resolve({ ...review(), snapshotId: "edited", files: [{ path: "a.txt", diffFingerprint: "edited", viewed: false }], detail: detail("a.txt", "edited") });
  await drain();
  assert.equal(view.rows[0].text, "edited");
  assert.equal(view.rowsSnapshot, "edited");
  assert.equal(view.files[0].viewed, false);
});

test("commit mode restores the pinned SHA, while Show re-resolves without clearing its old diff", async () => {
  const reads = [];
  let nextOid = "commit-a";
  const { view, cx, drain } = await modules({ client: { review: async context => {
    reads.push(context);
    const oid = context.commitRef === "HEAD" ? nextOid : context.commitRef;
    return { ...review(), snapshotId: context.source === "commit" ? oid : "working", commitOid: oid, parentCount: 1,
      files: [{ path: "a.txt" }], detail: { path: "a.txt", rows: [{ kind: "+", newLine: 1, text: oid ?? "working" }] } };
  } } });
  view.intent = null;
  view.commitInput.set_value("HEAD");
  view.applySource("commit", cx);
  await drain();
  view.applySource("uncommitted", cx);
  await drain();
  nextOid = "commit-b";
  view.applySource("commit", cx, { resolveCommit: false });
  assert.equal(view.commitOid, "commit-a");
  assert.equal(view.rows[0].text, "commit-a");
  assert.equal(view.loading, false);
  await drain();
  assert.equal(reads.at(-1).commitRef, "commit-a", "mode switching is navigation, not an implicit Show");
  view.applySource("commit", cx);
  assert.equal(view.rows[0].text, "commit-a", "Show retains the identified old commit until its replacement is ready");
  await drain();
  assert.equal(reads.at(-1).commitRef, "HEAD");
  assert.equal(view.commitOid, "commit-b");
  assert.equal(view.rows[0].text, "commit-b");
});

test("cached mode failures keep the diff readable but cannot send stale comments or change viewed marks", async () => {
  let fail = false, writes = 0;
  const { view, cx, drain } = await modules({ client: {
    review: async () => {
      if (fail) throw new Error("checkout unavailable");
      return { ...review(), files: [{ path: "a.txt", diffFingerprint: "fp" }],
        detail: { path: "a.txt", diffFingerprint: "fp", rows: [{ kind: "+", newLine: 1, text: "code" }] }, threads: [unsentThread()] };
    },
    deliver: async () => { writes++; }, setFileViewed: async () => { writes++; }, setStatus: async () => { writes++; },
  } });
  view.intent = null;
  view.refresh(cx);
  await drain();
  view.baseInput.set_value("main");
  view.applySource("branch", cx);
  await drain();
  fail = true;
  view.applySource("uncommitted", cx);
  view.target = () => ({ address: "t1", status: "idle" });
  view.send(cx);
  view.setViewed(true, cx);
  view.setStatus(view.threads[0], cx);
  view.begin({ side: "new", startLine: 1, endLine: 1 }, cx);
  await drain();
  assert.equal(writes, 0);
  assert.equal(view.intent, null);
  assert.equal(view.canAnchor(), false);
  assert.equal(view.rows[0].text, "code");
  assert.match(view.error, /last loaded comparison.*checkout unavailable/);
  fail = false;
  view.refresh(cx);
  await drain();
  assert.equal(view.canAnchor(), true);
  assert.equal(view.error, null);
});

test("late responses cannot overwrite a restored mode, and another ref or checkout never borrows its cache", async () => {
  const pending = [], reads = [];
  const { view, cx, drain } = await modules({ client: { review: context => {
    reads.push(context);
    const gate = deferred(); pending.push(gate); return gate.promise;
  } } });
  const result = (text, extra = {}) => ({ ...review(), ...extra, files: [{ path: "a.txt" }], detail: { path: "a.txt", rows: [{ kind: "+", text }] } });
  view.intent = null;
  view.apply(result("working"), {}, cx);
  view.baseInput.set_value("main");
  view.applySource("branch", cx);
  await settle();
  pending[0].resolve(result("main"));
  await drain();
  view.applySource("uncommitted", cx);
  await settle();
  view.applySource("branch", cx);
  assert.equal(view.rows[0].text, "main");
  await settle();
  pending[1].resolve(result("late working"));
  await settle();
  assert.equal(view.rows[0].text, "main");
  pending[2].resolve(result("updated main"));
  await drain();
  assert.equal(view.rows[0].text, "updated main");
  view.baseInput.set_value("release");
  view.applySource("branch", cx);
  assert.equal(view.rows.length, 0, "main's rows must not be labelled as release");
  await settle();
  pending[3].resolve(result("release", { baseRef: "release" }));
  await drain();
  view.rootInput.set_value("/other");
  view.changeRoot(cx);
  assert.equal(view.rows.length, 0, "another checkout never uses cached local content");
  await settle();
  pending[4].resolve(result("other", { root: "/other", reviewId: "other-review" }));
  await drain();
  view.applySource("uncommitted", cx);
  assert.equal(view.rows.length, 0, "changing checkout also drops inactive modes");
  await settle();
  assert.equal(reads.at(-1).root, "/other");
  pending[5].resolve(result("other working", { root: "/other", reviewId: "other-review" }));
  await drain();
});

test("returning to an empty comparison keeps the loaded empty state during refresh", async () => {
  const gate = deferred();
  let hold = false;
  const { view, cx, drain } = await modules({ client: { review: () => hold ? gate.promise : Promise.resolve(review()) } });
  view.intent = null;
  view.file = null;
  view.apply(review(), {}, cx);
  view.baseInput.set_value("main");
  view.applySource("branch", cx);
  await drain();
  hold = true;
  view.applySource("uncommitted", cx);
  assert.equal(view.root, "/checkout");
  assert.equal(view.file, null);
  assert.equal(view.files.length, 0);
  assert.equal(view.loading, false);
  gate.resolve(review());
  await drain();
});

function dockHost({ max } = {}) {
  const body = { id: "panel-body", type: "stack", active: "review", children: [{ id: "review", type: "block", content: { mod: "Codewalker" } }] };
  const panel = { id: "panel", type: "column", size: { px: 368 }, ...(max ? { max } : {}), children: [body] };
  const main = { id: "main", type: "block", content: { tab: "active" } };
  const root = { id: "work-body", type: "row", children: [main, panel] };
  const state = new Map([["layout", "personal"]]), commands = [];
  return { root, panel, main, state, commands, overrides: {
    layout: () => root, shared: key => state.get(key), setShared: (key, value) => state.set(key, value),
    run: (name, args) => {
      commands.push([name, args]);
      const node = args.id === "main" ? main : panel;
      if (name === "layout.hide") node.hidden = true;
      else if (name === "layout.show") node.hidden = false;
      else if (name === "layout.resize") node.size = args.px !== undefined ? { px: args.px } : { weight: args.weight };
      else assert.fail(`Unexpected command: ${name}`);
    },
  } };
}

test("docked expand and restore leave the current diff, cache, and unsaved draft intact", async () => {
  const host = dockHost();
  let writes = 0, commandRead = false;
  const command = deferred();
  const { view, cx, drain } = await modules({ ...host.overrides,
    nextCommand: () => { if (commandRead) return new Promise(() => {}); commandRead = true; return command.promise; },
    client: { saveDraft: async () => { writes++; } },
  });
  view.rows = [{ kind: "+", newLine: 1, text: "kept diff" }];
  view.page = 2;
  view.rememberComparison();
  const intent = view.intent, composer = view.composer, rows = view.rows, comparisons = view.comparisons;
  command.resolve("expand"); await settle();
  assert.equal(host.main.hidden, true);
  assert.equal(host.panel.size.weight, 1);
  assert.equal(view.expansionState().expanded, true);
  view.toggleExpansion(cx);
  view.reconcileExpansion(cx); await drain();
  assert.equal(host.main.hidden, false);
  assert.equal(host.panel.size.px, 368);
  assert.equal(view.expansionState().expanded, false);
  assert.equal(view.intent, intent);
  assert.equal(view.composer, composer);
  assert.equal(view.composer.value(), "Human question");
  assert.equal(view.rows, rows);
  assert.equal(view.page, 2);
  assert.equal(view.comparisons, comparisons);
  assert.equal(writes, 0, "resizing must not submit, save, or navigate a review");
});

test("pane and overlay reviews never operate on the layout's dock", async () => {
  for (const properties of [{ framed: true }, { overlay: "review-window" }]) {
    const host = dockHost();
    const { view, cx } = await modules({ ...host.overrides, props: () => properties });
    assert.equal(view.expansionState(), null);
    view.toggleExpansion(cx);
    assert.equal(host.commands.length, 0);
  }
});

test("closing an expanded dock restores the workspace through the view lifecycle", async () => {
  const host = dockHost();
  const { view, cx, drain } = await modules(host.overrides);
  view.toggleExpansion(cx);
  host.panel.hidden = true; // A key or the layout's toolbar closed the panel.
  view.reconcileExpansion(cx); await drain();
  view.reconcileExpansion(cx); await drain();
  assert.equal(host.main.hidden, false);
  assert.equal(host.panel.hidden, true, "restoring width must not reopen a closed panel");
  assert.equal(host.panel.size.px, 368);
  assert.equal(Object.keys(host.state.get("workspace.expanded.v1")).length, 0);
});

test("resolving hides a conversation immediately; reopening or returning files restores it without deleting messages", async () => {
  let saved = thread("t1", "a.txt", 1, { messages: [{ id: "m1", body: "Keep the rationale" }] });
  const { view, cx, drain } = await modules({ client: {
    setStatus: async (_context, _id, status) => ({ reviewId: "review-a", revision: 2, thread: saved = { ...saved, status } }),
    review: async () => ({ ...review(), files: [{ path: "a.txt" }], threads: [saved] }),
  } });
  view.intent = null;
  view.files = [{ path: "a.txt" }];
  view.threads = [saved];
  view.focusThread = saved.id;
  view.setStatus(saved, cx);
  await drain();
  assert.equal(view.visibleThreads().length, 0);
  assert.equal(view.focusThread, null);
  assert.equal(view.threads[0].messages[0].body, "Keep the rationale");
  view.filter = "all";
  assert.equal(view.visibleThreads()[0].id, saved.id);
  view.setStatus(view.threads[0], cx);
  await drain();
  view.filter = "active";
  assert.equal(view.visibleThreads().length, 1);
  view.apply({ ...review(), files: [], threads: [saved] }, {}, cx);
  assert.equal(view.file, null, "a removed diff is not kept open just for its history");
  assert.equal(view.visibleThreads().length, 0);
  view.apply({ ...review(), files: [{ path: "a.txt" }], threads: [saved] }, {}, cx);
  assert.equal(view.visibleThreads().length, 1);
});

test("a reply draft survives when its file leaves the diff, but its history stays hidden by default", async () => {
  const { view, cx } = await modules();
  const saved = thread("t1", "a.txt", 1);
  view.threads = [saved];
  view.intent = { ...view.intent, threadId: saved.id };
  view.apply({ ...review(), files: [], threads: [saved], detail: { path: "a.txt", rows: [], note: "Not in this diff" } }, { path: "a.txt" }, cx);
  assert.equal(view.file, "a.txt");
  assert.equal(view.visibleThreads().length, 0);
  assert.equal(view.intent.threadId, "t1");
  assert.equal(view.composer.value(), "Human question");
});

test("Clear history requires confirmation of an unchanged review and retries an uncertain result without clearing newer discussions", async () => {
  const calls = [];
  const newer = thread("new", "a.txt", 1);
  const { view, cx, drain } = await modules({ client: {
    clearHistory: async (context, commandId) => {
      calls.push({ ...context, commandId });
      if (calls.length === 1) throw new Error("answer lost");
      return { reviewId: "review-a", revision: 2, cleared: { threads: 1 } };
    },
    review: async () => ({ ...review(), revision: 4, files: [{ path: "a.txt" }], threads: [newer] }),
  } });
  view.clearHistory(cx);
  assert.equal(view.clearAttempt, null, "an open composer must be closed first");
  assert.equal(view.composer.value(), "Human question");
  view.intent = null;
  view.clearHistory(cx);
  assert.equal(calls.length, 0, "the first press only asks");
  view.revision++;
  view.clearHistory(cx);
  assert.equal(view.clearAttempt, null, "a changed review needs fresh confirmation");
  assert.equal(calls.length, 0);
  view.revision = 1;
  view.clearHistory(cx);
  view.clearHistory(cx);
  await drain();
  assert.equal(view.clearAttempt.uncertain, true);
  assert.equal(view.revision, 4);
  view.clearHistory(cx);
  await drain();
  assert.equal(calls[0].commandId, calls[1].commandId);
  assert.equal(calls[1].revision, 1, "the confirmation's revision stays pinned");
  assert.equal(view.clearAttempt, null);
  assert.equal(view.threads[0].id, "new", "an older replay does not erase newer discussions from the view");
});

test("clearing pins the confirmed revision and refuses remote helpers without the capability", async () => {
  const { client } = await remoteClient({ vps: { helper: "/home/vps/.local/share/herdr-codewalker/backend.py", capabilities: ["history-clear"], revision: 7 } });
  const context = { on: "vps", root: "/checkout", reviewId: "review-a", revision: 3 };
  await client.review(context);
  const requests = [];
  const call = client.call.bind(client);
  client.call = (context, command, args) => { if (command === "history-clear") requests.push(JSON.parse(args[1])); return call(context, command, args); };
  await client.clearHistory(context, "clear-once");
  assert.equal(requests[0].expectedRevision, 3, "do not silently adopt a newer background read's revision");
  assert.equal(requests[0].confirmed, true);
  const old = await remoteClient({ vps: { helper: "/home/vps/.local/share/herdr-codewalker/backend.py", revision: 7 } });
  await assert.rejects(old.client.clearHistory(context, "no-clear"), error => error.code === "remote_helper_outdated");
  assert.equal(old.calls.some(call => call.args.includes("history-clear")), false);
});
