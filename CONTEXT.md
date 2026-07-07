The public loop code is running on ubuntu@10.10.0.218. You have access via SSH.

The loop is running in ~/lawncare-saas on 10.10.0.218.

## Language

**PRD-level quality gate**:
A review pass over the completed PRD branch after all currently known PRD issues have been processed. It checks the full PRD implementation against the branch starting commit and may create follow-up PRD issues before the loop stops for human review.
_Avoid_: Per-issue review, inline reviewer, normal review round

**Extra review round**:
One PRD-level quality gate cycle that runs after the known PRD issues have drained. A round may create follow-up PRD issues, after which the loop processes those issues before considering another extra review round.
_Avoid_: Coder round, reviewer attempt, issue round

**Independent review session**:
A PRD-level review run whose reviewer receives the shared PRD and branch comparison inputs but not the other reviewer session's context or conclusions.
_Avoid_: Shared review context, combined reviewer, chained reviewer

**Follow-up PRD issue**:
A ticket created from a PRD-level quality gate finding so the loop can continue improving the same PRD implementation without human re-triage.
_Avoid_: Draft issue, review note, backlog item

**Review base**:
The fixed commit-ish supplied by the operator that represents the starting point for PRD-level quality gates. Every extra review round compares the current PRD branch against this same point.
_Avoid_: Current base, merge base, default branch

**Completed PRD branch**:
The PRD branch after all currently eligible PRD issues have been processed and the validation gate is green. PRD-level quality gates review this accumulated branch state, not individual issue branches.
_Avoid_: Issue branch, work branch, partial PRD branch

**Escalation review round**:
A single terminal PRD-level quality gate that runs once, only after the bounded extra review rounds have cleanly exhausted and their follow-up PRD issues have drained. It uses a frontier review agent authenticated via host credentials, files follow-up PRD issues, lets the normal loop drain them once, and then the loop stops. It never re-runs itself.
_Avoid_: Extra review round, retry round, final loop

**Agent invocation livelock**:
A single agent run that remains active but repeats the same operation without making observable progress toward completion. It is distinct from an issue that fails across multiple review rounds.
_Avoid_: No-progress issue, stuck round, idle timeout

**Issue-level no-progress**:
A terminal condition in which completed issue rounds reproduce the same candidate diff and the same actionable failed-check outcome. It is detected across coder/rework attempts only after the applicable host check, validation gate, or review gate has returned, and is distinct from an active agent invocation repeating tool calls.
_Avoid_: Agent invocation livelock, reviewer parse failure, reviewer incomplete

**Rework escalation**:
A retry of an issue attempt using the rework agent after the initial coder attempt fails, is rejected, or hits an agent invocation livelock. It may use the same model as the coder or a distinct configured rework model.
_Avoid_: Coder retry, model escalation, reviewer retry

**Backlog-clearer loop**:
A loop that processes independent, already-triaged issues sharing one label. Each issue gets its own branch forked fresh from the mainline and is delivered on its own; issues never build on each other and are never merged by the loop. Distinct from the PRD loop, which drives a set of sequential issues toward one accumulating PRD branch.
_Avoid_: PRD loop, extra review loop, sequential issue loop

**Review-ready issue**:
A backlog issue whose branch passed the validation gate and earned a clean reviewer approval. The loop signals this by adding the `Review` label and pushing the issue branch to origin; the issue stays open and a human opens the pull request. It is neither merged nor closed by the loop.
_Avoid_: Merged issue, completed PRD issue, approved-and-merged

**Backlog issue eligibility**:
The condition for the backlog-clearer loop to pick an issue: open, carrying the target label, and carrying neither `Review` nor `agent-stuck`. The target label is never removed, so eligibility is expressed purely by the absence of the terminal labels.
_Avoid_: Open issue, unprocessed issue, queue membership

### Issue-as-PRD loop

**Issue-as-PRD loop**:
A backlog loop variant in which each triaged backlog issue is treated as its own PRD: the loop decomposes the issue into readiness-gated child issues, fast-forwards approved child work onto a per-issue accumulation branch, runs exactly one full-parent extra review round, readiness-gates and drains any follow-ups once, and then delivers the branch review-ready. A reviewed partial branch may be delivered after a child gets stuck. Distinct from the Backlog-clearer loop (which does no decomposition, accumulation, or full-issue extra review) and from the PRD loop (whose PRD is a file).
_Avoid_: Backlog-clearer loop, PRD loop, mini-PRD, decomposing backlog loop

**Parent issue**:
The incoming triaged backlog issue that plays the PRD role for one pass of the Issue-as-PRD loop. It retains its configured backlog labels, gains `agent-in-progress` while owned, and is resumed before fresh work after a restart. Clean completion earns `Review`; reviewed incomplete delivery adds `agent-partial`; a reviewed branch needing manual mainline integration adds `agent-rebase-needed`; a parent-level failure with no reviewable delivery earns `agent-stuck` without `Review`.
_Avoid_: PRD issue, main issue, epic, backlog issue

**Parent state comment**:
The single host-managed GitHub comment on a parent issue containing schema-versioned tagged orchestration state: accumulation branch, original fork SHA, full-parent review base, phase, queue label, bounded review/repair budgets, and transition time. It is a restart checkpoint, is verified against branches/labels/children, and is excluded from agent-facing parent context.
_Avoid_: Parent specification, issue body, human comment, local state file

**Sub-task child issue**:
A true GitHub child issue linked under a parent and carrying a temporary per-parent label (`parent-<N>`). Open issues carrying that label form the active inner queue. Each actionable child is worked on its own branch and closes only after its approved HEAD is fast-forwarded into the accumulation branch and checkpointed remotely. Children may come from initial decomposition, full-parent review, or aggregate-validation repair.
_Avoid_: Follow-up PRD issue, backlog issue, draft issue, review note

**Initial issue decomposition**:
The first decomposition pass that turns normalized parent context (the issue body plus capped supplemental human comments) and repository context into sub-task child issues. It reuses the configured issue-decomposer model with dedicated prompts and has no code-quality or two-axis artifacts, unlike full-parent review decomposition.
_Avoid_: Extra-review decomposition, PRD decomposition, follow-up decomposition

**Issue accumulation branch**:
The stable per-parent integration branch (`issue-<N>-accumulation`) initially forked from origin/main and pushed as a recovery checkpoint. Child branches fork from its current tip sequentially; approved child HEADs fast-forward it and are checkpointed remotely without temporary pull requests. Before full-parent review it gets one best-effort refresh onto current mainline, and it is ultimately delivered for human review rather than auto-merged.
_Avoid_: Completed PRD branch, issue branch, work branch, PRD branch

**Partial delivery**:
The fail-soft terminal when at least one child integrated before an initial or review-follow-up child got stuck. The accumulated partial diff still receives aggregate validation, one full-parent extra review, and one follow-up drain before the branch is delivered with `Review` plus `agent-partial`; the failed child retains `agent-stuck`. An empty or unvalidated partial branch is not delivered and instead leaves the parent `agent-stuck` without `Review`.
_Avoid_: Abandoned parent, stuck issue, review-ready issue, clean delivery

**Rebase-needed delivery**:
A completed or partial reviewed accumulation branch delivered with `Review` plus `agent-rebase-needed` because the pre-review mainline rebase conflicted or mainline advanced after full-parent review began. The loop preserves the reviewed branch and diagnostics and leaves the final rebase to the human; this is neither partial implementation nor agent failure by itself.
_Avoid_: Partial delivery, parent-level stuck, automatic second rebase

**Sub-task readiness gate**:
A per-child step that runs once before the child's first coder attempt, for both initial and full-parent-review follow-up batches. It reuses the configured reviewer model with dedicated prompts and receives a clean context containing the child, normalized parent context, the active sibling batch, and repository access. It returns a machine-readable disposition plus a complete proposed body; the host validates, persists, and verifies the body. The agent never edits GitHub itself. Distinct from the reviewer, which gates code diffs rather than issue drafts.
_Avoid_: Reviewer, extra review round, initial issue decomposition, coder gate

**Gate outcome**:
The successful disposition assigned by the sub-task readiness gate: `fixed` (findings resolved in the proposed body, persist it and proceed), `not-actionable` (duplicate or already implemented, so the host closes and drops the child), or `assumed` (semantic ambiguity resolved by a recorded recommended-default assumption, persist it and proceed). Invocation, parsing, or persistence exhaustion is a parent-level technical failure rather than a gate outcome or child stuck classification.
_Avoid_: Reviewer verdict, readiness label, needs-info, stuck

**Dropped sub-task**:
A sub-task child issue the readiness gate closes without coding because evidence shows there is no work to do (duplicate or already implemented). It is removed from the inner drain queue and never gets a branch. Distinct from a stuck sub-task, which was attempted and failed.
_Avoid_: Stuck sub-task, skipped sub-task, not-actionable issue

### Companion TUI

**Companion TUI**:
A separate read-only terminal UI, run in a second terminal alongside a loop, that renders the loop's live state. It never drives the loop; it only observes what the loop emits.
_Avoid_: Dashboard, monitor, control panel

**Step**:
The smallest unit of loop activity the Companion TUI displays and times. A step is either an agent step or a host step, has a single start time, and ends when the next step begins.
_Avoid_: Stage, phase, task, action

**Agent step**:
A step that is one sandboxed agent invocation (initial decomposer, sub-task readiness, coder, rework, reviewer, or an extra-review session such as code-quality, two-axis, issue-decomposer, or escalation). It is the only kind of step that produces a working log.
_Avoid_: Agent run, invocation, agent stage

**Host step**:
A step that is host-side loop work with no agent and no working log — sandbox setup, issue publication/linking, label or state-comment transitions, validation, branch rebase/recovery, fast-forward integration, merge/push, or terminal delivery. It is timed like any other step but leaves the working-log pane without new content.
_Avoid_: Host phase, gate, host task

**Status snapshot**:
The single atomically-rewritten `.sandcastle/tui/status.json` the loop replaces at every step transition. It is the authoritative source for the status pane and holds loop metadata, the current iteration/round/phase, the ticket, and the current step (with its start time and, for agent steps, the working-log path).
_Avoid_: Status file, state dump, metrics record

**Working log**:
The per-agent-step, loop-formatted, human-readable stream of an agent's thinking and tool calls that the working-log pane tails. There is exactly one per agent step, so a new agent step starts a fresh working log.
_Avoid_: Agent log, run log, transcript, event stream

**Status pane**:
The left pane of the Companion TUI. Renders the status snapshot: current step, iteration/round, elapsed time, and ticket info.
_Avoid_: Left pane, info pane, header

**Working-log pane**:
The right pane of the Companion TUI. Tails the current agent step's working log and freezes it during host steps.
_Avoid_: Right pane, log pane, output pane
