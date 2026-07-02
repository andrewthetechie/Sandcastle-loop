# Backlog-clearer loop delivers review-ready branches instead of merging

The backlog-clearer loop (`run-backlog.mts`) processes independent, already-triaged
issues that share one label. On a clean reviewer approval it pushes the issue
branch to origin and adds the `Review` label, leaving the issue **open** for a
human to open the pull request; it never opens a PR, merges, or closes the issue.
Issues it cannot land are pushed, commented, and labelled `agent-stuck`. Each
issue forks fresh from `origin/<base-branch>` (default `main`) and issues never
build on each other.

This deliberately diverges from the PRD loop (`run-prd-*.mts`), which accumulates
sequential issues onto one `prd-<N>` branch and auto-merges each approved issue
into it. A reader familiar with the PRD loop would reasonably expect the same
merge-and-close behavior here, so the deviation is recorded to stop someone from
"fixing" it back into an auto-merge.

## Considered options

- **Auto-merge into the base branch (PRD-loop behavior).** Rejected: the backlog
  is unrelated tickets, not one coordinated plan. Auto-merging unrelated agent
  work into `main` removes the human PR review gate that these tickets are being
  prepared for, and makes independent branches interfere through a shared,
  advancing base.
- **Open the PR automatically but leave it unmerged.** Rejected for the first
  version: the loop's job is to produce a ready branch; opening the PR (reviewers,
  templates, CI triggers) is a human/policy concern kept out of the loop. The
  `Review` label plus pushed branch is enough of a signal.

## Consequences

- Terminal state is expressed purely by labels: `Review` (delivered) or
  `agent-stuck` (needs a human). Eligibility is "open, has the target label, has
  neither terminal label," so re-running the loop naturally skips finished issues.
  An in-memory skip set additionally guards against an issue that crashes before a
  terminal label is applied.
- Because the loop never merges, there is no base-advanced re-review/merge race to
  handle; each issue branch is rebased onto a fresh `origin/<base-branch>` per
  round only to keep the reviewer diff current, not to prepare a merge.
- The loop does not validate that `origin/<base-branch>` is green before starting
  an issue (unlike the PRD loop, which must protect an accumulating branch). A red
  mainline surfaces as per-issue validation failures instead.
