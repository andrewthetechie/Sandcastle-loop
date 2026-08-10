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
A backlog loop variant in which each triaged backlog issue is treated as its own PRD: the loop decomposes the issue into child issues, improves each child just before implementation, fast-forwards approved child work onto a per-issue accumulation branch, runs exactly one full-parent extra review round, improves and drains any follow-ups once, and then delivers the branch review-ready. A reviewed partial branch may be delivered after a child gets stuck. Distinct from the Backlog-clearer loop (which does no decomposition, accumulation, or full-issue extra review) and from the PRD loop (whose PRD is a file).
_Avoid_: Backlog-clearer loop, PRD loop, mini-PRD, decomposing backlog loop

**Parent issue**:
The incoming triaged backlog issue that plays the PRD role for one pass of the Issue-as-PRD loop. It retains its configured backlog labels, gains `agent-in-progress` while owned, and is resumed before fresh work after a restart. A parent whose accumulation cannot be integrated with current mainline gains `agent-diverged` while work continues; clean completion earns `Review`, reviewed incomplete delivery adds `agent-partial`, reviewed delivery needing manual mainline integration adds `agent-rebase-needed`, and a parent-level failure with no reviewable delivery earns `agent-stuck` without `Review`.
_Avoid_: PRD issue, main issue, epic, backlog issue

**Parent state comment**:
The single host-managed GitHub comment on a parent issue containing schema-versioned tagged orchestration state: accumulation branch, original fork SHA, full-parent review base, phase, queue label, any in-flight mainline refresh, divergence state, bounded review/repair budgets, and transition time. It is a restart checkpoint, is verified against branches/labels/children, and is excluded from agent-facing parent context.
_Avoid_: Parent specification, issue body, human comment, local state file

**Sub-task child issue**:
A true GitHub child issue linked under a parent and carrying a temporary per-parent label (`parent-<N>`). Open issues carrying that label form the active inner queue. Each actionable child is worked on its own branch and closes only after its approved HEAD is fast-forwarded into the accumulation branch and checkpointed remotely. Children may come from initial decomposition, full-parent review, or aggregate-validation repair.
_Avoid_: Follow-up PRD issue, backlog issue, draft issue, review note

**Initial issue decomposition**:
The first decomposition pass that turns normalized parent context (the issue body plus capped supplemental human comments) and repository context into sub-task child issues. It reuses the configured issue-decomposer model with dedicated prompts and has no code-quality or two-axis artifacts, unlike full-parent review decomposition.
_Avoid_: Extra-review decomposition, PRD decomposition, follow-up decomposition

**Issue accumulation branch**:
The stable per-parent integration branch (`issue-<N>-accumulation`) initially forked from origin/main and pushed as a recovery checkpoint. Child branches fork from its current tip sequentially; after every accumulation advance, and again before full-parent review, the loop refreshes it onto the latest observed mainline unless it has become a Diverged accumulation. It is ultimately delivered for human review rather than auto-merged.
_Avoid_: Completed PRD branch, issue branch, work branch, PRD branch

**Diverged accumulation**:
An Issue accumulation branch whose deterministic and agent-assisted integration with current mainline could not be completed safely. The parent records `agent-diverged`, preserves the pre-rebase checkpoint and diagnostics, continues child implementation from that checkpoint, and suppresses further automatic rebase attempts for that parent, including after restart; `agent-diverged` remains on the parent through delivery.
_Avoid_: Rebase-needed delivery, local/remote branch divergence, stuck parent

**Rebase agent**:
A dedicated agent that attempts semantic conflict resolution between an Issue accumulation branch and current mainline only after a deterministic rebase conflicts. It preserves the intent of both histories and reports an unresolved result instead of guessing when the safe resolution is ambiguous.
_Avoid_: Coder, rework agent, deterministic rebase, merge agent

**Partial delivery**:
The fail-soft terminal when at least one child integrated before an initial or review-follow-up child got stuck. The accumulated partial diff still receives aggregate validation, one full-parent extra review, and one follow-up drain before the branch is delivered with `Review` plus `agent-partial`; the failed child retains `agent-stuck`. An empty or unvalidated partial branch is not delivered and instead leaves the parent `agent-stuck` without `Review`.
_Avoid_: Abandoned parent, stuck issue, review-ready issue, clean delivery

**Rebase-needed delivery**:
A completed or partial reviewed accumulation branch delivered with `Review` plus `agent-rebase-needed` because its accumulation diverged or mainline advanced after full-parent review began. A diverged delivery also retains `agent-diverged`; the loop preserves the reviewed branch and diagnostics, leaves the final rebase to the human, and continues processing other parents.
_Avoid_: Partial delivery, parent-level stuck, automatic second rebase

**Just-in-time sub-task improvement**:
An evidence-backed refinement of a sub-task child issue immediately before implementation. It preserves the child's intent while improving its title and body against the latest accumulated parent work, and may remove the child from the queue only when that evidence proves the work is duplicate or already implemented.
_Avoid_: Sub-task readiness gate, reviewer, coder gate, issue rewrite

**Sub-task improvement outcome**:
The result of just-in-time sub-task improvement: `improved` persists a stronger actionable title or body, `unchanged` confirms with evidence that the child is already implementation-ready, and `redundant` proves that the work is duplicate or already implemented and removes it from the queue. Missing human decisions remain explicit in an actionable child rather than becoming assumptions; invocation, parsing, or persistence exhaustion is a parent-level technical failure.
_Avoid_: Gate outcome, reviewer verdict, readiness label, needs-info, stuck

**Dropped sub-task**:
A sub-task child issue that just-in-time sub-task improvement closes without coding because evidence proves there is no work to do (duplicate or already implemented). It is removed from the inner drain queue and never gets a branch. Distinct from a stuck sub-task, which was attempted and failed.
_Avoid_: Stuck sub-task, skipped sub-task, not-actionable issue

### Companion TUI

**Companion TUI**:
A separate read-only terminal UI, run in a second terminal alongside a loop, that renders the loop's live state. It never drives the loop; it only observes what the loop emits.
_Avoid_: Dashboard, monitor, control panel

**Step**:
The smallest unit of loop activity the Companion TUI displays and times. A step is either an agent step or a host step, has a single start time, and ends when the next step begins.
_Avoid_: Stage, phase, task, action

**Agent step**:
A step that is one sandboxed agent invocation (initial decomposer, just-in-time sub-task improvement, coder, rework, reviewer, or an extra-review session such as code-quality, two-axis, issue-decomposer, or escalation). It is the only kind of step that produces a working log.
_Avoid_: Agent run, invocation, agent stage

**Host step**:
A step that is host-side loop work with no agent and no working log — sandbox setup, issue publication/linking, label or state-comment transitions, validation, branch rebase/recovery, fast-forward integration, merge/push, or terminal delivery. It is timed like any other step but leaves the working-log pane without new content.
_Avoid_: Host phase, gate, host task

**Status snapshot**:
The atomically-rewritten `.sandcastle/tui/status-<loopType>.json` the loop replaces at every step transition (legacy `status.json` is still discovered). There is one file per loop type so multiple loops can run concurrently in the same repo without clobbering each other. It is the authoritative source for the status pane and holds loop metadata, the current iteration/round/phase, the ticket, and the current step (with its start time and, for agent steps, the working-log path).
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

### PR review loop

**PR risk rating**:
A 0–5 assessment assigned by the `pr-review` fixer to the combined change (original PR plus any fixes it applied). It judges the change itself, not CI or external check status. Distinct from a specialist severity or confidence score.
_Avoid_: Risk score, severity, confidence

**Risk label**:
A GitHub label `risk-N` (0 ≤ N ≤ 5) applied by the PR review loop after a successful review. It is durable state used by external automation and is replaced on re-review.
_Avoid_: Severity label, priority label

**PR review result artifact**:
The host-owned JSON file constructed from the immutable Standards and Spec findings plus the validated PR review fix-result artifact. It carries the risk rating, summary, every specialist finding, fixes applied, unresolved findings with reasons, and optional notes. The host uses it to produce the PR comment and risk label.
_Avoid_: Review report, findings file, output JSON

**PR review fix-result artifact**:
The JSON file the `pr-review` fixer writes after the two independent specialist sessions. It assigns every immutable specialist finding ID exactly one `fixed` or `not_fixed` disposition and supplies the combined-change risk rating and summary. The host rejects missing, duplicate, or unknown dispositions before constructing the PR review result artifact.
_Avoid_: PR review result artifact, specialist report, findings file

**Reviewed HEAD SHA**:
The commit SHA at the end of the PR review loop, recorded in the posted comment after any fixer commit. External automation can compare it to the PR's current HEAD to detect staleness.
_Avoid_: Review SHA, head commit

**Re-review**:
A fresh full review performed when a human removes the `ai-review-complete` label from a previously reviewed PR. The loop replaces the stale risk label and posts a new comment.
_Avoid_: Re-run, follow-up review

**Agent-authored label**:
The `agent-authored` label applied to pull requests created by `run-backlog-v3.mts` at parent delivery. It identifies loop-created PRs for external automation.
_Avoid_: Bot label, auto-PR label
