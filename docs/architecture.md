# Architecture

How the loops actually execute, what they share, and where the durable state lives.
Companion to [AGENTS.md](../AGENTS.md); read that first for the working rules.

Focus is on the three live entrypoints: `run-backlog-v3.mts`, `run-pr-review-v1.mts`, and
`tui-companion.mts`.

## The two planes

Every loop runs on two planes at once, and it matters which one your change is on.

**The control plane** is host-side and synchronous: `git` and `gh` subprocesses, host
validation commands, label and comment mutations. Failures here are real — they propagate,
they get retried under `runVerifiedHostMutation`, and they end tickets.

**The observability plane** is the TUI emitter and the metrics recorder. Every write is
wrapped so a failure can never reach loop control flow ([ADR 0002](adr/0002-companion-tui-reads-loop-emitted-status-snapshot.md)).
An emitter that throws is swallowed; a metrics file that can't be written is dropped. This
asymmetry is deliberate: you must not be able to break a production loop by breaking the
dashboard.

If you add a call in a runner, know which plane it is on. Adding a `tuiEmitter.*` call is
free. Adding a `gh` call is not.

## Layering

```
                    ┌──────────────────────────────────────────────┐
  entrypoints       │  run-backlog-v3   run-pr-review-v1   tui-…   │
                    └──────────┬─────────────────┬────────────┬────┘
                               │                 │            │
                    ┌──────────▼─────────┐  ┌────▼──────┐     │ reads
  adapters          │ backlog-v3-issue-  │  │ (none —   │     │ only
  (side effects)    │ as-prd-*  · git ·  │  │  inline)  │     │
                    │ gh · labels · state│  └────┬──────┘     │
                    └──────────┬─────────┘       │            │
                               │                 │            │
                    ┌──────────▼─────────────────▼──────┐     │
  shared engine     │ per-branch-engine · per-branch-   │     │
                    │ policy · reviewer-result          │     │
                    └──────────┬────────────────────────┘     │
                               │                              │
                    ┌──────────▼──────────────────────┐  ┌────▼─────────┐
  pure decisions    │ issue-as-prd-* · loop-progress · │  │ tui-view ·   │
  (plain data in,   │ subtask-readiness · extra-review-│  │ tui-status · │
   plain data out)  │ parsers · coder-escalation-ladder│  │ tui-working- │
                    └──────────┬──────────────────────┘  │ log          │
                               │                          └──────┬──────┘
                    ┌──────────▼──────────────────────────────────▼────┐
  infrastructure    │ github-issues · forgejo-tea · custom-agent-* ·   │
                    │ host-validation-* · metrics-recorder ·           │
                    │ failure-diagnostics · verified-host-mutation     │
                    └──────────────────────────────────────────────────┘
```

The rule the layering encodes: **the pure layer never imports `node:child_process`**.
Anything that shells out is injected as a `deps` object. That is why `run-backlog-v3.mts`
is 4.4k lines of wiring — it is where all the injection happens.

## `run-backlog-v3.mts` — the Issue-as-PRD backlog loop

### One outer iteration

```
acquireNextIssueAsPrdParentForLoop()
  ├─ resume: lowest-numbered open parent with all --label labels + agent-in-progress
  └─ else claim: lowest-numbered fresh eligible parent
        → add agent-in-progress (verified)
        → ensure parent-<N> queue label
        → create issue-<N>-accumulation from origin/<base>, push, verify
        → create the parent state comment in phase `claimed`

processIssueAsPrdParent(parent)
  → runIssueAsPrdParent(…, deps)          ← pure orchestrator, injected deps
       initial decomposition              (agent: initial-issue-decomposer)
       for each child in the parent-<N> queue:
         sub-task readiness gate          (agent: subtask-readiness)
           → fixed | not-actionable (drop) | assumed
         runPerBranchEngine               (agents: coder ↔ reviewer, ≤10 rounds)
         fast-forward approved HEAD into issue-<N>-accumulation, push, checkpoint
         close the child
       aggregate validation of the accumulated branch
       best-effort rebase onto current mainline
       exactly ONE full-parent extra review round
       readiness-gate + drain follow-up children ONCE
       deliver review-ready
```

Terminal labels on the parent: `Review` (clean), `Review` + `agent-partial` (a child stuck
but a usable subset was reviewed), `Review` + `agent-rebase-needed` (reviewed branch needs a
manual rebase), or `agent-stuck` without `Review` (nothing reviewable). Full semantics and
operator recovery: [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md).

At parent delivery the loop also opens a PR from the accumulation branch into the base
branch — best-effort (failures are logged, not fatal), skipped when a PR already exists for
that head, and disabled by `--no-pr`. Child delivery never opens a PR. Neither ever merges
or closes.

### Durable state — three stores that must agree

The loop keeps no process memory across restarts. Recovery reads three places:

| Store | Holds | Written by |
| --- | --- | --- |
| **Parent state comment** — one host-managed GitHub comment, tagged `<sandcastle_issue_as_prd_state>` | accumulation branch, original fork SHA, review base, phase, queue label, round/repair budgets, transition time | `backlog-v3-issue-as-prd-state-comment.mts` |
| **GitHub labels** | ownership (`agent-in-progress`), the `parent-<N>` queue label, terminal outcome | `runVerifiedHostMutation` wrappers |
| **Git branches** | `issue-<N>-accumulation` (local + pushed checkpoint), `issue-<N>-child-<M>` | `backlog-v3-issue-as-prd-git-adapter.mts` |

Disagreement between the three is *ownership ambiguity*: the loop logs it, skips the parent
for the run, and moves on. `recover-backlog-v3-issues.mts` is the operator tool that
repairs or resets those parents.

There is a **write-ordering invariant** in `processIssueAsPrdParent` worth knowing before
you touch that function: the terminal phase must land in the state comment *before* the
terminal label plan mutates the issue. Otherwise a finished parent is recorded at an
in-progress phase and wedges as ownership-ambiguous the moment its labels change. The
comment in the source says so; keep it true.

Claims never expire — there is no TTL on `agent-in-progress`, because the three stores
above are sufficient to resume and an automatic expiry would discard recoverable state.

### The shared per-branch engine

`runPerBranchEngine` (`per-branch-engine.mts`) is the coder↔reviewer loop every issue goes
through. It is pure: all I/O arrives through `PerBranchEngineDeps` (`createSandbox`,
`invokeCoder`, `runValidation`, `acquireReviewer`, `prepareBranchForReview`,
`recoverBranch`, …). Per round:

1. `preCoderRebaseGuard` (round 1 only, if the policy enables it) — a stale branch that no
   longer rebases becomes round-1 rework feedback rather than an instant stuck.
2. `invokeCoder` — the coder on round 1, the rework agent afterwards.
3. `prepareBranchForReview` → `runValidation` — host-side validation gate; the first failing
   command becomes next round's feedback.
4. `acquireReviewer` → a `ReviewResult` verdict.

It returns a discriminated union: `approved` | `already_satisfied` | `stuck` | `crashed`.

Two guards live inside it:

- **No-progress detection** (`loop-progress.mts`): rounds are fingerprinted by candidate diff
  plus failure signature. `failedRoundRepeatLimit` identical fingerprints ends the issue.
- **Model-change reset**: when `agentModelForRound` reports a different model than last
  round, the fingerprint history is cleared. This is load-bearing for `run-backlog-v4`'s
  escalation ladder — `failedRoundRepeatLimit` encodes "same model, same input, same
  failure, therefore pointless", and a stronger model invalidates that inference. Without
  the reset the ladder would never fire on the tasks that most need it.

Policy constants are per-runner, in `per-branch-policy.mts`: v3 allows 10 review rounds; v4
allows 6 and spends the saved budget on model escalation instead.

Separately, `agent-invocation-livelock.mts` watches *inside* a single agent run: five
consecutive identical normalized tool calls with an unchanged worktree snapshot aborts the
run as `agent_invocation_livelock`. That is a different failure from issue-level
no-progress — see `CONTEXT.md`, which names both and tells you which term to avoid.

### Agent invocation

Every agent runs the same way:

1. `buildAgentDefinition(config, model, systemPromptBody)` (`custom-agent-defs.mts`) renders
   an opencode agent-definition file — YAML frontmatter with `description`, `mode: primary`,
   `model`, `temperature`, and a `permission` block.
2. `writeAgentDefinitionFile` drops it into the sandbox worktree; `ensureOpencodeGitExclude`
   keeps it out of git.
3. The user prompt is a `{{PLACEHOLDER}}` template rendered by `renderSlimMessage`, then
   size-checked by `enforceArgvSizeLimit` (prompts travel through argv, which has a hard
   ceiling).
4. `sandbox.run({ agent: sandcastle.opencode(model, { agent: name }), maxIterations,
   completionSignal, idleTimeoutSeconds, promptFile, promptArgs, logging })`.

`completionSignal` is the exact marker the agent emits when done — it stops the run
immediately rather than burning the remaining iteration budget:

| Agent | Signal |
| --- | --- |
| coder, rework | `<promise>COMPLETE</promise>` |
| reviewer | `</review>` |
| initial issue decomposer | `</initial_issue_decomposition>` |
| sub-task readiness | `</subtask_readiness>` |
| code-quality, two-axis | `</extra_review>` |
| issue decomposer | `</followup_issues>` |
| pr-review | `</pr_review_complete>` |

Permissions are least-privilege per role: reviewers and decomposers get `edit: deny` and
`bash: deny`; only coder, rework, and the PR review agent can write.

## `run-pr-review-v1.mts` — the PR review loop

Structurally the simplest live loop. No engine, no state machine, no durable state comment —
the `ai-review-complete` label is the entire memory.

```
for iteration in 1..--loop-iterations:
    fetchPrList(labels?)                       ← full list, once per iteration
    for each PR:
        skip unless OPEN
        skip if already labeled ai-review-complete
        skip if mergeable is CONFLICTING or still computing
        skip if a commit landed within --settle-seconds
        processPr(pr)
    sleep --iteration-sleep-seconds
```

`processPr` fetches the branch, force-syncs the local ref to `origin/<head>`, computes the
review base as `merge-base(origin/<base>, prBranch)`, and creates a sandbox on the PR branch.
It then writes **three** agent definitions into the worktree — `pr-review`,
`pr-standards-review`, `pr-spec-review` — because the main agent invokes the other two
through the Task tool. `pr-review` is the only agent in the repo with `task: allow`.

Review inputs are **file-backed**: `writePrReviewInputs` (`pr-review-inputs.mts`) writes the
diff, diff-stat, changed-files list, PR body, linked issues, and a metadata JSON into the
worktree, and the user prompt carries only metadata plus the *paths*
(`DIFF_PATH`, `PR_BODY_PATH`, …). That keeps the argv payload small regardless of PR size —
the same pattern `extra-review-inputs.mts` uses for the PRD-level gates.

Linked issues are scraped from the PR body (`ISSUE_REF_PATTERN` → `gatherLinkedIssues`).
The agent reviews, applies the fixes itself, and commits. Then the host pushes the branch
(even with zero commits, to normalize the ref) and applies `ai-review-complete`.

Bail-outs return an outcome string without labeling, so the PR is retried next iteration:
`prompt_too_large` (argv limit), `error`.

Things to preserve when editing:

- **The label is idempotency.** Anything that applies `ai-review-complete` on a PR that was
  not actually reviewed silently drops that PR forever.
- **The settle window exists to avoid racing a human.** Do not shorten it to make testing
  easier.
- **Conflicted PRs are skipped, never resolved.** Rebasing someone's PR is not this loop's
  job.

## `tui-companion.mts` — the Companion TUI

A second terminal that answers "what is happening, on what, for how long, and what is the
agent doing". Strictly read-only.

### The contract

The loop writes; the TUI reads. Nothing flows back.

- **Status snapshot** — `.sandcastle/tui/status-<loopType>.json`, rewritten atomically
  (temp file + `rename`) at every step transition, plus a 2s heartbeat on `updatedAt` so a
  long step still looks alive. One file per loop type so a backlog loop and a PR review loop
  in the same checkout do not clobber each other ([ADR 0004](adr/0004-namespaced-tui-status-snapshots.md)).
  Legacy `status.json` is still discovered.
- **Working log** — `.sandcastle/tui/logs/<run-name>.log`, one per **agent step**, in a
  format the loop owns ([ADR 0003](adr/0003-loop-owns-working-log-format.md)).

The shape lives in `tui-status.mts` and is imported by both writer and reader, so they
cannot drift. `TUI_STATUS_SCHEMA_VERSION` is `1`.

A **step** is the unit the TUI displays and times. An **agent step** is one sandboxed agent
invocation and is the only kind with a working log; a **host step** is host-side work
(sandbox setup, validation, label transitions, integration, delivery) and leaves the log
pane frozen. Loops mark them with `tuiEmitter.beginAgentStep(…)` / `beginHostStep(…)`.

### Reader anatomy

| Module | Role |
| --- | --- |
| `tui-status.mts` | Contract, `buildTuiStatus`, atomic writer, path helpers, snapshot discovery (`TUI_STATUS_SNAPSHOT_FILE_RE`). |
| `tui-emitter.mts` | Loop-side singleton. Holds loop context, writes snapshots + logs, heartbeats. Every write wrapped. |
| `tui-working-log.mts` | Agent stream event → log lines. |
| `tui-view.mts` | **All derivation**: `deriveStatusView`, `deriveWorkingLogTarget`, plus multi-loop selection (`orderSnapshotPaths`, `pickFreshestSnapshot`, `selectAdjacentSnapshot`, `formatLoopSwitcherLabel`). Pure, tested without Ink. |
| `tui-companion.mts` | Ink rendering only — two panes, a footer, and the input handler. |

That split is the reason the TUI is testable at all: **put new logic in `tui-view.mts`**,
not in the component. If you find yourself computing something inside `StatusPane`, it
belongs one file over.

Runtime behavior worth knowing:

- Refresh is a 1s poll plus a recursive `fs.watch` on `.sandcastle/tui/`. The watch is the
  fast path; the poll is the safety net for platforms without recursive watch.
- A failed snapshot read is treated as a **torn read** — the previous state is kept so the
  pane does not flicker mid-`rename`.
- `deriveWorkingLogTarget(prev, next)` returns `clear` (new agent step → reset the pane and
  scroll), `continue` (same step → re-read), or `freeze` (host step → keep showing the last
  agent's output, greyed).
- Liveness is derived from `updatedAt` age (`running` → `stale` at 8s → `dead` at 30s) plus
  a `process.kill(pid, 0)` probe; `EPERM` counts as alive.
- Per-loop state (status, previous status, log, scroll offset) is held in a `Map` keyed by
  snapshot path, so switching loops preserves each one's scroll position.

Keys: `q` quit · `↑`/`↓` scroll · `g` top · `G` bottom · `tab`/`n` next loop ·
`shift+tab`/`p` previous.

## Configuration

`.sandcastle/config.mts` in the **target** repo, loaded by `loadSandcastleLoopConfig` at
startup. It is optional — every field has a default, and the loop prints whether it found
one. A default-exported object with:

| Field | Purpose |
| --- | --- |
| `models` | Per-role opencode `provider/model` strings: `coder`, `rework`, `reworkTier2`, `reworkTier3`, `reviewer`, `initialIssueDecomposer`, `subtaskReadiness`, `codeQuality`, `twoAxis`, `issueDecomposer`, `escalationReview`. `initialIssueDecomposer` and `subtaskReadiness` default to whatever `reviewer` resolves to. |
| `validationCommands` | The host validation gate. Default `["npm run typecheck", "npm run test", "npm run build"]`. Empty array disables it. |
| `setupCommands` | Run once the sandbox is ready. Default `["npm install"]`. |
| `cache` | Host↔sandbox cache mounts (`root`, `mounts`, `env`), so package managers do not re-download per sandbox. Host paths are derived per-repo and created eagerly. |
| `reviewer.maxAttempts` | Reviewer acquisition retries. Default 2. |
| `issueAsPrd.parentCommentMaxBytes` | Cap on the parent state comment. Default 32 000. |
| `reviewDiffMaxBytes` | Hard cap on review diffs passed via argv (backlog and PRD loops). Default 60 000. |
| `coderEscalation` | `tier2FromRound` (3) / `tier3FromRound` (5) for the v4 ladder. |

CLI flags override config for models: `--model-coder`, `--model-rework` (backlog),
`--model-reviewer` (PR review).

Agents authenticate through the host's opencode config, bind-mounted into every sandbox:
`~/.config/opencode` read-only, `~/.local/share/opencode` writable.

## Artifacts in the target repo

Everything the loops emit lands under `.sandcastle/` in the target repo:

| Path | Contents |
| --- | --- |
| `tui/status-<loopType>.json` | Current status snapshot. |
| `tui/logs/<run-name>.log` | Per-agent-step working logs. |
| `logs/*.log` | Raw sandcastle run logs (name encodes prd/issue/stage/round). |
| `metrics/runs.jsonl` | Append-only agent runs, validation runs, reviewer results, issue outcomes. Input to `metrics.py`. |
| `diagnostics/` | Crash bundles from `failure-diagnostics.mts`. |
| `extra-review-runs/<prd>/<round>/` | Per-round review inputs, raw + parsed outputs, created/skipped issues, `HANDOFF.md`. |
| `worktrees/` | Managed sandbox worktrees. Leaked ones are reclaimed by `cleanup-worktrees.sh`. |

`metrics.py` correlates `runs.jsonl` against opencode's SQLite session store to produce
per-issue and per-PRD token/wall-clock rollups. It is where the numbers quoted in
`per-branch-policy.mts` came from.

## Forge backends

Issue operations go through an interface with two implementations: `github-issues.mts`
(REST via `gh api`, the default) and `forgejo-tea.mts` (the `tea` CLI). Only
`run-prd-extra-review-custom-agents-shared-cache-forgejo.mts` uses the latter. If you add an
issue operation, add it to the interface, not to a call site.

`run-pr-review-v1.mts` shells `gh pr` directly — it has no forge abstraction and does not
need one.
