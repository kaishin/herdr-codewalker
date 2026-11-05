// Pure review presentation helpers. The Python helper remains the source of truth.
export const PAGE_ROWS = 240;

export function newId() {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function anchorLabel(anchor) {
  if (!anchor) return "File discussion";
  const start = anchor.startLine ?? anchor.start_line ?? anchor.start;
  const end = anchor.endLine ?? anchor.end_line ?? anchor.end ?? start;
  const noun = end !== start ? `lines ${start}–${end}` : `line ${start}`;
  return anchor.side === "old" ? `Old ${noun}` : noun[0].toUpperCase() + noun.slice(1);
}

export function lineOf(row, side) {
  const line = side === "old" ? row?.oldLine : row?.newLine;
  return Number.isInteger(line) && line > 0 ? line : null;
}

export function splitPath(path) {
  const cut = path.lastIndexOf("/");
  return { name: path.slice(cut + 1), dir: cut > 0 ? path.slice(0, cut) : "" };
}

// Theme colors are #rgb or #rrggbb, optionally with alpha; alpha is 0–255.
export function tint(color, alpha) {
  let hex = /^#[0-9a-f]+$/i.test(color ?? "") ? color.slice(1) : null;
  if (!hex) return color;
  if (hex.length <= 4) hex = [...hex.slice(0, 3)].map(c => c + c).join("");
  return `#${hex.slice(0, 6)}${Math.round(alpha).toString(16).padStart(2, "0")}`;
}

export function rowAnchor(row, side) {
  const line = lineOf(row, side);
  return line ? { side, startLine: line, endLine: line } : null;
}

export function anchorKey(path, anchor) {
  return `${path}\u0000${anchor.side}\u0000${anchor.startLine}\u0000${anchor.endLine}`;
}

export function actorLabel(message) {
  const actor = message.actor ?? message.author ?? {};
  const kind = actor.kind === "agent" ? "Agent" : "Human";
  return { kind, name: actor.displayName ?? actor.name ?? actor.id ?? kind };
}

export function threadLine(thread) {
  const a = thread.anchor;
  return { side: a?.side, line: a?.endLine ?? a?.end_line ?? a?.end };
}

export function threadIsOutdated(thread) {
  return thread.outdated === true || thread.stale === true || ["outdated", "stale", "missing", "ambiguous"].includes(thread.anchorStatus ?? thread.anchor_status ?? thread.validity);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Compact local time: "14:05" today, "Nov 3, 14:05" this year, "Nov 3, 2025" before.
export function timestamp(value, now = new Date()) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  if (date.getFullYear() !== now.getFullYear()) return `${day}, ${date.getFullYear()}`;
  return date.toDateString() === now.toDateString() ? time : `${day}, ${time}`;
}

export function readableError(error) {
  if (error?.code === "revision_conflict") return "The discussion changed in another window or agent. Refresh, then retry; your draft is kept.";
  if (error?.code === "snapshot_conflict") return "The code changed. Refresh and check the selected lines; your draft is kept.";
  return error?.message ?? String(error);
}

// `from`: a row index to start at instead of a page, for "Show in diff".
export function pageRows(rows, page, size = PAGE_ROWS, from = null) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (Number.isInteger(from) && from > 0 && from < rows.length) return { rows: rows.slice(from, from + size), page: Math.floor(from / size), pages, start: from };
  const current = Math.max(0, Math.min(page, pages - 1));
  return { rows: rows.slice(current * size, (current + 1) * size), page: current, pages, start: current * size };
}

// Discussions by file: files in diff order, then paths no longer in the diff;
// threads by line. `filter`: "all", "open" or "awaiting".
export function discussionGroups(threads, files, filter = "all") {
  const keep = thread => filter === "open" ? thread.status !== "resolved" : filter === "awaiting" ? thread.awaitingReply === true : true;
  const order = new Map(files.map((file, index) => [file.path, index]));
  const groups = new Map();
  for (const thread of threads.filter(keep)) {
    if (!groups.has(thread.path)) groups.set(thread.path, []);
    groups.get(thread.path).push(thread);
  }
  const rank = path => order.has(path) ? order.get(path) : files.length;
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([path, list]) => ({ path, file: files.find(file => file.path === path) ?? null,
      threads: list.sort((a, b) => (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0)) }));
}

const isHuman = message => message.actor?.kind === "human" && message.actor?.id === "local";

// What Send to agent would send: open threads, including those whose code
// changed since, with at least one of your messages not yet sent. `uncertain`: sent earlier, but
// whether it arrived is unknown; those are sent again only on request.
export function sendable(threads, { again = false } = {}) {
  const wants = message => isHuman(message) && (!message.delivery || (again && message.delivery.state === "uncertain"));
  return threads.filter(thread => thread.status !== "resolved" && thread.messages.some(wants))
    .map(thread => ({ thread, messageIds: thread.messages.filter(wants).map(message => message.id) }));
}

export function uncertainCount(threads) {
  return threads.filter(thread => thread.messages.some(message => isHuman(message) && message.delivery?.state === "uncertain")).length;
}

const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;

// The text pasted into the agent: each discussion with its code and messages,
// then the command that prints how to answer in a thread.
export function sendText({ items, root, branch, helper, note }) {
  const lines = [`Code review feedback from Codewalker for ${root}${branch ? ` (branch ${branch})` : ""}: ${items.length} ${items.length === 1 ? "discussion" : "discussions"}.`];
  if (note?.trim()) lines.push("", note.trim());
  for (const { thread, messageIds } of items) {
    const a = thread.anchor ?? {};
    const range = a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}-${a.endLine}`;
    lines.push("", `### ${thread.path}, ${range}${a.side === "old" ? " (removed side)" : ""} · thread ${thread.id}${threadIsOutdated(thread) ? " · code changed since" : ""}${thread.awaitingReply ? " · short reply requested" : ""}`);
    if (a.snippet) lines.push("```", a.snippet, "```");
    for (const message of thread.messages) {
      const who = isHuman(message) ? "Reviewer" : `${message.actor?.name ?? "Agent"} (${message.actor?.kind ?? "agent"})`;
      lines.push(`${who}${messageIds.includes(message.id) && thread.messages.length > 1 ? " (new)" : ""}: ${message.body}`);
    }
  }
  // How to answer lives in the helper's `skill` output, so the paste stays short.
  lines.push("", "---", `Before you act, read how to answer in these threads: python3 ${quote(helper)} skill --repo ${quote(root)}`);
  return lines.join("\n");
}

// UTF-8 size without TextEncoder, which the native runtime may not have.
export function utf8Bytes(text) {
  let bytes = 0;
  for (const char of text) { const code = char.codePointAt(0); bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return bytes;
}

// Comments are written as plain text: keep each line break, as the editor
// showed it, by making it a Markdown hard break. Fenced code is left as is.
export function markdownBody(text) {
  let fence = null;
  return String(text).split("\n").map((line, index, lines) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && (!fence || (mark[0] === fence[0] && mark.length >= fence.length))) { fence = fence ? null : mark; return line; }
    const next = lines[index + 1];
    return fence || !line.trim() || next === undefined || !next.trim() || /^\s*(`{3,}|~{3,})/.test(next) ? line : `${line}  `;
  }).join("\n");
}
