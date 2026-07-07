# Companion TUI reads a loop-emitted status snapshot

The Companion TUI needs a live view of what a loop (`run-prd-v3.mts` or
`run-backlog.mts`) is doing right now: the current step, the iteration, how long
the step has run, and the ticket being worked. Rather than reverse-engineer the
loop's console stdout, we add a tiny **additive status emitter** to the loop: at
every step transition it atomically rewrites a single snapshot file
(`.sandcastle/tui/status.json`) describing the current step. The TUI is a
strictly read-only renderer of that snapshot (plus the agent working log it
points to); it never drives the loop.

The snapshot is authoritative for the left ("status") pane. It carries loop
metadata, the current iteration/round/phase, the ticket, and the current step —
including `startedAt` (so elapsed is `now − startedAt`) and, for agent steps, the
exact `activeLogPath` of the working log the right pane should tail.

## Considered options

- **Parse the loop's stdout as the source of truth.** Rejected: console lines
  are not timestamped and the format is not a contract, so elapsed timing and
  step detection would be guesswork that breaks on any log-message edit.
- **Derive current step from the filesystem only** (newest `.sandcastle/logs/*.log`
  by mtime + `runName`, plus metrics). Rejected: reviewer and extra-review runs
  do not set an explicit log path today, so the current step would be invisible
  during those; host phases (validation, `npm install`, merge) have no file at
  all.
- **Extend `.sandcastle/metrics/runs.jsonl`.** Rejected: metrics records are
  written only *after* a run finishes and exist for post-hoc analytics. Live
  status needs start events and an atomic current-state read; conflating the two
  muddies both.
- **Snapshot plus an append-only event log.** Deferred: the left pane is a live
  status display, not a history view, and the snapshot already carries
  `startedAt`, so a fresh attach reconstructs current state without an event log.
  Add one later only if a step-history view is wanted.

## Consequences

- The loop gains a small emitter with a handful of call sites (one per step,
  agent and host). It is append-nothing/side-effect-only and never changes
  control flow, so it cannot fail the loop.
- The TUI is fully decoupled from stdout wording and from Sandcastle's internal
  logging layout, except that it tails the `activeLogPath` the snapshot hands it.
- Assumes **one active loop per repo** (PRD *or* backlog; PRD extra-review
  sessions already run sequentially). Two concurrent loops in one repo would
  clobber the single `status.json`; if that is ever needed, namespace the file.
- To make every agent step tailable, the loop must give reviewer and
  extra-review agent runs an explicit log path (as coder/rework already have) and
  echo it into the snapshot.
- `.sandcastle/metrics/runs.jsonl` stays analytics-only; the TUI does not depend
  on it.
