# AGENTS.md

Operating contract for coding agents working **on** this repository.

## What this repo is

Sandcastle Loop is the **source** for a family of autonomous coding loops. Each loop is a
Node/TypeScript program run with `tsx` that drives sandboxed LLM agents (opencode inside
Docker, via [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle)) against a
**separate target repository**, using GitHub issues or PRs as the work queue and git
branches as the unit of delivery.

Two facts follow from that, and most mistakes in this repo come from missing one:

1. **This repo is not a library.** Nothing imports it as a package. Deployment is a file
   copy: a runner plus its shared modules plus its prompt `.md` files are copied into the
   *target* repo's `.sandcastle/` directory and run with the *target* repo root as cwd.
   Runtime paths like `./.sandcastle/coder-agent-system-prompt-prd.md` and
   `.sandcastle/tui/status-backlog.json` resolve in the target repo, not here.
2. **The code here is the orchestrator, not the thing being orchestrated.** When a prompt
   says "follow the repository's AGENTS.md", it is addressing the *coder agent working in
   the target repo* — not you. This file is for you.

## The three files that matter

The repo contains a decade of runner versions, but three files carry essentially all the
live traffic. Unless you were pointed somewhere else, your change belongs in one of them:

| File | What it is | Lines | Deep dive |
| --- | --- | --- | --- |
| **`run-backlog-v3.mts`** | The production **Issue-as-PRD backlog loop**. Claims one triaged parent issue, decomposes it into GitHub child issues, drives each child through coder↔reviewer, accumulates approved work on a durable parent branch, runs one full-parent review, delivers review-ready. | 4.4k | [docs/runners.md#run-backlog-v3mts](docs/runners.md#run-backlog-v3mts) |
| **`run-pr-review-v1.mts`** | The **PR review loop**. Polls open PRs, host-runs independent Standards and Spec sessions with parsed artifacts, gives immutable findings to a fresh fixer session, pushes, labels `ai-review-complete`. | 1.3k | [docs/runners.md#run-pr-review-v1mts](docs/runners.md#run-pr-review-v1mts) |
| **`tui-companion.mts`** | The read-only **Companion TUI**. Renders live loop state from `.sandcastle/tui/` in a second terminal. Multi-loop aware. | 470 | [docs/runners.md#tui-companionmts](docs/runners.md#tui-companionmts) |

Everything else is either a shared module those three import, or a frozen older runner.
[docs/architecture.md](docs/architecture.md) explains how the three fit together and what
they share.

Before editing any of the three, know these three things:

- **`run-backlog-v3.mts` is thin on purpose.** Its ~4.4k lines are wiring: CLI parsing,
  sandbox lifecycle, `git`/`gh` shelling, dependency objects. The decisions live in the
  `issue-as-prd-*` pure modules. If you are adding an `if` to the runner, check whether it
  belongs in `issue-as-prd-orchestrator.mts`, `issue-as-prd-state.mts`, or
  `per-branch-engine.mts` instead.
- **`run-pr-review-v1.mts` is deliberately a simple staged loop.** No engine, no state
  machine, no durable state comment — two independent read-only specialist sessions, one
  fresh fixer session, one label. It is not a smaller `run-backlog-v3`, and it should not
  grow into one.
- **`tui-companion.mts` may never write.** It reads `.sandcastle/tui/` and nothing else. All
  derivation logic lives in `tui-view.mts` so it can be tested without Ink; the component
  file holds rendering only.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | `tsx --test *.test.mts` — every test file in the repo root. ~3s. |
| `npm run typecheck` | `tsc --noEmit` over an **explicit allowlist** of files (see below). |
| `npm run build` | esbuild-bundles `run-backlog-v3.mts`, `run-prd-v4.mts`, `tui-companion.mts` to `/tmp` as an import-graph smoke test. |
| `npm run tui` | Runs the Companion TUI against `.sandcastle/tui/` in the cwd. Only useful inside a target repo with a live loop. |

There is **no CI, no linter, and no `tsconfig.json`** — the compiler flags live inline in the
`typecheck` script. Your editor's TypeScript service is not configured for this repo, so
trust `npm run typecheck`, not the squiggles.

Run all three before handing work back.

### Known-red baseline

The repo does **not** start green. As of `d6f6acd`, on a clean checkout of HEAD:

- `npm test` → exit 1. 471/472 pass. The one failure is
  `issue-as-prd-validation.test.mts:96` — *"readiness drop or failure becomes
  parent_failure"*: `runAggregateValidation` returns `repaired` where the test expects
  `parent_failure`.
- `npm run typecheck` → exit 2. One error: `issue-as-prd-children.mts(66,9)` TS2322,
  `GitHubIssueRecord | null` not assignable to `GitHubIssueRecord | undefined`.
- `npm run build` → exit 0, clean.

Do not report these as regressions you caused, and do not "fix" them as a drive-by unless
that is the task. If you need to re-baseline, check HEAD out cleanly rather than stashing
someone's work:

```bash
git worktree add /tmp/head-check HEAD --detach
ln -s "$PWD/node_modules" /tmp/head-check/node_modules
(cd /tmp/head-check && npm test; npm run typecheck)
git worktree remove --force /tmp/head-check
```

## Repository shape

Flat root by design — every module is a top-level `.mts` file, and every test sits beside
its module as `<name>.test.mts`. There are no `src/`, `lib/`, or `index` files.

```
run-*.mts                  loop entrypoints (versioned; three are live)
tui-*.mts                  Companion TUI: contract, emitter, view derivation, renderer
<feature>.mts              shared modules, grouped by filename prefix
<feature>.test.mts         its tests
*-prompt-prd.md            agent prompts (system + user), literal-asserted by tests
*-prompt.test.mts          the literal assertions
docs/prd/                  problem statements (numbered)
docs/plans/                dated implementation plans
docs/adr/                  numbered decision records — behavioral invariants live here
docs/*.md                  operator runbooks + the docs added alongside this file
CONTEXT.md                 ubiquitous language; the naming authority for this domain
metrics.py, metrics_test.py  post-hoc token/outcome rollup over opencode's SQLite store
cleanup-worktrees.sh       reclaims leaked sandbox worktrees in a target repo
```

Module groups, by prefix:

| Prefix | Responsibility | Used by |
| --- | --- | --- |
| `per-branch-engine`, `per-branch-policy` | The shared coder↔reviewer↔validation engine, plus per-runner policy constants. | backlog v3/v4, prd v4/v5 |
| `issue-as-prd-*` | Pure Issue-as-PRD state machine: parent phases, queue state, children, validation, orchestration. | backlog v3/v4 |
| `backlog-v3-issue-as-prd-*` | Adapters binding that pure core to the runner (GitHub, git, labels, state comment). | backlog v3/v4 |
| `extra-review-*` | PRD-level quality gate: sessions, file-backed inputs, parsers, follow-up issues, artifacts. | backlog v3/v4, prd loops |
| `pr-review-inputs` | File-backed review inputs (diff, PR body, linked issues, metadata) for the PR review loop. | pr-review v1 |
| `custom-agent-*` | Builds the opencode agent-definition files, argv-size guard, stream rendering, worktree plumbing. | all runners |
| `tui-*` | Companion TUI: status contract, emitter, view derivation, Ink renderer. | all runners (emit) + TUI (read) |
| `github-issues`, `forgejo-tea` | Forge backends behind a shared issue-client interface. | backlog v3/v4 |
| `host-validation-*`, `host-command-env`, `aggregate-validation-worktree` | Host-side validation gate. | backlog v3/v4 |
| `loop-progress`, `agent-invocation-livelock`, `failure-diagnostics`, `metrics-recorder` | Progress fingerprints, watchdogs, crash capture, telemetry. | all runners |
| `verified-host-mutation`, `reviewer-result`, `subtask-readiness`, `coder-escalation-ladder` | Small single-purpose policies with heavy test coverage. | backlog v3/v4 |

## Non-negotiables

### 1. Runner versions are frozen; add a new one instead of editing an old one

`run-prd.mts` → `run-prd-v3` → `v4` → `v5`, and `run-backlog.mts` → `v2` → `v3` → `v4` are
snapshots, not a refactoring history. A new capability means a new numbered file, and the
old ones stay because they are still deployed on hosts and are asserted against by tests
(`run-backlog-v3-static.test.mts` reads `run-backlog-v2.mts` and `run-prd-v4.mts` to prove
older runners have **not** silently adopted Issue-as-PRD behavior).

Never delete or "clean up" an older runner. Never backport a behavior change into one. Fix
the bug in the version you were asked about; if the same bug exists in others, say so
rather than fixing them unasked.

**`run-backlog-v4.mts` is a near-copy of v3** — it differs only in the coder escalation
ladder and a lower round cap. A fix in v3's shared logic usually belongs in a shared module
so both pick it up; a fix in v3's *runner body* does not automatically reach v4. Say which
you did.

### 2. Prompt `.md` files are literal-asserted — edit both sides

Every agent prompt has a test that asserts the file's **exact full text**:

| Prompt pair | Test |
| --- | --- |
| `coder-agent-system-prompt-prd.md`, `coder-user-prompt-prd.md` | `coder-prompt.test.mts` |
| `rework-agent-system-prompt-prd.md`, `rework-user-prompt-prd.md`, `rework-prompt-prd.md` | `rework-prompt.test.mts` |
| `reviewer-agent-system-prompt-prd.md`, `reviewer-user-prompt-prd.md` | `reviewer-prompt.test.mts` |
| `code-quality-*-prompt-prd.md` | `code-quality-prompt.test.mts` |
| `two-axis-*-prompt-prd.md` | `two-axis-prompt.test.mts` |
| `decomposer-*-prompt-prd.md` | `decomposer-prompt.test.mts` |
| `initial-issue-decomposer-*`, `subtask-readiness-*` | `issue-as-prd-prompt.test.mts` |
| `pr-review-*`, `pr-standards-review-*`, `pr-spec-review-*` | `pr-review-prompt.test.mts` (path + non-empty assertions only) |

Changing a prompt without updating its `EXPECTED_*` constant fails the suite. That is
deliberate: prompts are behavior, and the test is the review surface for a prompt diff.
Update the expectation in the same commit, and keep the structural assertions
(`assert.match(/## Scope/)`, `assert.doesNotMatch(/\{\{/)`) meaningful rather than deleting
them.

Placeholders are `{{UPPER_SNAKE}}`, substituted by `renderSlimMessage`. A **system** prompt
must contain no placeholders; **user** prompts are the templated half.

Note the two path conventions — the backlog loop's core prompts resolve against the *target
repo* (`"./.sandcastle/coder-agent-system-prompt-prd.md"`), while the Issue-as-PRD and PR
review prompts resolve against the *script* (`fileURLToPath(new URL("./x.md",
import.meta.url))`). Match the surrounding style of whichever runner you are in.

### 3. The typecheck and build lists are allowlists — extend them

`npm run typecheck` names files explicitly. A new `.mts` module gets **zero** type coverage
until you add it (or a matching glob) to the `typecheck` script in `package.json`. Same for
`npm run build`.

`run-pr-review-v1.mts` and its `pr-review-*` pure modules are included explicitly. Older
runner variants remain outside the allowlist unless named by the script. If you edit an
outside runner, typecheck it manually before claiming it compiles:

```bash
npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext \
  --target es2022 --types node types/ai-hero-sandcastle.d.ts <runner>.mts
```

New test files at the root are picked up automatically by `tsx --test *.test.mts`.

### 4. Behavioral invariants are ADR-protected

These read as bugs to someone who has not read the ADRs. Do not "fix" them:

- **The loops never auto-merge and never auto-close a parent issue.** Approved work is
  delivered as a pushed branch plus a `Review` label
  ([ADR 0001](docs/adr/0001-backlog-loop-delivers-review-ready-branches.md)). Note the one
  refinement since that ADR: `run-backlog-v3` *does* open a PR at parent delivery
  (best-effort, skipped by `--no-pr`, never on a child). Opening a PR is not merging one —
  the no-merge/no-close invariant is the part that must hold.
- **The Companion TUI is strictly read-only.** The loop owns the status snapshot and the
  working-log format; the TUI only renders what it finds. Emission is side-effect-only and
  swallows its own I/O errors so observability can never alter loop control flow
  ([ADR 0002](docs/adr/0002-companion-tui-reads-loop-emitted-status-snapshot.md),
  [0003](docs/adr/0003-loop-owns-working-log-format.md)).
- **Status snapshots are namespaced per loop type** (`status-<loopType>.json`), with legacy
  `status.json` still discovered ([ADR 0004](docs/adr/0004-namespaced-tui-status-snapshots.md)).
- **Exactly one full-parent extra review round per parent**, no parallel child drain, no
  second automatic rebase. Full list:
  [docs/issue-as-prd-loop-setup.md](docs/issue-as-prd-loop-setup.md#forbidden-behavior-checklist).

If a task genuinely requires breaking one of these, write an ADR in the same change.

### 5. Every remote mutation is verified

GitHub and git writes on state-carrying paths go through `runVerifiedHostMutation`
(`verified-host-mutation.mts`): mutate → read back → verify → retry, accumulating
diagnostics. The loop treats a write it could not read back as a failure, because durable
state (labels, the parent state comment, branch checkpoints) is the only thing that survives
a restart. Do not add a bare `gh issue edit` or `git push` to a path that carries state.

### 6. Crashes are contained, never fatal

Both live loops wrap per-unit work so one bad ticket cannot kill the run: `run-backlog-v3`
catches around `processIssueAsPrdParent` and quarantines the parent for the run;
`run-pr-review-v1` catches around `processPr` and moves to the next PR. Acquisition
failures retry a bounded number of times. Preserve that shape — new work inside the
iteration body needs to be inside the guard, and every terminal path should record a
failure diagnostic (`recordLoopFailureDiagnostic`) and an outcome (`recordIssueOutcome`).

### 7. Do not run the loops

`tsx run-backlog-v3.mts …` and `tsx run-pr-review-v1.mts …` need Docker, an authenticated
`gh`, configured opencode providers, and a real target repository — and they **mutate that
repository's issues, labels, branches, and PRs**. Never launch one to "check that it works".
Verify with `npm test` / `npm run typecheck` / `npm run build`, and hand a run back to the
operator.

`npm run tui` is safe (read-only) but shows nothing outside a target repo with a live loop.
`recover-backlog-v3-issues.mts` is dry-run by default (`--apply` to execute) — still an
operator tool, not a test harness.

## Where logic goes

The house pattern is **thin runner, deep pure module**. Runners hold CLI parsing, sandbox
lifecycle, git/`gh` shelling, and the outer iteration. Every decision worth testing is
extracted into a small module that takes plain data and returns plain data.

When you add behavior:

- Put the decision in a new or existing pure module with an explicit input/output type, and
  test it directly. Prefer discriminated unions for outcomes (`{ kind: "approved" | "stuck"
  | "crashed", … }`) — that is the established shape, e.g. `PerBranchEngineOutcome`.
- Inject side effects as a `deps` object the test can fake (see `issue-as-prd-validation.mts`
  and its test's `createDeps`, or the large deps object `run-backlog-v3.mts` passes to
  `runIssueAsPrdParent`), rather than importing `child_process` into logic.
- Only the wiring goes in the runner.

Style: two-space indent, double quotes, semicolons, `.mts` extensions on **all** relative
imports (`import { x } from "./y.mts"`), `type`-only imports marked `import type`, named
exports only, top-level `await` is fine (ESM). Numeric literals use `_` separators
(`60_000`). Runners are sectioned with `// ---` banner comments — keep them.

Comments explain *why*. The existing ones carry real measurements and rationale (see the v4
escalation-ladder header in `per-branch-policy.mts`, or the state-comment ordering note in
`processIssueAsPrdParent`); match that bar rather than restating the code.

## Testing

`node:test` + `node:assert/strict`, executed through `tsx`. No test framework, no mocking
library, no snapshots.

Three kinds of test live here, and you should know which you are writing:

1. **Unit tests over pure modules** — the default and the majority. Call the function, assert
   the returned value. Fake collaborators with hand-written `deps` objects.
2. **Static source tests** (`run-backlog-v3-static.test.mts`) — read a runner's source text
   and `assert.match` on it, because the runner cannot be imported without a sandbox. This
   is how `run-backlog-v3.mts` is covered at all. They are intentionally brittle: they pin
   wiring that has broken before. If you rename a function in a runner, a static test will
   fail — update the regex, do not delete the assertion. `assert.doesNotMatch` assertions
   guard against a behavior *reappearing*; treat them as load-bearing.
3. **Prompt tests** — see non-negotiable #2.

`run-pr-review-v1.mts` has only the path assertions in `pr-review-prompt.test.mts`. If you
add logic to it, extract that logic into a module you can unit-test, or add static
assertions in the same style as `run-backlog-v3-static.test.mts`.

## Documentation map

Five document types, each with a distinct job. Put new writing in the right one:

| Location | Purpose | When to add |
| --- | --- | --- |
| `CONTEXT.md` | Ubiquitous language: every domain term, its definition, and the terms to *avoid* for it. | You introduce or rename a domain concept. Do this **first** — the vocabulary drives the naming. |
| `docs/prd/NNN-*.md` | Problem statement and solution shape for one capability. | A new capability is being specified. |
| `docs/plans/YYYY-MM-DD-*.md` | Checkbox-per-task implementation plan derived from a PRD. | Multi-session implementation work. |
| `docs/adr/NNNN-*.md` | A decision a future reader would otherwise "fix" — context, decision, consequences. | You deliberately diverge from an obvious expectation. |
| `docs/*-setup.md` | Operator runbooks: preflight, flags, terminal states, manual recovery. | Operator-visible behavior changed. |

Use `CONTEXT.md` terminology exactly in code, comments, commit messages, and docs. It
distinguishes things that are genuinely different and easy to conflate — *agent invocation
livelock* vs *issue-level no-progress*, *extra review round* vs *review round*, *sub-task
child issue* vs *follow-up PRD issue*, *agent step* vs *host step*. Getting these wrong
makes a diff unreviewable.

## Commits

Recent history mixes `feat:`/`fix:` prefixes with bare `sync` commits. Use the conventional
prefixes. Do not commit or push unless asked.

## Further reading

- [docs/architecture.md](docs/architecture.md) — how a loop iteration executes, the module
  layering, the durable-state contracts, and the observability plane.
- [docs/runners.md](docs/runners.md) — the three live entrypoints in depth (flags, flow,
  where to change what), plus the frozen catalog.
- [docs/conventions.md](docs/conventions.md) — worked recipes: change a prompt, add a TUI
  field, add a config knob, add a loop step, cut a new runner version.
- [docs/issue-as-prd-loop-setup.md](docs/issue-as-prd-loop-setup.md) — operator runbook for
  `run-backlog-v3.mts`: labels, terminal states, manual recovery.
