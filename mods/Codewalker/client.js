import { exec } from "herdr";
import { newId } from "./model.js";

export const HUMAN = { kind: "human", id: "local", name: "You" };
const STATUS = { added: "A", untracked: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechanged: "T" };
const KIND = { add: "+", delete: "-", context: " ", meta: "" };

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
    if (context.on) throw protocolError({ code: "unsupported_remote", message: "This helper reviews local checkouts only. Choose a local checkout; no local fallback is used for remote spaces." });
    const argv = [this.helper, "--repo", context.root];
    if (this.store) argv.push("--store", this.store);
    argv.push(command, "--json", ...args);
    const result = await this.execute("python3", argv);
    let response;
    try { response = JSON.parse(result.stdout); }
    catch { throw protocolError({ code: "helper_error", message: `The review helper did not return JSON (exit ${result.code}). ${result.stderr?.slice(0, 500) ?? ""}` }); }
    if (!response.ok) throw protocolError(response.error);
    if (result.code !== 0 || response.protocolVersion !== 1) throw protocolError({ message: "The review helper returned an unsupported response. Check the installed helper version." });
    const data = response.data;
    const identity = data.context?.reviewId ?? data.reviewId;
    const revision = data.context?.revision ?? data.revision;
    if (identity && Number.isInteger(revision)) this.revisions.set(identity, Math.max(this.revisions.get(identity) ?? 0, revision));
    return data;
  }

  sourceArgs(context) {
    const args = ["--scope", context.source ?? "uncommitted"];
    if (context.source === "branch" && context.baseRef) args.push("--base", context.baseRef);
    return args;
  }

  // Reads bypass the ordered mutation queue: they never write, so a background
  // refresh cannot delay a draft save or post. The view applies only the newest
  // read for its current review identity.
  async review(context, path = null) {
    const args = this.sourceArgs(context);
    const known = context.reviewId && this.latest?.context?.reviewId === context.reviewId ? this.latest.files : null;
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
      root: data.context.repoRoot, reviewId: data.context.reviewId, revision: data.context.revision,
      branch: data.context.branch, storePath: data.context.storePath, snapshotId: data.snapshotId, baseRef: data.baseRef, baseOid: data.baseOid,
      files: data.files.map(file => ({ ...file, status: STATUS[file.status] ?? file.status })),
      threads: data.threads.map(normalizeThread), drafts: humanDrafts(data.drafts), note: data.warnings?.join(" · "), detail,
    };
  }

  async file(context, path) {
    const review = await this.review(context, path);
    return { ...review.detail, reviewId: review.reviewId, snapshotId: review.snapshotId, revision: review.revision, threads: review.threads };
  }

  async drafts(context) {
    return humanDrafts((await this.call(context, "list", this.sourceArgs(context))).drafts);
  }

  mutation(context, command, payload, commandId = newId()) {
    return this.serialize(async () => {
      const key = `${context.root}\u0000${context.reviewId}\u0000${commandId}`;
      let entry = this.pending.get(key);
      if (!entry) {
        entry = { command, payload: { commandId, reviewId: context.reviewId, expectedRevision: this.revisions.get(context.reviewId) ?? context.revision, actor: HUMAN, ...payload } };
        this.pending.set(key, entry);
      }
      const data = await this.call(context, entry.command, ["--data", JSON.stringify(entry.payload)]);
      // Keep the original envelope in memory for an explicit uncertain-result retry.
      return data;
    });
  }

  saveDraft(context, intent, body) {
    return this.mutation(context, "draft-save", { draftId: intent.id, body, target: { path: intent.path, anchor: intent.anchor, threadId: intent.threadId, snapshotId: intent.snapshotId, context: intent.context ?? context, pendingPost: this.attempts.get(intent.id) ?? intent.pendingPost, replyRequested: intent.replyRequested === true, scope: context.source, base: context.baseRef } });
  }

  deleteDraft(context, draftId) {
    return this.mutation(context, "draft-delete", { draftId });
  }

  submit(context, intent, body, commandId) {
    return this.serialize(async () => {
      const key = `${context.root}\u0000${context.reviewId}\u0000${commandId}`;
      let entry = this.pending.get(key);
      const restored = intent.pendingPost;
      if (!entry && restored?.commandId === commandId) {
        if (restored.context.root !== context.root || restored.payload.reviewId !== context.reviewId) throw protocolError({ code: "review_conflict", message: "This saved post belongs to another checkout or branch." });
        entry = { command: restored.operation, payload: restored.payload };
        this.pending.set(key, entry);
      }
      if (!entry) {
        const revision = this.revisions.get(context.reviewId) ?? context.revision;
        const command = intent.threadId ? "reply" : "create";
        const data = intent.threadId ? { threadId: intent.threadId, body } : { scope: context.source, ...(context.source === "branch" ? { base: context.baseRef } : {}), anchor: { path: intent.path, side: intent.anchor.side, startLine: intent.anchor.startLine, endLine: intent.anchor.endLine, snapshotId: intent.snapshotId }, body };
        const payload = { commandId, reviewId: context.reviewId, expectedRevision: revision + 1, actor: HUMAN, ...data, ...(intent.replyRequested ? { replyRequested: true } : {}) };
        const receipt = { commandId, context, operation: command, payload };
        // Persist the exact post envelope BEFORE invoking it. The draft commit advances revision by one.
        const draft = { commandId: newId(), reviewId: context.reviewId, expectedRevision: revision, actor: HUMAN, draftId: intent.id, body,
          target: { path: intent.path, anchor: intent.anchor, threadId: intent.threadId, snapshotId: intent.snapshotId, context: intent.context ?? context, pendingPost: receipt, replyRequested: intent.replyRequested === true } };
        await this.call(context, "draft-save", ["--data", JSON.stringify(draft)]);
        this.attempts.set(intent.id, receipt);
        entry = { command, payload };
        this.pending.set(key, entry);
      }
      return this.call(context, entry.command, ["--data", JSON.stringify(entry.payload)]);
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
      ...(context.source === "branch" ? { base: context.baseRef } : {}), path, diffFingerprint, viewed }, commandId);
  }

  setStatus(context, threadId, status, commandId) {
    return this.mutation(context, "resolve", { threadId, resolved: status === "resolved" }, commandId);
  }
}
