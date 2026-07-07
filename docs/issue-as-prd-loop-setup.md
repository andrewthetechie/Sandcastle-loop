# Issue-as-PRD Loop Operations

This document is the operator runbook for the backlog Issue-as-PRD loop driven
by `run-backlog-v3.mts`.

The loop never auto-merges or auto-closes a parent issue. It claims or resumes
one parent at a time, may decompose that parent into true GitHub child issues,
accumulates approved work on a durable parent branch, and delivers a review-ready
branch for a human to inspect and turn into a pull request.

## Required host tools and access

Before starting the loop, verify:

- Node.js 20+
- `tsx`
- Docker or another supported Sandcastle container runtime
- `git`
- `gh`
- authenticated opencode / agent credentials required by the configured models
- push access to the repository remote

Required GitHub permissions:

- Issues: read and write
- Issue comments: read and write
- Labels: read and write
- Sub-issues API access: read and write

The loop uses true GitHub child issues beneath a parent issue. The per-parent
queue label is still authoritative for drain order, but the sub-issue link is
required for hierarchy and auditability.

## Preflight

Before production use:

1. Authenticate `gh auth status`.
2. Confirm the configured validation commands succeed on the host. In this public-loop repo
   snapshot dated 2026-07-03, `npm run typecheck`, `npm test`, and `npm run build` all pass.
3. Confirm sandbox setup commands succeed in a clean worktree.
4. Confirm the configured backlog labels identify only triaged parent issues.
5. Confirm the repo remote named `origin` is writable.
6. Confirm the base branch passed to `--base-branch` already exists on origin.

## Stable naming

Per parent issue `#N`:

- accumulation branch: `issue-N-accumulation`
- child branch: `issue-N-child-M`
- queue label: `parent-N`
- pre-review diagnostic branch:
  `issue-N-accumulation-pre-review-<12-char-head>`

## Label provisioning

The loop must ensure these permanent labels exist:

| Label | Meaning |
| --- | --- |
| `Review` | review-ready parent branch exists |
| `agent-stuck` | parent-level failure with no review-ready delivery, or a stuck child |
| `agent-in-progress` | currently owned parent; recoverable; never auto-expires |
| `agent-partial` | reviewed partial parent delivery |
| `agent-rebase-needed` | reviewed branch needs manual mainline rebase |

The loop also creates a temporary dynamic label per active parent:

- `parent-N`

Its purpose is durable queue selection and restart recovery. Dynamic label
deletion after clean or partial delivery is warning-only and happens last.

## Durable state marker

Each parent has exactly one host-managed state comment carrying:

- marker: `sandcastle-issue-as-prd-state`
- tagged JSON wrapper: `<sandcastle_issue_as_prd_state> ... </sandcastle_issue_as_prd_state>`

The state comment is the durable checkpoint for:

- accumulation branch name
- original fork SHA
- current full-parent review base SHA
- attempted / observed mainline SHAs
- current parent phase
- queue label
- completed extra-review rounds
- aggregate validation repair budget use
- partial-cause child number
- transition timestamp

Operators should treat disagreements between the state comment and observed
branches / labels / child issues as ownership ambiguity that requires manual
handoff.

## Claim and resume behavior

Parent selection is resume-before-fresh:

1. Resume the lowest-numbered open parent carrying all configured backlog labels
   plus `agent-in-progress`.
2. Only if no resumable parent exists, claim the lowest-numbered fresh eligible
   parent.

Fresh claim order:

1. verified add `agent-in-progress`
2. ensure `parent-N`
3. fetch mainline
4. create `issue-N-accumulation` from `origin/<base>`
5. push and verify the initial checkpoint
6. create the parent state comment in phase `claimed`

Claims do not expire automatically. There is no TTL on `agent-in-progress`.
Restart recovery depends on durable GitHub and Git state, not process memory.

## Terminal states

| Labels on parent | Meaning | Human follow-up |
| --- | --- | --- |
| `Review` | clean reviewed delivery | open PR from accumulation branch |
| `Review` + `agent-partial` | reviewed usable subset delivered; at least one child stayed stuck | inspect stuck child, decide whether to finish separately |
| `Review` + `agent-rebase-needed` | reviewed branch delivered unchanged but now needs manual mainline rebase | rebase manually, resolve conflicts, preserve diagnostics |
| `agent-stuck` without `Review` | no review-ready parent delivery exists | inspect diagnostics, branch, artifacts, and retained queue label |
| `agent-in-progress` | owned, recoverable, non-terminal | resume, reconcile, or intentionally hand off |

## Why claims do not expire

The loop uses:

- the accumulation branch
- remote accumulation checkpoint
- child issue states
- per-parent queue label
- the host-managed state comment

These together are sufficient to resume after restart. Automatic claim expiry
would discard recoverable state and create avoidable ownership ambiguity.

## Manual recovery

### Ownership disagreement

Stop the loop and inspect:

- the single parent state comment
- whether `issue-N-accumulation` exists locally and remotely
- local / remote accumulation head agreement
- parent labels, especially `agent-in-progress` and `parent-N`
- open and closed child issues under `parent-N`

If the recorded state is wrong, repair the durable source of truth first:

- update or remove the incorrect state comment
- repair missing labels
- repair or recreate the accumulation branch from the verified checkpoint

Only clear `agent-in-progress` if you are intentionally abandoning the current
ownership record.

### Rebase-needed delivery

If a parent is delivered with `Review` plus `agent-rebase-needed`:

1. inspect the pre-review diagnostic branch and recorded diagnostics
2. fetch current mainline
3. rebase the delivered accumulation branch manually
4. resolve conflicts manually
5. re-run the required host validation
6. open the pull request yourself

The loop must not perform a second automatic rebase or a second full-parent
review round.

### Parent-level stuck without Review

Inspect:

- parent comments
- retained `parent-N` label
- accumulation branch
- extra-review artifacts
- any stuck child issues

Then either:

- repair and resume the same parent, or
- intentionally clear / rewrite ownership state for a human handoff

## Forbidden behavior checklist

Operators should treat any of the following as defects:

- parent auto-close
- parent auto-merge
- second full-parent review round
- parallel child drain
- parallel readiness over the same queue batch
- local-only child queue store replacing GitHub child issues + `parent-N`
- readiness marking a child `agent-stuck` by itself
- older runners silently adopting Issue-as-PRD behavior

For full requirement-to-evidence mapping, see
[issue-as-prd-loop-acceptance-trace.md](issue-as-prd-loop-acceptance-trace.md).
