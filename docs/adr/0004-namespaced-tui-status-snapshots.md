# Namespaced TUI status snapshots for concurrent loops

## Context

ADR 0002 established the Companion TUI contract: a loop emits a single atomic
status snapshot to `.sandcastle/tui/status.json`, and the TUI renders it
read-only. That design intentionally assumed **one active loop per repo**.

In practice we want to run a backlog loop (`run-backlog-v3.mts`) and a PR review
loop (`run-pr-review-v1.mts`) in the same repository checkout at the same time.
Both loops share the `tuiEmitter` singleton, and each emitter heartbeats the
same `status.json` path every two seconds. The result is that the TUI flips back
and forth between the two loops' snapshots on every refresh.

The loop-side emitter is side-effect-only and swallows its own I/O failures, so
the collision is purely observational — it never corrupts loop output — but it
makes the TUI unusable for monitoring either loop.

## Decision

Namespace the snapshot file by loop type:

- `status-prd.json` for PRD loops (`run-prd-v4.mts`, `run-prd-v5.mts`)
- `status-backlog.json` for backlog loops (`run-backlog-v2.mts`,
  `run-backlog-v3.mts`, `run-backlog-v4.mts`)
- `status-pr-review.json` for the PR review loop (`run-pr-review-v1.mts`)
- Legacy `status.json` is still discovered so an older emitter binary continues
  to appear in the TUI.

The filename is derived from `status.loopType` inside `writeStatusSnapshotAtomic`,
so no loop call site needs to change. Temp files use the same namespaced prefix
and remain dotfiles, so they are never discovered as snapshots.

The TUI discovers every `status*.json` file in `.sandcastle/tui/`, maintains
independent state (status, previous status, working log, scroll offset) per
snapshot, and lets the operator cycle between loops with `tab` / `shift+tab`
(or `n` / `p`). It defaults to the loop with the most recent `updatedAt`
heartbeat. When only one snapshot exists the UI is identical to the previous
single-loop behavior.

## Consequences

- Multiple loop types can run concurrently in the same repo without clobbering
each other's TUI snapshot.
- Working logs remain in the shared `.sandcastle/tui/logs/` directory; run-name
prefixes are already disjoint across loop types (`coder-`, `rework-`,
`reviewer-`, `pr-review-`, etc.), so log files do not collide.
- The TUI must keep per-loop state. The pure selection helpers live in
`tui-view.mts` and are tested without Ink.
- Two loops of the **same type** in one repo still share `status-<type>.json`.
This is acceptable because the repo's existing partitioning guidance already
places same-type loops on different machines. If same-type concurrency is ever
needed, the namespace can be extended with a sanitized `loopId` suffix.
- The schema version stays at 1 because the snapshot payload shape is unchanged;
only the on-disk filename changes.
