# PRD 001: Extra Review Rounds for the PRD Loop

## Problem Statement

The PRD loop can implement and merge individual PRD issues, but it currently stops once the issue queue drains. A human reviewer then manually reviews the completed PRD branch with stricter review skills, turns those reviews into follow-up work, and posts that work back into GitHub so the loop can continue.

That manual post-loop step is slow, inconsistent, and easy to forget. The loop needs a bounded PRD-level quality gate that reviews the completed PRD branch, creates follow-up PRD issues automatically, lets the normal issue loop process them, and then stops with enough artifacts for a human reviewer to continue from the exact point where automation finished or failed.

## Solution

Extend the extra-review runner with a configurable PRD-level quality gate that runs after the normal PRD issue queue drains cleanly. The gate will run two independent review sessions, decompose their findings into follow-up PRD issues, create non-duplicate GitHub issues automatically, and re-enter the normal implementation loop for up to a configured number of extra review rounds.

The extra review process will compare the completed PRD branch against an operator-supplied review base. It will run entirely through Sandcastle-managed sessions. The two reviewers will not share context with each other. The issue decomposer will run in a third independent session and receive only the two review outputs plus PRD and review metadata.

The loop will save artifacts for every extra review round, including successful rounds and failure handoffs. If automation cannot safely continue, it will stop with a markdown handoff that tells the human reviewer what was reviewed, what findings were available, what issues were created or skipped, and what failed.

## User Stories

1. As a loop operator, I want the loop to review the completed PRD branch after normal issues drain, so that I do not need to manually start a second review workflow.
2. As a loop operator, I want extra reviews to run only after the PRD issue queue drains cleanly, so that reviewers inspect a coherent completed PRD branch.
3. As a loop operator, I want extra reviews to be skipped when PRD issues are stuck, so that automation does not review a known-incomplete implementation.
4. As a loop operator, I want extra reviews to be skipped when the outer iteration cap is exhausted, so that the loop does not mistake a safety stop for successful completion.
5. As a loop operator, I want to provide a required review base, so that every extra review compares against the intended starting commit.
6. As a loop operator, I want the review base resolved and logged once, so that later artifacts clearly identify the reviewed range.
7. As a loop operator, I want the extra review round count to be configurable, so that the default can be two rounds without hardcoding the policy into control flow.
8. As a loop operator, I want extra review rounds to stop early when no new work is produced, so that the loop does not keep reviewing a clean branch.
9. As a loop operator, I want duplicate-only output to stop cleanly with warnings, so that already-ticketed work is not reposted.
10. As a loop operator, I want generated follow-up PRD issues to be created automatically in GitHub, so that the normal loop can keep working without human re-triage.
11. As a loop operator, I want each follow-up PRD issue to carry the PRD label, so that the existing issue picker will process it.
12. As a loop operator, I want each follow-up PRD issue to carry a review-follow-up label, so that generated review work remains traceable.
13. As a loop operator, I want follow-up PRD issues to include provenance, so that a human can trace each issue back to its review round, reviewer output, review base, and branch head.
14. As a loop operator, I want duplicate prevention across open and closed PRD issues, so that reruns do not create repeated tickets for the same finding.
15. As a loop operator, I want duplicate detection to log warnings, so that I can see when review findings were already represented in the ticket system.
16. As a human reviewer, I want the code-quality reviewer and two-axis reviewer to run in independent review sessions, so that one reviewer does not bias the other.
17. As a human reviewer, I want the issue decomposer to receive both review outputs in its own session, so that it can deduplicate and shape follow-up work without sharing reviewer context.
18. As a human reviewer, I want the decomposer to merge overlapping findings into one issue when appropriate, so that follow-up work is not fragmented.
19. As a human reviewer, I want the decomposer to split broad findings into smaller issues when appropriate, so that each follow-up issue is implementable by the normal loop.
20. As a loop operator, I want extra review sessions to be Sandcastle-managed, so that the extra workflow uses the same execution model as the rest of the loop.
21. As a loop operator, I want extra review sessions to run sequentially at first, so that the feature avoids concurrency complexity.
22. As a loop operator, I want extra review sessions to use disposable review worktrees, so that accidental edits cannot pollute the completed PRD branch.
23. As a loop operator, I want the host to warn if an extra review agent dirties its worktree, so that read-only contract violations are visible.
24. As a loop operator, I want separate model constants for each extra-review agent, so that reviewer and decomposer models can be tuned independently later.
25. As a loop operator, I want review inputs to be file-backed, so that extra reviewers can inspect diffs of any size without prompt argument limits.
26. As a human reviewer, I want the decomposer to avoid receiving the full diff by default, so that it decomposes review findings instead of acting as a third reviewer.
27. As a loop operator, I want extra reviewers to be read-only, so that the only code changes continue to flow through generated PRD issues and the normal implementation loop.
28. As a loop operator, I want all extra-review agent outputs to use strict tagged JSON, so that the host can parse decisions without brittle markdown scraping.
29. As a loop operator, I want parse failures to stop the extra-review loop, so that ambiguous output is not converted into misleading GitHub issues.
30. As a human reviewer, I want raw outputs saved on parse failure, so that I can inspect exactly what the agents produced.
31. As a human reviewer, I want a markdown handoff saved on every round, so that I can resume from a successful or failed automation checkpoint.
32. As a loop operator, I want artifacts saved for successful rounds too, so that the loop has an audit trail for reviews, created issues, skipped duplicates, and stop reasons.
33. As a loop operator, I want the decomposer to ask no clarifying questions, so that the unattended loop cannot block waiting for human input.
34. As a loop operator, I want ambiguous decomposer input to become a human-review stop, so that unclear findings are not turned into low-quality issues.
35. As a loop operator, I want severe extra-review findings to become follow-up PRD issues rather than direct coder feedback, so that all implementation work follows the existing issue, validation, review, and merge path.
36. As a human reviewer, I want the final stop after configured extra review rounds to be explicit, so that I know when the loop has finished its bounded automated review cycle.

## Implementation Decisions

- The PRD-level quality gate runs only after the normal PRD issue queue drains with no open non-stuck PRD issues and no stuck PRD issues.
- If the normal implementation loop exits because the outer safety cap was reached, extra reviews do not run.
- The extra-review runner requires an operator-supplied review base. The review base is resolved once and reused for every extra review round.
- The completed PRD branch is the review target. Extra reviewers inspect the cumulative PRD implementation, not individual issue branches.
- The maximum number of extra review rounds is controlled by a constant whose default value is two.
- An extra review round creates another implementation cycle only when it successfully creates at least one new non-duplicate follow-up PRD issue.
- If a round creates no issues, only duplicate issues, or no actionable findings, the loop stops cleanly and writes artifacts.
- The two reviewer agents run in independent review sessions. They receive the same PRD and branch comparison inputs, but neither receives the other reviewer session's context or conclusions.
- The issue decomposer runs in its own independent session after both reviewers finish.
- The decomposer receives the two parsed review outputs, PRD body, review base and head metadata, changed file list, and diff stat. It does not receive the full diff by default.
- Extra review inputs are file-backed. The host writes full diff, diff stat, changed files, PRD body, and metadata into review artifacts, and the reviewer prompts instruct agents to read those files.
- Extra review can handle a diff of any size subject to local storage and agent runtime limits. It must not truncate the diff and pretend to have reviewed the full branch.
- All extra-review agents are Sandcastle-managed and run sequentially in the first implementation.
- Extra reviews run from disposable review worktrees derived from the completed PRD branch. These branches are not pushed.
- Extra review prompts enforce read-only behavior. Reviewers and the decomposer may inspect files and git history, but they must not modify files, install dependencies, create commits, or call the issue tracker.
- The host checks for dirty review worktrees after extra-review sessions and logs a warning if an agent violated the read-only contract.
- Each extra-review agent has its own model constant. The initial values may match the existing reviewer model, but they remain independently configurable.
- Each extra-review agent has bounded max-iteration constants. Extra reviewers need enough iterations to read file-backed inputs; the decomposer needs enough iterations to read review outputs and emit structured issue drafts.
- Extra reviewer outputs use strict tagged JSON. The code-quality review and two-axis review have separate output contracts suitable for parsing.
- The issue decomposer emits strict tagged JSON containing either follow-up issue drafts, a no-work result, or a needs-human-review result.
- The decomposer is allowed to merge overlapping reviewer findings and split broad findings into smaller implementation-ready follow-up PRD issues.
- Follow-up PRD issues are created automatically in GitHub when decomposition succeeds.
- Every generated issue receives the current PRD label and a review-follow-up label.
- Generated issue bodies include provenance: extra review round, source reviewers, review base, reviewed branch head, source findings, and artifact references where useful.
- Duplicate prevention uses a stable hidden marker in generated issue bodies. The marker includes the PRD identity, review base, and a stable source fingerprint derived from the decomposed issue and source finding text.
- Before creating a follow-up PRD issue, the host searches open and closed PRD issues for the duplicate marker.
- If a duplicate is found, the host skips creation, logs a warning, and records the duplicate in round artifacts.
- If reviewer output or decomposer output cannot be parsed, the extra-review loop stops for human review.
- If decomposition reports that findings are too ambiguous to issue safely, the extra-review loop stops for human review.
- The host writes artifacts for every extra review round, whether successful or failed.
- Round artifacts include raw reviewer output, parsed review JSON, decomposer output, created issue records, skipped duplicate records, and a markdown handoff.
- The markdown handoff is the human continuation point. It explains what ran, what was reviewed, what was created, what was skipped, and why automation stopped.
- The existing normal implementation loop remains responsible for implementing follow-up PRD issues, validating them, running the inline issue reviewer, merging them into the PRD branch, and closing issues.
- Existing runtime prompt path conventions are preserved for the runner.

## Testing Decisions

- Tests should verify externally observable loop behavior rather than internal implementation details. Good tests should exercise inputs, GitHub command decisions, parser behavior, artifact output, and loop stop reasons.
- The review-base parser should be tested for required input, invalid input, and successful resolution to a fixed commit.
- The extra-review orchestration should be tested around queue-drain conditions: clean drain, stuck issue present, and outer safety cap reached.
- The round-budget behavior should be tested for new issues created, no findings, duplicate-only findings, parse failure, and needs-human-review decomposition.
- The duplicate-prevention module should be tested with open issue duplicates, closed issue duplicates, and new issue creation.
- The tagged JSON parsers should be tested against valid reviewer output, valid decomposer output, missing tags, malformed JSON, wrong shapes, and inconsistent states.
- The issue publisher should be tested with the command arguments it would send to GitHub, including required labels and provenance body content.
- The artifact writer should be tested to ensure successful and failed rounds both produce the expected raw outputs, structured outputs, issue records, duplicate records, and markdown handoff.
- The file-backed input writer should be tested to ensure full diff, diff stat, changed files, PRD body, and metadata are written without truncation.
- The read-only worktree check should be tested by simulating clean and dirty review worktrees and verifying warning behavior.
- Prompt contracts should be reviewed with fixture outputs rather than testing model quality. Tests should assert that the runner accepts only the expected tagged JSON shape.
- Existing validation commands remain the primary behavior check before extra review runs and before issue branches merge.

## Out of Scope

- Parallel execution of extra-review agents is out of scope for the first implementation.
- Changing the normal per-issue coder, validation, inline reviewer, PR creation, merge, or stuck-issue workflow is out of scope except where necessary to call the extra-review phase after a clean queue drain.
- Replacing the existing Sandcastle execution model is out of scope.
- Creating issues from partial, unparseable, or ambiguous review output is out of scope.
- Allowing extra-review agents to edit code, commit changes, install dependencies, push branches, or call GitHub is out of scope.
- Running PRD-level quality gates on incomplete PRD branches is out of scope.
- Decomposing directly from the full diff without reviewer findings is out of scope.
- Building a human approval UI for generated issues is out of scope.
- Automatically publishing or pushing disposable review branches is out of scope.

## Further Notes

- The feature uses the glossary terms PRD-level quality gate, extra review round, independent review session, follow-up PRD issue, review base, and completed PRD branch.
- The implementation should prefer deep, testable modules for parsing tagged outputs, writing artifacts, duplicate detection, and issue publication. Those modules have stable interfaces and encapsulate behavior that would otherwise make the runner harder to reason about.
- The default extra review round budget is two, but the code should make the constant easy to adjust.
- The final loop behavior should be conservative: when automation cannot prove it is safe to continue, it should stop with a handoff rather than create low-quality work.
