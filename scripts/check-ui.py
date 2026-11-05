#!/usr/bin/env python3
"""Check native review descriptions, including the full-height content contract.

This does not lay out or paint. A populated live Review screenshot is still required.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = '''import Codewalker from "./view.js";
export default class Fixture extends Codewalker {
  init(props, cx) {
    super.init(props, cx);
    this.width = 1100; // A wide window unless a variant narrows it.
    this.folder = this.root = "/synthetic/example-checkout";
    this.reviewId = "synthetic-review"; this.snapshotId = "synthetic-snapshot"; this.revision = 4;
    this.branch = "example-feature"; this.file = "src/example.py";
    this.files = [{path:this.file,status:"M",additions:1,deletions:1}];
    this.rows = [{kind:"@",text:"@@ -1,2 +1,2 @@"},{kind:"-",oldLine:1,newLine:null,text:"old_value = 1"},{kind:"+",oldLine:null,newLine:1,text:"new_value = 2"},{kind:" ",oldLine:2,newLine:2,text:"print(value)"}];
    const anchor = {side:"new",startLine:1,endLine:1,snippet:"new_value = 2"};
    this.threads = [{id:"synthetic-thread",path:this.file,anchor,status:"open",messages:[{id:"synthetic-human",actor:{kind:"human",id:"local",name:"You"},body:"Synthetic fixture: why change this value?",createdAt:"2026-01-01T10:00:00Z"},{id:"synthetic-agent",actor:{kind:"agent",id:"example",name:"Example agent"},body:"Synthetic fixture: it corrects the boundary condition.",createdAt:"2026-01-01T10:01:00Z"}]},{id:"synthetic-outdated",path:this.file,anchor:{...anchor,startLine:40,endLine:40,snippet:"original_code()"},outdated:true,status:"resolved",messages:[{id:"synthetic-old",actor:{kind:"human",id:"local",name:"You"},body:"Synthetic fixture: retained discussion.",createdAt:"2026-01-01T10:00:00Z"}]}];
    this.intent = {id:"synthetic-draft",path:this.file,threadId:"synthetic-thread",anchor,snapshotId:this.snapshotId,context:this.context()};
    this.composer.set_value("Synthetic reply draft");
    this.draftStatus = "Synthetic fixture · not written to disk";
    this.drafts = [{id:"synthetic-other-draft",path:"src/other.py",body:"Synthetic saved draft"}];
    this.pendingFile = PENDING;
    EXTRA
  }
}
'''


def check_content_height(spec, stacked=False):
    # Inspect the runtime-built description, not source text. gpui-base h_flex
    # centers children by default: these two columns must instead fill its height
    # or their flexible scroll regions collapse even when review data is loaded.
    stack = []
    regions = []
    for line in spec.splitlines():
        depth = len(line) - len(line.lstrip())
        while stack and stack[-1][0] >= depth:
            stack.pop()
        if ':id[Str("review-changed-paths")]' in line or ':id[Str("review-diff-' in line:
            regions.append(stack.copy())
        stack.append((depth, line))
    assert len(regions) == 2, "Both review scroll regions must be rendered"
    common = 0
    while common < min(map(len, regions)) and regions[0][common] == regions[1][common]:
        common += 1
    assert common, "Review scroll regions must share a content row"
    row = regions[0][common - 1][1]
    columns = [region[common][1] for region in regions]
    if stacked:
        # Docked and narrow: files above with a fixed height, the diff takes the rest.
        assert row.lstrip().startswith("v_flex "), "Narrow Review must stack files above the diff"
        assert " .h[" in columns[0] and " .flex_1" in columns[1], "Stacked file list needs a fixed height; the diff fills the rest"
        return
    assert row.lstrip().startswith("h_flex "), "Review columns must share a row"
    assert " .items_stretch" in row or all(" .h_full" in column for column in columns), (
        "Review content columns do not fill the row: h_flex defaults to items_center; "
        "file list and diff scroll regions can collapse to zero height"
    )


def check_siblings(spec, *names):
    """The named elements share one parent row, in this order."""
    lines = spec.splitlines()
    found = [next(i for i, line in enumerate(lines) if line.lstrip().startswith(name)) for name in names]
    depth = {len(lines[i]) - len(lines[i].lstrip()) for i in found}
    assert len(depth) == 1 and found == sorted(found), f"{names} must sit side by side"
    level = depth.pop()
    # Nothing between them leaves their parent.
    assert all(len(line) - len(line.lstrip()) >= level for line in lines[found[0]:found[-1]] if line.strip()), f"{names} must share one row"


def main():
    # Source is the reviewed authored module; no downloaded helpers or live app configuration.
    with tempfile.TemporaryDirectory(prefix="codewalker-native-fixture-") as temp:
        destination = Path(temp).resolve() / "mod"
        destination.mkdir()
        for name in ("main.js", "client.js", "model.js", "mod.json", "review.svg"):
            shutil.copy2(ROOT / "mods/Codewalker" / name, destination / ("view.js" if name == "main.js" else name))
        shutil.copytree(ROOT / "mods/Codewalker/icons", destination / "icons")
        # Settled; a file switch in progress (the shown diff stays, dimmed); a
        # hovered row while a new two-line comment is open; docked at the
        # panel's default width with a thread awaiting a short reply.
        hover = 'this.hoverRow = 2; this.intent = {...this.intent, threadId:null, anchor:{side:"new",startLine:1,endLine:2}};'
        docked = 'this.width = 368; this.height = 900; this.threads[0] = {...this.threads[0], awaitingReply:true}; this.intent = {...this.intent, replyRequested:true};'
        listing = 'this.width = 368; this.height = 900; this.mode = "discussions";'
        editing = 'this.editing = {id:"synthetic-human", body:"Synthetic fixture: why change this value?", commandId:"c"}; this.editor.set_value(this.editing.body);'
        deleting = 'this.confirmDelete = "synthetic-human";'
        sending = 'this.width = 368; this.height = 900; this.mode = "send";'
        for pending, extra in (("null", ""), ('"src/other.py"', ""), ("null", hover), ("null", docked), ("null", listing), ("null", editing), ("null", deleting), ("null", sending)):
            (destination / "main.js").write_text(FIXTURE.replace("PENDING", pending).replace("EXTRA", extra))
            result = subprocess.run(["herdr-app", "check", str(destination), "--print-spec"],
                                    check=True, capture_output=True, text=True)
            spec = result.stdout
            narrow = extra == docked
            if extra == sending:
                # The exact text to paste, agent choice, and a Send that waits for a ready agent.
                assert ':id[Str("review-send")]' in spec and 'Button "send-to-agent"' in spec, "Send view shows its preview and Send"
                assert "thread synthetic-thread" in spec and "Synthetic fixture: why change this value?" in spec, "The preview is the exact message"
                assert "WARN" not in result.stderr, result.stderr
                print(result.stderr.strip())
                continue
            if not extra:
                assert 'Button "open-send"' in spec, "Unsent comments offer Send in the header"
                # Comment bodies are Markdown (TextView), not plain text.
                assert 'message-body-synthetic-human' in spec, "Comment bodies render as Markdown"
            if extra == listing:
                # Every thread by file; replies sit indented under the first comment.
                assert ':id[Str("review-discussions")]' in spec and ':id[Str("review-diff-' not in spec, "Discussions replace the file list and diff"
                assert '"Show in diff"' in spec and ".border_l[Number(2.0)]" in spec, "Each thread links to its diff; replies are indented"
                assert 'Button "group-src/example.py"' in spec, "Threads group under their file"
                assert "WARN" not in result.stderr, result.stderr
                print(result.stderr.strip())
                continue
            # The first comment asks before it takes the thread; replies of others have no Delete.
            assert ('"Delete thread"' in spec) == (extra == deleting), "Deleting the comment asks first and names the thread"
            assert "delete-synthetic-agent" not in spec, "Only your own messages offer Delete"
            if not extra:
                # Resolve is in the card header, above the messages; Reply stays below them.
                order = [spec.index(name) for name in ('Button "status-synthetic-thread"', ':id[Str("message-synthetic-human")]', 'Button "reply-synthetic-thread"')]
                assert order == sorted(order), "Resolve belongs in the thread header, Reply under the messages"
                check_siblings(spec, 'Button "reply-synthetic-thread"', 'Button "message-edit-synthetic-human"', 'Button "message-delete-synthetic-human"')
            if extra == editing:
                # The message body becomes an editor with Cancel and Save; no second Edit.
                assert '"Save"' in spec and "message-cancel-edit" in spec and "edit-synthetic-human" not in spec, "An edited message shows its editor"
            check_content_height(spec, stacked=narrow)
            dimmed = ".opacity" in spec and 'new_value = 2' in spec
            assert dimmed == (pending != "null"), "A pending file switch must keep the shown diff, dimmed"
            assert ("icons/plus.svg" in spec) == (extra == hover), "Only a hovered, anchorable row shows the comment button"
            assert ('"Comment on lines 1–2"' in spec) == (extra == hover), "A range comment names its lines"
            assert '"Ask for a short reply"' in spec, "Every open composer offers a short-reply request"
            assert ("edit-synthetic-human" in spec) == (extra not in (editing, deleting)) and "edit-synthetic-agent" not in spec, "Only your own messages offer Edit"
            assert ('"Awaiting reply"' in spec) == narrow, "A thread owed a reply says so"
            # Resolve carries a check mark; a checked reply request adds one more.
            assert spec.count("icons/check.svg") == 1 + narrow, "Resolve and a checked request show a check mark"
            if not extra:
                assert all(f"icons/{name}.svg" in spec for name in ("reply", "pencil", "trash")), "Reply, Edit and Delete show their icons"
            assert "WARN" not in result.stderr, result.stderr
            print(result.stderr.strip())
        print("Review full-height, stacked, pending-switch, hover/range, reply-request and discussions contracts passed (description only; not paint)")


if __name__ == "__main__":
    main()
