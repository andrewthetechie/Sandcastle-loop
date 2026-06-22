# Setting up the PRD extra-review loop in a new repo

This guide explains how to install and run `run-prd-extra-reviews.mts` — the
autonomous, PRD-driven coding loop with PRD-level quality gates — inside a fresh
target repository. It covers prerequisites, the files to copy, the repo
conventions the loop assumes, how to configure which models run, how to
configure the review steps, and how to start the loop.

---

## 1. What the loop does

`run-prd-extra-reviews.mts` is a superset of the simpler `run-prd.mts`. It drives
a GitHub-issue-backed implementation loop on top of
[`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle), running every
agent in an isolated Docker sandbox.

There are two nested loops:

1. **Normal issue loop.** It picks the lowest-numbered open GitHub issue labelled
   `prd-<NNN>`, runs a **coder** agent in a sandbox, validates the result
   host-side (typecheck / test / build), runs an inline **reviewer** agent, and —
   when the reviewer approves — merges the issue branch into the PRD base branch
   `prd-<NNN>` and closes the issue.

2. **Extra review rounds (PRD-level quality gate).** When the issue queue drains
   cleanly (no open, non-`agent-stuck` issues remain), the loop runs an *extra
   review round* against the whole completed PRD branch, comparing it to a fixed
   `--review-base` commit. Each round runs three sequential, independent sessions:
   - **Code-quality review** (`extra-code-review-prompt-prd.md`)
   - **Two-axis review** — standards + spec fit (`extra-two-axis-review-prompt-prd.md`)
   - **Issue decomposer** — turns findings into follow-up issue drafts
     (`extra-issue-decomposer-prompt-prd.md`)

   Decomposed findings are published as new `prd-<NNN>` + `ai-review-followup`
   issues (with hidden dedupe markers), and the loop resumes the normal issue
   loop to work them off. Rounds are bounded by `MAX_EXTRA_REVIEW_ROUNDS`.

The loop stops with a written `HANDOFF.md` when: the queue is clean and the
configured round budget is spent, an issue is stuck, the base branch goes red,
review output needs human review / fails to parse, or the outer iteration cap is
hit.

### Module map

| File | Responsibility |
| --- | --- |
| `run-prd-extra-reviews.mts` | Entry point. CLI parsing, normal issue iteration, branch hygiene/recovery, merge, wiring. |
| `extra-review-config.mts` | **Extra-review** models, round budget, labels, prompt-file paths, iteration caps. |
| `extra-review-main-loop.mts` | Bounded orchestrator alternating normal iterations and extra-review rounds. |
| `extra-review-sessions.mts` | Runs the three sequential review sessions in disposable sandboxes. Defines each session (model + prompt + completion signal). |
| `extra-review-inputs.mts` | Writes file-backed review inputs (diff, diff-stat, changed files, PRD body, metadata). |
| `extra-review-issues.mts` | Publishes follow-up issues; dedupe-marker handling. |
| `extra-review-artifacts.mts` | Writes per-round artifacts + `HANDOFF.md`. |
| `extra-review-queue-state.mts` | Decides continue / stop / start-extra-review from the open-issue queue. |
| `extra-review-contracts.mts` | TypeScript contracts for the review/issue JSON. |
| `extra-review-parsers.mts`, `extra-review-parser-utils.mts` | Defensive parsing of the tagged JSON the reviewers emit. |
| `extra-review-support.mts` | Barrel re-export of the above. |
| `*-prompt-prd.md` | The agent prompts (coder, rework, reviewer, and the three extra-review prompts). |

---

## 2. Prerequisites

On the host that runs the loop:

- **Node.js** (with `npx`/`tsx` available) — the loop is run with `tsx`.
- **Git** — the target repo is a git repo with a GitHub remote named `origin`.
- **GitHub CLI (`gh`)**, authenticated (`gh auth status`). All issue/PR
  operations (`issue list/view/create/close/comment/edit`, `label`,
  `pr create/merge`) run from the host using your `gh` credentials, and pushes
  use the host's git credentials.
- **A sandbox provider** — this loop is wired to **Docker**
  (`@ai-hero/sandcastle/sandboxes/docker`). Docker Desktop or a Docker daemon
  must be running.
- **opencode**, installed and configured. The agents run via
  `sandcastle.opencode(<model>)`, and the host opencode config is bind-mounted
  into each sandbox (see [§5](#5-configuring-which-models-to-use)).
- **`@ai-hero/sandcastle`** installed in the target repo
  (`npm install --save-dev @ai-hero/sandcastle`).

> The base `@ai-hero/sandcastle` quickstart wires `claudeCode` +
> `ANTHROPIC_API_KEY`. This loop instead uses **opencode**, so configure opencode
> rather than (or in addition to) Claude.

---

## 3. File layout in the target repo

Sandcastle's convention is to keep loop scripts and prompts under `.sandcastle/`.
The orchestration `.mts` files import each other with relative paths and the code
references prompts as `./.sandcastle/<name>.md`, so **all** of the following must
live together in `.sandcastle/` at the repo root.

1. Scaffold sandcastle once (creates `.sandcastle/` with a `Dockerfile`,
   `.env.example`, etc.):

```bash
npm install --save-dev @ai-hero/sandcastle
npx sandcastle init
```

2. Copy the loop files into `.sandcastle/`:

```text
.sandcastle/
  run-prd-extra-reviews.mts          # entry point
  run-prd.mts                        # optional: simpler loop without extra reviews
  extra-review-config.mts
  extra-review-main-loop.mts
  extra-review-sessions.mts
  extra-review-inputs.mts
  extra-review-issues.mts
  extra-review-artifacts.mts
  extra-review-queue-state.mts
  extra-review-contracts.mts
  extra-review-parsers.mts
  extra-review-parser-utils.mts
  extra-review-support.mts

  implement-prompt-prd.md            # coder, first attempt
  rework-prompt-prd.md               # coder, subsequent rounds
  review-prompt-prd.md               # inline per-issue reviewer
  extra-code-review-prompt-prd.md    # extra-review session 1
  extra-two-axis-review-prompt-prd.md# extra-review session 2
  extra-issue-decomposer-prompt-prd.md# extra-review session 3

  Dockerfile                         # from `sandcastle init`; the sandbox image
```

3. The loop writes run artifacts to `.sandcastle/extra-review-runs/` — add that
   to `.gitignore` (the `sandcastle init` `.gitignore` already ignores `.env.*`).

> The `.test.mts` files are unit tests for the helper modules. They are useful
> for verifying edits but are not required at runtime; keep them if you want to
> run `vitest`.

---

## 4. Repo conventions the loop assumes

These are not configurable via flags — they are baked into the constants and must
match your repo layout.

- **PRD file**: one Markdown file per PRD at `docs/prd/<NNN>-*.md`, where `<NNN>`
  is the zero-padded PRD number (e.g. `docs/prd/001-extra-review.md`). Exactly one
  file must match `docs/prd/<NNN>-*.md`. The PRD's first `# Heading` becomes the
  PRD title. (`PRD_DIR` in `run-prd-extra-reviews.mts`.)
- **Label + branch naming**: `LABEL_PREFIX = "prd"` produces the issue label and
  base branch `prd-<NNN>`. Each issue gets a child branch
  `prd-<NNN>-issue-<issue#>`. Extra-review sessions use disposable
  `prd-<NNN>-extra-review-...` branches.
- **Issue queue**: open issues labelled `prd-<NNN>` are the work queue, processed
  lowest-number-first. Issues labelled `agent-stuck` (`STUCK_LABEL`) are skipped
  and cause the loop to stop for human attention.
- **Host git state**: before each iteration the host must be on branch
  `prd-<NNN>` with **no uncommitted tracked changes**; the loop fast-forwards the
  local branch to `origin/prd-<NNN>` and validates it. It refuses to run against a
  dirty or wrong base.
- **`origin/prd-<NNN>`** is the fork point for every sandbox. If it does not exist
  yet, the loop creates it from the current `HEAD` and pushes it.

---

## 5. Configuring which models to use

Agents run through opencode, so every model value is an **opencode
`provider/model` identifier** (e.g. `zai-coding-plan/glm-5.1`,
`strix/qwen3.6-35b-a3b-8bit`). Configure those providers in your host opencode
config first; the loop bind-mounts it into every sandbox:

- `~/.config/opencode` → mounted **read-only** (provider + auth config)
- `~/.local/share/opencode` → mounted **writable** (session state, SQLite, tokens)

Then set the model strings in two places.

### Normal issue loop (coder + inline reviewer)

In `run-prd-extra-reviews.mts`, near the top:

```ts
const CODER_MODEL = "strix/qwen3.6-35b-a3b-8bit";
const REVIEWER_MODEL = "zai-coding-plan/glm-5.1";
```

- `CODER_MODEL` — implements each issue (often a cheaper/local model).
- `REVIEWER_MODEL` — the inline per-issue integration reviewer.

### Extra-review sessions (PRD-level quality gate)

In `extra-review-config.mts`:

```ts
export const EXTRA_CODE_REVIEW_MODEL = "zai-coding-plan/glm-5.1";
export const EXTRA_TWO_AXIS_REVIEW_MODEL = "zai-coding-plan/glm-5.1";
export const EXTRA_ISSUE_DECOMPOSER_MODEL = "zai-coding-plan/glm-5.1";
```

- `EXTRA_CODE_REVIEW_MODEL` — maintainability / code-quality gate.
- `EXTRA_TWO_AXIS_REVIEW_MODEL` — standards + spec-fit gate.
- `EXTRA_ISSUE_DECOMPOSER_MODEL` — turns findings into follow-up issue drafts.

Use a stronger model for the reviewers/decomposer than for the coder: the coder
is expected to be cheap and is gated by validation + review, while the reviewers
are the quality backstop.

---

## 6. Configuring the review steps

There are two independent review layers: the **per-issue validation + inline
review** (normal loop) and the **PRD-level extra-review round**.

### 6a. Host-side validation gate (normal loop)

After each coder commit and before the reviewer, the host runs these commands in
the sandbox worktree; the first failure is fed back to the coder as the next
round's feedback. The same gate also runs against `origin/prd-<NNN>` before each
iteration to ensure the base is green. Edit in `run-prd-extra-reviews.mts`:

```ts
const VALIDATION_COMMANDS: string[] = [
  "npm run typecheck",
  "npm run test",
  "npm run build",
];
```

Replace these with your project's commands (e.g. `uv run pytest`,
`cargo test`, `go build ./...`). An **empty array disables** the gate. Also set
what runs once the sandbox is ready (e.g. install deps):

```ts
const SANDBOX_READY_COMMANDS: string[] = ["npm install"];
```

Other normal-loop knobs in the same file:

| Constant | Meaning |
| --- | --- |
| `MAX_REVIEW_ROUNDS` (10) | Coder↔reviewer attempts per issue before it is marked `agent-stuck`. |
| `MAX_ITERATIONS` (50) | Outer-loop safety cap on issues processed. |
| `CODER_MAX_ITERATIONS` (30) | Agent steps per coder invocation. |
| `REVIEW_DIFF_MAX_BYTES` (60000) | Hard cap on the reviewer diff (keeps it under the argv limit). |
| `REVIEW_DIFF_EXCLUDES` | Pathspecs excluded from review diffs (lockfiles, etc.). |
| `PR_MERGE_STRATEGY` (`--squash`) | `gh pr merge` strategy; use one your branch protection allows. |
| `COPY_TO_WORKTREE` | Host files copied into each worktree before the sandbox starts. |
| `DEFAULT_IDLE_TIMEOUT_SECONDS` (1800) | Fail the run if the agent's stdout is silent this long. Override with `--idle-timeout`. |

The inline reviewer prompt is `review-prompt-prd.md`; the coder prompts are
`implement-prompt-prd.md` (first attempt) and `rework-prompt-prd.md` (rounds 2+).
Edit those Markdown files to change review/coding behavior for your stack.

### 6b. Extra-review round configuration

In `extra-review-config.mts`:

```ts
export const MAX_EXTRA_REVIEW_ROUNDS = 2;
export const REVIEW_FOLLOW_UP_LABEL = "ai-review-followup";

export const EXTRA_REVIEWER_MAX_ITERATIONS = 20;
export const EXTRA_DECOMPOSER_MAX_ITERATIONS = 15;

export const EXTRA_CODE_REVIEW_PROMPT_FILE =
  "./.sandcastle/extra-code-review-prompt-prd.md";
export const EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE =
  "./.sandcastle/extra-two-axis-review-prompt-prd.md";
export const EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE =
  "./.sandcastle/extra-issue-decomposer-prompt-prd.md";
```

- `MAX_EXTRA_REVIEW_ROUNDS` — how many PRD-level gate cycles may run per loop
  invocation. Each round that creates follow-up issues is followed by the normal
  loop working those issues, then potentially another round.
- `REVIEW_FOLLOW_UP_LABEL` — applied (alongside `prd-<NNN>`) to every generated
  follow-up issue.
- `EXTRA_REVIEWER_MAX_ITERATIONS` / `EXTRA_DECOMPOSER_MAX_ITERATIONS` — agent step
  budgets for the review and decomposer sessions.
- The `*_PROMPT_FILE` paths point at the three prompt files; keep them under
  `.sandcastle/`.

### 6c. The extra-review sessions

The three sessions are defined in `extra-review-sessions.mts` as
`ExtraReviewSessionDefinition` objects (`EXTRA_CODE_REVIEW_SESSION`,
`EXTRA_TWO_AXIS_REVIEW_SESSION`, `EXTRA_ISSUE_DECOMPOSER_SESSION`). Each binds a
model, a prompt file, a `maxIterations`, and a `completionSignal` — the closing
tag (`</extra_review>` / `</followup_issues>`) that stops the agent as soon as it
emits its JSON block. Edit a session there if you want to change the model
mapping, iteration budget, or completion behavior beyond what the config exports
expose.

The reviewers receive **file-backed inputs** (PRD body, metadata, changed-files
list, diff-stat, full diff) rather than inline prompt text. The decomposer
receives the two parsed review outputs but deliberately **not** the raw diff. The
prompts instruct the agents to read those files from paths passed as prompt args.

To change what each reviewer looks for, edit the corresponding prompt `.md`. The
output schema is contractually enforced by `extra-review-parsers.mts`
/`extra-review-contracts.mts`; if you change a prompt's JSON shape you must update
those parsers too, or the round will stop as `parse_failure`.

---

## 7. Running the loop

Preconditions checklist:

- Docker is running; `gh auth status` is green; opencode providers are configured.
- The repo has `docs/prd/<NNN>-*.md` and open issues labelled `prd-<NNN>`.
- The host repo is checked out on branch `prd-<NNN>` with a clean tracked tree.
- You know the **review base** — the fixed commit-ish the PRD branched from (the
  point every extra-review round compares against), e.g. the merge-base with
  `main`.

Run from the repo root:

```bash
npx tsx .sandcastle/run-prd-extra-reviews.mts \
  --prd <N> \
  --review-base <commit-ish> \
  [--idle-timeout <seconds>]
```

- `--prd <N>` *(required)* — positive integer PRD number; resolves to label/branch
  `prd-<NNN>` and PRD file `docs/prd/<NNN>-*.md`.
- `--review-base <commit-ish>` *(required)* — must resolve to a commit
  (`git rev-parse --verify <ref>^{commit}`). Branch, tag, or SHA all work.
- `--idle-timeout <seconds>` *(optional)* — overrides
  `DEFAULT_IDLE_TIMEOUT_SECONDS`. Raise it for slow local models that buffer
  stdout during long generations.

Example:

```bash
npx tsx .sandcastle/run-prd-extra-reviews.mts --prd 1 --review-base main
```

### v3 runner with agent-invocation livelock guard

Use `run-prd-v3.mts` when you want the custom-agent shared-cache loop (the
same capabilities as `run-prd-extra-review-custom-agents-shared-cache-v2.mts`)
plus an **agent invocation livelock** watchdog on coder and rework runs. It
accepts the **same CLI flags** as v2:

```bash
npx tsx run-prd-v3.mts \
  --prd <N> \
  --review-base <commit-ish> \
  [--idle-timeout <seconds>]
```

- `--prd <N>` and `--review-base <commit-ish>` are required; `--idle-timeout`
  is optional (same semantics as above).

At a high level, the livelock guard watches normalized tool calls during a
single agent run. If the agent makes **five consecutive identical tool calls**
while the worktree snapshot (commit + porcelain status) is unchanged, the run
is aborted with a structured `agent_invocation_livelock` reason. This is
distinct from idle timeout, crash, or the separate issue-level no-progress
detector (identical review diffs / validation failures across rounds).

Recovery behavior:

- **Round-1 coder livelock** — converted to synthetic feedback and the loop
  escalates to the **rework** agent on the next round (one recovery chance).
- **Rework livelock** — terminal for that issue: the issue is marked
  `agent-stuck` with outcome `stuck_livelock` and is not retried automatically.

Example:

```bash
npx tsx run-prd-v3.mts --prd 3 --review-base main
```

To run the simpler loop **without** PRD-level extra reviews, use
`run-prd.mts` instead (same flags minus `--review-base`):

```bash
npx tsx .sandcastle/run-prd.mts --prd 1
```

### What happens during a run

1. The loop ensures `origin/prd-<NNN>` exists, validates the base is green, then
   picks the lowest open `prd-<NNN>` issue.
2. It creates a Docker sandbox on a `prd-<NNN>-issue-<#>` branch, runs the coder,
   validates host-side, then runs the reviewer — up to `MAX_REVIEW_ROUNDS` times.
3. On approval it opens and merges a PR into `prd-<NNN>`, closes the issue, and
   refreshes `origin/prd-<NNN>`.
4. When no eligible issues remain and the queue is clean, it runs an extra-review
   round, publishes any follow-up issues, and resumes the normal loop.
5. It stops when the round budget is exhausted (with the queue clean), an issue is
   stuck, the base goes red, or a safety cap is hit — always writing a
   `HANDOFF.md`.

---

## 8. Artifacts and troubleshooting

- **Run artifacts** are written under
  `.sandcastle/extra-review-runs/prd-<NNN>/<round-id>/`, including the review
  inputs, each session's raw + parsed output, `created-issues.json`,
  `skipped-duplicate-issues.json`, and a human-readable `HANDOFF.md`. Start with
  `HANDOFF.md` to see why a round stopped.
- **Stuck issues** (`agent-stuck`) carry a comment with the last reviewer/host
  feedback. Fix or close them, remove the label, then re-run the loop. Issues
  stopped by the v3 livelock guard record outcome `stuck_livelock` and include
  which tool call repeated.
- **`parse_failure`** means a reviewer/decomposer emitted malformed or
  off-schema JSON. Inspect the `*.raw.txt` artifact; tighten the prompt or fix the
  matching parser.
- **`needs_human_review`** means the reviewers/decomposer flagged something they
  could not safely resolve — read the handoff's "Needs Human Review" section.
- **Base branch red** halts the loop immediately: repair `prd-<NNN>` (make
  `VALIDATION_COMMANDS` pass on it) before re-running.
- **Duplicate follow-ups** are skipped via a hidden marker embedded in each
  generated issue body, so re-running a round will not re-file the same finding.
