# Loop Speedup (v2) — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green (typecheck + tests) before moving on. Implement TDD where a test step is given.

**Goal:** Cut wasted cycles in the PRD loop by (1) instrumenting the host validation gate so its time is measured, (2) skipping the redundant post-merge base re-validation via tree-hash equivalence, and (4) stopping the per-issue review loop early when it stops making progress — all wired into a new entry file `run-prd-extra-review-custom-agents-shared-cache-v2.mts`.

**Architecture:** `run-prd-extra-review-custom-agents-shared-cache-v2.mts` is a fork of `run-prd-extra-review-custom-agents-shared-cache.mts`. Shared, additive changes land in `metrics-recorder.mts` (two new record writers) and `metrics.py` (two new rollups); these leave the v1 entry file working unchanged. A new pure module `loop-progress.mts` holds the no-progress detector so it is unit-testable (the entry files themselves have no unit tests). The v2 entry file wires validation-gate timing, a tree-keyed base-validation skip, the no-progress bail, a lowered round cap, and a per-issue outcome metric.

**Tech Stack:** TypeScript `.mts` (Node ESM), `@ai-hero/sandcastle`, `node:test` + `node:assert/strict`, `node:crypto`, `node:child_process` (`spawnSync`/`execFileSync`), Python 3 (`metrics.py`), `gh`/`git` CLIs.

---

## Scope

**In scope (from the review):**
- **Item 1** — Instrument the validation gate (per-command timing → `runs.jsonl`; surfaced in `metrics.py`).
- **Item 2** — Eliminate the redundant post-merge base re-validation by keying the "already green" check on the **tree hash** instead of the commit SHA.
- **Item 4** — Stop burning local-LLM rounds on hopeless issues: a no-progress detector (identical review diff / identical validation failure), a lowered `MAX_REVIEW_ROUNDS`, and a per-issue outcome metric.

**Explicitly out of scope** (separate future work): Item 3 (affected-only tests / drop `build` / cheapest-first ordering), Item 5 (GPU/CPU overlap, parallel extra-review sessions).

---

## Design decisions

- **New entry file, fork not refactor.** Matches the existing `run-prd-*` family (each is a standalone entry). v1 stays byte-for-byte; v2 carries all behavior changes.
- **Shared modules change additively.** `metrics-recorder.mts` gains new exports; `metrics.py` gains new sections gated on record presence. v1 emits none of the new records, so its `metrics.py` output is unchanged.
- **Validation timing is host-side, synchronous.** The gate runs `spawnSync`; we wrap each command with `Date.now()` and write a `sandcastle_validation_run` record per command. We do **not** reuse `recordMeasuredAgentRun` (that wraps an async LLM promise).
- **Base-validation skip keys on tree hash.** After a squash-merge of a branch that was rebased onto the current base, the new base commit's **tree** equals the validated issue-branch tree. So we remember the validated tree hash and skip base re-validation when `origin/<prd>`'s tree already matches. Caveat: relies on the standard rebase-then-squash path (the loop's `approveAndMerge` already verifies the base did not advance before merging); any divergence simply falls through to a normal (safe) re-validation.
- **No-progress detector is two cheap signals.** (a) identical **review diff** across consecutive rounds (coder reproduced the same net change), and (b) identical **validation failure signature** (`<command> :: <summarized first error>`) across consecutive rounds. Either tripping its stall limit bails the issue to the existing stuck path before the next expensive coder round.
- **Stall limits are constants, tunable.** `DIFF_STALL_LIMIT = 1` (bail on the 2nd identical diff), `VALIDATION_STALL_LIMIT = 2` (bail on the 3rd identical failure — a little lenient for transient infra hiccups).
- **`MAX_REVIEW_ROUNDS` lowered 10 → 5** for the local-model tier; the no-progress bail usually triggers earlier.
- **Per-issue outcome metric.** One `sandcastle_issue_outcome` record per issue (`merged` / `already_satisfied` / `stuck_rounds_exhausted` / `stuck_no_progress` / `blocked` / `crashed`, plus `rounds_used`) so `metrics.py` can show rounds-per-issue and where rounds are wasted.

See `CONTEXT.md` for the canonical loop glossary.

---

## File structure

**Modify (shared, additive — both v1 and v2 benefit):**
- `metrics-recorder.mts` — extract a private `appendMetricRecord`; add `recordValidationRun` / `buildValidationRunRecord` and `recordIssueOutcome` / `buildIssueOutcomeRecord`.
- `metrics.py` — add a generic record loader, a validation-time rollup (per issue / per PRD / per command), and an issue-outcome table.

**Create:**
- `loop-progress.mts` — pure no-progress detector (`initialNoProgressState`, `observeReviewDiff`, `observeValidationFailure`).
- `loop-progress.test.mts` — unit tests for the detector.
- `metrics-recorder.test.mts` — unit tests for the two new record builders.
- `run-prd-extra-review-custom-agents-shared-cache-v2.mts` — new entry file (fork of the shared-cache loop) wiring items 1, 2, 4.

---

## Task 1: Add validation + issue-outcome record writers

**Files:**
- Modify: `metrics-recorder.mts` (extract append helper at `metrics-recorder.mts:89-95`; append new exports at end of file)
- Test: `metrics-recorder.test.mts` (create)

- [ ] **Step 1: Extract the shared append helper**

In `metrics-recorder.mts`, replace the tail of `writeMetricRecord` (the `metricsDir` + `appendFileSync` block, currently `metrics-recorder.mts:89-95`) with a call to a new private helper, and define that helper. The end of `writeMetricRecord` becomes:

```ts
  appendMetricRecord(record);
}

function appendMetricRecord(record: Record<string, unknown>): void {
  const metricsDir = join(process.cwd(), ".sandcastle", "metrics");
  mkdirSync(metricsDir, { recursive: true });
  appendFileSync(
    join(metricsDir, "runs.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}
```

> The existing `record` object built in `writeMetricRecord` is unchanged; only its final write goes through `appendMetricRecord`. The `appendFileSync`/`mkdirSync`/`join` imports already exist at the top of the file.

- [ ] **Step 2: Append the validation-run writer**

Add to the end of `metrics-recorder.mts`:

```ts
export interface ValidationRunMetadata {
  prd: number | string;
  issue?: number;
  round: number | string;
  gate: "issue" | "base";
  command: string;
  commandIndex: number;
}

export interface ValidationRunResult {
  startedMs: number;
  endedMs: number;
  status: "success" | "failed";
  exitCode: number | null;
}

export function buildValidationRunRecord(
  metadata: ValidationRunMetadata,
  result: ValidationRunResult,
): Record<string, unknown> {
  return {
    kind: "sandcastle_validation_run",
    schema_version: 1,
    prd: metadata.prd,
    issue: metadata.issue,
    round: metadata.round,
    gate: metadata.gate,
    command: metadata.command,
    command_index: metadata.commandIndex,
    status: result.status,
    exit_code: result.exitCode,
    started_ms: result.startedMs,
    ended_ms: result.endedMs,
    elapsed_ms: result.endedMs - result.startedMs,
    started_at: new Date(result.startedMs).toISOString(),
    ended_at: new Date(result.endedMs).toISOString(),
  };
}

export function recordValidationRun(
  metadata: ValidationRunMetadata,
  result: ValidationRunResult,
): void {
  appendMetricRecord(buildValidationRunRecord(metadata, result));
}
```

- [ ] **Step 3: Append the issue-outcome writer**

Add to the end of `metrics-recorder.mts`:

```ts
export interface IssueOutcomeMetadata {
  prd: number | string;
  issue: number;
  outcome:
    | "merged"
    | "already_satisfied"
    | "stuck_rounds_exhausted"
    | "stuck_no_progress"
    | "blocked"
    | "crashed";
  roundsUsed: number;
}

export function buildIssueOutcomeRecord(
  metadata: IssueOutcomeMetadata,
): Record<string, unknown> {
  return {
    kind: "sandcastle_issue_outcome",
    schema_version: 1,
    prd: metadata.prd,
    issue: metadata.issue,
    outcome: metadata.outcome,
    rounds_used: metadata.roundsUsed,
    recorded_at: new Date().toISOString(),
  };
}

export function recordIssueOutcome(metadata: IssueOutcomeMetadata): void {
  appendMetricRecord(buildIssueOutcomeRecord(metadata));
}
```

- [ ] **Step 4: Write the tests**

Create `metrics-recorder.test.mts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIssueOutcomeRecord,
  buildValidationRunRecord,
} from "./metrics-recorder.mts";

test("buildValidationRunRecord computes elapsed and tags the kind", () => {
  const record = buildValidationRunRecord(
    {
      prd: 2,
      issue: 47,
      round: 3,
      gate: "issue",
      command: "npm run test",
      commandIndex: 1,
    },
    { startedMs: 1_000, endedMs: 4_500, status: "failed", exitCode: 1 },
  );
  assert.equal(record.kind, "sandcastle_validation_run");
  assert.equal(record.schema_version, 1);
  assert.equal(record.prd, 2);
  assert.equal(record.issue, 47);
  assert.equal(record.gate, "issue");
  assert.equal(record.command, "npm run test");
  assert.equal(record.command_index, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.exit_code, 1);
  assert.equal(record.elapsed_ms, 3_500);
});

test("buildValidationRunRecord allows a base gate with no issue", () => {
  const record = buildValidationRunRecord(
    {
      prd: 2,
      round: "base",
      gate: "base",
      command: "npm run build",
      commandIndex: 2,
    },
    { startedMs: 0, endedMs: 10, status: "success", exitCode: 0 },
  );
  assert.equal(record.issue, undefined);
  assert.equal(record.gate, "base");
  assert.equal(record.elapsed_ms, 10);
});

test("buildIssueOutcomeRecord records the terminal outcome and rounds", () => {
  const record = buildIssueOutcomeRecord({
    prd: 2,
    issue: 47,
    outcome: "stuck_no_progress",
    roundsUsed: 3,
  });
  assert.equal(record.kind, "sandcastle_issue_outcome");
  assert.equal(record.outcome, "stuck_no_progress");
  assert.equal(record.rounds_used, 3);
  assert.equal(record.issue, 47);
});
```

- [ ] **Step 5: Run the tests**

Run: `npm run test`
Expected: the three new tests PASS; all existing tests still PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add metrics-recorder.mts metrics-recorder.test.mts
git commit -m "feat(metrics): add validation-run and issue-outcome record writers"
```

---

## Task 2: Pure no-progress detector module

**Files:**
- Create: `loop-progress.mts`
- Create: `loop-progress.test.mts`

- [ ] **Step 1: Write the failing test**

Create `loop-progress.test.mts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialNoProgressState,
  observeReviewDiff,
  observeValidationFailure,
} from "./loop-progress.mts";

test("first review diff seeds state without stalling", () => {
  const r = observeReviewDiff(initialNoProgressState(), "diff-a", 1);
  assert.equal(r.stalled, false);
  assert.equal(r.state.diffStreak, 0);
});

test("identical review diff stalls at the limit", () => {
  let state = initialNoProgressState();
  ({ state } = observeReviewDiff(state, "diff-a", 1)); // seed
  const r = observeReviewDiff(state, "diff-a", 1); // repeat
  assert.equal(r.stalled, true);
  assert.equal(r.state.diffStreak, 1);
});

test("a changed review diff resets the streak", () => {
  let state = initialNoProgressState();
  ({ state } = observeReviewDiff(state, "diff-a", 1));
  ({ state } = observeReviewDiff(state, "diff-a", 1)); // would stall, but caller bails
  const r = observeReviewDiff(state, "diff-b", 1); // progress
  assert.equal(r.stalled, false);
  assert.equal(r.state.diffStreak, 0);
});

test("validation failure stalls only after the limit", () => {
  let state = initialNoProgressState();
  let r = observeValidationFailure(state, "tsc :: error TS2345", 2);
  state = r.state;
  assert.equal(r.stalled, false); // seed
  r = observeValidationFailure(state, "tsc :: error TS2345", 2);
  state = r.state;
  assert.equal(r.stalled, false); // streak 1, limit 2
  r = observeValidationFailure(state, "tsc :: error TS2345", 2);
  assert.equal(r.stalled, true); // streak 2 >= 2
});

test("a different validation signature resets the streak", () => {
  let state = initialNoProgressState();
  ({ state } = observeValidationFailure(state, "sig-a", 2));
  ({ state } = observeValidationFailure(state, "sig-a", 2));
  const r = observeValidationFailure(state, "sig-b", 2);
  assert.equal(r.stalled, false);
  assert.equal(r.state.validationStreak, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test`
Expected: FAIL — `Cannot find module './loop-progress.mts'`.

- [ ] **Step 3: Implement the module**

Create `loop-progress.mts`:

```ts
import { createHash } from "node:crypto";

export interface NoProgressState {
  lastDiffHash: string | null;
  diffStreak: number;
  lastValidationSignature: string | null;
  validationStreak: number;
}

export function initialNoProgressState(): NoProgressState {
  return {
    lastDiffHash: null,
    diffStreak: 0,
    lastValidationSignature: null,
    validationStreak: 0,
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Observe the review diff for a round. Stalls when the coder reproduces an
 * identical net diff `stallLimit` times in a row (i.e. it is not responding to
 * feedback). Returns the next state and whether to bail.
 */
export function observeReviewDiff(
  state: NoProgressState,
  diff: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  const diffHash = sha1(diff);
  if (state.lastDiffHash === diffHash) {
    const diffStreak = state.diffStreak + 1;
    return { state: { ...state, diffStreak }, stalled: diffStreak >= stallLimit };
  }
  return {
    state: { ...state, lastDiffHash: diffHash, diffStreak: 0 },
    stalled: false,
  };
}

/**
 * Observe a validation failure signature for a round. Stalls when the same
 * failure recurs `stallLimit` times in a row.
 */
export function observeValidationFailure(
  state: NoProgressState,
  signature: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  if (state.lastValidationSignature === signature) {
    const validationStreak = state.validationStreak + 1;
    return {
      state: { ...state, validationStreak },
      stalled: validationStreak >= stallLimit,
    };
  }
  return {
    state: { ...state, lastValidationSignature: signature, validationStreak: 0 },
    stalled: false,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test`
Expected: PASS (all five new tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add loop-progress.mts loop-progress.test.mts
git commit -m "feat(loop): add pure no-progress detector"
```

---

## Task 3: Fork the entry file

**Files:**
- Create: `run-prd-extra-review-custom-agents-shared-cache-v2.mts` (copy of `run-prd-extra-review-custom-agents-shared-cache.mts`)

- [ ] **Step 1: Copy the base entry file**

```bash
cp run-prd-extra-review-custom-agents-shared-cache.mts run-prd-extra-review-custom-agents-shared-cache-v2.mts
```

- [ ] **Step 2: Update the metrics-recorder import**

In the new file, replace the metrics-recorder import (`run-prd-...-v2.mts`, the line `import { recordMeasuredAgentRun } from "./metrics-recorder.mts";`) with:

```ts
import {
  recordIssueOutcome,
  recordMeasuredAgentRun,
  recordValidationRun,
} from "./metrics-recorder.mts";
```

- [ ] **Step 3: Add the loop-progress import**

Add directly below the metrics-recorder import:

```ts
import {
  initialNoProgressState,
  observeReviewDiff,
  observeValidationFailure,
  type NoProgressState,
} from "./loop-progress.mts";
```

- [ ] **Step 4: Update the USAGE string**

Replace the `USAGE` constant value so the help text names the new file:

```ts
const USAGE =
  "Usage: tsx run-prd-extra-review-custom-agents-shared-cache-v2.mts --prd <N> --review-base <commit-ish> [--idle-timeout <seconds>]";
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (imports are unused until later tasks — that is fine for `.mts` under the project's `tsc` config; if the config flags unused imports, proceed to Task 4 which uses them and re-run there).

- [ ] **Step 6: Commit**

```bash
git add run-prd-extra-review-custom-agents-shared-cache-v2.mts
git commit -m "chore: fork shared-cache loop entry as v2"
```

---

## Task 4: Item 1 — instrument the validation gate

**Files:**
- Modify: `run-prd-extra-review-custom-agents-shared-cache-v2.mts` (`GateResult` type; `runValidationGate`; the two call sites)

- [ ] **Step 1: Extend `GateResult` with a failure signature**

Replace the `GateResult` type:

```ts
type GateResult =
  | { ok: true }
  | { ok: false; feedback: string; signature: string };
```

- [ ] **Step 2: Time each command and record it**

Replace the whole `runValidationGate` function body with the timed, context-aware version:

```ts
function runValidationGate(
  worktreePath: string,
  context: {
    prd: number;
    issue?: number;
    round: number | string;
    gate: "issue" | "base";
  },
): GateResult {
  for (const [index, cmd] of VALIDATION_COMMANDS.entries()) {
    console.log(`  $ ${cmd}`);
    const startedMs = Date.now();
    const result = spawnSync(cmd, {
      shell: true,
      cwd: worktreePath,
      encoding: "utf8",
      env: HOST_COMMAND_ENV,
    });
    const endedMs = Date.now();
    recordValidationRun(
      {
        prd: context.prd,
        issue: context.issue,
        round: context.round,
        gate: context.gate,
        command: cmd,
        commandIndex: index,
      },
      {
        startedMs,
        endedMs,
        status: result.status === 0 ? "success" : "failed",
        exitCode: result.status,
      },
    );
    const elapsedS = ((endedMs - startedMs) / 1000).toFixed(1);
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      const summary = summarizeFailureOutput(output);
      console.log(`    ✗ failed (exit ${result.status}) in ${elapsedS}s: ${summary}`);
      return {
        ok: false,
        signature: `${cmd} :: ${summary}`,
        feedback: [
          "## Validation failed",
          "",
          "Command:",
          "```",
          cmd,
          "```",
          "",
          "Output (truncated to last 4000 chars):",
          "```",
          output.slice(-4000),
          "```",
          "",
          "Fix the failures and commit again.",
        ].join("\n"),
      };
    }
    console.log(`    ✓ ${elapsedS}s`);
  }
  return { ok: true };
}
```

> `summarizeFailureOutput` already exists in the file and is reused for the stable failure signature in Item 4.

- [ ] **Step 3: Pass context at the base-validation call site**

In `ensureBaseBranchIsGreen`, change the gate call (currently `const gate = runValidationGate(process.cwd());`) to:

```ts
  const gate = runValidationGate(process.cwd(), {
    prd: prdNumber,
    round: "base",
    gate: "base",
  });
```

> This call site is finalized in Task 5; passing the context now keeps the file compiling between tasks.

- [ ] **Step 4: Pass context at the per-round call site**

In `processNormalIssueIteration`, change the per-round gate call (currently `const gate = runValidationGate(sandbox.worktreePath);`) to:

```ts
      const gate = runValidationGate(sandbox.worktreePath, {
        prd: prdNumber,
        issue: issue.number,
        round,
        gate: "issue",
      });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add run-prd-extra-review-custom-agents-shared-cache-v2.mts
git commit -m "feat(v2): instrument the validation gate with per-command timing"
```

---

## Task 5: Item 2 — tree-keyed base-validation skip

**Files:**
- Modify: `run-prd-extra-review-custom-agents-shared-cache-v2.mts` (add `treeShaOf`; rewrite `ensureBaseBranchIsGreen`; rename loop state; capture the approved tree; set it after merge; update `validateBaseForExtraReview`)

- [ ] **Step 1: Add a tree-hash helper**

Add `treeShaOf` next to the other git helpers (near `gitSpawn`):

```ts
function treeShaOf(ref: string, cwd?: string): string {
  return git(["rev-parse", `${ref}^{tree}`], cwd).trim();
}
```

> The existing `git(...)` helper does not trim, so `.trim()` here is required.

- [ ] **Step 2: Rewrite `ensureBaseBranchIsGreen` to key on tree hash**

Replace the whole `ensureBaseBranchIsGreen` function:

```ts
function ensureBaseBranchIsGreen(lastValidatedTreeSha: string): string {
  syncLocalPrdBranchToOrigin();
  const baseTreeSha = treeShaOf(originPrdRef());
  if (baseTreeSha === lastValidatedTreeSha) {
    console.log(
      `Base ${originPrdRef()} tree ${baseTreeSha.slice(0, 7)} already validated; skipping base re-validation.`,
    );
    return baseTreeSha;
  }

  console.log(
    `Running base validation for ${originPrdRef()} (tree ${baseTreeSha.slice(0, 7)})`,
  );
  const gate = runValidationGate(process.cwd(), {
    prd: prdNumber,
    round: "base",
    gate: "base",
  });
  if (!gate.ok) {
    throw new Error(
      `Base branch ${originPrdRef()} is red. Stop the loop and repair ${prdBranch} before processing more issues.\n\n${gate.feedback}`,
    );
  }

  return baseTreeSha;
}
```

> `syncLocalPrdBranchToOrigin()` is still called for its fast-forward + dirty-base guards; we now ignore its return value and compare trees instead of commit SHAs.

- [ ] **Step 3: Rename the module-level validation-state variable**

Change the declaration (currently `let lastValidatedBaseSha = "";`) to:

```ts
let lastValidatedTreeSha = "";
```

- [ ] **Step 4: Update `validateBaseForExtraReview`**

In `validateBaseForExtraReview`, change the assignment to use the renamed variable:

```ts
    lastValidatedTreeSha = ensureBaseBranchIsGreen(lastValidatedTreeSha);
```

- [ ] **Step 5: Add an issue-scope holder for the approved tree**

In `processNormalIssueIteration`, alongside the other per-issue mutable state (next to `let reviewedBaseSha = "";`), add:

```ts
  let approvedTreeSha = "";
```

- [ ] **Step 6: Capture the validated tree at approval**

In the reviewer "approved" branch, where the base has not advanced, capture the tree right where `reviewedBaseSha` is set:

```ts
        reviewedBaseSha = reviewContext.baseSha;
        approvedTreeSha = treeShaOf("HEAD", sandbox.worktreePath);
        approved = true;
        break;
```

- [ ] **Step 7: Prime the skip after a successful merge**

In the post-loop `approved` branch, immediately after `approveAndMerge(...)` returns successfully, set the module state:

```ts
        approveAndMerge(
          issue,
          sandbox.worktreePath,
          issueBranch,
          reviewedBaseSha,
        );
        lastValidatedTreeSha = approvedTreeSha;
        console.log(`Issue #${issue.number} merged into ${prdBranch}.`);
```

> After the squash-merge of the rebased issue branch, `origin/<prd>`'s tree equals `approvedTreeSha`, so the next iteration's `validateBaseForExtraReview` skips the full suite. If `approveAndMerge` throws (e.g. `BaseAdvancedError`), `lastValidatedTreeSha` is left unchanged and the next base validation runs normally.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `tsc` flags `syncLocalPrdBranchToOrigin`'s now-unused return, it is still a void-usable call — no change needed; the function is also used elsewhere.)

- [ ] **Step 9: Commit**

```bash
git add run-prd-extra-review-custom-agents-shared-cache-v2.mts
git commit -m "feat(v2): skip redundant base re-validation via tree-hash equivalence"
```

---

## Task 6: Item 4 — no-progress bail, lower round cap, outcome metric

**Files:**
- Modify: `run-prd-extra-review-custom-agents-shared-cache-v2.mts` (constants; per-issue loop state; top-of-round; blocked break; pre-gate diff check; validation-fail check; terminal outcome recording)

- [ ] **Step 1: Lower the round cap and add stall-limit constants**

Change the round cap (currently `const MAX_REVIEW_ROUNDS = 10;`) and add the stall limits directly below it:

```ts
const MAX_REVIEW_ROUNDS = 5; // coder<->reviewer attempts per issue (lowered from 10)
const DIFF_STALL_LIMIT = 1; // bail after this many identical review diffs in a row
const VALIDATION_STALL_LIMIT = 2; // bail after this many identical validation failures in a row
```

- [ ] **Step 2: Add per-issue progress + outcome state**

In `processNormalIssueIteration`, alongside the other per-issue state (next to `let approvedTreeSha = "";` from Task 5), add:

```ts
  let progressState: NoProgressState = initialNoProgressState();
  let roundsUsed = 0;
  let terminalReason:
    | "stuck_rounds_exhausted"
    | "stuck_no_progress"
    | "blocked" = "stuck_rounds_exhausted";
```

- [ ] **Step 3: Track the round number reached**

At the top of the round loop, right after the existing `--- Round ... ---` log, add:

```ts
      roundsUsed = round;
```

- [ ] **Step 4: Label the blocked break**

In the coder "blocked" branch, set the terminal reason before breaking:

```ts
        if (blockedMatch) {
          const reason = blockedMatch[1]!.trim();
          console.log(`  coder signaled blocked: ${reason.slice(0, 200)}`);
          lastFeedback = `Coder signaled blocked on round ${round}:\n\n${reason}`;
          terminalReason = "blocked";
          break;
        }
```

- [ ] **Step 5: Add the identical-diff no-progress check before the gate**

In `processNormalIssueIteration`, after `reviewContext` is finalized (after the diff-too-large / workflow-pollution re-checks) and immediately before the `console.log(\`  running validation gate\`)` line, insert:

```ts
      const diffProgress = observeReviewDiff(
        progressState,
        reviewContext.diff,
        DIFF_STALL_LIMIT,
      );
      progressState = diffProgress.state;
      if (diffProgress.stalled) {
        console.log(
          `  no-progress: coder reproduced an identical review diff across rounds; bailing to stuck`,
        );
        terminalReason = "stuck_no_progress";
        lastFeedback = [
          "## No progress",
          "",
          `Stopped early after round ${round}: the coder produced an identical change two rounds in a row without resolving the outstanding feedback.`,
          "",
          "Last feedback before stopping:",
          "",
          feedback || "(none recorded)",
        ].join("\n");
        break;
      }
```

> Placed before the gate so a stalled issue does not pay for another full validation run or reviewer call.

- [ ] **Step 6: Add the identical-validation-failure check**

Replace the per-round validation-gate failure handling. The gate call from Task 4 Step 4 stays; replace the `if (!gate.ok) { ... }` block with:

```ts
      if (!gate.ok) {
        const validationProgress = observeValidationFailure(
          progressState,
          gate.signature,
          VALIDATION_STALL_LIMIT,
        );
        progressState = validationProgress.state;
        feedback = gate.feedback;
        lastFeedback = feedback;
        if (validationProgress.stalled) {
          console.log(
            `  no-progress: the same validation failure recurred across rounds; bailing to stuck`,
          );
          terminalReason = "stuck_no_progress";
          break;
        }
        continue;
      }
```

- [ ] **Step 7: Record the terminal outcome (already-satisfied path)**

In the post-loop `if (alreadySatisfiedReason) { ... }` branch, after the successful `closeIssueAsAlreadySatisfied(...)` + its success log, add:

```ts
        recordIssueOutcome({
          prd: prdNumber,
          issue: issue.number,
          outcome: "already_satisfied",
          roundsUsed,
        });
```

- [ ] **Step 8: Record the terminal outcome (merged path)**

In the post-loop `else if (approved) { ... }` branch, after the `Issue #... merged into ...` success log (and after `lastValidatedTreeSha = approvedTreeSha;` from Task 5), add:

```ts
        recordIssueOutcome({
          prd: prdNumber,
          issue: issue.number,
          outcome: "merged",
          roundsUsed,
        });
```

- [ ] **Step 9: Record the terminal outcome (stuck path)**

In the final `else { ... }` (stuck) branch, after the existing `markStuck(...)` call, add:

```ts
      recordIssueOutcome({
        prd: prdNumber,
        issue: issue.number,
        outcome: terminalReason,
        roundsUsed,
      });
```

- [ ] **Step 10: Record the terminal outcome (crash path)**

In the `catch (iterErr) { ... }` block of `processNormalIssueIteration`, after the existing `console.error(...)`, add:

```ts
    recordIssueOutcome({
      prd: prdNumber,
      issue: issue.number,
      outcome: "crashed",
      roundsUsed,
    });
```

- [ ] **Step 11: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. Confirm `NoProgressState`, `observeReviewDiff`, `observeValidationFailure`, `recordIssueOutcome`, and `recordValidationRun` are all imported (Task 3) and used.

- [ ] **Step 12: Commit**

```bash
git add run-prd-extra-review-custom-agents-shared-cache-v2.mts
git commit -m "feat(v2): bail stalled issues early, lower round cap, record issue outcomes"
```

---

## Task 7: Surface the new metrics in `metrics.py`

**Files:**
- Modify: `metrics.py` (add a generic loader; add validation + outcome rollups; wire into `main`)

- [ ] **Step 1: Add a generic record loader**

Add near `load_recorded_runs` in `metrics.py`:

```python
def load_records_of_kind(kind, paths=RUN_METRICS_FILES):
    out = []
    seen = set()
    for path in paths:
        path = path.resolve()
        if path in seen:
            continue
        seen.add(path)
        if not path.exists():
            continue
        with path.open("r", encoding="utf8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("kind") == kind:
                    out.append(rec)
    return out
```

- [ ] **Step 2: Add the validation-time rollup**

Add to `metrics.py`:

```python
def print_validation_rollup(prd_filter, issue_filter):
    recs = load_records_of_kind("sandcastle_validation_run")
    per_issue = defaultdict(float)
    per_prd = defaultdict(float)
    per_cmd = defaultdict(lambda: [0.0, 0])  # [seconds, runs]
    found = False
    for r in recs:
        prd = parse_int(r.get("prd"))
        issue = parse_int(r.get("issue"))
        if prd_filter is not None and prd != prd_filter:
            continue
        if issue_filter is not None and issue != issue_filter:
            continue
        found = True
        secs = (parse_int(r.get("elapsed_ms")) or 0) / 1000.0
        per_prd[prd] += secs
        if issue is not None:
            per_issue[(prd, issue)] += secs
        cmd = r.get("command", "?")
        per_cmd[cmd][0] += secs
        per_cmd[cmd][1] += 1
    if not found:
        return
    print()
    print("Validation time per command:")
    print(f"{'Command':<40}{'Runs':>8}{'Total':>10}")
    print("-" * 58)
    for cmd in sorted(per_cmd.keys(), key=lambda c: -per_cmd[c][0]):
        secs, runs = per_cmd[cmd]
        print(f"{cmd[:40]:<40}{runs:>8}{fmt_elapsed(secs):>10}")
    print()
    print("Validation time per issue:")
    print(f"{'PRD':<5}{'Issue':<8}{'Validation':>12}")
    print("-" * 25)
    for (prd, issue) in sorted(per_issue.keys()):
        print(f"{prd:<5}{issue:<8}{fmt_elapsed(per_issue[(prd, issue)]):>12}")
    print()
    print("Validation time per PRD:")
    print(f"{'PRD':<5}{'Validation':>12}")
    print("-" * 17)
    for prd in sorted(per_prd.keys()):
        print(f"{prd:<5}{fmt_elapsed(per_prd[prd]):>12}")
```

- [ ] **Step 3: Add the issue-outcome rollup**

Add to `metrics.py`:

```python
def print_outcome_rollup(prd_filter, issue_filter):
    recs = load_records_of_kind("sandcastle_issue_outcome")
    rows = []
    by_outcome = defaultdict(int)
    for r in recs:
        prd = parse_int(r.get("prd"))
        issue = parse_int(r.get("issue"))
        if prd_filter is not None and prd != prd_filter:
            continue
        if issue_filter is not None and issue != issue_filter:
            continue
        outcome = r.get("outcome", "?")
        rounds = parse_int(r.get("rounds_used")) or 0
        rows.append((prd, issue, outcome, rounds))
        by_outcome[outcome] += 1
    if not rows:
        return
    print()
    print("Issue outcomes:")
    print(f"{'PRD':<5}{'Issue':<8}{'Outcome':<24}{'Rounds':>8}")
    print("-" * 45)
    for (prd, issue, outcome, rounds) in sorted(rows):
        print(f"{prd:<5}{issue:<8}{outcome:<24}{rounds:>8}")
    print()
    print("Outcome totals:")
    for outcome in sorted(by_outcome.keys()):
        print(f"  {outcome:<24}{by_outcome[outcome]:>5}")
```

- [ ] **Step 4: Wire the rollups into `main`**

In `main()`, just before the `if args.stuck:` block near the end, add:

```python
    print_validation_rollup(args.prd, args.issue)
    print_outcome_rollup(args.prd, args.issue)
```

- [ ] **Step 5: Smoke-run the analyzer**

Run: `python3 metrics.py`
Expected: existing token tables print as before; the new "Validation time …" and "Issue outcomes" sections print only when such records exist (they will be empty/absent against the current mock `runs.jsonl`, which is expected — no crash).

- [ ] **Step 6: Commit**

```bash
git add metrics.py
git commit -m "feat(metrics): roll up validation time and per-issue outcomes"
```

---

## Task 8: Validation and dry run

**Files:** none (verification only)

- [ ] **Step 1: Full landing gate**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all PASS. New tests (`metrics-recorder.test.mts`, `loop-progress.test.mts`) PASS; existing tests unaffected.

- [ ] **Step 2: Confirm the v1 entry is untouched**

Run: `git diff --stat origin/main -- run-prd-extra-review-custom-agents-shared-cache.mts`
Expected: no changes to the v1 entry file (all entry-level behavior changes live in `-v2.mts`).

- [ ] **Step 3: End-to-end dry run (operator/runner host)**

On the runner host, run the v2 entry against a PRD with at least one eligible issue:

```bash
tsx run-prd-extra-review-custom-agents-shared-cache-v2.mts --prd <N> --review-base <commit-ish>
```

Expected:
- Per validation command, a timing line prints (`✓ 12.3s` / `✗ failed (exit 1) in 8.1s: …`).
- After the first merged issue, the next iteration logs `Base origin/<prd> tree <sha> already validated; skipping base re-validation.` (confirms Item 2).
- `.sandcastle/metrics/runs.jsonl` contains `sandcastle_validation_run` and `sandcastle_issue_outcome` records.
- If an issue loops, it bails with a `no-progress:` log before reaching round 5 (confirms Item 4).

- [ ] **Step 4: Read the new metrics**

Run: `python3 metrics.py --prd <N>`
Expected: the new "Validation time per command/issue/PRD" and "Issue outcomes" sections populate. This is the measurement that tells you whether the 36h is dominated by tests, by local-LLM rounds, or by base re-validation.

---

## Self-review checklist (run before handoff)

- **Spec coverage:** Item 1 = Task 1 (writers) + Task 4 (gate timing) + Task 7 (rollup). Item 2 = Task 5 (tree-hash skip). Item 4 = Task 2 (detector) + Task 6 (bail/cap/outcome) + Task 7 (outcome rollup). v2 fork = Task 3. Verification = Task 8.
- **Type/name consistency across tasks:** `GateResult` failure adds `signature` (Task 4) consumed by `observeValidationFailure` (Task 6); `runValidationGate(worktreePath, context)` signature matches both call sites (Task 4 Steps 3–4, Task 5 Step 2); `lastValidatedTreeSha` replaces `lastValidatedBaseSha` everywhere (Task 5 Steps 3–4, 7); `recordValidationRun`/`recordIssueOutcome`/`NoProgressState`/`observeReviewDiff`/`observeValidationFailure` are imported in Task 3 and used in Tasks 4/6; `ValidationRunMetadata.gate` is `"issue" | "base"` in both the writer (Task 1) and the gate context (Task 4).
- **No placeholders:** every code step shows complete code; commands include expected output.
- **Risks / caveats:** (a) tree-hash skip assumes the standard rebase-then-squash merge produces a base tree equal to the validated branch tree — `approveAndMerge` already guards against base advancement, and any divergence falls through to a normal re-validation; (b) the `markStuck` comment still says "after MAX_REVIEW_ROUNDS rounds" even on an early no-progress bail — the no-progress `lastFeedback` states the real stopping round, so the surfaced comment is accurate; (c) stall limits are intentionally aggressive and live as constants for easy tuning; (d) Items 3 and 5 are deliberately excluded.

## Execution handoff

Plan saved to `docs/plans/2026-06-15-loop-speedup-v2.md`. To execute: implement Tasks 1→8 in order (Tasks 1, 2, 7 are TDD; Tasks 3–6 are entry-file wiring verified by typecheck/build + the extracted-module tests + the Task 8 dry run). Land on a green `npm run typecheck && npm run test && npm run build` after every task.
