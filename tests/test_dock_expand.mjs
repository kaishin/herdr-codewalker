import test from "node:test";
import assert from "node:assert/strict";
import { KEY, RESTORE_TIMEOUT, dockExpand, findNode, plan } from "../mods/Codewalker/dock-expand.js";

const DOCK = { panel: "panel", stack: "panel-body", child: "git" };

// The wiring from the README example: main + a side panel in one row.
function tree({ max = 900, size = { px: 368 }, active = "git", extra = [] } = {}) {
  return { id: "root", type: "column", children: [
    { id: "tab-bar", type: "row", children: [{ id: "tabs", type: "block", content: { mod: "tabs" } }] },
    { id: "work-body", type: "row", children: [
      { id: "main", type: "block", content: { tab: "active" } },
      ...extra,
      { id: "panel", type: "column", ...(size ? { size } : {}), ...(max ? { max } : {}), children: [
        { id: "panel-body", type: "stack", active, children: [
          { id: "files", type: "block", content: { mod: "files" } },
          { id: "review", type: "block", content: { mod: "Codewalker" } },
          { id: "git", type: "block", content: { mod: "Git", props: { dock: DOCK } } },
        ] },
      ] },
    ] },
  ] };
}

// Like Herdr: run() only queues; flush() applies the queue to the tree.
function host(root, { layoutName = "mine", drop = false, throws = false } = {}) {
  const h = { root, queue: [], ran: [], store: { layout: layoutName }, clock: 1000, receiptAtFirstRun: undefined };
  h.deps = {
    layout: () => h.root,
    run: (name, args) => {
      if (throws) throw new Error("bad args");
      if (h.receiptAtFirstRun === undefined) h.receiptAtFirstRun = h.store[KEY]?.[h.store.layout] ?? null;
      h.ran.push([name, args]);
      if (!drop) h.queue.push([name, args]);
      return null;
    },
    shared: key => h.store[key],
    setShared: (key, value) => { h.store[key] = value; return null; },
    now: () => h.clock,
  };
  h.flush = () => {
    for (const [name, args] of h.queue.splice(0)) {
      const node = findNode(h.root, args.id);
      if (name === "layout.hide") node.hidden = true;
      if (name === "layout.show") node.hidden = false;
      if (name === "layout.resize") node.size = args.px !== undefined ? { px: args.px } : { weight: args.weight };
    }
  };
  h.controller = dockExpand(h.deps);
  return h;
}

test("without max, expand hides only visible row siblings and fills; restore is exact", () => {
  const h = host(tree({ max: null, extra: [{ id: "notes", type: "block", hidden: true }] }));
  assert.equal(h.controller.state(DOCK).mode, "fill");
  assert.equal(h.controller.expand(DOCK, "Git"), null);
  assert.equal(h.receiptAtFirstRun?.panel, "panel", "receipt is written before the first command");
  assert.deepEqual(h.ran, [["layout.hide", { id: "main" }], ["layout.resize", { id: "panel", weight: 1 }]]);
  h.flush();
  assert.equal(findNode(h.root, "main").hidden, true);
  assert.equal(findNode(h.root, "notes").hidden, true, "an already hidden sibling stays hidden");
  assert.equal(h.controller.state(DOCK).expanded, true);

  h.ran = [];
  assert.equal(h.controller.restore(), null);
  assert.deepEqual(h.ran, [["layout.show", { id: "main" }], ["layout.resize", { id: "panel", px: 368 }]]);
  assert.ok(h.store[KEY].mine.restoring, "the receipt stays until the restore is seen");
  assert.equal(h.controller.reconcile(), "waiting");
  h.flush();
  assert.equal(h.controller.reconcile(), "restored");
  assert.equal(h.store[KEY].mine, undefined);
  assert.deepEqual(findNode(h.root, "panel").size, { px: 368 });
  assert.equal(findNode(h.root, "main").hidden, false);
  assert.equal(findNode(h.root, "notes").hidden, true);
});

test("a finite max widens to max and hides nothing", () => {
  const h = host(tree({ max: 900 }));
  assert.equal(h.controller.state(DOCK).mode, "max");
  h.controller.expand(DOCK, "Git");
  assert.deepEqual(h.ran, [["layout.resize", { id: "panel", px: 900 }]]);
  h.flush();
  assert.equal(findNode(h.root, "main").hidden, undefined);
  h.controller.restore(); h.flush();
  assert.equal(h.controller.reconcile(), "restored");
  assert.deepEqual(findNode(h.root, "panel").size, { px: 368 });
});

test("a panel already at max cannot expand", () => {
  const h = host(tree({ max: 900, size: { px: 900 } }));
  const state = h.controller.state(DOCK);
  assert.equal(state.supported, true);
  assert.equal(state.reason, "at-max");
  assert.match(h.controller.expand(DOCK, "Git"), /maximum width \(900px\)/);
  assert.deepEqual(h.ran, []);
});

test("a missing original size restores as weight 1", () => {
  const h = host(tree({ max: null, size: null }));
  h.controller.expand(DOCK, "Git"); h.flush();
  h.ran = [];
  h.controller.restore();
  assert.deepEqual(h.ran.at(-1), ["layout.resize", { id: "panel", weight: 1 }]);
  h.flush();
  assert.equal(h.controller.reconcile(), "restored");
});

test("a restore that never applies times out and keeps the receipt", () => {
  const h = host(tree({ max: null }));
  h.controller.expand(DOCK, "Git"); h.flush();
  const dropped = host(h.root, { drop: true });
  dropped.store = h.store;
  dropped.controller.restore();
  assert.equal(dropped.controller.reconcile(), "waiting");
  dropped.clock += RESTORE_TIMEOUT + 1;
  h.store.layout = "mine";
  assert.equal(dropped.controller.reconcile(), "timeout");
  const receipt = h.store[KEY].mine;
  assert.equal(receipt.restoring, null);
  assert.match(receipt.error, /Try Restore again/);
  assert.equal(dropped.controller.state(DOCK).expanded, true, "Restore is still offered");
});

test("commands that throw keep the receipt with an error", () => {
  const h = host(tree({ max: null }), { throws: true });
  assert.match(h.controller.expand(DOCK, "Git"), /Expand failed/);
  assert.equal(h.store[KEY].mine.panel, "panel");
  assert.equal(h.controller.state(DOCK).expanded, true);
});

test("hiding the panel or showing a non-participant restores on reconcile", () => {
  for (const change of [root => { findNode(root, "panel").hidden = true; }, root => { findNode(root, "panel-body").active = "files"; }]) {
    const h = host(tree({ max: null }));
    h.controller.expand(DOCK, "Git"); h.flush();
    assert.equal(h.controller.needsReconcile(), false);
    change(h.root);
    assert.equal(h.controller.needsReconcile(), true);
    assert.match(h.controller.reconcile(), /panel-hidden|other-child/);
    h.flush();
    assert.equal(h.controller.reconcile(), "restored");
    assert.equal(findNode(h.root, "main").hidden, false);
  }
});

test("switching the stack to another participant keeps the expansion", () => {
  const h = host(tree({ max: null }));
  h.controller.expand(DOCK, "Git"); h.flush();
  findNode(h.root, "panel-body").active = "review";
  assert.equal(h.controller.needsReconcile(), false);
  assert.equal(h.controller.reconcile(), null);
  assert.equal(h.controller.state({ panel: "panel", stack: "panel-body", child: "review" }).expanded, true, "Codewalker sees the same expansion");
});

test("stale and reparented siblings are not shown again", () => {
  const h = host(tree({ max: null, extra: [{ id: "side", type: "block" }] }));
  h.controller.expand(DOCK, "Git"); h.flush();
  assert.deepEqual(h.store[KEY].mine.hidden, ["main", "side"]);
  // A file edit moves `side` to the tab bar and removes `main`.
  const body = findNode(h.root, "work-body");
  const side = body.children.find(n => n.id === "side");
  body.children = body.children.filter(n => n.id !== "side" && n.id !== "main");
  findNode(h.root, "tab-bar").children.push(side);
  h.ran = [];
  h.controller.restore();
  assert.deepEqual(h.ran, [["layout.resize", { id: "panel", px: 368 }]]);
  h.flush();
  assert.equal(h.controller.reconcile(), "restored");
  assert.equal(side.hidden, true, "a moved sibling is left as it is");
});

test("receipts are kept per layout", () => {
  const h = host(tree({ max: null }), { layoutName: "one" });
  h.controller.expand(DOCK, "Git"); h.flush();
  h.store.layout = "two";
  h.root = tree({ max: null });
  assert.equal(h.controller.state(DOCK).expanded, false);
  assert.equal(h.controller.reconcile(), null, "another layout's receipt is ignored");
  assert.equal(h.controller.expand(DOCK, "Codewalker"), null);
  assert.deepEqual(Object.keys(h.store[KEY]).sort(), ["one", "two"]);
  assert.equal(h.controller.expand(DOCK, "Git"), "The panel is already expanded.");
});

test("only a panel directly in a row is supported", () => {
  const root = tree({ max: null });
  findNode(root, "work-body").type = "column";
  assert.equal(plan(root, DOCK).reason, "not-in-row");
  const h = host(root);
  assert.equal(h.controller.state(DOCK).supported, false);
  assert.equal(host(tree(), { layoutName: null }).controller.state(DOCK).reason, "no-layout-name");
});

test("a waiting restore asks for no reconcile; only a result or a timeout does", () => {
  const h = host(tree({ max: null }));
  h.controller.expand(DOCK, "Git"); h.flush();
  h.controller.restore();
  assert.equal(h.controller.needsReconcile(), false, "waiting must not re-render in a loop");
  h.clock += RESTORE_TIMEOUT + 1;
  assert.equal(h.controller.needsReconcile(), true);
  h.clock -= RESTORE_TIMEOUT + 1;
  h.flush();
  assert.equal(h.controller.needsReconcile(), true);
  assert.equal(h.controller.reconcile(), "restored");
});

test("after an error, nothing restores automatically", () => {
  const h = host(tree({ max: null }));
  h.controller.expand(DOCK, "Git"); h.flush();
  h.store[KEY].mine = { ...h.store[KEY].mine, error: "Restore did not finish. Try Restore again." };
  findNode(h.root, "panel").hidden = true;
  h.ran = [];
  assert.equal(h.controller.needsReconcile(), false);
  assert.equal(h.controller.reconcile(), null);
  assert.deepEqual(h.ran, []);
  assert.equal(h.controller.restore(), null, "a click still restores");
  assert.equal(h.ran[0][0], "layout.show");
});

test("malformed receipts are ignored and replaced", () => {
  for (const bad of [{ v: 2, panel: "panel" }, { v: 1, layout: "mine", panel: "panel", stack: "panel-body", row: "work-body", hidden: "main", size: { px: 368 }, mode: "fill" }, "x", [1]]) {
    const h = host(tree({ max: null }));
    h.store[KEY] = { mine: bad, other: { keep: true } };
    assert.equal(h.controller.state(DOCK).expanded, false);
    assert.equal(h.controller.needsReconcile(), false);
    assert.equal(h.controller.expand(DOCK, "Git"), null);
    assert.equal(h.store[KEY].mine.v, 1);
    assert.deepEqual(h.store[KEY].other, { keep: true }, "other layouts' entries are kept");
  }
});

test("the plan needs a real stack showing this copy", () => {
  const notActive = tree({ max: null, active: "files" });
  assert.equal(plan(notActive, DOCK).reason, "not-active");
  assert.equal(plan(tree({ max: null }), { ...DOCK, child: "nope" }).reason, "child-missing");
  const notStack = tree({ max: null });
  findNode(notStack, "panel-body").type = "column";
  assert.equal(plan(notStack, DOCK).reason, "not-a-stack");
  assert.equal(plan(tree({ max: null }), DOCK).ok, true);
});
