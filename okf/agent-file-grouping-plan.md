---
type: Proposal
title: "Agent-driven file grouping via JSON"
description: "Proposed opt-in review groups supplied by external agents through the existing integration."
tags: ["agents", "grouping", "proposal"]
generated: { by: "pi/gpt-6.1-sol", at: "2026-11-17T00:04:58Z" }
sources:
  - resource: "Git revision febd5e0a69ca81d65d9ea3c0f593af824532c7d1, file docs/agent-file-grouping-plan.md"
    title: "Original agent-file-grouping-plan.md before OKF migration"
status: draft
---
# Codewalker: Agent-driven file grouping via JSON

Status: proposal, not implemented. The example schema is illustrative, not a finalized contract.

## Core idea

Introduce a Codewalker-owned JSON configuration that allows external coding agents to organize changed files into logical review groups, without embedding AI functionality directly into Codewalker.

Codewalker owns the configuration, persistence, validation, and UI. The external coding agent supplies the intelligence. Communication reuses the existing agent integration, avoiding new dependencies on specific models, harnesses, or API providers.

## Proposed approach

1. **Codewalker-owned configuration.** Store grouping data in a JSON file managed by Codewalker, alongside its existing persistent data. It does not live in the reviewed repository and is not committed to version control.
2. **Agent-driven grouping.** Codewalker defines the grouping schema and handles presentation. The user's existing coding agent decides how files should be grouped based on the changes being reviewed.
3. **Reuse existing agent integration.** Extend the mechanism agents already use to post review comments and replies so they can submit or update file groupings. Do not introduce a separate communication channel.
4. **One-click generation.** An optional **Generate Groups** button uses the existing prompt-injection mechanism to instruct the active coding agent to analyze the changed files and submit groupings through Codewalker's integration.
5. **Automatic consumption.** Codewalker reads its own grouping configuration and presents changed files according to the agent-defined groups.
6. **Handling changes.** Newly changed or modified files that are not covered by the current grouping appear in an **Ungrouped** section until the user regenerates the groups.
7. **Opt-in.** Grouping remains optional, preserving the existing lightweight review experience.

## Example configuration

Illustrative schema, not a finalized contract:

```json
{
  "groups": [
    {
      "name": "Authentication",
      "files": [
        "src/auth/login.ts",
        "src/auth/session.ts"
      ]
    },
    {
      "name": "UI Changes",
      "files": [
        "src/components/LoginForm.tsx"
      ]
    }
  ]
}
```

## Architectural flow

1. The user clicks **Generate Groups** in the Codewalker UI.
2. The existing agent prompt mechanism requests grouping of changed files.
3. The external coding agent analyzes the changes and submits groups through an extension of the existing comments/replies integration.
4. Codewalker validates and stores the grouping JSON in its own data location.
5. Codewalker renders the groups and ungrouped files for review.

## Existing integration

The current [agent workflow](/agent-workflow.md) and [CLI protocol](/protocol.md) document the shared comments/replies integration and persistent review store. Grouping submission and the **Generate Groups** button described here are proposed extensions, not existing protocol features.

## Longer-term vision

The JSON configuration could evolve into a general-purpose agent-controlled customization interface for Codewalker, supporting additional review metadata and presentation features.
