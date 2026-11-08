// dock-expand.js v1: expand a docked side panel to fill the workspace, then
// restore it exactly. Shared by the Git and Codewalker mods: keep both copies
// identical. No imports; Herdr functions come in as arguments, so tests run in Node.
//
// Clicks only: layout.hide / layout.show / layout.resize. Never layout.set and
// never a file write, so the layout file and unrelated clicks stay as they are.
// The receipt lives in shared("workspace.expanded.v1"), a map keyed by layout
// name, so it survives restarts and two layouts never overwrite each other.
//
// - The panel's parent must be a "row". Anything else is not supported.
// - A panel with a finite `max` is only widened to that max (mode "max"); its
//   siblings stay. Without `max`, the visible siblings in that row are hidden
//   and the panel gets weight 1 (mode "fill"). Hidden siblings are not touched.
// - run() only queues a command, so a restore keeps its receipt (marked
//   `restoring`) until layout() shows it applied; after RESTORE_TIMEOUT the
//   receipt stays with an error, and Restore can be tried again.
// - reconcile() restores on its own when the panel is hidden or a mod that is
//   not a participant is shown in its stack. Call it from cx.spawn, never
//   during render: needsReconcile() is the cheap check for render, and is
//   false while a restore is only waiting (no render/spawn loop). Do not
//   cx.notify() for "waiting" or null: layout and shared changes re-render.
// - A receipt with an error is never restored automatically (no retry loop);
//   Restore stays offered. A hidden panel can still be shown by its toolbar.
// - Malformed receipts are ignored, and expanding replaces them.

export const KEY = "workspace.expanded.v1";
export const PARTICIPANTS = ["Git", "Codewalker"];
export const RESTORE_TIMEOUT = 5000;

export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function parentOf(node, id, parent = null) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return parent;
  for (const child of node.children || []) {
    const found = parentOf(child, id, node);
    if (found) return found;
  }
  return null;
}

const finite = n => typeof n === "number" && Number.isFinite(n) && n > 0;

// The size a node has now, as layout.resize takes it. Missing means weight 1.
export function sizeOf(node) {
  const size = node?.size;
  if (finite(size?.px)) return { px: size.px };
  if (finite(size?.weight)) return { weight: size.weight };
  return { weight: 1 };
}

const sameSize = (a, b) => (a.px !== undefined ? a.px === b.px : a.weight === b.weight);

const activeChild = stack => (stack.children || []).find(n => n.id === stack.active) || (stack.children || [])[0] || null;

// A v1 receipt this code can act on, or null.
export function validReceipt(r) {
  const id = v => typeof v === "string" && v.length > 0;
  const size = v => v && typeof v === "object" && (finite(v.px) || finite(v.weight));
  if (!r || typeof r !== "object" || r.v !== 1) return null;
  if (!id(r.layout) || !id(r.panel) || !id(r.stack) || !id(r.row)) return null;
  if (!Array.isArray(r.hidden) || !r.hidden.every(id)) return null;
  if (!size(r.size) || !["fill", "max"].includes(r.mode)) return null;
  return r;
}

// What expanding would do, or why it can't. Pure.
export function plan(root, dock) {
  if (!dock?.panel || !dock?.stack) return { ok: false, reason: "no-dock" };
  const panel = findNode(root, dock.panel), stack = findNode(root, dock.stack), row = parentOf(root, dock.panel);
  if (!panel || !stack) return { ok: false, reason: "missing" };
  if (!findNode(panel, dock.stack)) return { ok: false, reason: "stack-outside-panel" };
  if (stack.type !== "stack") return { ok: false, reason: "not-a-stack" };
  if (dock.child && !(stack.children || []).some(n => n.id === dock.child)) return { ok: false, reason: "child-missing" };
  if (dock.child && activeChild(stack)?.id !== dock.child) return { ok: false, reason: "not-active" };
  if (row?.type !== "row" || !row.id) return { ok: false, reason: "not-in-row" };
  if (panel.hidden) return { ok: false, reason: "hidden" };
  const size = sizeOf(panel);
  if (finite(panel.max)) {
    if (size.px !== undefined && size.px >= panel.max) return { ok: false, reason: "at-max", max: panel.max };
    return { ok: true, mode: "max", max: panel.max, row: row.id, hide: [], size, target: { px: panel.max } };
  }
  const hide = (row.children || []).filter(n => n.id && n.id !== panel.id && !n.hidden).map(n => n.id);
  if (!hide.length) return { ok: false, reason: "alone" };
  return { ok: true, mode: "fill", max: null, row: row.id, hide, size, target: { weight: 1 } };
}

export function expandCommands(dock, p) {
  return [...p.hide.map(id => ["layout.hide", { id }]), ["layout.resize", { id: dock.panel, ...p.target }]];
}

// Recorded siblings that are still children of the recorded row. Others are
// stale (removed or moved) and are left alone.
export function validSiblings(root, receipt) {
  const row = findNode(root, receipt.row);
  const ids = new Set((row?.children || []).map(n => n.id));
  return (receipt.hidden || []).filter(id => ids.has(id) && id !== receipt.panel);
}

export function restoreCommands(root, receipt) {
  const commands = validSiblings(root, receipt).map(id => ["layout.show", { id }]);
  const panel = findNode(root, receipt.panel);
  if (panel && parentOf(root, receipt.panel)?.id === receipt.row) commands.push(["layout.resize", { id: receipt.panel, ...(receipt.size || { weight: 1 }) }]);
  return commands;
}

// True once layout() shows the receipt's restore applied.
export function restored(root, receipt) {
  if (validSiblings(root, receipt).some(id => findNode(root, id)?.hidden)) return false;
  const panel = findNode(root, receipt.panel);
  if (!panel || parentOf(root, receipt.panel)?.id !== receipt.row) return true;
  return sameSize(receipt.size || { weight: 1 }, sizeOf(panel));
}

// Why the panel should be restored without a click, or null.
export function autoRestoreReason(root, receipt, participants = PARTICIPANTS) {
  const panel = findNode(root, receipt.panel);
  if (!panel || parentOf(root, receipt.panel)?.id !== receipt.row) return "panel-moved";
  if (panel.hidden) return "panel-hidden";
  const stack = findNode(root, receipt.stack);
  if (!stack) return "stack-missing";
  const mod = activeChild(stack)?.content?.mod;
  if (!participants.includes(mod)) return "other-child";
  return null;
}

const receipts = shared => {
  const value = shared(KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

// deps: { layout, run, shared, setShared, now? }. Each mod builds its own; the
// shared receipt is the only state, so two controllers stay consistent.
export function dockExpand(deps) {
  const { layout, run, shared, setShared } = deps, now = deps.now || (() => Date.now());
  const name = () => (typeof shared("layout") === "string" ? shared("layout") : null);
  const get = () => { const n = name(); return n ? validReceipt(receipts(shared)[n]) : null; };
  const put = receipt => {
    const n = name(); if (!n) return;
    const all = { ...receipts(shared) };
    if (receipt) all[n] = receipt; else delete all[n];
    setShared(KEY, all);
  };
  const runAll = commands => { for (const [command, args] of commands) run(command, args); };

  function startRestore(receipt) {
    const root = layout();
    put({ ...receipt, restoring: now(), error: null });
    try { runAll(restoreCommands(root, receipt)); return null; }
    catch (e) { put({ ...receipt, restoring: null, error: `Restore failed: ${e?.message || e}` }); return get().error; }
  }

  return {
    // For the expand button: { supported, expanded, restoring, mode, max, reason, error }.
    state(dock) {
      const receipt = get();
      if (receipt && receipt.panel === dock?.panel) {
        return { supported: true, expanded: true, restoring: Boolean(receipt.restoring), mode: receipt.mode, max: receipt.max ?? null, reason: null, error: receipt.error || null };
      }
      if (!name()) return { supported: false, expanded: false, restoring: false, mode: null, max: null, reason: "no-layout-name", error: null };
      const p = plan(layout(), dock);
      return { supported: p.ok || p.reason === "at-max", expanded: false, restoring: false, mode: p.mode || (p.reason === "at-max" ? "max" : null), max: p.max ?? null, reason: p.ok ? null : p.reason, error: null };
    },
    // Writes the receipt first, then queues the clicks. Returns an error or null.
    expand(dock, by) {
      if (get()) return "The panel is already expanded.";
      const n = name(); if (!n) return "The layout name is not known.";
      const p = plan(layout(), dock);
      if (!p.ok) return p.reason === "at-max" ? `The panel is already at the layout's maximum width (${p.max}px).` : "This layout can't expand the panel.";
      const receipt = { v: 1, layout: n, panel: dock.panel, stack: dock.stack, row: p.row, hidden: p.hide, size: p.size, mode: p.mode, max: p.max, by: by || null, at: now(), restoring: null, error: null };
      put(receipt);
      try { runAll(expandCommands(dock, p)); return null; }
      // The receipt stays, so Restore can undo whatever did apply.
      catch (e) { put({ ...receipt, error: `Expand failed: ${e?.message || e}` }); return get().error; }
    },
    restore() {
      const receipt = get();
      return receipt ? startRestore(receipt) : null;
    },
    // Cheap check for render: is there anything for reconcile() to do?
    needsReconcile() {
      const receipt = get();
      if (!receipt) return false;
      const root = layout();
      if (receipt.restoring) return restored(root, receipt) || now() - receipt.restoring > RESTORE_TIMEOUT;
      if (receipt.error) return false;
      return autoRestoreReason(root, receipt) !== null;
    },
    // Run from cx.spawn. Finishes or times out a restore, and restores when the
    // panel was hidden, moved, or shows a non-participant. Returns what it did.
    reconcile() {
      const receipt = get();
      if (!receipt) return null;
      const root = layout();
      if (receipt.restoring) {
        if (restored(root, receipt)) { put(null); return "restored"; }
        if (now() - receipt.restoring > RESTORE_TIMEOUT) {
          put({ ...receipt, restoring: null, error: "Restore did not finish. Try Restore again." });
          return "timeout";
        }
        return "waiting";
      }
      if (receipt.error) return null;
      const reason = autoRestoreReason(root, receipt);
      if (!reason) return null;
      startRestore(receipt);
      return reason;
    },
  };
}
