# PRD: Companion TUI for the Sandcastle loops

## Problem Statement

When an operator runs `run-prd-v3.mts` or `run-backlog.mts`, the only live view
of what the loop is doing is its raw console stdout. That stream interleaves many
concerns, is not timestamped, and does not answer the operator's actual questions
at a glance: which step is running right now, how long it has been running, which
iteration and round it is on, which ticket it is working, and what the sandboxed
agent is currently thinking or doing. To follow the working agent's reasoning the
operator has to find and `tail` a per-run log file whose path they must
reconstruct by hand, and that file only exists for some agents.

The operator wants a second terminal they can leave open beside the loop that
answers "what is happening, on what, for how long, and what is the agent doing"
without scrolling a firehose or hand-tailing files.

## Solution

Add a read-only **Companion TUI** that runs in a second terminal and renders a
loop's live state. It has two panes split by a vertical divider: a **status pane**
on the left and a **working-log pane** on the right.

The status pane shows the current step, the step kind, elapsed time for the step,
the loop phase, iteration and round counters, and the ticket being worked. The
working-log pane tails the currently running agent's working log — its thinking
and tool calls as a running feed — and clears when a new agent step begins, so a
`coder` → `reviewer` transition starts a fresh log. During host steps (which have
no agent) it freezes the last agent log and shows a thin footer noting the host
step.

The loop is the source of truth. Rather than parse stdout, each loop writes an
additive **status snapshot** (`.sandcastle/tui/status.json`) at every step
transition and a loop-owned **working log** per agent step; the TUI only reads
these. This contract is recorded in ADR 0002 (status snapshot) and ADR 0003
(loop-owned working-log format). The emitter never changes loop control flow, so
it cannot fail a loop.

## User Stories

1. As a loop operator, I want a companion view in a second terminal, so that I can watch a loop without scrolling its raw stdout.
2. As a loop operator, I want the view split into a status pane and a working-log pane, so that live metadata and the agent's activity are visible at the same time.
3. As a loop operator, I want the status pane on the left and the working-log pane on the right, so that the layout matches how I read the two concerns.
4. As a loop operator, I want the status pane to name the current step, so that I know exactly what the loop is doing right now.
5. As a loop operator, I want the status pane to show whether the current step is an agent step or a host step, so that I know whether to expect working-log activity.
6. As a loop operator, I want the status pane to show how long the current step has been running, so that I can spot a step that is taking unusually long.
7. As a loop operator, I want the status pane to show the loop phase (normal issue, extra review, or escalation), so that I know which part of the loop I am watching.
8. As a loop operator, I want the status pane to show the current iteration as `N/max`, so that I know how far the outer loop has progressed.
9. As a loop operator, I want the status pane to show the current review round as `R/max` when an issue is being worked, so that I know how close the issue is to bailing.
10. As a loop operator, I want the status pane to show the extra-review round as `K/max` when the loop is in extra review, so that I can track PRD-level review progress.
11. As a loop operator, I want the status pane to show the ticket number and title being worked, so that I know which issue the loop is on.
12. As a loop operator, I want the status pane to show the issue branch, so that I can inspect or check it out quickly.
13. As a loop operator, I want an agent step to show which model it is using, so that I can tell whether a slow step is a heavy model.
14. As a loop operator, I want a validation host step to show which command is running, so that I know whether `typecheck`, `test`, or `build` is the slow one.
15. As a loop operator, I want the working-log pane to tail the current agent's thinking, so that I can follow the agent's reasoning live.
16. As a loop operator, I want the working-log pane to tail the current agent's tool calls, so that I can see what actions the agent is taking.
17. As a loop operator, I want the working-log pane to clear when a new agent step starts, so that a `coder` → `reviewer` change does not mix two agents' output.
18. As a loop operator, I want the working-log pane to keep the last agent log frozen during a host step, so that I retain context while validation or merge runs.
19. As a loop operator, I want a thin footer in the working-log pane during host steps, so that I know why the log is not advancing.
20. As a loop operator, I want a working log for every agent, including reviewer and the extra-review sessions, so that no agent's activity is invisible.
21. As a loop operator, I want the same companion to work against both the PRD loop and the backlog loop, so that I do not need a different tool per loop.
22. As a loop operator, I want the companion to auto-detect which loop type is running, so that I do not have to configure it per run.
23. As a loop operator, I want to leave the companion open before any loop starts, so that it attaches automatically when a loop begins.
24. As a loop operator, I want the companion to show a clear "waiting for a loop" state when none is running, so that an empty screen is not ambiguous.
25. As a loop operator, I want to attach the companion mid-run, so that I can start watching a loop that is already in progress.
26. As a loop operator, I want the companion to show a "stopped" state with the loop's stop reason when a loop ends cleanly, so that I know why it finished.
27. As a loop operator, I want the companion to detect a crashed loop (dead process or stale heartbeat), so that I am not shown a confidently-wrong "running" state.
28. As a loop operator, I want elapsed time to freeze and be flagged when the loop looks dead, so that I do not see a clock running for a loop that has stopped.
29. As a loop operator, I want the status pane to update within about a second of a step change, so that the view feels live.
30. As a loop operator, I want the working-log pane to update as new lines are written, so that I can follow the agent in near real time.
31. As a loop operator, I want to scroll back through the current working log, so that I can re-read earlier reasoning without losing my place.
32. As a loop operator, I want to quit the companion with a single key, so that I can close it quickly.
33. As a loop operator, I want the companion to never send input to or otherwise affect the loop, so that watching is always safe.
34. As a loop operator, I want the emitter to be incapable of failing the loop, so that adding observability does not risk the run.
35. As a loop maintainer, I want the snapshot written atomically, so that the companion never reads a half-written status.
36. As a loop maintainer, I want the snapshot schema shared as one type between the emitter and the TUI, so that what is written and what is read cannot drift.
37. As a loop maintainer, I want agent-step emission to hook the single existing chokepoint both loops route agent runs through, so that agent status and working-log wiring live at one seam.
38. As a loop maintainer, I want host steps emitted at the existing coarse host chokepoints, so that the status pane stays live during validation, prep, and merge without scattering emitter calls.
39. As a loop maintainer, I want the status-derivation and working-log-target logic in pure functions, so that liveness, elapsed, counter formatting, and clear-vs-continue behavior are tested without launching a loop or rendering Ink.
40. As a human joining an operator, I want the companion to be self-explanatory at a glance, so that I can understand loop state without reading the loop source.

## Implementation Decisions

- The loop is the source of truth. Each loop writes a single **status snapshot**
  at `.sandcastle/tui/status.json`, atomically (write temp, then rename), at every
  step transition. The TUI is a strictly read-only renderer. (ADR 0002)
- The snapshot is snapshot-only: there is no separate append-only event log in v1.
  The status pane is a live current-state view, and the snapshot carries the step
  start time so a fresh attach reconstructs current state without history.
- One active loop per repo is assumed; the single `status.json` is not namespaced
  in v1.
- The snapshot type is the contract between emitter and TUI and is shared as one
  TypeScript type. Its shape (decision-precise, from the design session):

```ts
interface TuiStatus {
  schemaVersion: 1;
  loopType: "prd" | "backlog";
  loopId: string;               // e.g. "prd-003" or the backlog label
  pid: number;
  loopStartedAt: string;        // ISO
  updatedAt: string;            // ISO heartbeat
  loopState: "running" | "stopped";
  stopReason?: string;          // set on clean stop
  phase: "normal_issue" | "extra_review" | "escalation";
  iteration?: { current: number; max: number };
  extraReviewRound?: { current: number; max: number };
  round?: { current: number; max: number };      // review round within an issue
  ticket?: { number: number; title: string; branch: string; labels?: string[] };
  step: {
    kind: "agent" | "host";
    name: string;               // agent: coder | rework | reviewer | code_quality
                                //        | two_axis | issue_decomposer | escalation_review
                                // host:  sandbox_setup | validation | branch_prep
                                //        | merge | deliver_review_ready | base_validation
    startedAt: string;          // ISO; elapsed = now - startedAt
    detail?: string;            // agent: model; validation: the command
    activeLogPath?: string;     // agent steps only
  };
}
```

- A **step** is the smallest timed unit and is either an agent step or a host
  step (see glossary). The status pane times whichever step is current; the
  working-log pane keys off agent steps only.
- Every agent step produces a loop-owned, human-readable **working log** written
  as one file per agent step. Its lines are formatted from the Sandcastle agent
  stream events the loop already intercepts — thinking text as lines, tool calls
  as compact `→ tool(args)` lines. The snapshot's `step.activeLogPath` points at
  the current file. (ADR 0003)
- Agent-step emission and working-log wiring hook `recordMeasuredAgentRun`, the
  single function both loops already route every agent run through. Reviewer and
  the extra-review sessions must be given the stream callback and an explicit log
  path so they produce working logs too, not just coder/rework.
- Host-step emission uses explicit step markers at the existing coarse host
  chokepoints: sandbox setup, the validation gate (per command), branch
  prep/recovery, merge (PRD) or review-ready delivery (backlog), and base
  validation.
- On clean stop each loop writes a terminal snapshot with `loopState: "stopped"`
  and a `stopReason`. The emitter also keeps `updatedAt` fresh as a heartbeat and
  records the loop `pid`.
- The emitter is side-effect-only and wrapped so any failure to write the
  snapshot or working log is swallowed and never propagates into loop control
  flow.
- The TUI is a Node + Ink (TypeScript) application, run with `tsx` in a second
  terminal, on the same host as the loop (local filesystem).
- The TUI derives its render model from two pure functions: one that maps
  `(status, now)` to a status view (elapsed, liveness, staleness, formatted
  phase/iteration/round/ticket, and whether to freeze), and one that maps
  `(previousStatus, nextStatus)` to a working-log target decision (clear vs
  continue, and which file to tail).
- Liveness is determined from `pid` plus `updatedAt` heartbeat freshness against
  `now`. A dead pid or a heartbeat older than a threshold marks the loop dead;
  elapsed is then frozen and flagged, distinct from a clean `stopped`.
- The TUI stays open across loop start, stop, and crash, showing waiting /
  running / stopped / dead states, and quits on `q`.
- The TUI stays live via a hybrid refresh: `fs.watch` on the `.sandcastle/tui`
  directory and the active working log for instant updates, a ~1s poll fallback
  robust to atomic-rename and missed events, and an independent ~1s tick so
  elapsed advances even when nothing changes.
- Layout: the status pane occupies roughly the left 40% (with a minimum column
  width) and the working-log pane fills the remainder, over a thin footer showing
  keybindings (quit, scroll).

## Testing Decisions

- Tests exercise externally observable behavior and pure-function contracts, not
  private implementation details or Ink rendering.
- Test the emitter's snapshot builder as a pure function: given synthetic
  loop/step inputs it returns a correct `TuiStatus`, mirroring the builder tests
  in `metrics-recorder.test.mts` (`buildMeasuredAgentRunRecord` and siblings).
- Test the working-log line formatter as a pure function: given synthetic
  Sandcastle stream events (thinking text, `toolCall`) it returns the expected
  formatted lines, and returns nothing for events that should be ignored,
  mirroring `toolCallObservationFromStreamEvent` tests in
  `agent-invocation-livelock.test.mts`.
- Test the TUI status-derivation function: given a snapshot and a `now`, assert
  elapsed, liveness (running vs stale vs dead vs stopped), elapsed-freeze on
  staleness, and formatted phase/iteration/round/ticket output.
- Test the TUI working-log-target function: assert it clears and retargets on a
  new agent step, continues within the same agent step, and freezes (no retarget)
  during host steps.
- Test that agent status/working-log emission happens once per agent run at the
  `recordMeasuredAgentRun` chokepoint, using a synthetic run, without launching a
  real sandbox or agent.
- Test that the atomic snapshot writer produces a complete, parseable file (a
  reader never sees a partial write), using a temporary directory.
- Reuse prior art from `metrics-recorder.test.mts`,
  `agent-invocation-livelock.test.mts`, `loop-progress.test.mts`, and
  `reviewer-result.test.mts` for pure-builder and stream-event test patterns.
- Do not launch real OpenCode, Sandcastle, git, or GitHub in unit tests; do not
  assert on Ink-rendered frames or on `fs.watch` timing.

## Out of Scope

- Any ability to control, pause, or send input to the loop from the TUI; it is
  read-only.
- Running the TUI on a different host from the loop, or over SSH / a network
  filesystem; v1 assumes same-host, local filesystem.
- Supporting two concurrent loops in one repo; the single `status.json` is not
  namespaced in v1.
- A step-history view or scrollback of past steps in the status pane, and the
  append-only event log that would back it.
- Changing or extending `.sandcastle/metrics/runs.jsonl`, or building dashboards
  or analytics.
- Replacing or reformatting Sandcastle's own logging; the working log is a
  separate presentation artifact.
- Mouse support, configurable layouts/themes, and Windows-specific terminal
  handling.
- Changing loop control flow, validation commands, merge strategy, models, or any
  existing loop behavior beyond adding the side-effect-only emitter and giving
  reviewer/extra-review runs a working-log path.
- Older runner variants except where they already share the extracted emitter or
  helper modules.

## Further Notes

- The loops run on a remote host (per `CONTEXT.md`), so the companion is expected
  to run there too, in a second terminal, reading local files.
- This PRD depends on the glossary terms added for this feature: Companion TUI,
  Step, Agent step, Host step, Status snapshot, Working log, Status pane, and
  Working-log pane.
- It also depends on ADR 0002 (the TUI reads a loop-emitted status snapshot rather
  than parsing stdout or the filesystem) and ADR 0003 (the loop owns the
  working-log format rather than reusing Sandcastle's file log).
- The key reuse that keeps the change small: both loops already funnel every agent
  run through `recordMeasuredAgentRun`, and coder/rework already stream events
  through `createLivelockWatchdogStreamCallback`. Agent-step status and working
  logs hook those existing chokepoints; only reviewer and the extra-review
  sessions need the stream callback and explicit log path added.
