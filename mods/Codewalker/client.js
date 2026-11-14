import { exec } from "herdr";
import { newId, quote } from "./model.js";

export const HUMAN = { kind: "human", id: "local", name: "You" };
const STATUS = { added: "A", untracked: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechanged: "T" };
const KIND = { add: "+", delete: "-", context: " ", meta: "" };

// A helper on another machine must report at least this build in `hello`.
export const HELPER_MIN = 2;
// Where a helper is looked for on another machine, relative to that user's home.
// The first is the documented install path; the second is that machine's own Codewalker mod.
export const REMOTE_HELPERS = [".local/share/herdr-codewalker/backend.py", ".config/herdr-app/mods/Codewalker/backend.py"];
// UTF-16 units per --data entry: at most 90 KB of UTF-8, below Linux's 128 KiB argument limit.
const DATA_PART = 30_000;

// The machine a checkout is on (`exec`'s `on`); null is this computer.
export const machineOf = context => context?.on || null;
// Review IDs come from the path and branch, so the same path on two machines has one ID.
const scoped = (context, id) => `${machineOf(context) ?? ""}\u0000${id}`;

export function dataParts(text, size = DATA_PART) {
  const parts = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + size);
    // Never split a surrogate pair: each entry must be valid text on its own.
    if (end < text.length && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

function protocolError(error) {
  const result = new Error(error?.message ?? "The review helper failed.");
  result.code = error?.code ?? "helper_error";
  result.details = error?.details;
  return result;
}

function normalizeThread(thread) {
  return { ...thread, path: thread.anchor.path, outdated: thread.anchor.validity === "stale" };
}

function normalizeDraft(draft) {
  const target = draft.target ?? {};
  return { ...draft, path: target.path ?? target.anchor?.path ?? "Saved discussion", intent: { id: draft.id, path: target.path ?? target.anchor?.path, anchor: target.anchor, threadId: target.threadId ?? null, snapshotId: target.snapshotId ?? target.anchor?.snapshotId, context: target.context, pendingPost: target.pendingPost, replyRequested: target.replyRequested === true } };
}

const RETAINED = "This path is no longer in the selected diff. Its discussions are retained below.";

function fileDetail(file) {
  const rows = [];
  for (const hunk of file.hunks ?? []) {
    rows.push({ kind: "@", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, hunkId: hunk.id });
    for (const row of hunk.rows) rows.push({ ...row, kind: KIND[row.kind] ?? row.kind, hunkId: hunk.id });
  }
  const note = file.binary ? "Binary change · no line anchors available" : file.tooLarge ? "This diff exceeds the helper's safe preview limit. Existing discussions remain available." : file.note ?? file.warning ?? null;
  return { path: file.path, diffFingerprint: file.diffFingerprint, rows, note };
}

function humanDrafts(drafts) {
  return (drafts ?? []).filter(draft => draft.actor?.kind === HUMAN.kind && draft.actor?.id === HUMAN.id).map(normalizeDraft);
}

export class ReviewClient {
  constructor({ helper, execute = exec, store } = {}) {
    this.helper = helper;
    this.execute = execute;
    this.store = store;
    this.tail = Promise.resolve();
    this.revisions = new Map();
    this.pending = new Map();
    this.attempts = new Map();
    this.latest = null;
    this.lastWrite = 0;
    // Machine name -> the helper found there. Failed probes are not kept.
    this.helpers = new Map();
    this.paths = new Map();
    this.local = null;
  }

  // The command a person runs to put the helper on another machine. Review never copies it itself.
  installCommand(on) {
    return `hc file write --on ${quote(on)} ${REMOTE_HELPERS[0]} < ${quote(this.helper)}`;
  }

  // The helper that runs for this context: the bundled one here, or the one
  // already installed on the checkout's machine. Never this computer's path there.
  helperFor(context) {
    const on = machineOf(context);
    if (!on) return Promise.resolve({ machine: null, path: this.helper, capabilities: null });
    let found = this.helpers.get(on);
    if (!found) {
      found = this.probe(on);
      this.helpers.set(on, found);
      found.catch(() => { if (this.helpers.get(on) === found) this.helpers.delete(on); });
    }
    return found;
  }

  async hello(path, on) {
    const result = await this.execute("python3", [path, "hello", "--json"], on ? { on } : undefined);
    try { return { result, response: JSON.parse(result.stdout) }; }
    catch { return { result, response: null }; }
  }

  async probe(on) {
    let outdated = null, problem = null;
    for (const candidate of REMOTE_HELPERS) {
      let answer;
      // exec rejects when the program cannot start there: no Python, or no connection.
      try { answer = await this.hello(candidate, on); }
      catch (error) {
        throw protocolError({ code: "remote_unavailable", details: { machine: on },
          message: `Cannot run python3 on ${on}: ${error?.message ?? error}. Check the connection (hc machine ls) and that Python 3.10+ is installed there. Nothing was read from this computer instead.` });
      }
      const { result, response } = answer, data = response?.data;
      if (response?.ok && response.protocolVersion === 1 && typeof data?.helper === "string" && data.helperVersion >= HELPER_MIN) {
        if (!data.git) throw protocolError({ code: "remote_git_missing", details: { machine: on }, message: `Git is not installed on ${on}, or not on the PATH that Herdr uses there.` });
        this.paths.set(on, data.helper);
        return { machine: on, path: data.helper, capabilities: data.capabilities ?? [], storePath: data.storePath, helperVersion: data.helperVersion };
      }
      if (response?.error?.code === "unsupported_python") throw protocolError({ code: "remote_python_unsupported", details: { machine: on }, message: `${response.error.message} (${on} has ${response.error.details?.python ?? "an older version"}).` });
      // A JSON answer that is not a current hello is an older or newer helper.
      if (response) outdated ??= candidate;
      else if (!/can't open file|No such file/i.test(result.stderr ?? "")) problem ??= (result.stderr ?? "").trim().slice(-300);
    }
    if (outdated) throw protocolError({ code: "remote_helper_outdated", details: { machine: on, path: outdated, install: this.installCommand(on) },
      message: `The review helper on ${on} (~/${outdated}) is from another Codewalker version. Review does not change it. Put a current helper there from this computer: ${this.installCommand(on)}` });
    throw protocolError({ code: "remote_helper_missing", details: { machine: on, install: this.installCommand(on) },
      message: `The review helper is not installed on ${on}${problem ? ` (${problem})` : ""}. Review does not copy code to other machines. Install it from this computer: ${this.installCommand(on)}` });
  }

  // Repeated --data entries only for a helper that says it joins them.
  async dataArgs(context, json) {
    const parts = dataParts(json);
    if (parts.length > 1) {
      let helper = await this.helperFor(context);
      if (!helper.machine) {
        this.local ??= this.hello(this.helper, null).then(({ response }) => response?.data?.capabilities ?? [], () => []);
        helper = { capabilities: await this.local };
      }
      if (helper.capabilities.includes("data-parts")) return parts.flatMap(part => ["--data", part]);
    }
    return ["--data", json];
  }

  serialize(action) {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => {});
    return next;
  }

  async call(context, command, args = []) {
    const write = !["review", "list", "context", "export"].includes(command);
    // Lets the view ignore store-folder events caused by its own writes, before and after they land.
    if (write) this.lastWrite = Date.now();
    try { return await this.invoke(context, command, args); }
    finally { if (write) this.lastWrite = Date.now(); }
  }

  async invoke(context, command, args) {
    const on = machineOf(context), helper = await this.helperFor(context);
    const argv = [helper.path, "--repo", context.root];
    // The store override is a path on this computer; another machine keeps its own store.
    if (this.store && !on) argv.push("--store", this.store);
    argv.push(command, "--json", ...args);
    let result;
    if (!on) result = await this.execute("python3", argv);
    else {
      // The same call as the local one, started on the checkout's machine. A write whose
      // answer is lost stays uncertain: callers retry the same command ID.
      try { result = await this.execute("python3", argv, { on }); }
      catch (error) { throw protocolError({ code: "remote_unavailable", details: { machine: on }, message: `No answer from ${on}: ${error?.message ?? error}. Nothing was read from this computer instead.` }); }
    }
    let response;
    try { response = JSON.parse(result.stdout); }
    catch {
      // The helper may have been moved or replaced: look for it again on the next call.
      if (on) { this.helpers.delete(on); this.paths.delete(on); }
      throw protocolError({ code: "helper_error", message: `The review helper${on ? ` on ${on}` : ""} did not return JSON (exit ${result.code}). ${result.stderr?.slice(0, 500) ?? ""}` });
    }
    if (!response.ok) throw protocolError(response.error);
    if (result.code !== 0 || response.protocolVersion !== 1) throw protocolError({ message: "The review helper returned an unsupported response. Check the installed helper version." });
    const data = response.data;
    const identity = data.context?.reviewId ?? data.reviewId;
    const revision = data.context?.revision ?? data.revision;
    if (identity && Number.isInteger(revision)) this.revisions.set(scoped(context, identity), Math.max(this.revisions.get(scoped(context, identity)) ?? 0, revision));
    // Results name their machine: the same review ID can exist on two machines.
    if (data && typeof data === "object") data.machine = on;
    return data;
  }

  // The helper path an agent on the checkout's machine runs (Send to agent).
  // Null until that machine's helper has answered; never this computer's path for another machine.
  helperPath(context) {
    const on = machineOf(context);
    return on ? this.paths.get(on) ?? null : this.helper;
  }

  sourceArgs(context) {
    const args = ["--scope", context.source ?? "uncommitted"];
    if (context.source === "branch" && context.baseRef) args.push("--base", context.baseRef);
    if (context.source === "commit") args.push("--commit", context.commitRef ?? "");
    return args;
  }

  // Reads bypass the ordered mutation queue: they never write, so a background
  // refresh cannot delay a draft save or post. The view applies only the newest
  // read for its current review identity.
  async review(context, path = null) {
    const args = this.sourceArgs(context);
    const sameSource = this.latest?.machine === machineOf(context) && this.latest?.scope === (context.source ?? "uncommitted")
      && (context.source !== "branch" || this.latest.baseRef === context.baseRef)
      && (context.source !== "commit" || this.latest.commitOid === context.commitRef);
    const known = sameSource && context.reviewId && this.latest?.context?.reviewId === context.reviewId ? this.latest.files : null;
    // Retained discussions must never trigger an unchanged-file browsing fallback.
    let data = null;
    if (path && !(known && !known.some(file => file.path === path))) {
      try { data = await this.call(context, "review", [...args, "--file", path]); }
      catch (error) { if (error.code !== "not_found" || error.details?.path !== path) throw error; }
    }
    data ??= await this.call(context, "review", path ? args : [...args, "--select-first"]);
    this.latest = data;
    const detail = data.file ? fileDetail(data.file) : path ? { path, rows: [], note: RETAINED } : null;
    return {
      machine: data.machine, root: data.context.repoRoot, reviewId: data.context.reviewId, revision: data.context.revision,
      branch: data.context.branch, storePath: data.context.storePath, snapshotId: data.snapshotId, baseRef: data.baseRef, baseOid: data.baseOid, commitOid: data.commitOid, parentCount: data.parentCount,
      files: data.files.map(file => ({ ...file, status: STATUS[file.status] ?? file.status })),
      threads: data.threads.map(normalizeThread), drafts: humanDrafts(data.drafts), note: data.warnings?.join(" · "), detail,
    };
  }

  async file(context, path) {
    const review = await this.review(context, path);
    return { ...review.detail, machine: review.machine, reviewId: review.reviewId, snapshotId: review.snapshotId, revision: review.revision, threads: review.threads };
  }

  async drafts(context) {
    return humanDrafts((await this.call(context, "list", this.sourceArgs(context))).drafts);
  }

  mutation(context, command, payload, commandId = newId()) {
    return this.serialize(async () => {
      const key = `${machineOf(context) ?? ""}\u0000${context.root}\u0000${context.reviewId}\u0000${commandId}`;
      let entry = this.pending.get(key);
      if (!entry) {
        entry = { command, payload: { commandId, reviewId: context.reviewId, expectedRevision: this.revisions.get(scoped(context, context.reviewId)) ?? context.revision, actor: HUMAN, ...payload } };
        this.pending.set(key, entry);
      }
      const data = await this.call(context, entry.command, await this.dataArgs(context, JSON.stringify(entry.payload)));
      // Keep the original envelope in memory for an explicit uncertain-result retry.
      return data;
    });
  }

  saveDraft(context, intent, body) {
    return this.mutation(context, "draft-save", { draftId: intent.id, body, target: { path: intent.path, anchor: intent.anchor, threadId: intent.threadId, snapshotId: intent.snapshotId, context: intent.context ?? context, pendingPost: this.attempts.get(intent.id) ?? intent.pendingPost, replyRequested: intent.replyRequested === true, scope: context.source, base: context.baseRef, commit: context.commitRef } });
  }

  deleteDraft(context, draftId) {
    return this.mutation(context, "draft-delete", { draftId });
  }

  submit(context, intent, body, commandId) {
    return this.serialize(async () => {
      const key = `${machineOf(context) ?? ""}\u0000${context.root}\u0000${context.reviewId}\u0000${commandId}`;
      let entry = this.pending.get(key);
      const restored = intent.pendingPost;
      if (!entry && restored?.commandId === commandId) {
        if (machineOf(restored.context) !== machineOf(context) || restored.context.root !== context.root || restored.payload.reviewId !== context.reviewId) throw protocolError({ code: "review_conflict", message: "This saved post belongs to another machine, checkout or branch." });
        entry = { command: restored.operation, payload: restored.payload };
        this.pending.set(key, entry);
      }
      if (!entry) {
        const revision = this.revisions.get(scoped(context, context.reviewId)) ?? context.revision;
        const command = intent.threadId ? "reply" : "create";
        const data = intent.threadId ? { threadId: intent.threadId, body } : { scope: context.source, ...(context.source === "branch" ? { base: context.baseRef } : context.source === "commit" ? { commit: context.commitRef } : {}), anchor: { path: intent.path, side: intent.anchor.side, startLine: intent.anchor.startLine, endLine: intent.anchor.endLine, snapshotId: intent.snapshotId }, body };
        const payload = { commandId, reviewId: context.reviewId, expectedRevision: revision + 1, actor: HUMAN, ...data, ...(intent.replyRequested ? { replyRequested: true } : {}) };
        const receipt = { commandId, context, operation: command, payload };
        // Persist the exact post envelope BEFORE invoking it. The draft commit advances revision by one.
        const draft = { commandId: newId(), reviewId: context.reviewId, expectedRevision: revision, actor: HUMAN, draftId: intent.id, body,
          target: { path: intent.path, anchor: intent.anchor, threadId: intent.threadId, snapshotId: intent.snapshotId, context: intent.context ?? context, pendingPost: receipt, replyRequested: intent.replyRequested === true } };
        await this.call(context, "draft-save", await this.dataArgs(context, JSON.stringify(draft)));
        this.attempts.set(intent.id, receipt);
        entry = { command, payload };
        this.pending.set(key, entry);
      }
      return this.call(context, entry.command, await this.dataArgs(context, JSON.stringify(entry.payload)));
    });
  }

  // Only the author's own messages; the helper keeps the replaced body.
  editMessage(context, messageId, body, commandId) {
    return this.mutation(context, "edit", { messageId, body }, commandId);
  }

  // Only the author's own messages. The first comment takes its thread with it.
  deleteMessage(context, messageId, commandId) {
    return this.mutation(context, "delete", { messageId }, commandId);
  }

  // Delivery record for Send to agent: "uncertain" before, "sent" after, "none" to clear.
  deliver(context, messageIds, state, target, commandId) {
    return this.mutation(context, "deliver", { messageIds, state, target }, commandId);
  }

  setFileViewed(context, path, diffFingerprint, viewed, commandId) {
    return this.mutation(context, "file-view", { scope: context.source,
      ...(context.source === "branch" ? { base: context.baseRef } : context.source === "commit" ? { commit: context.commitRef } : {}), path, diffFingerprint, viewed }, commandId);
  }

  setStatus(context, threadId, status, commandId) {
    return this.mutation(context, "resolve", { threadId, resolved: status === "resolved" }, commandId);
  }
}
