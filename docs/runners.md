# Runners

Every entrypoint in the repo: what it does, how it is invoked, and what checks cover it.
Three are live. The rest are frozen snapshots kept because they are deployed elsewhere and
because tests assert against them — see
[AGENTS.md § non-negotiable 1](../AGENTS.md#1-runner-versions-are-frozen-add-a-new-one-instead-of-editing-an-old-one).

All runners are executed with `tsx` from the **target** repo root, not from here.

---

## Live

### `run-backlog-v3.mts`

The production Issue-as-PRD backlog loop. Claims one triaged parent issue at a time,
decomposes it into true GitHub child issues, drives each child through the shared
coder↔reviewer engine, accumulates approved work on a durable parent branch, runs exactly
one full-parent review round, and delivers a review-ready branch.

```bash
tsx run-backlog-v3.mts --label <name[,name2]> \
  [--base-branch main] [--idle-timeout 1800] \
  [--model-coder <model>] [--model-rework <model>] [--no-pr]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--label` | *required* | Comma-separated. An issue must carry **all** of them to be eligible — this is how two loops on different machines partition one backlog. |
| `--base-branch` | `main` | Fork point is `origin/<base-branch>`; it must already exist on origin. |
| `--idle-timeout` | `1800` | Seconds of agent stdout silence before the run fails. Raise it for slow local models that buffer during long generations. |
| `--model-coder` / `--model-rework` | from `.sandcastle/config.mts` | Override the configured role models. |
| `--no-pr` | off | Suppress the best-effort PR creation at parent delivery. |

**Key constants** (top of file): `MAX_ITERATIONS = 250` outer parents per run,
`MAX_REVIEW_ROUNDS = 10` and `CODER_MAX_ITERATIONS = 30` from `BACKLOG_V3_ENGINE_POLICY`,
`MAX_ACQUISITION_FAILURES = 3` consecutive `gh` failures before the run gives up.

**Labels it manages.** Permanent: `Review`, `agent-stuck`, `agent-in-progress`,
`agent-partial`, `agent-rebase-needed`, `agent-authored` — created by `ensureLabels()` at
startup. Dynamic: one `parent-<N>` queue label per active parent, deleted last and
warning-only. `agent-authored` is applied to PRs the loop opens so external automation can
identify them.

**Stop reasons:** `no_eligible_issue` (the normal end — re-run to continue) or
`max_iterations`. A crashed parent is quarantined for the run and the loop continues.

**Where to change what:**

| You want to change… | Edit |
| --- | --- |
| Parent phase transitions, terminal classification | `issue-as-prd-state.mts`, `issue-as-prd-orchestrator.mts` |
| Child queue selection, drain decisions | `issue-as-prd-queue-state.mts` |
| Aggregate validation / repair budget | `issue-as-prd-validation.mts` |
| Round limits, retry budgets | `per-branch-policy.mts` |
| Coder↔reviewer round mechanics | `per-branch-engine.mts` |
| Label/branch/state-comment side effects | `backlog-v3-issue-as-prd-*.mts` |
| Reviewer verdict parsing | `reviewer-result.mts` |
| Agent prompts | the paired `.md` + its `*-prompt.test.mts` |
| CLI flags, sandbox wiring, `gh`/`git` shelling | the runner itself |

**Covered by:** `run-backlog-v3-static.test.mts` (source-text assertions on wiring — the
only coverage the runner body has), plus unit tests on every module it imports. It is in
both the `typecheck` and `build` allowlists.

**Operator runbook:** [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md).
**Acceptance trace:** [issue-as-prd-loop-acceptance-trace.md](issue-as-prd-loop-acceptance-trace.md).

---

### `run-pr-review-v1.mts`

The PR review loop. Polls open PRs, runs one agent that fans out to Standards and Spec
sub-agents via the Task tool, applies the findings itself, pushes, labels
`ai-review-complete`, applies a 0–5 risk label, and posts a comment summarizing what it
found, fixed, and chose not to fix.

```bash
tsx run-pr-review-v1.mts [--label <name[,name2]>] [--model-reviewer <model>] \
  [--settle-seconds 300] [--loop-iterations 2500] \
  [--iteration-sleep-seconds 300] [--base-branch main] [--idle-timeout 1800]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--label` | *(none)* | Optional. Absent means every open PR is eligible. |
| `--model-reviewer` | config `models.reviewer` | The model for all three agents. |
| `--settle-seconds` | `300` | Skip PRs with a commit newer than this — avoids racing a human mid-push. |
| `--loop-iterations` | `2500` | Outer polling iterations. |
| `--iteration-sleep-seconds` | `300` | Sleep between iterations. |
| `--base-branch` | `main` | Review base is `merge-base(origin/<base>, prBranch)`. |
| `--idle-timeout` | `1800` | Agent stdout silence limit. |

**Per-PR skip conditions,** in order: not `OPEN`; already labeled `ai-review-complete`;
`mergeable` is `CONFLICTING` or still computing (`null`); not settled. Then, inside
`processPr`: rendered prompt over the argv limit → `prompt_too_large`. Skips leave the
PR unlabeled, so it is retried next iteration.

**The three agents** (`custom-agent-defs.mts`):

| Agent | Permissions | Prompt |
| --- | --- | --- |
| `pr-review` (main) | `edit: allow`, `bash: allow`, **`task: allow`** | `pr-review-agent-system-prompt.md` + `pr-review-user-prompt.md` |
| `pr-standards-review` | fully read-only | `pr-standards-review-agent-system-prompt.md` |
| `pr-spec-review` | fully read-only | `pr-spec-review-agent-system-prompt.md` |

All three definitions are written into the worktree before the run, because the main agent
invokes the other two itself. `pr-review` is the only `task: allow` agent in the repo.

`PR_REVIEW_MAX_ITERATIONS = 20`; the completion signal is `</pr_review_complete>`.

**Review inputs are file-backed.** `writePrReviewInputs` (`pr-review-inputs.mts`) writes the
diff, diff-stat, changed-files list, PR body, linked issues, and a metadata JSON into the
worktree; the prompt carries only metadata and the paths (`DIFF_PATH`, `PR_BODY_PATH`,
`LINKED_ISSUES_PATH`, …). Keep it that way — inlining a diff back into `promptArgs`
reintroduces `prompt_too_large` skips on exactly the large PRs that most need review.

**Review result is file-backed too.** The coordinating agent writes a JSON artifact to
`RESULT_PATH` before emitting `</pr_review_complete>`. The host validates the artifact,
records the reviewed HEAD SHA, applies the matching `risk-N` label, applies
`ai-review-complete`, and then posts the summary comment. An invalid or missing artifact
is treated as an error outcome: no labels or comment are applied, and the PR is retried.

**Invariants to preserve:**

- `ai-review-complete` is the loop's primary memory. Applying it to a PR that was not
  actually reviewed drops that PR forever. Removing the label makes the PR eligible for a
  fresh full re-review; stale `risk-N` labels are replaced and a new comment is posted.
- `risk-N` labels are durable state used by external automation. They are applied and
  removed through verified mutations.
- An invalid or missing review result artifact is an error outcome: no labels or comment
  are applied.
- Conflicted PRs are skipped, never rebased or resolved.
- The branch is pushed even when the agent produced zero commits, to normalize the ref.

**Covered by:** `pr-review-prompt.test.mts` (path + non-empty assertions on the four prompt
files), plus unit tests on every module it imports. **It is in the `typecheck` allowlist**
— run `npm run typecheck` after editing.

If you add logic here, extract it into a module you can unit-test rather than growing
`processPr`.

---

### `tui-companion.mts`

The read-only Companion TUI. Run it in a second terminal, from the target repo root, while
a loop is running.

```bash
npm run tui          # or: tsx tui-companion.mts
```

No flags — it reads `.sandcastle/tui/` relative to the cwd.

**Keys:** `q` quit · `↑`/`↓` scroll · `g` top · `G` bottom · `tab`/`n` next loop ·
`shift+tab`/`p` previous loop.

**Layout:** status pane left (40% of columns, min 30), working-log pane right, one footer
line. Pane border color tracks liveness: green `running`, yellow `stale` (>8s since
`updatedAt`), red `dead` (>30s, or the pid probe fails), cyan `stopped`.

**Multi-loop:** it discovers every `status*.json` in `.sandcastle/tui/`, keeps independent
state per snapshot (status, previous status, log, scroll offset), and defaults to the
freshest `updatedAt`. With one snapshot the UI is identical to single-loop behavior. Two
loops of the *same* type in one repo still share a file — put those on different machines
([ADR 0004](adr/0004-namespaced-tui-status-snapshots.md)).

**Where to change what:**

| You want to change… | Edit |
| --- | --- |
| What a field *says* — labels, elapsed formatting, liveness thresholds, loop selection | `tui-view.mts` |
| What a field *is* — a new snapshot field | `tui-status.mts` (both writer and reader import it), then emit it in `tui-emitter.mts` |
| How it *looks* — panes, colors, layout, keys | `tui-companion.mts` |
| Working-log line formatting | `tui-working-log.mts` |

Rendering only in the component. If you are computing something inside `StatusPane` or
`WorkingLogPane`, it belongs in `tui-view.mts` where it can be tested without Ink.

**Covered by:** `tui-view.test.mts`, `tui-status.test.mts`, `tui-emitter.test.mts`,
`tui-working-log.test.mts`. The component file itself has no tests — it is in the
`typecheck` and `build` allowlists, and the build (which bundles Ink and React) is the
smoke test that it still resolves.

---

## Operator tools

| Script | Purpose |
| --- | --- |
| `recover-backlog-v3-issues.mts` | Repairs or resets Issue-as-PRD parents the loop reports as ownership-ambiguous. Classifies each candidate as repair-in-place (make labels/branches agree with the state comment) or full reset (quarantine the branch, delete remote branch + state comments, close loop-generated children, drop the queue label). **Dry-run by default; `--apply` executes.** `--label <name[,name2]> [--issue <n[,n2]>] [--include-stuck] [--unstick-children]` |
| `deliver-stuck-parent.mts` | Manually delivers a stuck parent: merges each child branch that has commits into the accumulation branch (fast-forward preferred), pushes, and opens a PR. `--issue <N> [--base-branch main] [--dry-run] [--no-pr]` |
| `cleanup-worktrees.sh` | Reclaims leaked managed worktrees under `.sandcastle/worktrees/` after a crash. Skips dirty worktrees and the one you are standing in; prompts before deleting. `[--dry-run] [--yes] [--age-minutes N] [--include-dirty] [--prune-branches]` |
| `metrics.py` | Post-hoc token/wall-clock rollup, correlating `.sandcastle/metrics/runs.jsonl` with opencode's SQLite session store. `[--prd N] [--issue N] [--detail]`. Tested by `metrics_test.py` (`python3 -m unittest metrics_test`), which is **not** part of `npm test`. |

---

## Frozen

Kept for deployed hosts and for the `assert.doesNotMatch` guards in
`run-backlog-v3-static.test.mts`. Do not edit, delete, or backport into these.

| File | What it was | Superseded by |
| --- | --- | --- |
| `run-backlog-v4.mts` | Issue-as-PRD backlog loop plus the three-tier coder escalation ladder (rounds 1–2 `rework`, 3–4 `reworkTier2`, 5–6 `reworkTier3`; cap 6 instead of 10). Adds `--model-rework-tier2`, `--model-rework-tier3`, `--escalate-tier2-round`, `--escalate-tier3-round`. | *Newer than v3, but v3 is what runs.* Outside the typecheck allowlist. |
| `run-backlog-v2.mts`, `run-backlog.mts` | Backlog-clearer loop — independent issues, one branch each, no decomposition or accumulation ([ADR 0001](adr/0001-backlog-loop-delivers-review-ready-branches.md)). | `run-backlog-v3.mts` |
| `run-prd-v5.mts` | PRD loop taking `--prd-file`/`--tag`/`--branch` instead of a numbered PRD. | — |
| `run-prd-v4.mts` | PRD loop: `--prd <N> --review-base <commit-ish>`. Still in the typecheck **and** build allowlists. | — |
| `run-prd-v3.mts` | PRD loop plus the agent-invocation-livelock watchdog. | `run-prd-v4.mts` |
| `run-prd.mts`, `run-prd-extra-reviews.mts`, `run-prd-extra-review-custom-agents*.mts` | The lineage that produced the extra-review architecture; the `-forgejo` variant is the only `tea`-backed runner. Documented in [extra-review-loop-setup.md](extra-review-loop-setup.md), which describes an older layout and constant-editing config — treat it as history. | `run-prd-v4.mts` |

The PRD loops differ from the backlog loops in one structural way worth remembering: a PRD
loop's spec is a **file** (`docs/prd/<NNN>-*.md`) and it accumulates sequential issues onto
one `prd-<N>` branch, auto-merging each approved issue into it. The backlog loops treat an
**issue** as the spec and never auto-merge. Conflating the two is the most common mistake in
this repo — `CONTEXT.md` names both and lists the terms to avoid for each.
