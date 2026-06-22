# PRD: Agent Invocation Livelock Detection and Rework Escalation

## Problem Statement

The PRD loop can get trapped inside a single coder run even though the agent is
still producing output. A concrete failure mode is a coder repeatedly calling the
same command, such as `git status -s`, for a long time. Because the existing
no-progress checks run only after the agent invocation returns, the outer issue
loop never regains control and cannot apply its normal round limits, validation
checks, rework path, or stuck handling.

This is an agent invocation livelock, not an idle timeout and not a normal
issue-level no-progress case. The operator needs the loop to identify this
condition while the agent run is still active, abort it, and retry once through
rework escalation. The operator also needs reliable monitoring that distinguishes
round-1 coder work from rework, especially when coder and rework are configured
to use different models.

## Solution

Add an agent invocation livelock watchdog around coder and rework agent runs.
The watchdog observes Sandcastle's live agent stream events, tracks consecutive
identical normalized tool calls, and aborts the in-flight agent invocation when
the same tool call appears five times in a row without worktree progress.

When the round-1 coder hits this guard, the loop converts the livelock into
synthetic feedback and retries the issue through the existing rework agent path.
When the rework agent hits the same guard, the loop marks the issue stuck. Rework
escalation remains valid whether the rework model is the same as the coder model
or a distinct stronger model.

The loop also records explicit stage and agent metadata for coder and rework
runs. Monitoring should treat the loop's recorded stage, agent, model, and run
name as the source of truth, and only use provider-based inference as a fallback
for older runs.

This work lands in a new runner, `run-prd-v3.mts`, copied from
`run-prd-extra-review-custom-agents-shared-cache-v2.mts`; the other runner
variants are out of scope. It assumes the latest Sandcastle release, whose
opencode provider emits parsed tool-call stream events through the file-logging
`onAgentStreamEvent` callback and whose abort signal rejects with a structured
reason the loop can use for control flow.

## User Stories

1. As a loop operator, I want a repeated tool-call loop to be detected while the agent invocation is still running, so that the loop does not wait forever for the coder to return.
2. As a loop operator, I want five consecutive identical normalized tool calls to trigger the guard, so that a clear livelock pattern is stopped quickly.
3. As a loop operator, I want the counter to be consecutive rather than run-wide, so that legitimate repeated commands separated by other work are not treated as livelocks.
4. As a loop operator, I want any different tool call to reset the repeated-call streak, so that the guard only catches tight repetition.
5. As a loop operator, I want text output between tool calls not to reset the streak, so that a model cannot avoid detection by narrating between identical commands.
6. As a loop operator, I want the guard to require no worktree progress before aborting, so that legitimate edit-test-edit-test workflows are not killed.
7. As a loop operator, I want worktree progress to include the current HEAD and porcelain status, so that commits and uncommitted file changes both break the no-progress condition.
8. As a loop operator, I want tool-call comparison to normalize tool names and arguments, so that formatting noise does not hide a repeated operation.
9. As a loop operator, I want shell commands compared after whitespace normalization, so that repeated shell inspection commands are detected reliably.
10. As a loop operator, I want the guard to apply to any tool call, so that livelocks are not limited to `git status` loops.
11. As a loop operator, I want the first coder livelock to become feedback for the next round, so that the system has one chance to recover through rework escalation.
12. As a loop operator, I want rework escalation after a coder livelock to use the rework agent, so that the retry has the rework prompt and rework scope.
13. As a loop operator, I want a rework livelock to mark the issue stuck, so that the same issue does not burn another agent run.
14. As a loop operator, I want the stuck comment to explain the repeated tool call that caused the abort, so that a human can see why the issue stopped.
15. As a loop operator, I want livelock feedback to tell the rework agent what repeated call was stopped, so that the retry can avoid the same behavior.
16. As a loop operator, I want coder and rework models to be allowed to match, so that prompt-only rework escalation remains a valid local configuration.
17. As a loop operator, I want a visible warning when coder and rework models match, so that I know rework escalation is prompt-only and not model escalation.
18. As a loop operator, I want rework runs to be named as rework, so that logs and metrics no longer make them look like coder runs.
19. As a loop operator, I want rework metrics to use a rework stage, so that monitoring can distinguish coder work from rework work.
20. As a loop operator, I want metrics to include the selected agent name, so that backend monitoring can confirm whether `coder` or `rework` actually ran.
21. As a loop operator, I want metrics to include the model used for the run, so that I can verify true model escalation when rework uses a stronger model.
22. As a loop operator, I want monitoring to prefer explicit loop run records over provider inference, so that a rework model on a different provider is not misclassified.
23. As a loop maintainer, I want provider inference to remain as a fallback for old metrics, so that historical reports do not stop working.
24. As a loop maintainer, I want the guard implemented using Sandcastle's existing stream callback and abort signal, so that the public Sandcastle API does not need to change.
25. As a loop maintainer, I want the watchdog logic isolated from the large runner, so that the repeated-call behavior can be unit tested without launching agents.
26. As a loop maintainer, I want the runner wrapper to preserve normal Sandcastle file logging, so that existing operator workflows around log files still work.
27. As a loop maintainer, I want abort reasons to be structured enough for control flow, so that livelock aborts are distinguishable from idle timeouts, crashes, and user aborts.
28. As a loop maintainer, I want the existing issue-level no-progress detector to remain in place, so that round-level repeated diffs and validation failures are still handled.
29. As a human reviewer, I want stuck issues caused by agent invocation livelock to carry actionable context, so that I can decide whether to clarify the issue or repair the loop.
30. As a loop operator, I want this feature to work for both same-model and different-model rework configurations, so that I can choose the escalation strength per repository.
31. As a loop operator, I want a rework livelock to be recorded as a distinct terminal outcome, so that I can count livelock-caused stuck issues separately from rounds-exhausted and no-progress.
32. As a loop maintainer, I want the metrics rollup to attribute rework runs to a rework stage instead of folding them into coder, so that coder and rework cost are not conflated.

## Implementation Decisions

- The canonical term for this failure mode is agent invocation livelock: one agent run remains active but repeats the same operation without observable progress.
- The guard watches live Sandcastle agent stream events rather than scraping log files after the fact.
- The guard uses Sandcastle's existing abort signal support to stop the in-flight agent subprocess.
- The repeated-call threshold is five consecutive identical normalized tool calls.
- The repeated-call threshold is not a total count across the full run.
- A different tool call resets the streak.
- Text-only output does not reset the streak.
- A matching repeated-call streak aborts only when worktree progress has not changed since the streak began.
- Worktree progress is represented by the current HEAD and porcelain status.
- Tool-call identity is the normalized tool name plus normalized formatted arguments.
- Tool names are normalized case-insensitively.
- Tool arguments are trimmed and internal whitespace is collapsed before comparison.
- Shell command arguments are compared by the same normalized argument string.
- The first round's coder livelock is converted into synthetic feedback and the loop continues to the next round.
- The synthetic feedback describes the repeated tool call, the threshold, and the lack of worktree progress.
- The next round after a coder livelock uses the existing rework escalation path.
- A rework livelock is terminal for that issue and routes to the stuck path.
- Rework escalation is allowed when coder and rework models are identical.
- When coder and rework models are identical, the loop emits a warning that rework escalation is prompt-only.
- When coder and rework models differ, the same rework path performs both prompt escalation and model escalation.
- Coder runs are recorded with a coder stage and coder agent.
- Rework runs are recorded with a rework stage and rework agent.
- Rework run names use rework terminology in the form `rework #<issue> r<round>` rather than coder terminology.
- Agent-run metric records gain an explicit agent field.
- Metrics and monitoring prefer explicit recorded stage, agent, model, and run name over provider-based inference.
- Provider-based stage inference remains only as a compatibility fallback for runs that predate explicit run records.
- The implementation targets a new runner file `run-prd-v3.mts`, copied from `run-prd-extra-review-custom-agents-shared-cache-v2.mts`; the other runner variants are out of scope.
- The runner assumes the latest Sandcastle version: the opencode provider emits parsed tool-call stream events through the file-logging `onAgentStreamEvent` callback, and an aborted run rejects with a structured `signal.reason`.
- `stage` is the rollup grouping key and names the loop phase: `coder`, `rework`, or `reviewer`.
- `agent` is a separate verification field recording the agent definition that actually ran (the `CustomAgentConfig.name`), so monitoring can confirm whether `coder` or `rework` executed; a `stage`/`agent` mismatch signals a wiring bug.
- A rework livelock records a distinct terminal issue outcome `stuck_livelock`, separate from `stuck_no_progress`, `stuck_rounds_exhausted`, and `blocked`.
- The post-hoc metrics rollup (`metrics.py`) treats `rework` as a first-class stage: it is included in the recorded-run stage filter and in the per-issue and per-PRD rollup buckets, so rework token usage and elapsed time are attributed to rework rather than dropped or merged into coder.
- The legacy provider-based log-name inference in `metrics.py` does not need to learn the rework stage, because the new runner always emits explicit run records and the inference path only serves runs that predate explicit records.
- Existing issue-level no-progress detection remains separate from agent invocation livelock detection.
- Existing validation, review, merge, and stuck workflows remain the authority after an agent invocation completes normally.

## Testing Decisions

- Test the livelock detector as a pure unit: identical normalized tool calls build a consecutive streak and the fifth matching call reports a livelock when the worktree snapshot is unchanged.
- Test that the detector does not trip on five total calls when they are not consecutive.
- Test that a different tool call resets the streak.
- Test that text events do not reset the streak because the detector only consumes tool-call observations.
- Test that a changed HEAD resets or invalidates the no-progress condition.
- Test that a changed porcelain status resets or invalidates the no-progress condition.
- Test normalization of tool names, whitespace, and shell command arguments.
- Test the runner-facing wrapper at the highest practical seam by feeding synthetic Sandcastle stream events into the callback and asserting that the abort controller is triggered only for the resolved livelock condition.
- Test coder control flow by simulating a coder livelock and asserting that the next attempt uses rework escalation with synthetic feedback.
- Test rework control flow by simulating a rework livelock and asserting that the issue routes to the stuck path.
- Test metrics record construction so coder and rework records include explicit stage, agent, run name, and model.
- Extract a pure agent-run record builder (mirroring `buildValidationRunRecord`) so stage, agent, model, and run-name fields can be asserted without launching agents.
- Test metrics rollup behavior so explicit run records are preferred over provider inference.
- Test that the metrics rollup attributes a rework-stage run to rework totals rather than coder totals.
- Test that a rework livelock records the `stuck_livelock` terminal outcome.
- Reuse the style of the existing pure loop-progress tests for detector behavior.
- Reuse the style of the existing metrics-recorder tests for schema-level metric fields.
- Reuse the existing prompt and runner tests' preference for observable behavior rather than testing private implementation details.

## Out of Scope

- Changing Sandcastle's public API.
- Implementing log-tail parsing as the primary watchdog mechanism.
- Changing the rework prompt content beyond the synthetic livelock feedback supplied by the loop.
- Changing the existing issue-level no-progress detector for repeated review diffs or validation failures.
- Changing reviewer, code-quality, two-axis, decomposer, or escalation review behavior.
- Requiring coder and rework to use different models.
- Adding a new human approval step before rework escalation.
- Adding backend monitoring infrastructure beyond emitting and consuming the corrected explicit run metadata.
- General detection of low-quality reasoning, weak plans, or slow progress that does not show up as repeated identical tool calls.

## Further Notes

- The motivating observed loop was repeated `bash(git status -s)` output in a coder log. The design deliberately generalizes this to any identical tool call because the underlying failure mode is repetition without progress, not a specific Git command.
- Sandcastle already exposes the needed primitives: live agent stream events for parsed tool calls and abort signals for active runs.
- Rework escalation can be prompt-only or prompt-plus-model depending on configuration. Both modes are intentional and should be observable.
- This PRD depends on the glossary terms agent invocation livelock and rework escalation.
