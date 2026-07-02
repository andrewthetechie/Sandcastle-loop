# PRD: Harden reviewer parse failures and no-progress handling

## Problem Statement

The normal issue loop can mark tickets `agent-stuck` after a reviewer output-format failure even when the implementation is correct or review has not actually completed. A concrete observed path is: a single reviewer attempt inspects files but returns prose or no final `<review>...</review>` block, the host synthesizes `needs_human_review`, that synthetic feedback is sent to rework as if it were an actionable code finding, the rework agent leaves the same net diff because there is no code fix to apply, and the issue-level no-progress detector stops after round 2.

From the operator's perspective, the stuck comment says the agent made no progress, but the root failure was a reviewer contract or host parsing edge. This burns extra coder/rework runs, creates misleading `agent-stuck` comments, and forces humans to inspect logs manually to decide whether the code should have been approved, retried through the reviewer, or stopped for real human review.

This is distinct from agent invocation livelock. Agent invocation livelock is a single coder or rework run repeating tool calls while active. This PRD is about reviewer output handling and issue-level no-progress behavior after a reviewer invocation returns.

## Solution

Harden the reviewer result pipeline so reviewer parse failures are handled as reviewer/host failures, not as code rework feedback. The loop should retry reviewer output before involving rework, preserve bounded reviewer context for operators, distinguish reviewer parse failures from real `needs_human_review`, and keep reviewer acquisition failures out of coder progress tracking.

The host should own a bounded sequence of independent reviewer attempts over one immutable candidate. Each attempt is one Sandcastle iteration with the closing review tag as its completion signal. If returned stdout does not contain a valid verdict, the host should parse that attempt's persisted reviewer run log before deciding whether to retry. Issue-level no-progress should use the outcome of a completed validation or review gate, not an unchanged diff by itself.

## User Stories

1. As a loop operator, I want reviewer parse failures to be distinguished from reviewer decisions, so that I can tell whether the code was rejected or the review contract failed.
2. As a loop operator, I want a missing `<review>` block to retry the reviewer before rework runs, so that a transient format failure does not waste a coder/rework round.
3. As a loop operator, I want invalid reviewer JSON to retry the reviewer before rework runs, so that syntax noise does not become implementation feedback.
4. As a loop operator, I want wrong-shaped reviewer JSON to be reported separately from a real `needs_human_review` decision, so that the stuck reason identifies the failed contract.
5. As a loop operator, I want the host to allow a bounded number of independent reviewer attempts, so that a transient format failure can recover without conflating Sandcastle iterations with one reviewer's tool-use budget.
6. As a loop operator, I want the host to parse the persisted reviewer log when stdout lacks the verdict block, so that a valid verdict is not lost when stdout and log capture disagree.
7. As a loop operator, I want a valid verdict from stdout or the current attempt's run log to be accepted regardless of footer text, so that display metadata does not override a valid contract result.
8. As a loop operator, I want an attempt that ends without a complete `<review>...</review>` block to be classified as reviewer incomplete with diagnostic code `missing_tag`, so that the next action is reviewer retry or human inspection rather than rework.
9. As a loop operator, I want `.sandcastle/config.mts` to expose `reviewer.maxAttempts`, defaulting to 2 total attempts and accepting integers from 1 through 5, so that reviewer retries are bounded and configurable.
10. As a loop operator, I want reviewer retries to reuse the same reviewed diff and base SHA, so that the second reviewer attempt evaluates the same candidate implementation.
11. As a loop operator, I want reviewer retry attempts to have unique run names, run logs, and reviewer-result metrics, so that I can monitor instability and inspect one attempt without mixing outputs.
12. As a loop operator, I want reviewer acquisition failures to avoid the rework agent, so that rework receives only actionable code/test findings.
13. As a loop operator, I want real `changes_requested` findings to continue flowing to rework, so that existing review-driven rework remains unchanged.
14. As a loop operator, I want real `needs_human_review` decisions from the reviewer to stop with human-review context, so that unsafe or incomplete inputs do not get guessed through automation.
15. As a loop operator, I want parser failures to include the current attempt's reviewer run-log path in the stuck comment or terminal output, so that I can inspect the exact attempt output quickly.
16. As a loop operator, I want reviewer acquisition failures to include a short sanitized reviewer-text excerpt, so that I can often diagnose the issue without opening the full log.
17. As a loop operator, I want reviewer acquisition failures to distinguish missing tag, invalid JSON, wrong shape, approved-with-findings, and blocking-without-findings, so that the failure mode is actionable.
18. As a loop operator, I want issue-level no-progress to track the actionable feedback source and a normalized feedback signature together with the candidate diff, so that the terminal reason identifies what repeatedly failed.
19. As a loop operator, I want no-progress stuck comments to identify whether the repeated failed outcome followed validation feedback, real reviewer findings, workflow-pollution feedback, diff-too-large feedback, branch-hygiene feedback, missing-commit feedback, host-input-limit feedback, or livelock feedback, so that the comment points to the correct subsystem.
20. As a loop operator, I want issue outcome metrics to distinguish reviewer parse failure, reviewer incomplete, intentional human review, and stuck no-progress, so that dashboards do not blame coder quality for reviewer contract problems.
21. As a loop maintainer, I want reviewer result parsing isolated behind a small interface, so that missing-tag, log-fallback, retry, and terminal behavior can be tested without launching Sandcastle.
22. As a loop maintainer, I want the normal issue-loop decision logic to be testable with synthetic reviewer results and repeated diffs, so that this regression is locked down at the behavior seam that failed.
23. As a loop maintainer, I want issue comments to include only sanitized reviewer assistant text capped at 800 characters and 12 lines, so that comments remain readable and do not publish prompts, diffs, tool arguments, or credentials.
24. As a loop maintainer, I want the reviewer prompt to keep requiring exactly one tagged JSON block, so that the host contract stays strict even though the host is more resilient.
25. As a loop maintainer, I want reviewer retries to preserve existing validation and branch hygiene checks, so that a stale or polluted branch is not reviewed repeatedly without correction.
26. As a loop maintainer, I want reviewer parse-failure handling to apply to the current v3 runner first, so that the active production runner is fixed before older variants are considered.
27. As a loop maintainer, I want older runner variants to remain out of scope unless they share extracted helper modules, so that the change stays focused.
28. As a human reviewer, I want a ticket stopped for reviewer parse failure to tell me that automation could not obtain a valid review verdict, so that I do not waste time looking for a code change the rework agent failed to make.
29. As a human reviewer, I want the stuck comment to include the last valid implementation state and review base metadata, so that I can manually approve, reject, or rerun from the right context.
30. As a human reviewer, I want the comment to avoid saying only "no progress" when the underlying problem was reviewer output parsing, so that the operational signal is accurate.
31. As a loop operator, I want each reviewer attempt to emit a `sandcastle_reviewer_result` metric that records whether stdout or run-log fallback supplied the verdict, so that I can decide later whether stdout capture needs a deeper fix.
32. As a loop operator, I want reviewer retry exhaustion to be terminal without running rework, so that the loop stops at the failing subsystem.
33. As a loop operator, I want real human-review decisions, reviewer parse failures, and reviewer incomplete exhaustion to use `stuck_needs_human_review`, `stuck_reviewer_parse_failure`, and `stuck_reviewer_incomplete` respectively, so that metrics and stuck issue triage can separate them.
34. As a loop operator, I want the existing agent invocation livelock behavior to remain unchanged, so that this fix does not regress the tool-call watchdog.
35. As a loop operator, I want validation and review gates to be rerun before declaring no progress, so that an unchanged candidate can recover from transient validation failures or reviewer instability.
36. As a loop operator, I want no-progress to stop only after an initial failed-round fingerprint is followed by three consecutive identical repeats, so that tickets which need one or two extra implementation rounds are not stopped prematurely.

## Implementation Decisions

- Model reviewer acquisition as an exact discriminated union:
  - `verdict`: a valid `approved`, `changes_requested`, or `needs_human_review` result plus `resultSource: "stdout" | "run_log"`.
  - `parse_failed`: at least one complete review tag was found, but its JSON or schema was invalid. Preserve a typed failure code and bounded diagnostic details.
  - `incomplete`: neither stdout nor the current attempt's run log contained a complete review tag. Use diagnostic code `missing_tag`.
- Parse-failure codes must distinguish `invalid_json`, `wrong_shape`, `approved_with_findings`, `blocking_without_findings`, `multiple_tags`, and other exact-field/schema violations. Reuse or generalize the existing extra-review parser utilities instead of maintaining another ad hoc parser.
- Parse each attempt in this order: strict tagged JSON from stdout; if that is not a valid verdict, strict tagged JSON from that attempt's run log; then classify the unsuccessful attempt. A valid verdict from either source is authoritative regardless of surrounding max-iteration footer text.
- The parser may locate a tagged block amid run-log display text, but it must never infer a decision from prose. More than one complete `<review>` block in one source is `parse_failed` with code `multiple_tags`.
- Treat log-read absence or failure as diagnostic context, not as an exception that crashes the issue iteration. Classify the attempt from the available stdout and record the missing/unreadable log condition.
- The host owns reviewer retries. Every reviewer attempt calls `sandbox.run` with `maxIterations: 1` and `completionSignal: "</review>"`; do not increase Sandcastle `maxIterations` to give one OpenCode review more tool-use budget.
- Add `reviewer?: { maxAttempts?: number }` to `SandcastleLoopConfig`. `reviewer.maxAttempts` counts the initial attempt, defaults to 2, and must be an integer from 1 through 5. Invalid values fail config loading with a field-specific error.
- Retry only `parse_failed` and `incomplete`. A valid `needs_human_review` verdict stops immediately, a valid `changes_requested` verdict routes to rework, and a valid `approved` verdict proceeds to base-advancement verification and merge.
- Reviewer attempts happen after validation succeeds and before any rework feedback is generated. All attempts reuse the same issue branch state, review base SHA, diff, prompt inputs, and successful validation result. Reviewer attempts must not invoke coder/rework or rerun validation.
- Give every attempt a unique run identity: `reviewer #<issue> r<round> a<attempt>`. Use the `logFilePath` returned by that exact Sandcastle run for fallback and operator context; never rediscover a log by filename or parse an earlier attempt's appended log.
- If attempts are exhausted, the last unsuccessful acquisition category determines the terminal issue outcome: `stuck_reviewer_parse_failure` or `stuck_reviewer_incomplete`. Preserve summaries for all attempts in metrics, but show only bounded final-attempt diagnostics in the issue comment.
- A valid intentional human-review verdict uses terminal outcome `stuck_needs_human_review`. All three reviewer terminal outcomes add `agent-stuck`, and none uses `stuck_no_progress`.
- Do not convert `parse_failed`, `incomplete`, or valid `needs_human_review` results into rework feedback. Only valid `changes_requested` findings become rework feedback.
- Emit one `sandcastle_reviewer_result` metric per reviewer attempt with `schema_version: 1`, PRD, issue, round, attempt, max attempts, status (`approved`, `changes_requested`, `needs_human_review`, `parse_failed`, or `incomplete`), result source (`stdout`, `run_log`, or `none`), optional parse-failure code, log-fallback-used boolean, and log path. Keep `sandcastle_agent_run` as the source for duration, model, agent, and token attribution.
- Extend `sandcastle_issue_outcome` and its TypeScript union for `stuck_reviewer_parse_failure`, `stuck_reviewer_incomplete`, and `stuck_needs_human_review`. The Python outcome rollup may remain generic but must have fixtures proving the new strings are reported distinctly.
- Reviewer terminal comments must show the terminal outcome, issue round, final reviewer attempt/max attempts, reviewer run name, reviewed base SHA, candidate HEAD/tree metadata, current attempt log path, result source, failure code, and sanitized final-attempt excerpt.
- Build the comment excerpt from reviewer assistant text only. Do not include the prompt, issue diff, tool arguments, or full run-log envelope. Normalize control characters; redact bearer credentials and values associated case-insensitively with `authorization`, `api_key`, `token`, `secret`, `password`, and `cookie`; then cap the excerpt at 800 characters and 12 lines. Mark substitutions as `[REDACTED]`.
- Keep the strict reviewer prompt contract requiring exactly one tagged JSON block. The host is becoming more resilient, but the reviewer is still required to comply.
- Replace the independent diff-streak and validation-signature early exits with one completed failed-round fingerprint containing candidate diff hash, actionable feedback source, and normalized feedback signature. Supported sources are `validation`, `reviewer_changes_requested`, `workflow_pollution`, `diff_too_large`, `branch_hygiene`, `missing_commit`, `host_input_limit`, and `livelock`.
- Build feedback signatures from canonical structured fields, not rendered feedback prose: validation command plus summarized first error; stable JSON for reviewer finding problem/remediation/file/line fields; stable host failure code for workflow pollution, diff too large, branch hygiene, missing commit, and host input limits; normalized tool name and arguments for livelock. Normalize line endings and whitespace before hashing. Comments may show a bounded human-readable signature summary, but streak comparison uses the hash.
- Reviewer `parse_failed`, reviewer `incomplete`, and valid `needs_human_review` are terminal/acquisition outcomes, not feedback sources, because they never trigger coder/rework.
- Always rerun the applicable host check, validation gate, or reviewer gate before recording another failed-round fingerprint. An initial failed fingerprint seeds state; stop only after three subsequent consecutive identical fingerprints, meaning four identical failed outcomes in total. Reset the streak when the diff hash, source, or normalized signature changes, or when the applicable check succeeds.
- A no-progress comment must state the actionable feedback source, normalized signature summary, repeated-outcome count, and last feedback. This replaces the generic claim that an unchanged diff alone proves coder no-progress.
- Keep existing approval base-advancement verification, branch-hygiene checks, validation commands, and agent invocation livelock behavior. Reviewer acquisition retries must not mutate livelock state.
- Extract pure reviewer parsing, attempt-result resolution, failed-round fingerprinting, excerpt sanitization, reviewer-result metric construction, and stuck-comment formatting. Keep Sandcastle invocation and filesystem reads in the v3 runner adapter.
- The active v3 runner is the implementation target. Older runner variants are out of scope except where they already share extracted helper code.
- Do not publish extra-review artifacts for normal issue reviewer failures. The required operator surface is the attempt-specific run log, issue comment, terminal output, and metrics.

## Testing Decisions

- Tests should exercise externally observable loop behavior and helper contracts, not private implementation details.
- Make the normal issue-loop reviewer decision seam testable with injected reviewer-attempt results. Given one immutable candidate, synthetic stdout/log contents, and `reviewer.maxAttempts`, assert whether the loop retries reviewer, routes valid findings to rework, approves, or marks the issue stuck.
- Add config tests for the default `reviewer.maxAttempts` value of 2, accepted bounds 1 and 5, and rejection of zero, values above 5, non-integers, and non-numbers.
- Add runner-adapter tests proving each attempt uses `maxIterations: 1`, `completionSignal: "</review>"`, an attempt-indexed run name, and the exact `logFilePath` returned by that run.
- Add parser tests for valid approved, valid changes requested, valid needs human review, missing tag, invalid JSON, wrong top-level shape, missing/extra/invalid fields, approved with findings, blocking decision without findings, and multiple tags.
- Add fallback tests where stdout is missing, malformed, or wrong-shaped while the current attempt's run log contains a valid verdict. Assert `resultSource: "run_log"` and `logFallbackUsed: true`.
- Add fallback negative tests for missing/unreadable logs and for sources where neither stdout nor the current attempt's log contains a valid verdict. Filesystem failure must return acquisition diagnostics rather than throw.
- Add tests proving a valid verdict remains authoritative when the run log also includes max-iteration footer text.
- Add tests proving no complete tag becomes `incomplete`/`missing_tag`, while a complete invalid block becomes `parse_failed` with the specific failure code.
- Add attempt-loop tests proving the default permits two total attempts, retries only parse failed/incomplete results, reuses the same candidate inputs, and never invokes coder/rework or validation between attempts.
- Add exhaustion tests for exact terminal outcomes `stuck_reviewer_parse_failure` and `stuck_reviewer_incomplete` and their attempt-specific comments.
- Add tests proving valid `changes_requested` findings still produce rework feedback and valid `needs_human_review` stops immediately as `stuck_needs_human_review`.
- Add failed-round fingerprint tests proving an initial failed outcome plus two identical repeats does not stop, the third identical repeat does stop, and any changed diff/source/signature or successful gate resets the streak.
- Add behavior tests proving unchanged candidates still rerun validation/review and can recover to success before the no-progress threshold.
- Add tests proving reviewer parse failure/incomplete never enters failed-round fingerprint state and never becomes coder no-progress.
- Add excerpt sanitizer tests for assistant-text selection, control-character normalization, each required credential pattern, `[REDACTED]` markers, 800-character truncation, and the 12-line cap.
- Add stuck-comment formatter tests covering both reviewer acquisition outcomes, intentional human review, source-aware no-progress, validation no-progress, and livelock comments.
- Add `sandcastle_reviewer_result` builder/recorder tests for stdout success, log fallback, parse failure, incomplete output, attempt numbers, and log paths. Add issue-outcome and Python rollup fixtures for all three new terminal strings.
- Reuse prior art from the existing parser, extra-review session, loop-progress, livelock, stuck-comment, and metrics-recorder tests.
- Do not launch real OpenCode or Sandcastle agents in unit tests, and do not depend on live GitHub issue state.

## Out of Scope

- Changing Sandcastle's public API.
- Changing opencode itself.
- Using Sandcastle `maxIterations` as the normal reviewer retry mechanism or as a way to extend one OpenCode reviewer's tool-use budget.
- Replacing the reviewer model.
- Requiring coder and rework to use different models.
- Changing the reviewer from a strict tagged JSON contract to freeform prose scraping.
- Changing extra-review code-quality, two-axis, decomposer, or escalation review behavior except where shared parser utilities naturally apply.
- Reworking the entire normal issue loop architecture.
- Adding a human approval gate before every rework round.
- Disabling issue-level no-progress detection globally.
- Changing validation commands, setup commands, or branch merge strategy.
- Fixing unrelated coder scope creep or reviewer judgment quality issues.
- Backfilling old stuck issues automatically.
- Creating a dashboard beyond emitting enough metrics for existing metrics tooling to report the new outcomes.

## Further Notes

The motivating investigation used live logs from `andrew@10.10.0.32:~/yardwhisper`. In one observed path, a reviewer run inspected files and wrote prose but emitted no `<review>` block; the host synthesized `needs_human_review`; rework received non-actionable feedback; the repeated diff detector then stopped the issue as no-progress. In another recent path, the reviewer run log contained a valid `<review>` block while returned stdout did not preserve it.

Sandcastle's max-iterations footer is display metadata emitted when no configured completion signal ends its outer iteration loop. It is not evidence that OpenCode consumed a per-review tool-call budget. The normal reviewer therefore uses one Sandcastle iteration per host-owned attempt and `</review>` as the completion signal. This also makes missing-tag incompleteness observable without launching nested independent review invocations.

This PRD depends on the glossary distinction between agent invocation livelock, which is a single active agent run repeating operations, and issue-level no-progress, which is repeated identical failed outcomes across completed issue rounds. The failure addressed here is neither a coder tool-call livelock nor a genuine ignored code finding; it is a reviewer result acquisition failure that currently gets misrouted into the rework/no-progress path.
