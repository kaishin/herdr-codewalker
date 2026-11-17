// Synthetic demo data, rendered by the real Codewalker view. No repository,
// database, terminal-send, or network operations are available in this fixture.
import Codewalker from "./view.js";

export default class Preview extends Codewalker {
  refresh() {}
  read() {}
  follow() {}
  watch() {}
  close() {}
  persistDraft() {}
  submit() {}
  discard() {}
  saveEdit() {}
  deleteMessage() {}
  setStatus() {}
  setViewed() {}
  send() {}
  markArrived() {}
  changeRoot() {}
  applySource() {}
  candidates() { return []; }

  init(p, cx) {
    super.init(p, cx);
    this.fixed = this.framed = true;
    this.on = null;
    this.width = 900;
    this.height = 620;
    this.folder = this.root = "/demo/taskboard";
    this.client = { saveDraft: async () => ({}), deleteDraft: async () => ({}) };
    this.reviewId = "demo-review";
    this.snapshotId = this.rowsSnapshot = "demo-snapshot";
    this.revision = 3;
    this.branch = "fix/retry-safe-jobs";
    this.source = "commit";
    this.commitRef = this.commitOid = "8e4c2a1f0123456789abcdef0123456789abcdef01";
    this.commitParents = 1;
    this.commitInput.set_value("8e4c2a1f");
    this.file = "src/jobs/queue.ts";
    this.rowsFingerprint = "demo-diff";
    this.files = [
      { path: this.file, status: "M", additions: 3, deletions: 1, diffFingerprint: "demo-diff", viewed: false },
      { path: "src/jobs/schema.ts", status: "M", additions: 2, deletions: 1, diffFingerprint: "demo-schema", viewed: true },
      { path: "tests/jobs.test.ts", status: "M", additions: 18, deletions: 0, diffFingerprint: "demo-tests", viewed: false },
    ];
    this.rows = [
      { kind: "@", text: "@@ -12,4 +12,6 @@", hunkId: "demo-hunk" },
      { kind: " ", oldLine: 12, newLine: 12, text: "export async function enqueue(job: Job) {" },
      { kind: "-", oldLine: 13, newLine: null, text: "  await db.insert(jobs).values(job);" },
      { kind: "+", oldLine: null, newLine: 13, text: "  await db.insert(jobs)" },
      { kind: "+", oldLine: null, newLine: 14, text: "    .values(job)" },
      { kind: "+", oldLine: null, newLine: 15, text: "    .onConflictDoNothing({ target: jobs.id });" },
      { kind: " ", oldLine: 14, newLine: 16, text: "  return job.id;" },
      { kind: " ", oldLine: 15, newLine: 17, text: "}" },
    ];
    this.threads = [{
      id: "demo-thread", path: this.file, status: "open", outdated: false,
      anchor: { path: this.file, side: "new", startLine: 15, endLine: 15, commitOid: this.commitOid },
      messages: [
        { id: "demo-human", actor: { kind: "human", id: "local", name: "You" },
          body: "Please make retries safe. Two workers can receive the same job.",
          createdAt: "2026-01-01T10:00:00Z", delivery: { state: "sent", target: "demo-agent" } },
        { id: "demo-agent", actor: { kind: "agent", id: "demo", name: "Agent" },
          body: "Done. The unique job ID now prevents duplicate inserts.",
          createdAt: "2026-01-01T10:01:00Z" },
      ],
    }];
    this.intent = null;
    this.drafts = [];
    this.draftsLoaded = true;
    this.error = this.note = null;
    this.loading = this.reading = false;
  }
}
