---
type: Verification Report
title: "Remote support implementation and verification"
description: "Historical implementation results, accepted Send trade-offs, and remaining remote verification limits."
tags: ["remote", "delivery", "verification"]
generated: { by: "pi/gpt-6.1-sol", at: "2026-11-17T00:04:58Z" }
sources:
  - resource: "Git revision febd5e0a69ca81d65d9ea3c0f593af824532c7d1, file docs/remote-support-report.md"
    title: "Original remote-support-report.md before OKF migration"
---
# Remote support: implementation and verification

Implementation and verification notes from 2026-11-14. Machine names, private repository paths, conversation excerpts, and deployment receipts are omitted. The live checks below are historical results, not a claim that they ran on every later revision.

For setup and current behavior, see [README.md](../README.md), [protocol.md](/protocol.md), and [ux.md](/ux.md).

## Remote reviews

Review runs Git, SQLite, and path resolution on the checkout's machine through Herdr's `exec(..., { on })`. It does not fall back to a local checkout or store when the remote call fails.

| Area | Implementation |
| --- | --- |
| Transport | `exec("python3", [remoteHelper, "--repo", remoteRoot, ...args], { on })`. Local calls keep the existing form without `on`. |
| Helper discovery | Read-only `hello` probes `.local/share/herdr-codewalker/backend.py`, then `.config/herdr-app/mods/Codewalker/backend.py`, relative to the remote user's home. The response supplies the absolute helper path. Successful probes are cached per machine; failed probes are retried on the next read. |
| Compatibility | Requires protocol version 1 and helper version 2 or later. A helper that answers JSON but lacks the required handshake is reported as outdated, not missing. |
| Deployment | Review never uploads or updates remote code. Errors show a manual `hc file write --on` command. To review in both directions, each computer needs a current UI mod and a compatible helper on every target. Installing only a helper does not update that computer's UI. |
| Storage | A local `--store` override is never sent remotely. Each helper uses its machine's default store. Send text uses the helper path on the checkout's machine. |
| Refresh | No remote folder watch. Review refreshes every 15 seconds, after its own writes, on manual Refresh, and when an agent on that machine changes status. |
| Identity | Review IDs derive from path and branch, so the same path can have the same ID on two machines. Client revision and pending-command keys include the machine; the view rejects late writes from another machine. Saved posts and restored drafts keep their original machine context. |
| Folders | Review follows the focused terminal's folder and machine. A typed folder stays on the machine in view. An explicit `folder` prop without `on` is local. |
| Agents | Send lists agents on the checkout's machine and uses their full `machine/terminal` address. It requires a successful helper response before sending. |
| Large writes | Helpers with the `data-parts` capability receive large JSON as repeated `--data` arguments, each at most 30,000 UTF-16 units without splitting surrogate pairs. Other helpers receive one argument. This avoids Linux's per-argument size limit. |
| Errors | `remote_helper_missing`, `remote_helper_outdated`, `remote_unavailable`, `remote_git_missing`, and `remote_python_unsupported`. A lost write response remains uncertain; retries use the same command ID. |

Sources: [`client.js`](../mods/Codewalker/client.js), [`backend.py`](../mods/Codewalker/backend.py), and [`main.js`](../mods/Codewalker/main.js).

## Send behavior and accepted trade-off

The first Send implementation had two problems:

- Herdr's default 30-second process timeout could stop `hc` while it waited for a person's unfinished terminal draft. A timeout did not prove whether the text arrived.
- `hc send --if idle` rejected finished agents whose core status was `done`, even when the app showed them as Ready. In the tested core version, `--if` accepted only `idle` or `working`.

The accepted solution changes Codewalker only. It does not require a herdr-core patch:

1. At the click, require an agent whose app status is `idle` or `done`, on the checkout's machine.
2. Record an `uncertain` delivery in that checkout's store. If this fails, send nothing.
3. Run `exec("hc", ["send", "--json", address, text], { timeout: 600000 })`, without `--if` or `--force`.
4. Record the outcome only when there is evidence for it.

The Ready check is **not atomic with typing**. An agent that starts working after the click can receive the text while it works. Herdr-core still refuses blocked agents and waits for a person's draft; Codewalker makes no promise about how the receiving agent queues input.

| Outcome | Evidence and behavior |
| --- | --- |
| Delivered | Exit 0 and a successful `sent` record. Show **Delivered to agent**. If recording fails, keep the delivery unconfirmed. |
| Not sent | `hc` could not start, a known refusal exit code matches its error kind, or the error hint says **nothing was typed**. Attempt to clear the uncertain record. |
| Unconfirmed | All other failures, including timeout and exit 130. Keep the uncertain record; never retry automatically. Ask the person to check the agent's chat. |

While `hc` waits, Review shows **Sending** and blocks another send. An unconfirmed delivery offers **It arrived** and **It is not there · Send again**. A late outcome is recorded for the original checkout, but does not move focus or replace the new checkout's notice.

A proposed core `--if ready` extension was not applied. The plain-send trade-off above is the shipped behavior.

## Narrow discussion headers

At a panel width of about 368px, a fixed header row clipped **Show** and **Reopen**. A folded card also retained a bottom divider.

`main.js` now uses `wrapHeader(info, actions)` for inline cards and the Discussions list:

- Labels can wrap and shrink, with a 140px flex basis.
- Actions stay together and move to another line when needed.
- Status tags truncate instead of overflowing.
- Only an open card draws the divider below its header.

## Recorded verification

The implementation session used `herdr-app 0.1.15` and `hc 0.1.21` on macOS. Remote targets had Python and Git installed.

| Level | Result and scope |
| --- | --- |
| JavaScript tests | 70 passed. Simulated transport covered remote routing, helper errors and retry, machine isolation, saved posts and drafts, large arguments, Send targeting, refusal classification, and late outcomes. |
| Python tests | 52 passed. The remote acceptance test used the real client, helper, Git, and separate SQLite stores, with only the transport bridge simulated. |
| Mutation checks | Removing machine isolation, changing Send guards or outcome classification, and restoring the default Send timeout caused the relevant tests to fail. |
| Native descriptions | `python3 scripts/check-ui.py` passed. Includes a remote label and narrow card fixtures at 300px. This checks descriptions, not paint or interaction. |
| Real remote write cycles | Disposable repositories and stores on two machines passed discovery, diff reads, drafts, large writes, idempotent post retry, replies, delivery records, Viewed, Resolve, branch scope, and commit scope over `hc exec --on`. Fixtures were removed. |
| App transport | A temporary read-only probe used the real client and the app's `exec(..., { on })`. Remote review and commit reads, local calls, missing repositories, and unknown-machine errors behaved as expected. The probe was removed. |
| Real Send | Disposable terminal receivers confirmed delivery for idle and done states, refusal for blocked state, and delivery if the receiver became working after the click. Stopping `hc` after typing produced an unconfirmed result even though the text arrived. No real agent received these test messages. |
| Installation | Collision-checked `scripts/install.py --apply --check` passed for local and remote UI installations. Installed source matched the checkout at deployment time. Settings and keybinding symlinks were preserved. |
| Live paint | A remote screenshot after the header fix showed complete Show/Reopen buttons and no folded-card divider. Earlier full Review captures were blocked by a locked screen. |

Reusable checks:

```sh
node --experimental-vm-modules --test tests/*.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/check-ui.py
```

Coverage lives in [`tests/test_ui.mjs`](../tests/test_ui.mjs), [`tests/test_acceptance.py`](../tests/test_acceptance.py), and [`scripts/check-ui.py`](../scripts/check-ui.py).

## Limits and remaining manual checks

- Remote writes were tested over `hc exec --on`, not through the app's `exec` bridge. The app bridge was verified for read paths only.
- Live paint of the new Send states, a real Send by a person, and an expanded discussion card were not verified in the implementation session.
- A missing helper or unavailable machine causes another probe on the 15-second refresh timer.
- A person who keeps typing beyond the app's ten-minute timeout can still cause an unconfirmed delivery.
- `backend.py open` opens UI only on the computer running the Herdr window.
- Saved machine names are client-relative names, not global machine identities. Renaming a connection can affect stored draft contexts and delivery targets.
- Windows remotes were not tested. Helper discovery uses home-relative POSIX paths.
- Card widths below about 240px were not modeled.

For a live manual check, use a disposable checkout and receiver: confirm remote labels and all three comparison scopes; exercise drafts and Send outcomes; inspect folded and expanded cards at a narrow width. Do not reconcile an uncertain real delivery without first checking the receiving chat.
