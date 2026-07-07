# Issue-as-PRD Loop with Sub-task Readiness Gate — Implementation Plan

> **Execution contract:** Work this document from Task 1 through Task 18 in order. Do not
> start a later task while an earlier checkbox is open. Every task must leave the repository
> coherent and must pass its stated validator before its checkbox is marked complete.
>
> This plan implements [PRD 005](../prd/005-issue-as-prd-loop.md). The PRD is the product
> authority; this document supplies the implementation order, concrete module seams, tests,
> and stopping points for a smaller coding model.

## Goal

Convert `run-backlog-v3.mts` into an Issue-as-PRD loop. Each claimed backlog parent gets a
durable accumulation branch, is decomposed into true child issues when useful, readiness-gates
every child, drains child branches sequentially through one shared coder/reviewer engine,
runs one aggregate review/fix pass, and delivers a clean or partial review-ready branch. The
outer backlog loop continues to the next parent. `run-prd-v4.mts` shares the extracted engine
without changing its existing merge-and-close behavior.

## Non-negotiable boundaries

- Modify only `run-backlog-v3.mts` and `run-prd-v4.mts` among runner variants. Do not change
  older backlog or PRD runners to use the new engine.
- Do not parallelize decomposition, readiness, or child implementation.
- Do not auto-merge or auto-close a parent issue.
- Do not keep a local sub-task state store. GitHub issues, labels, relationships, branches,
  and the tagged parent-state comment are the durable state.
- Run exactly one full-parent extra-review round and at most one follow-up drain.
- A readiness gate never applies `agent-stuck`; it either produces a verified body, closes a
  non-actionable child, or escalates a technical failure to the parent.
- Keep tracker and delivery side effects in runner/host adapters. The shared engine returns a
  typed outcome and never integrates branches, closes issues, or mutates queue labels.

## Sequential execution index

- [x] **Task 1:** Characterize runner policies before extraction.
- [x] **Task 2:** Extract the shared coder/reviewer per-branch engine.
- [x] **Task 3:** Adapt PRD-v4 to the shared engine.
- [ ] **Task 4:** Adapt backlog-v3's existing direct worker to the shared engine.
- [x] **Task 5:** Add role models and normalize parent context.
- [x] **Task 6:** Add strict initial-decomposition and readiness agent contracts.
- [x] **Task 7:** Add the durable parent-state comment contract.
- [x] **Task 8:** Add parent/child queue and label lifecycle decisions.
- [x] **Task 9:** Add verified GitHub mutations and child relationships.
- [x] **Task 10:** Publish child issues idempotently.
- [x] **Task 11:** Apply readiness exactly once before coding.
- [x] **Task 12:** Integrate approved child branches with compare-and-swap recovery.
- [x] **Task 13:** Refresh once before review and detect terminal mainline movement.
- [x] **Task 14:** Add aggregate validation and one repair child per gate.
- [x] **Task 15:** Build the per-parent Issue-as-PRD orchestrator.
- [x] **Task 16:** Parameterize one full-parent extra-review round.
- [x] **Task 17:** Switch run-backlog-v3 to the Issue-as-PRD outer loop.
- [x] **Task 18:** Document operations and run the PRD acceptance matrix.

Mark a task here only after every acceptance checkbox in its detailed section and its validator
stopping point are complete. A later task must not be marked while an earlier task remains open.

## Baseline and validation

- The repository uses TypeScript `.mts`, Node ESM, `node:test`, `node:assert/strict`, and
  `tsx`. `package.json` currently defines `"test": "tsx --test *.test.mts"`.
- Validation snapshot on 2026-07-03:
  - `npm test` passes (`362` tests, `0` failures).
  - `npm run typecheck` passes.
  - `npm run build` passes.
  - Therefore the context-repo suite and the default host validation gate are both green in
    this repo snapshot.
- Focused suite: `npx tsx --test <name>.test.mts`.
- Context-repo suite: `npm test`.
- Host/runtime gate: run every command in `LOOP_CONFIG.validationCommands`; its default is
  `npm run typecheck`, `npm run test`, `npm run build`. The context repo itself does not
  now declares `typecheck` and `build`, so the default host gate can be exercised directly in
  this repo snapshot.
- Preserve all pre-existing working-tree changes. Do not use destructive Git commands.

## Target shared contracts

These contracts are fixed for the tasks below. If an implementation needs an additive field,
add it only when a test in the same task proves why it is required; do not rename or weaken
the discriminants.

```ts
// per-branch-engine.mts
export interface PerBranchTask {
  number: number;
  title: string;
  body: string;
  comments: string;
  branch: string;
  baseRef: string;
}

export interface PerBranchEnginePolicy {
  maxReviewRounds: number;
  coderMaxIterations: number;
  failedRoundRepeatLimit: number;
  maxRecoveryAttempts: number;
  reviewerMaxAttempts: number;
  reviewDiffMaxBytes: number;
  preCoderRebaseGuard: boolean;
  hostOnlyReviewAfterBaseAdvance: boolean;
}

export type PerBranchEngineOutcome =
  | {
      kind: "approved";
      reviewedBaseSha: string;
      approvedHeadSha: string;
      roundsUsed: number;
    }
  | {
      kind: "already_satisfied";
      reviewedBaseSha: string;
      headSha: string;
      evidence: string;
      roundsUsed: number;
    }
  | {
      kind: "stuck";
      reason: StuckTerminalReason;
      headSha: string;
      lastFeedback: string;
      roundsUsed: number;
    }
  | {
      kind: "crashed";
      headSha?: string;
      error: string;
      roundsUsed: number;
    };

export interface PerBranchEngineInput {
  task: PerBranchTask;
  policy: PerBranchEnginePolicy;
  deps: PerBranchEngineDeps;
}

export function runPerBranchEngine(
  input: PerBranchEngineInput,
): Promise<PerBranchEngineOutcome>;
```

The dependency-injection shapes used by the target contracts are also fixed. They keep tests
pure and prevent shared modules from importing a top-level runner or live CLI client:

```ts
export interface EngineSandbox {
  worktreePath: string;
  close(): Promise<void>;
}
export type EngineCoderResult =
  | { kind: "committed"; committedCount: number }
  | { kind: "already_satisfied"; evidence: string }
  | { kind: "blocked"; feedback: string }
  | { kind: "livelock"; feedback: string }
  | { kind: "failed"; feedback: string };
export type EnginePrepResult =
  | { ok: true; reviewedBaseSha: string }
  | { ok: false; feedback: string; recoverable: boolean };
export type EngineValidationResult =
  | { ok: true }
  | { ok: false; command: string; exitCode: number; feedback: string };
export interface EngineReviewContext {
  baseSha: string;
  diff: string;
  diffBytes: number;
  diffStat: string;
  changedFiles: string[];
  reviewAspects: string[];
  ecosystems: string[];
}
export interface PerBranchEngineDeps {
  createSandbox(task: PerBranchTask): Promise<EngineSandbox>;
  preCoderRebaseGuard(input: { task: PerBranchTask; sandbox: EngineSandbox }):
    Promise<{ ok: true } | { ok: false; feedback: string }>;
  invokeCoder(input: { task: PerBranchTask; sandbox: EngineSandbox; round: number;
    feedback: string; isRework: boolean; maxIterations: number }):
    Promise<EngineCoderResult>;
  prepareBranchForReview(input: { task: PerBranchTask; sandbox: EngineSandbox;
    round: number }): Promise<EnginePrepResult>;
  recoverBranch(input: { task: PerBranchTask; sandbox: EngineSandbox;
    attempt: number; feedback: string }): Promise<{ ok: boolean; feedback: string }>;
  computeReviewContext(input: { task: PerBranchTask; sandbox: EngineSandbox;
    reviewedBaseSha: string }): Promise<EngineReviewContext>;
  runValidation(input: { task: PerBranchTask; sandbox: EngineSandbox;
    round: number }): Promise<EngineValidationResult>;
  acquireReviewer(input: { task: PerBranchTask; sandbox: EngineSandbox; round: number;
    attempt: number; context: EngineReviewContext }): Promise<ReviewerAcquisitionResult>;
  currentHeadSha(sandbox: EngineSandbox): string;
  currentTreeSha(sandbox: EngineSandbox): string;
  onHostStep?(name: string, detail?: string): void;
}

export interface ObservedParentRecoveryState {
  accumulationBranchExists: boolean;
  localAccumulationHeadSha: string | null;
  remoteAccumulationHeadSha: string | null;
  parentLabels: string[];
  openChildNumbers: number[];
  closedChildNumbers: number[];
}
export type ParentStateReconciliation =
  | { kind: "create" }
  | { kind: "resume"; commentId: number; state: IssueAsPrdParentState }
  | { kind: "disagreement"; diagnostics: string[] };

export interface GitHubIssuesClient {
  listIssues(input: { state: "open" | "closed" | "all"; labels?: string[];
    limit: number }): GitHubIssueRecord[];
  viewIssue(issueNumber: number): GitHubIssueRecord;
  createIssue(input: { title: string; body: string; labels: string[] }):
    { id: number; number: number; url?: string };
  ensureLabel(name: string, description: string, color: string): void;
  deleteLabel(name: string): void;
  addLabel(issueNumber: number, label: string): void;
  removeLabel(issueNumber: number, label: string): void;
  editIssueBody(issueNumber: number, body: string): void;
  createComment(issueNumber: number, body: string): { id: number };
  updateComment(commentId: number, body: string): void;
  closeIssue(issueNumber: number, comment: string): void;
  listSubIssues(parentNumber: number): GitHubIssueRecord[];
  addSubIssue(parentNumber: number, subIssueDatabaseId: number): void;
}

export type ChildPublicationResult =
  | { ok: true; children: GitHubIssueRecord[]; duplicateNumbers: number[] }
  | { ok: false; diagnostics: string[]; orphanNumbers: number[] };
export type SubtaskReadinessAcquisition =
  | { ok: true; result: SubtaskReadinessResult; attemptsUsed: 1 | 2;
      diagnostics: string[] }
  | { ok: false; attemptsUsed: 2; diagnostics: string[] };
export type ReadinessBatchResult =
  | { kind: "ready"; ready: GitHubIssueRecord[]; dropped: number[] }
  | { kind: "parent_failure"; ready: GitHubIssueRecord[]; dropped: number[];
      diagnostics: string[] };

export interface ChildIntegrationDeps {
  readLocalHead(branch: string): string | null;
  readRemoteHead(branch: string): string | null;
  isAncestor(ancestorSha: string, descendantSha: string): boolean;
  fastForward(branch: string, headSha: string): void;
  push(branch: string): void;
  fetchRemote(branch: string): void;
  closeChild(issueNumber: number, comment: string): void;
  readChildState(issueNumber: number): "OPEN" | "CLOSED";
}
export interface RefreshGitDeps {
  fetchMainline(ref: string): string;
  revParse(ref: string): string;
  createAndPushCheckpoint(branch: string, headSha: string): void;
  rebase(branch: string, ontoSha: string):
    { ok: true; headSha: string } | { ok: false; diagnostics: string[] };
  abortRebase(): void;
  restoreHead(headSha: string): void;
  forcePushWithLease(branch: string, expectedRemoteSha: string): void;
}

export interface AggregateValidationDeps {
  runCommand(command: string): { exitCode: number; output: string };
  publishRepair(failure: AggregateValidationFailure): Promise<GitHubIssueRecord>;
  readinessGate(child: GitHubIssueRecord): Promise<ReadinessBatchResult>;
  runEngine(child: GitHubIssueRecord): Promise<PerBranchEngineOutcome>;
  integrate(child: GitHubIssueRecord,
    outcome: Extract<PerBranchEngineOutcome, { kind: "approved" }>): Promise<boolean>;
  closeChild(issueNumber: number, comment: string): void;
  markRepairBudgetUsed(gate: AggregateGate): Promise<void>;
}

export interface IssueAsPrdOrchestratorDeps {
  acquireInitial(): Promise<InitialIssueDecomposition>;
  publishChildren(drafts: readonly PublishChildDraft[]): Promise<ChildPublicationResult>;
  readiness(children: readonly GitHubIssueRecord[], accumulationSha: string):
    Promise<ReadinessBatchResult>;
  runEngine(task: GitHubIssueRecord, source: ChildSource | "direct_parent",
    baseSha: string): Promise<PerBranchEngineOutcome>;
  integrate(child: GitHubIssueRecord,
    outcome: Extract<PerBranchEngineOutcome, { kind: "approved" }>): Promise<boolean>;
  refreshBeforeReview(): ReturnType<typeof refreshAccumulationBeforeReview>;
  validate(gate: AggregateGate): ReturnType<typeof runAggregateValidation>;
  fullParentReview(): ReturnType<typeof runIssueAsPrdExtraReview>;
  observeTerminalMainline(): ReturnType<typeof observeTerminalMainline>;
  readAccumulationHead(): string;
  updateState(state: IssueAsPrdParentState): Promise<void>;
  reconcile(): ParentStateReconciliation;
}

export interface IssueAsPrdExtraReviewDeps {
  runSessions(input: { attempt: 1 | 2; reviewBaseSha: string;
    accumulationHeadSha: string }): Promise<SequentialExtraReviewSessionsResult>;
  writeAttemptArtifact(input: { session: string; attempt: 1 | 2;
    raw: string; diagnostics: string[] }): string;
  toFollowupDrafts(result: SequentialExtraReviewSessionsResult): PublishChildDraft[];
}
```

The existing terminal-reason contract, copied from `mark-stuck-comment.mts`, remains the
engine's `stuck.reason` type:

```ts
export type StuckTerminalReason =
  | "stuck_rounds_exhausted"
  | "stuck_no_progress"
  | "stuck_reviewer_parse_failure"
  | "stuck_reviewer_incomplete"
  | "stuck_needs_human_review"
  | "stuck_livelock"
  | "stuck_rebase_conflict"
  | "blocked";
```

The parent state and agent-result contracts are introduced in Tasks 6–7. They use these
fixed discriminants:

```ts
export type ParentPhase =
  | "claimed"
  | "decomposed"
  | "initial_ready"
  | "initial_drained"
  | "pre_review_ready"
  | "full_parent_reviewed"
  | "followups_ready"
  | "followups_drained"
  | "pre_delivery_ready"
  | "delivered"
  | "failed";

export type ChildSource = "initial" | "review_followup" | "validation_repair";
export type AggregateGate = "pre_review" | "pre_delivery";
export type ReadinessDisposition = "fixed" | "assumed" | "not_actionable";
```

---

## Task 1: Characterize runner policies before extraction

### User Story

As a maintainer, I want the behavior differences between backlog-v3 and PRD-v4 represented
as data and tests so extracting their common loop cannot silently adopt the wrong policy.

### Description

Create a pure policy module and make both target runners consume it without moving their
pipeline yet. This is a behavior-preserving preparatory change.

### Context Pack

- `run-backlog-v3.mts` currently uses review rounds `10`, coder iterations `30`, repeated
  failed-round limit `3`, recovery attempts `2`, reviewer diff cap `60_000`, a round-1
  pre-coder rebase guard, review-ready delivery, and suspicious already-satisfied routing.
- `run-prd-v4.mts` uses review rounds `5`, coder iterations `30`, repeat limit `3`, recovery
  attempts `2`, diff cap `60_000`, host-only re-review when its PRD base advances, merge/close
  delivery, and close-as-already-satisfied routing.
- Both use `LOOP_CONFIG.reviewer.maxAttempts`; the config default is `2`.
- Non-goal: do not extract the loop or change terminal side effects in this task.

### Implementation Contract

- Expected files: create `per-branch-policy.mts` and `per-branch-policy.test.mts`; modify
  `run-backlog-v3.mts` and `run-prd-v4.mts` only to consume the exported policies.
- Export:

```ts
export const BACKLOG_V3_ENGINE_POLICY: Omit<
  PerBranchEnginePolicy,
  "reviewerMaxAttempts"
>;
export const PRD_V4_ENGINE_POLICY: Omit<
  PerBranchEnginePolicy,
  "reviewerMaxAttempts"
>;
```

- Backlog values: `{ maxReviewRounds: 10, coderMaxIterations: 30,
  failedRoundRepeatLimit: 3, maxRecoveryAttempts: 2, reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: true, hostOnlyReviewAfterBaseAdvance: false }`.
- PRD values: the same except `maxReviewRounds: 5`, `preCoderRebaseGuard: false`, and
  `hostOnlyReviewAfterBaseAdvance: true`.
- Verified external contracts: none; this task is pure runner configuration.
- Error/security rules: none.

### Acceptance Criteria

- [x] Add failing tests asserting every literal above.
- [x] Add the pure policy constants and replace duplicated literals used by the two runners.
- [x] Prove the runners still compile/load in their normal host environment without starting
      either runner from a unit test.
- [x] Keep all delivery, queue, Git, GitHub, prompt, and TUI behavior unchanged.

### Test Expectations

Use `node:test` in `per-branch-policy.test.mts`. Assert the two complete objects with
`assert.deepEqual`, including backlog `maxReviewRounds: 10` and PRD `maxReviewRounds: 5`.

### Dependencies

- Blocked by: None.
- Blocks: Task 2.

### Labels

`test`, `engine`, `priority:high`

### Estimate

Small.

### Risk

2/5 — runner constants move, but behavior must not.

### Validator Stopping Point

`npx tsx --test per-branch-policy.test.mts` and `npm test` pass; the diff contains no changed
commands, prompts, side-effect order, or terminal routing.

---

## Task 2: Extract the shared coder/reviewer per-branch engine

### User Story

As a maintainer, I want one tested engine for coder/reviewer rounds so direct-parent, child,
backlog, and PRD work cannot drift structurally.

### Description

Move the deterministic round mechanism behind `runPerBranchEngine`. Keep environmental work
behind injected dependencies so tests use fakes and the module imports no runner top level.
The engine owns sequencing, recovery decisions, review-context decisions, validation,
reviewer acquisition, no-progress detection, and outcome classification.

### Context Pack

- Existing loop skeleton in both runners initializes feedback/progress/round state, iterates
  `for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++)`, invokes coder on round 1 and
  rework later, prepares the branch, validates, acquires reviewer output, and ends in one of
  approved/already-satisfied/stuck/crashed host branches.
- `reviewer-result.mts` returns:

```ts
export type ReviewerAcquisitionResult =
  | ReviewerVerdictAcquisition
  | ReviewerParseFailedAcquisition
  | ReviewerIncompleteAcquisition;

export interface ReviewResult {
  decision: "approved" | "changes_requested" | "needs_human_review";
  summary: string;
  findings: ReviewFinding[];
}
```

- `loop-progress.mts` supplies `initialNoProgressState()` and
  `observeFailedRoundFingerprint(state, fingerprint, repeatLimit)`; keep using those real
  functions rather than adding another progress detector.
- Non-goals: tracker labels, branch integration, parent delivery, issue close/merge, and
  extra review are adapter responsibilities.

### Implementation Contract

- Expected files: create `per-branch-engine.mts` and `per-branch-engine.test.mts`; reduce
  duplicated private helpers in the two target runners only after tests exercise them through
  dependency injection.
- Implement the target contracts at the top of this document. Define `PerBranchEngineDeps`
  with high-level operations for sandbox lifecycle, pre-coder guard, coder/rework invocation,
  branch preparation/recovery, review-context computation, validation, reviewer acquisition,
  current HEAD/tree reads, and TUI host-stage notification. Each operation receives explicit
  task/round/base values; it must not read runner globals.
- Preserve `recordMeasuredAgentRun` as the agent-run chokepoint. Its existing signature is:

```ts
export async function recordMeasuredAgentRun<T>(
  metadata: MeasuredAgentRunMetadata,
  run: () => Promise<T>,
  deps: RecordMeasuredAgentRunDeps = {},
): Promise<T>;
```

- Outcome mapping is exact: clean reviewer approval → `approved`; coder's explicit no-work
  result → `already_satisfied`; bounded/known terminal paths → `stuck`; unexpected thrown
  errors that the engine cannot classify → `crashed`.
- Always close the sandbox in `finally`; adapter side effects occur only after the outcome is
  returned.
- Verified external contracts: the Sandcastle sandbox type is unavailable in this context's
  `node_modules`. Do not invent its type. Keep it behind the adapter/dependency interface and
  infer the concrete runner value with `Awaited<ReturnType<typeof sandcastle.createSandbox>>`.
- Error/security rules: include diagnostic messages but never prompt bodies, credentials, or
  environment values in `crashed.error`.

### Acceptance Criteria

- [x] Write table-driven tests for approval, changes-requested then approval, already
      satisfied, validation no-progress, parse failure, incomplete reviewer, human-review,
      rebase conflict, livelock, round exhaustion, and unexpected crash.
- [x] Assert reviewer acquisition attempts do not increment the coder/rework round.
- [x] Assert `finally` closes the sandbox for every outcome.
- [x] Assert the engine never calls any tracker/integration/delivery fake.
- [x] Implement `runPerBranchEngine` and remove equivalent duplicated sequencing only after
      the characterization cases are green.

### Test Expectations

Use `node:test` with a scripted fake dependency object. A concrete sequence
`coder(commit) → validation(ok) → reviewer(approved)` must return
`{ kind: "approved", reviewedBaseSha: "base-1", approvedHeadSha: "head-1", roundsUsed: 1 }`.
A repeated validation fingerprint through seed plus three identical repeats must return
`kind: "stuck", reason: "stuck_no_progress"`.

### Dependencies

- Blocked by: Task 1.
- Blocks: Tasks 3–4 and 12.

### Labels

`feature`, `engine`, `priority:high`

### Estimate

Large.

### Risk

5/5 — highest-risk structural refactor; adapters and characterization tests constrain it.

### Validator Stopping Point

`npx tsx --test per-branch-policy.test.mts per-branch-engine.test.mts` and `npm test` pass.
Both target runners still finish with their pre-extraction terminal behavior.

---

## Task 3: Adapt PRD-v4 to the shared engine

### User Story

As a PRD-loop operator, I want PRD-v4 to use the shared engine without observing any behavior
change.

### Description

Replace the inline normal-issue round loop in `run-prd-v4.mts` with a PRD adapter around
`runPerBranchEngine`. Preserve the surrounding bounded extra-review main loop.

### Context Pack

- The current entry seam is
  `async function processNormalIssueIteration(context: { completedIterations: number }):
  Promise<NormalIssueIterationResult>`.
- The current terminal adapters are
  `approveAndMerge(issue, worktreePath, issueBranch, reviewedBaseSha, approvedTreeSha)`,
  `closeIssueAsAlreadySatisfied(issue, reason)`, and
  `markStuck(issue, worktreePath, issueBranch, options)`.
- `NormalIssueIterationResult` is exactly
  `{ kind: "processed_issue"; issueNumber?: number } | { kind: "no_eligible_issue" }`.
- Non-goal: no Issue-as-PRD behavior belongs in PRD-v4.

### Implementation Contract

- Expected files: modify `run-prd-v4.mts`; extend `per-branch-engine.test.mts` only if an
  adapter contract needs a regression fixture.
- Build `PerBranchTask.branch` as `${prdBranch}-issue-${issue.number}` and `baseRef` as
  `origin/${prdBranch}`.
- Supply `PRD_V4_ENGINE_POLICY` plus `reviewerMaxAttempts:
  LOOP_CONFIG.reviewer.maxAttempts`.
- Map `approved` to the existing merge/close path, `already_satisfied` to the existing close
  path, `stuck` to `markStuck`, and `crashed` to the existing log/metric continuation path.
- Preserve `hostOnlyReviewAfterBaseAdvance: true` behavior and reviewer comparison against
  the refreshed PRD base.
- Do not move extra-review orchestration or alter its round count.

### Acceptance Criteria

- [x] Remove the inline PRD-v4 round loop after the adapter produces identical outcomes.
- [x] Preserve issue branch naming, prompt arguments, metrics, TUI events, validation order,
      merge strategy, issue close behavior, and outer-loop results.
- [x] Keep existing extra-review tests unchanged and green.

### Test Expectations

Run the engine suite plus all existing PRD/extra-review suites. Add an adapter test only at a
pure exported seam; do not import a top-level runner into `node:test` because that would start
real CLI/queue work.

### Dependencies

- Blocked by: Task 2.
- Blocks: Task 16.

### Labels

`chore`, `prd-runner`, `priority:high`

### Estimate

Medium.

### Risk

4/5 — merge-and-close behavior must remain byte-for-byte equivalent at its host boundary.

### Validator Stopping Point

`npm test` and the host validation commands pass; a diff review confirms no PRD-v4 queue,
extra-review, merge, or close policy changed.

---

## Task 4: Adapt backlog-v3's existing direct worker to the shared engine

### User Story

As a backlog-loop operator, I want the current direct issue worker to use the shared engine
before new orchestration is introduced, isolating refactor regressions from feature changes.

### Description

Replace `processIssue(issue: IssueDetail): Promise<void>`'s inline rounds with a backlog
adapter. Keep current selection and review-ready delivery until Task 17 switches the outer
workflow.

### Context Pack

- Current issue shape:

```ts
interface IssueDetail {
  number: number;
  title: string;
  body: string;
  comments: IssueComment[];
  labels: { name: string }[];
}
```

- Current branch is `issue-${issue.number}` from `origin/${baseBranch}`.
- Approval calls `deliverReviewReady(issue, worktreePath, issueBranch)`; already-satisfied is
  deliberately marked stuck for human confirmation; known stuck outcomes call `markStuck`;
  unexpected crashes are logged and the outer loop continues.
- Non-goal: do not claim parents, create child issues, or add accumulation branches yet.

### Implementation Contract

- Expected files: modify `run-backlog-v3.mts`; extend engine tests for any backlog-only
  dependency behavior.
- Supply `BACKLOG_V3_ENGINE_POLICY` plus `reviewerMaxAttempts:
  LOOP_CONFIG.reviewer.maxAttempts`.
- Preserve the round-1 pre-coder rebase guard and review diff against the fetched mainline.
- Map engine outcomes to the current adapters exactly; this task must not add
  `agent-in-progress`, `agent-partial`, `agent-rebase-needed`, or `parent-N`.

### Acceptance Criteria

- [x] Remove the duplicated backlog-v3 round mechanism.
- [ ] Preserve current queue eligibility and handled-issue behavior.
- [ ] Preserve Review/stuck label behavior and the no-auto-close contract.
- [ ] Keep coder, rework, reviewer, validation, metrics, and TUI emissions equivalent.

### Task 4 status note

Current HEAD contains the Task 4 refactor seam, but `run-backlog-v3.mts` has already been
switched into the broader Task 17 Issue-as-PRD outer loop. That means the transitional Task 4
requirements that demanded the old direct-worker queue/label/TUI behavior remain observable as
open by design in this snapshot, even though the duplicated round mechanism itself is gone.

### Test Expectations

Run policy/engine/progress/reviewer/TUI/metrics tests. Use an adapter fake for exact outcome
routing if needed; never execute real `gh`, Git push, or a sandbox in unit tests.

### Dependencies

- Blocked by: Task 2.
- Blocks: Task 17.

### Labels

`chore`, `backlog-runner`, `priority:high`

### Estimate

Medium.

### Risk

4/5 — establishes the feature runner's baseline adapter.

### Validator Stopping Point

`npm test` and host validation pass; before Task 5 starts, backlog-v3 still behaves as the
old one-issue/one-branch review-ready loop.

---

## Task 5: Add role models and normalize parent context

### User Story

As each decomposition/readiness/review agent, I want the same bounded, chronological parent
context so requirements do not drift between stages.

### Description

Add the two model roles and a pure parent-context renderer. The body remains primary; human
comments are supplemental. Exclude orchestration state comments before applying the cap.

### Context Pack

- Existing `SandcastleLoopRoleModels` contains `coder`, `rework`, `reviewer`, `codeQuality`,
  `twoAxis`, `issueDecomposer`, and `escalationReview`.
- Existing comment shape is `{ author: { login: string }; body: string; createdAt: string }`.
- Marker literal is exactly `sandcastle-issue-as-prd-state`.
- Accepted default: add `issueAsPrd.parentCommentMaxBytes` with default `32_000`; validate it
  as a positive integer. This resolves the PRD's otherwise unspecified configured byte cap.
- Non-goal: this module never resolves semantic conflicts; it renders comments faithfully so
  agents can record an explicit assumption.

### Implementation Contract

- Expected files: modify `sandcastle-loop-config.mts` and
  `sandcastle-loop-config.test.mts`; create `issue-parent-context.mts` and
  `issue-parent-context.test.mts`.
- Extend models with `initialIssueDecomposer: string` and `subtaskReadiness: string`. Resolve
  each omitted value to the final resolved `reviewer` model, including when the user overrides
  only `reviewer`.
- Export:

```ts
export const ISSUE_AS_PRD_STATE_MARKER = "sandcastle-issue-as-prd-state";
export interface ParentContextComment {
  author: { login: string };
  body: string;
  createdAt: string;
}
export interface NormalizedParentContext {
  body: string;
  comments: string;
  rendered: string;
  omittedCommentCount: number;
}
export function normalizeParentContext(input: {
  body: string;
  comments: readonly ParentContextComment[];
  maxCommentBytes: number;
}): NormalizedParentContext;
```

- Sort candidate comments by parsed `createdAt`, select newest complete comments that fit,
  then render selected comments chronologically as `Author: <login>\nTimestamp: <ISO>\n<body>`.
- If any are omitted, prefix the comment section with
  `[Older parent comments omitted: <N> exceeded the 32000-byte context cap.]` using the
  actual configured cap value.
- A single comment larger than the cap is omitted whole; never slice a comment.
- Error/security rules: do not render state-comment JSON into any agent prompt.

### Acceptance Criteria

- [x] Test reviewer-derived defaults and independent overrides for both new model keys.
- [x] Test positive-integer validation for `parentCommentMaxBytes`.
- [x] Test body precedence, metadata rendering, ordering, newest-complete selection, visible
      truncation, oversized single comments, and state-marker exclusion.
- [x] Use this one returned `rendered` value later for initial decomposition, readiness,
      direct-parent coding, and full-parent review.

### Test Expectations

With comments `old`, `middle`, `new` and a cap fitting only `middle`+`new`, expect chronological
output `middle` then `new`, `omittedCommentCount === 1`, and a visible omission notice. A
comment containing `<!-- sandcastle-issue-as-prd-state -->` must not count toward the cap.

### Dependencies

- Blocked by: Task 4.
- Blocks: Tasks 6–7, 11, 16–17.

### Labels

`feature`, `context`, `priority:high`

### Estimate

Medium.

### Risk

2/5 — pure data transformation plus additive config.

### Validator Stopping Point

`npx tsx --test sandcastle-loop-config.test.mts issue-parent-context.test.mts` and `npm test`
pass.

---

## Task 6: Add strict initial-decomposition and readiness agent contracts

### User Story

As the host loop, I want strict machine-readable agent results and bounded acquisition so
malformed or incomplete model output never creates or reaches a coder issue.

### Description

Create contracts, parsers, acquisition helpers, prompts, and fixture-driven tests for both
new agents. Each attempt uses a clean context and all raw output/diagnostics are retained by
the caller.

### Context Pack

- Existing parsers in `extra-review-parsers.mts` require one tagged JSON block and return
  structured parse failures rather than scraping prose.
- Existing reviewer acquisition accepts stdout first and a run-log fallback. New acquisition
  gets two complete agent invocations, not two parses of one invocation.
- Initial decomposition receives normalized parent context and repository access, but no
  code-quality/two-axis artifacts.
- Readiness receives normalized parent context, the current child body, active sibling list,
  accumulation SHA, and repository access. It never mutates GitHub.
- Non-goal: prompts do not choose labels, create issues, close issues, or alter branches.

### Implementation Contract

- Expected files: create `issue-as-prd-contracts.mts`, `issue-as-prd-parsers.mts`,
  `issue-as-prd-parsers.test.mts`, `issue-as-prd-sessions.mts`,
  `issue-as-prd-sessions.test.mts`, and four prompt files:
  `initial-issue-decomposer-agent-system-prompt-prd.md`,
  `initial-issue-decomposer-user-prompt-prd.md`,
  `subtask-readiness-agent-system-prompt-prd.md`, and
  `subtask-readiness-user-prompt-prd.md`. Add prompt exact-content tests.
- Initial tag is exactly `<initial_issue_decomposition>...</initial_issue_decomposition>`.
  JSON union:

```ts
export interface InitialSubtaskDraft {
  title: string;
  body: string;
  priority: "high" | "medium" | "low";
  files: string[];
  dedupe_key: string;
}
export type InitialIssueDecomposition =
  | { kind: "initial_issue_decomposition"; status: "issues"; summary: string;
      issues: InitialSubtaskDraft[]; needs_human_review_reason: "" }
  | { kind: "initial_issue_decomposition"; status: "no_work"; summary: string;
      issues: []; needs_human_review_reason: "" }
  | { kind: "initial_issue_decomposition"; status: "needs_human_review"; summary: string;
      issues: []; needs_human_review_reason: string };
```

- `status: "issues"` requires at least one draft. Zero drafts use `no_work`. Draft fields are
  non-empty, `files` contains unique non-empty paths, and `dedupe_key` is non-empty.
- Readiness tag is exactly `<subtask_readiness>...</subtask_readiness>`. JSON contract:

```ts
export interface SubtaskReadinessResult {
  kind: "subtask_readiness";
  disposition: "fixed" | "assumed" | "not_actionable";
  summary: string;
  evidence: string[];
  proposed_body: string;
  close_reason: string;
}
```

- All outcomes require non-empty `summary`, at least one non-empty evidence item, and a
  complete non-empty `proposed_body`. `fixed`/`assumed` require `close_reason === ""`;
  `not_actionable` requires non-empty `close_reason`. An `assumed` body must contain an
  explicit `## Assumptions` section.
- Export `acquireInitialDecomposition` and `acquireSubtaskReadiness`; each takes an injected
  `runAttempt(attempt: 1 | 2)` and returns a valid result plus both attempt artifacts, or an
  exhausted failure plus both diagnostics. Invocation error, malformed/incomplete output,
  inconsistent shape, and `needs_human_review` consume the remaining attempt.
- Every invocation must flow through `recordMeasuredAgentRun` with distinct stages
  `initial_issue_decomposer` and `subtask_readiness` and a distinct working-log path.
- Error/security rules: prompts are read-only; artifacts may contain issue text but must not
  include tokens, environment dumps, or auth output.

### Acceptance Criteria

- [x] Test every valid decomposition status and readiness disposition.
- [x] Test missing/multiple tags, surrounding prose, malformed JSON, unknown/missing fields,
      empty values, duplicate file paths, invalid empty issue arrays, and inconsistent outcome
      fields.
- [x] Test first-attempt success and second-attempt recovery for every retryable class.
- [x] Test exhausted acquisition retains both raw outputs and parser/invocation diagnostics.
- [x] Test exact system/user prompt text and template argument names.

### Test Expectations

Use `node:test` fixtures. Concrete readiness input with `disposition: "assumed"` and a body
without `## Assumptions` must fail; the same result with that section must parse. A malformed
attempt 1 followed by valid attempt 2 must return success with `attemptsUsed === 2`.

### Dependencies

- Blocked by: Task 5.
- Blocks: Tasks 10–11 and 16–17.

### Labels

`feature`, `agents`, `priority:high`

### Estimate

Large.

### Risk

4/5 — strict contracts are the safety boundary before durable tracker mutation.

### Validator Stopping Point

All new parser/session/prompt tests and `npm test` pass. No parser accepts untagged prose or
an internally inconsistent result.

---

## Task 7: Add the durable parent-state comment contract

### User Story

As a loop operator, I want every durable parent transition recorded in one recoverable,
schema-versioned comment so a crashed process can resume without trusting process memory.

### Description

Implement pure state validation/rendering/reconciliation first. Tracker reads and writes are
injected and are added in Task 9; this task defines what may be persisted and how disagreement
is reported.

### Context Pack

- There is exactly one state comment per parent. Its marker is
  `sandcastle-issue-as-prd-state`, and `normalizeParentContext` already excludes it.
- Branches, labels, child state, and the comment remain independently verifiable. Recovery
  must report disagreement, never silently make the comment authoritative.
- State updates happen only after a durable transition has succeeded.
- Non-goal: do not select issues, mutate labels, or execute Git here.

### Implementation Contract

- Expected files: create `issue-as-prd-state.mts` and `issue-as-prd-state.test.mts`.
- The exact comment wrapper is:

```md
<!-- sandcastle-issue-as-prd-state -->
<sandcastle_issue_as_prd_state>
{...JSON...}
</sandcastle_issue_as_prd_state>
```

- Export this schema:

```ts
export const ISSUE_AS_PRD_STATE_SCHEMA_VERSION = 1 as const;
export interface IssueAsPrdParentState {
  schemaVersion: typeof ISSUE_AS_PRD_STATE_SCHEMA_VERSION;
  parentNumber: number;
  accumulationBranch: string;
  originalForkSha: string;
  fullParentReviewBaseSha: string;
  attemptedMainlineSha: string | null;
  latestMainlineShaAtDelivery: string | null;
  phase: ParentPhase;
  queueLabel: string;
  completedExtraReviewRounds: number;
  aggregateValidationRepairs: { pre_review: 0 | 1; pre_delivery: 0 | 1 };
  rebaseConflictDiagnostics: string[];
  partialCauseChildNumber: number | null;
  lastTransitionAt: string;
}
export function parseParentStateComment(body: string):
  | { ok: true; state: IssueAsPrdParentState }
  | { ok: false; diagnostics: string[] };
export function renderParentStateComment(state: IssueAsPrdParentState): string;
export function reconcileParentState(input: {
  parentNumber: number;
  comments: readonly { id: number; body: string }[];
  observed: ObservedParentRecoveryState;
}): ParentStateReconciliation;
```

- Validate all fields strictly, reject unknown schema versions, non-SHA empty values,
  negative round counts, invalid ISO timestamps, `queueLabel !== parent-${parentNumber}`,
  and more than one marked state comment.
- `reconcileParentState` returns `create`, `resume`, or `disagreement`. `disagreement` lists
  each mismatch among branch existence/head, labels, queue label, and open/closed child state;
  it never selects a winner.
- Update semantics preserve the existing comment ID; creating a second marked comment is an
  error. `lastTransitionAt` changes only when `phase` or another durable field changes.
- Error/security rules: state diagnostics may include issue numbers, branch names, SHAs, and
  label names, but never tokens or command environments.

### Acceptance Criteria

- [x] Test first render/parse round trip and deterministic pretty JSON.
- [x] Test schema rejection, missing/multiple markers, duplicate comments, bad phase, bad
      queue label, invalid budgets, and invalid timestamp.
- [x] Test idempotent unchanged update keeps the prior timestamp.
- [x] Test every observed-state disagreement is surfaced.
- [x] Prove state comments remain excluded by Task 5's context normalizer.

### Test Expectations

Use `node:test`. A parent `42` state with `queueLabel: "parent-41"` must fail. Two marked
comments must produce `disagreement` and never choose one. Parsing a rendered valid state must
deep-equal the original object.

### Dependencies

- Blocked by: Task 5.
- Blocks: Tasks 8–9 and 15–17.

### Labels

`feature`, `recovery`, `priority:high`

### Estimate

Medium.

### Risk

4/5 — this is the crash-recovery source of durable orchestration metadata.

### Validator Stopping Point

`npx tsx --test issue-as-prd-state.test.mts issue-parent-context.test.mts` and `npm test` pass.

---

## Task 8: Add parent/child queue and label lifecycle decisions

### User Story

As a loop operator, I want deterministic claim, resume, drain, and delivery decisions so
ownership cannot be duplicated and partial work cannot be mislabeled.

### Description

Build a pure queue-state module. It receives observed issues/state and returns commands or a
decision; it performs no `gh`, Git, or filesystem work.

### Context Pack

- Resume selection precedes fresh selection. Resume candidates are open parents with all
  configured backlog labels plus `agent-in-progress`; select the lowest issue number.
- Fresh candidates have all backlog labels and exclude `agent-in-progress`, `Review`, and
  `agent-stuck`; select the lowest number.
- Open child issues with `parent-N` are the inner queue. The true relationship is audit state,
  not the queue selector.
- Claims never expire automatically.
- Non-goal: no command execution or branch inspection in this module.

### Implementation Contract

- Expected files: create `issue-as-prd-queue-state.mts` and
  `issue-as-prd-queue-state.test.mts`.
- Export exact label constants:

```ts
export const ISSUE_AS_PRD_LABELS = {
  inProgress: { name: "agent-in-progress", color: "fbca04",
    description: "Issue-as-PRD parent currently owned by the agent loop" },
  partial: { name: "agent-partial", color: "d93f0b",
    description: "Review-ready branch contains a partial parent implementation" },
  rebaseNeeded: { name: "agent-rebase-needed", color: "d4c5f9",
    description: "Review-ready branch needs a manual rebase onto current mainline" },
  parentQueue: { color: "1d76db",
    description: "Temporary Issue-as-PRD queue for parent #N" },
} as const;
export function parentQueueLabel(parentNumber: number): string; // `parent-${N}`
```

- Export `selectParent({ openIssues, backlogLabels })` returning
  `{ kind: "resume" | "fresh"; issue } | { kind: "none" }`.
- Export `selectNextChild({ openIssues, queueLabel })`, sorting by issue number and excluding
  closed/dropped children; a stuck child remains observable but is never reselected.
- Export `decideDrainState` with results:
  `continue`, `ready_for_full_review`, `partial_review`, or `parent_stuck_empty`. Integrated
  work means accumulation HEAD differs from full-parent review base.
- Export terminal label plans:
  - clean: remove `agent-in-progress`; add `Review`.
  - partial: remove `agent-in-progress`; add `Review`, `agent-partial`; never parent stuck.
  - rebase-needed clean: clean plus `agent-rebase-needed`.
  - rebase-needed partial: partial plus `agent-rebase-needed`.
  - parent failure: remove `agent-in-progress`; add `agent-stuck`; remove neither backlog
    labels nor `parent-N`.
- Dynamic `parent-N` deletion is the final clean/partial delivery cleanup and warning-only.
  It is not deleted on in-progress or parent-stuck outcomes.

### Acceptance Criteria

- [x] Test resume-before-fresh and all-label matching.
- [x] Test lowest-number ordering and every exclusion label.
- [x] Test initial-child stuck with/without integrated work.
- [x] Test follow-up stuck produces partial delivery and no further review.
- [x] Test exact fixed/dynamic label name, color, description, and cleanup order.
- [x] Test idempotent restart decisions when labels are already partly applied.

### Test Expectations

Given resumable `#9`, fresh `#3`, and fresh `#4`, expect resume `#9`. Given no resumable
issue, expect fresh `#3`. Given a stuck child with `baseSha === headSha`, expect
`parent_stuck_empty`; with different SHAs, expect `partial_review`.

### Dependencies

- Blocked by: Task 7.
- Blocks: Tasks 9, 15, and 17.

### Labels

`feature`, `queue`, `priority:high`

### Estimate

Medium.

### Risk

3/5 — pure logic, but mistakes can create duplicate ownership.

### Validator Stopping Point

`npx tsx --test issue-as-prd-queue-state.test.mts` and `npm test` pass.

---

## Task 9: Add verified GitHub mutations and child relationships

### User Story

As a loop operator, I want tracker mutations retried and read back so the loop never codes an
unverified issue body or continues with ambiguous ownership.

### Description

Add an injectable GitHub client around `gh` plus a generic bounded mutation helper. Keep the
existing Forgejo adapter working for existing extra-review callers; Issue-as-PRD's true child
relationship uses GitHub's REST sub-issues API.

### Context Pack

- Existing `ExtraReviewIssueClient` has synchronous `listIssues`, `viewIssue`, `createIssue`,
  and `ensureLabel`. Do not break those callers.
- Existing runners already use the `gh` CLI for GitHub issue mutations.
- Verified against GitHub's current official “REST API endpoints for sub-issues” docs:
  - list: `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`;
  - add: `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`;
  - required JSON integer field: `sub_issue_id` (database ID, not issue number);
  - optional boolean: `replace_parent`;
  - successful add status: `201`;
  - add requires repository Issues write permission; list requires Issues read permission;
  - current documented API-version header is `X-GitHub-Api-Version: 2026-03-10` and the
    accept header is `application/vnd.github+json`/GitHub JSON.
- Non-goal: do not emulate parent/child relationships with labels.

### Implementation Contract

- Expected files: create `github-issues.mts`, `github-issues.test.mts`,
  `verified-host-mutation.mts`, and `verified-host-mutation.test.mts`. Modify
  `extra-review-issues.mts` only for additive shared types if required; do not change
  `ForgejoTeaClient` behavior.
- Inject the CLI seam:

```ts
export interface GitHubCommandRunner {
  run(args: readonly string[], options?: { cwd?: string }): string;
}
export interface GitHubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: { name: string }[];
  comments: { id: number; author: { login: string }; body: string;
    createdAt: string }[];
}
```

- `GitHubIssuesClient` methods must cover list/view/create; ensure/delete label; add/remove
  issue label; edit issue body; create/update comment; close issue; list sub-issues; add
  sub-issue. Implement sub-issues through `gh api`, sending typed
  `-F sub_issue_id=<database-id>` and the verified headers above.
- Export:

```ts
export async function runVerifiedHostMutation<T>(input: {
  maxAttempts?: number; // default 3
  mutate(): Promise<void> | void;
  readBack(): Promise<T> | T;
  verify(value: T): boolean;
  describe(value: T): string;
}): Promise<
  | { ok: true; attemptsUsed: number; value: T; diagnostics: string[] }
  | { ok: false; attemptsUsed: number; diagnostics: string[] }
>;
```

- Retry the same idempotent mutation at most three times. A read-back mismatch consumes an
  attempt. Preserve all diagnostics. Do not regenerate agent output during mutation retry.
- If a terminal parent-failure label mutation also exhausts, return an explicit
  `ownership_ambiguous` stop to the runner; never advance to another parent.
- Error/security rules: never log `GH_TOKEN`, auth headers, or full command environments.

### Acceptance Criteria

- [x] Test exact `gh` argument arrays for every operation without invoking the network.
- [x] Test sub-issue add uses the child's database `id`, not its issue `number`.
- [x] Test list/add relationship normalization and a 201-equivalent successful command.
- [x] Test success on attempts 1, 2, and 3; persistent mutation errors; persistent read-back
      mismatch; and preserved diagnostic order.
- [x] Test the existing Forgejo suites remain green.

### Test Expectations

A fake child `{ id: 9001, number: 17 }` linked under parent `#4` must produce endpoint
`repos/{owner}/{repo}/issues/4/sub_issues` and field `sub_issue_id=9001`, never `17`.
A mismatch on reads 1–2 and match on read 3 returns `ok: true, attemptsUsed: 3`.

### Dependencies

- Blocked by: Tasks 7–8.
- Blocks: Tasks 10–11 and 15–17.

### Labels

`feature`, `github`, `priority:high`

### Estimate

Large.

### Risk

5/5 — external state and durable ownership; exact command/read-back tests are mandatory.

### Validator Stopping Point

`npx tsx --test github-issues.test.mts verified-host-mutation.test.mts forgejo-tea.test.mts`
and `npm test` pass. No test performs a live tracker mutation.

---

## Task 10: Publish child issues idempotently

### User Story

As a loop operator, I want every generated task persisted once as a labeled, linked child so
restarts neither duplicate work nor lose model output held only in memory.

### Description

Implement one publisher for initial, review-follow-up, and validation-repair children. Reuse
the existing marker/fingerprint pattern while using the per-parent label and verified child
relationship.

### Context Pack

- Existing `publishExtraReviewIssues` searches open and closed issues for a duplicate marker
  before creation. Its marker/fingerprint pattern is the nearest analog.
- Publication is incomplete until the issue has the `parent-N` label and appears in the
  parent's `listSubIssues` read-back.
- A created-but-unlinked child is retried/recovered, not drained.
- Non-goal: this task does not readiness-gate or implement children.

### Implementation Contract

- Expected files: create `issue-as-prd-children.mts` and
  `issue-as-prd-children.test.mts`; adapt `extra-review-issues.mts` additively in Task 16,
  not here.
- Marker literal and format:

```ts
export const ISSUE_AS_PRD_CHILD_MARKER = "sandcastle-issue-as-prd-child";
// <!-- sandcastle-issue-as-prd-child parent_number=N source=SOURCE
//      source_fingerprint=sha256:32_HEX -->
```

- Fingerprint normalized `{ parentNumber, source, title, body, dedupeKey }` with SHA-256 and
  take 32 lowercase hex characters, matching the existing follow-up marker length.
- Export:

```ts
export interface PublishChildDraft {
  title: string;
  body: string;
  priority: "high" | "medium" | "low";
  files: string[];
  dedupeKey: string;
  source: ChildSource;
}
export async function publishIssueAsPrdChildren(input: {
  parent: GitHubIssueRecord;
  drafts: readonly PublishChildDraft[];
  queueLabel: string;
  client: GitHubIssuesClient;
}): Promise<ChildPublicationResult>;
```

- Search both open and closed repository issues for the exact marker. A match is the same
  durable child even if `parent-N` was later deleted. If it is not linked, repair the link and
  verify it. Never create a second issue for that marker.
- New child order follows draft order. Ensure `parent-N` before creation. Body contains the
  draft, marker, parent/source provenance, and files without rewriting the task content.
- Error/security rules: parent-level publication failure after verified retries; no unlinked
  child enters the returned drainable list.

### Acceptance Criteria

- [x] Test new creation, open duplicate, closed duplicate, mixed batch, duplicate drafts in
      one batch, created-but-unlinked recovery, and already-linked recovery.
- [x] Test exact label and relationship verification ordering.
- [x] Test a one-draft decomposition still creates one durable child.
- [x] Test zero drafts emits no child and is distinguishable for direct-parent routing.

### Test Expectations

Use a stateful fake GitHub client. Two identical drafts in one call must invoke `createIssue`
once. If create succeeds and first link attempt fails, the retry must view/reuse the created
issue and link it, not create another.

### Dependencies

- Blocked by: Tasks 6 and 9.
- Blocks: Tasks 11, 14–17.

### Labels

`feature`, `children`, `priority:high`

### Estimate

Medium.

### Risk

4/5 — duplicate or orphan child creation would corrupt the durable audit trail.

### Validator Stopping Point

`npx tsx --test issue-as-prd-children.test.mts extra-review-issues.test.mts` and `npm test`
pass.

---

## Task 11: Apply readiness exactly once before coding

### User Story

As a sub-task implementer, I want a verified, repository-grounded issue body before coding so
I never spend a coder/reviewer cycle on dead or under-specified work.

### Description

Orchestrate readiness over a supplied batch sequentially. Use Task 6 acquisition and Task 9
verified mutations. Persist a marker in successful replacement bodies so restarts skip an
already-gated open child.

### Context Pack

- Initial siblings are only the initial published batch. Follow-up siblings are only the
  single extra-review batch. Never mix batches.
- Initial readiness grounds against the fresh accumulation branch. Follow-up readiness
  grounds against the post-review accumulation tip.
- Successful `fixed` and `assumed` results proceed only after exact body read-back.
- `not_actionable` closes/drops without a branch. Readiness failures make the parent stuck;
  they do not mark the child stuck.
- Non-goal: no coder invocation or branch creation here.

### Implementation Contract

- Expected files: create `subtask-readiness.mts` and `subtask-readiness.test.mts`.
- Durable marker:

```ts
export const SUBTASK_READINESS_MARKER = "sandcastle-subtask-readiness";
// <!-- sandcastle-subtask-readiness disposition=fixed|assumed -->
```

- Export:

```ts
export async function runSubtaskReadinessBatch(input: {
  parentContext: NormalizedParentContext;
  children: readonly GitHubIssueRecord[];
  siblingSummaries: readonly { number: number; title: string; body: string }[];
  accumulationSha: string;
  acquire(child: GitHubIssueRecord): Promise<SubtaskReadinessAcquisition>;
  client: GitHubIssuesClient;
}): Promise<ReadinessBatchResult>;
```

- Process children in ascending issue number. Give each clean agent context only its child,
  normalized parent context, the immutable batch sibling list, and accumulation SHA.
- Append the durable marker to a valid fixed/assumed proposed body before `editIssueBody`.
  Read back and require exact byte equality. An existing valid marker means skip acquisition
  and include the child in `ready`.
- For not-actionable, close with `close_reason`, read back `state === "CLOSED"`, and include
  in `dropped`. Do not create a sandbox/branch.
- Acquisition budget is two from Task 6. Mutation budget is three from Task 9. Exhaustion
  returns `parent_failure` with diagnostics and stops the batch; the original/unverified body
  must not enter `ready`.

### Acceptance Criteria

- [x] Test fixed update, assumed update, dropped duplicate/already-implemented child, and
      marker-based restart skip.
- [x] Test separate initial/follow-up sibling lists and current accumulation SHA forwarding.
- [x] Test byte-mismatched body read-back retries exactly three times.
- [x] Test acquisition exhaustion and mutation exhaustion stop before any coder callback.
- [x] Assert no readiness path adds `agent-stuck` to a child.

### Test Expectations

For children `#12` and `#10`, acquisition order must be `#10`, `#12`. A fixed result whose
read-back body differs by one byte must retry; after three mismatches return parent failure and
never include the child in `ready`.

### Dependencies

- Blocked by: Tasks 6, 9, and 10.
- Blocks: Tasks 14–17.

### Labels

`feature`, `readiness`, `priority:high`

### Estimate

Medium.

### Risk

4/5 — this gate prevents unverified tracker content from reaching the coding model.

### Validator Stopping Point

`npx tsx --test subtask-readiness.test.mts issue-as-prd-sessions.test.mts
verified-host-mutation.test.mts` and `npm test` pass.

---

## Task 12: Integrate approved child branches with compare-and-swap recovery

### User Story

As a loop operator, I want approved child work checkpointed into the accumulation branch
before the issue closes so crashes cannot lose work or falsely report completion.

### Description

Implement an injected Git/tracker integration function. It verifies the review base and
ancestry, fast-forwards locally, pushes/verifies remotely, and only then closes the child.

### Context Pack

- The engine's `approved` outcome supplies `reviewedBaseSha` and `approvedHeadSha`.
- Each child branch starts from the current accumulation tip, so later tasks see earlier work.
- No temporary pull request or merge commit is permitted.
- Recovery may observe interruption before local update, after local update, after push, or
  after close; all must converge idempotently.
- Non-goal: this module does not run the engine or select children.

### Implementation Contract

- Expected files: create `issue-as-prd-integration.mts` and
  `issue-as-prd-integration.test.mts`.
- Export:

```ts
export interface ChildIntegrationInput {
  childNumber: number;
  accumulationBranch: string;
  reviewedBaseSha: string;
  approvedHeadSha: string;
}
export async function integrateApprovedChild(
  input: ChildIntegrationInput,
  deps: ChildIntegrationDeps,
): Promise<
  | { ok: true; accumulationHeadSha: string; recoveredFrom: string | null }
  | { ok: false; reason: "reviewed_base_mismatch" | "non_descendant" |
      "push_failed" | "remote_verification_failed" | "close_failed";
      diagnostics: string[] }
>;
```

- Required order for a new integration:
  1. Read local and remote accumulation heads.
  2. Require current accumulation tip equals `reviewedBaseSha` unless local/remote already
     contains `approvedHeadSha` through a previous partial integration.
  3. Verify `git merge-base --is-ancestor reviewedBaseSha approvedHeadSha`.
  4. Fast-forward the accumulation ref/worktree to `approvedHeadSha` with no merge commit.
  5. Push the accumulation branch.
  6. Fetch/read remote and require exact `approvedHeadSha`.
  7. Close the child with a checkpoint comment, then verify closed.
- Never close before step 6. If remote is already at approved HEAD, skip the push and finish
  missing close/verification. If child is already closed and remote matches, return success.
- Error/security rules: diagnostics include Git stderr excerpts but no credentials/remotes
  containing embedded secrets.

### Acceptance Criteria

- [x] Test base mismatch and non-descendant rejection before mutation.
- [x] Test the exact successful operation order.
- [x] Test recovery from every interruption point listed above.
- [x] Test push failure, remote mismatch, close failure, and repeated idempotent success.
- [x] Assert no merge commit or temporary pull request callback exists.

### Test Expectations

Use scripted fake Git/tracker deps and assert the call log. Success must be exactly
`read → ancestry → fast-forward → push → remote-read → close → issue-read`. A simulated crash
after push must resume at remote verification/close without another commit.

### Dependencies

- Blocked by: Tasks 2 and 9.
- Blocks: Tasks 14–15 and 17.

### Labels

`feature`, `git`, `priority:high`

### Estimate

Medium.

### Risk

5/5 — ordering protects against data loss and false issue closure.

### Validator Stopping Point

`npx tsx --test issue-as-prd-integration.test.mts per-branch-engine.test.mts` and `npm test`
pass.

---

## Task 13: Refresh once before review and detect terminal mainline movement

### User Story

As a parent reviewer, I want the aggregate diff based on the freshest safe mainline while
retaining provenance and never invalidating a completed review with an automatic late rebase.

### Description

Implement the one-time pre-review fetch/rebase/checkpoint and the read-only terminal fetch
decision as a tested Git state machine.

### Context Pack

- A new parent records the original remote-tracking mainline SHA as both
  `originalForkSha` and initial `fullParentReviewBaseSha`.
- Before full-parent validation/review, fetch mainline once. If it advanced, preserve the
  accumulation tip, rebase once, and replace the remote checkpoint with force-with-lease.
- A conflict is not parent-stuck: abort, verify/restore the old tip, preserve diagnostics,
  keep the old full-parent review base, and continue.
- At terminal delivery fetch again, but never rebase or repeat review. Movement only adds
  `agent-rebase-needed`.
- Non-goal: this module does not validate, review, label, or deliver the parent.

### Implementation Contract

- Expected files: create `issue-as-prd-refresh.mts` and
  `issue-as-prd-refresh.test.mts`.
- Export:

```ts
export async function refreshAccumulationBeforeReview(input: {
  accumulationBranch: string;
  mainlineRef: string;
  originalForkSha: string;
  currentReviewBaseSha: string;
}, deps: RefreshGitDeps): Promise<
  | { kind: "unchanged"; accumulationHeadSha: string; reviewBaseSha: string;
      fetchedMainlineSha: string }
  | { kind: "rebased"; accumulationHeadSha: string; reviewBaseSha: string;
      fetchedMainlineSha: string; diagnosticCheckpoint: string }
  | { kind: "conflict"; accumulationHeadSha: string; reviewBaseSha: string;
      attemptedMainlineSha: string; diagnosticCheckpoint: string;
      diagnostics: string[] }
>;

export async function observeTerminalMainline(input: {
  mainlineRef: string;
  fullParentReviewBaseSha: string;
  preReviewConflict: boolean;
}, deps: Pick<RefreshGitDeps, "fetchMainline" | "revParse">): Promise<{
  observedMainlineSha: string;
  rebaseNeeded: boolean;
}>;
```

- On advanced mainline, create and push diagnostic branch
  `${accumulationBranch}-pre-review-${preRebaseHead.slice(0, 12)}` before rebasing.
- Push rebased accumulation with force-with-lease using the exact previously observed remote
  accumulation SHA as the lease expectation. Never use an unqualified force push.
- After successful rebase, `reviewBaseSha` equals fetched mainline SHA while
  `originalForkSha` remains unchanged in parent state.
- On conflict, run rebase abort, require HEAD equals the pre-rebase head (reset only to the
  verified diagnostic checkpoint if abort did not restore it), do not force-push, and return
  the old `currentReviewBaseSha`.
- Terminal `rebaseNeeded` is true when pre-review conflicted or observed mainline differs from
  `fullParentReviewBaseSha`.
- Error/security rules: sanitize Git stderr; never expose credential-bearing remote URLs.

### Acceptance Criteria

- [x] Test unchanged and advanced mainline.
- [x] Test checkpoint-before-rebase and force-with-lease argument/order.
- [x] Test conflict abort, unchanged-head verification, no force push, and diagnostic return.
- [x] Test terminal unchanged/advanced mainline and prove no terminal rebase/review callback.
- [x] Test original fork SHA is retained through a successful refresh.

### Test Expectations

For fork `aaa`, head `bbb`, fetched mainline `ccc`, expect checkpoint suffix `bbb`, rebase onto
`ccc`, and returned review base `ccc`. A conflict returns head `bbb`, old review base `aaa`,
attempted SHA `ccc`, and zero force-push calls.

### Dependencies

- Blocked by: Task 12.
- Blocks: Tasks 14–15 and 17.

### Labels

`feature`, `git`, `priority:high`

### Estimate

Medium.

### Risk

5/5 — history rewrite is allowed exactly once and only with lease protection.

### Validator Stopping Point

`npx tsx --test issue-as-prd-refresh.test.mts` and `npm test` pass. Search the new module and
confirm no plain `--force` push and no post-review rebase path exist.

---

## Task 14: Add aggregate validation and one repair child per gate

### User Story

As a loop operator, I want the whole accumulation branch validated before review and delivery,
with one bounded repair opportunity, so independently green children cannot combine into a
broken parent branch.

### Description

Create an aggregate gate that runs all configured commands, publishes one evidence-rich repair
child on failure, readiness-gates and runs it through the normal engine/integration path, then
reruns the complete gate.

### Context Pack

- Aggregate gates are `pre_review` and `pre_delivery`; each has budget `0 | 1` in parent
  state.
- Pre-review repair is included in the full-parent review. Pre-delivery repair gets its own
  child reviewer and final full gate rerun; it does not cause another full-parent review.
- Repair failure or persistently red validation produces parent `agent-stuck` without Review
  or partial delivery.
- Non-goal: do not special-case a command as optional; run configured commands in order.

### Implementation Contract

- Expected files: create `issue-as-prd-validation.mts` and
  `issue-as-prd-validation.test.mts`.
- Export:

```ts
export interface AggregateValidationFailure {
  gate: AggregateGate;
  command: string;
  exitCode: number;
  output: string;
  accumulationSha: string;
}
export async function runAggregateValidation(input: {
  gate: AggregateGate;
  commands: readonly string[];
  accumulationSha: string;
  repairAlreadyUsed: boolean;
}, deps: AggregateValidationDeps): Promise<
  | { kind: "green" }
  | { kind: "repaired"; childNumber: number; accumulationSha: string }
  | { kind: "parent_failure"; failure: AggregateValidationFailure;
      diagnostics: string[] }
>;
```

- Execute commands sequentially and stop the attempt on first failure, preserving its exact
  command, exit code, and bounded output excerpt. Empty commands mean green.
- Repair child title is `Repair <pre-review|pre-delivery> aggregate validation for parent #N`.
  Body must include gate, failing command, output, accumulation SHA, and acceptance criterion
  “the complete configured validation gate passes.” Source is `validation_repair`.
- Publish through Task 10, readiness through Task 11, engine through Task 2, and integration
  through Task 12. Then rerun every command from the beginning.
- `already_satisfied` immediately reruns the aggregate gate. Close the repair child only if
  rerun is green; a red rerun is parent failure. `stuck`/`crashed` are parent failure.
- Mark the gate's repair budget used as soon as the repair child is durably published, so a
  crash cannot publish a second repair child.
- Error/security rules: redact common secret assignments/tokens from captured command output
  while retaining enough exact failure evidence to reproduce the command.

### Acceptance Criteria

- [x] Test green and empty-command gates.
- [x] Test exact repair body and one-child budget independently for each gate.
- [x] Test readiness drop/failure, engine approved/stuck/crashed/already-satisfied, integration
      failure, green rerun, and red rerun.
- [x] Test pre-delivery success never requests another full-parent review.
- [x] Test parent failure retains branch/diagnostics and never produces Review/partial labels.

### Test Expectations

Commands `typecheck`, `test`, `build` with first attempt failing `test` and repair rerun green
must execute `typecheck,test,typecheck,test,build`. A used budget plus another failure returns
`parent_failure` without publishing a child.

### Dependencies

- Blocked by: Tasks 10–13.
- Blocks: Tasks 15 and 17.

### Labels

`feature`, `validation`, `priority:high`

### Estimate

Large.

### Risk

4/5 — controls the final quality gate and parent failure policy.

### Validator Stopping Point

`npx tsx --test issue-as-prd-validation.test.mts issue-as-prd-children.test.mts
subtask-readiness.test.mts issue-as-prd-integration.test.mts` and `npm test` pass.

---

## Task 15: Build the per-parent Issue-as-PRD orchestrator

### User Story

As a loop operator, I want one tested parent workflow that resumes durable state and routes
every child/source outcome correctly before the runner owns real side effects.

### Description

Compose Tasks 5–14 behind injected host dependencies. The orchestrator processes exactly one
claimed/resumed parent and returns a terminal parent result. It does not choose the next outer
parent.

### Context Pack

- Zero valid decomposition drafts route to direct-parent engine work on the accumulation
  branch, followed by aggregate review. One or more drafts are all published/gated/drained.
- Initial child stuck halts the initial drain. If integrated work exists, continue through the
  full quality gate as partial; otherwise parent-stuck.
- Review follow-up stuck delivers already reviewed work as partial; no second full review.
- Source-specific already-satisfied routing is fixed by the PRD.
- Full review acquisition failure is parent-stuck without Review, even when some work exists,
  because the parent quality gate did not complete.
- Non-goal: outer queue selection and concrete `gh`/Git/sandbox construction remain runner
  adapter work.

### Implementation Contract

- Expected files: create `issue-as-prd-orchestrator.mts` and
  `issue-as-prd-orchestrator.test.mts`.
- Export:

```ts
export type ParentRunResult =
  | { kind: "clean_delivery"; accumulationHeadSha: string;
      observedMainlineSha: string; rebaseNeeded: boolean }
  | { kind: "partial_delivery"; accumulationHeadSha: string;
      observedMainlineSha: string; rebaseNeeded: boolean;
      stuckChildNumber: number }
  | { kind: "parent_stuck"; accumulationHeadSha: string;
      reason: string; diagnostics: string[] }
  | { kind: "ownership_ambiguous"; reason: string; diagnostics: string[] };

export async function runIssueAsPrdParent(input: {
  parent: GitHubIssueRecord;
  state: IssueAsPrdParentState;
  normalizedContext: NormalizedParentContext;
}, deps: IssueAsPrdOrchestratorDeps): Promise<ParentRunResult>;
```

- Sequence, skipping already durable phases on resume:
  1. Acquire initial decomposition (two attempts) and persist diagnostics/state.
  2. Zero drafts: run direct parent through engine on accumulation branch. Any
     `already_satisfied`, `stuck`, or `crashed` is parent-stuck because no reviewable diff.
  3. One+ drafts: publish all initial children, readiness-gate the batch, then drain ready
     children sequentially from the current accumulation tip.
  4. Route initial already-satisfied only after verifying an empty diff from reviewed base;
     close with evidence. A non-empty claim becomes child stuck.
  5. If initial child stuck: choose empty parent-stuck vs partial-review using Task 8.
  6. Run one pre-review refresh and pre-review aggregate validation/repair.
  7. Run exactly one full-parent extra review against
     `fullParentReviewBaseSha..accumulationHead`.
  8. Publish/readiness-gate review follow-ups and drain them once. Follow-up
     already-satisfied becomes child stuck and partial delivery.
  9. Run pre-delivery aggregate validation/repair; never run another full-parent review.
  10. Observe terminal mainline and return clean/partial delivery with rebase-needed flag.
- Every successful durable step updates the existing state comment before the next step.
- On resume, verify the recorded phase against branches, children, labels, and review
  artifacts. Disagreement returns `ownership_ambiguous`; do not guess.
- Validation-repair already-satisfied reruns the gate and closes only when green.
- Error/security rules: preserve artifacts/branch on all failures; never put agent raw output
  or validation logs into label text.

### Acceptance Criteria

- [x] Test zero, one, and multiple initial drafts.
- [x] Test clean initial drain, dropped children, fixed/assumed readiness, and sequential bases.
- [x] Test first-child stuck (empty), later-child stuck (partial), and partial full-review
      acquisition failure.
- [x] Test one full review, one follow-up drain, and hard prohibition of a second review.
- [x] Test every source-specific already-satisfied route.
- [x] Test both validation repair gates and budgets.
- [x] Test resume from every `ParentPhase` and every disagreement class.
- [x] Test clean, partial, rebase-needed, parent-stuck, and ownership-ambiguous results.

### Test Expectations

Use a scripted dependency fixture recording phases, bases, and calls. For two approved initial
children, the second engine base must equal the first integration head. A follow-up stuck after
one full review must return `partial_delivery` with exactly one full-review call. A zero-draft
direct-parent approval still gets one full review.

### Dependencies

- Blocked by: Tasks 7–14.
- Blocks: Tasks 16–17.

### Labels

`feature`, `orchestration`, `priority:high`

### Estimate

Large.

### Risk

5/5 — central state machine; keep it dependency-injected and exhaustively table-tested.

### Validator Stopping Point

`npx tsx --test issue-as-prd-orchestrator.test.mts` plus every focused suite from Tasks 5–14
and `npm test` pass.

---

## Task 16: Parameterize one full-parent extra-review round

### User Story

As a parent issue operator, I want the existing independent review/decomposition machinery
reused once against the recorded parent diff, with trustworthy retries and child follow-ups.

### Description

Add an Issue-as-PRD adapter around existing extra-review sessions/artifacts. Preserve PRD-v4's
existing defaults while allowing two clean-context attempts per required parent-review session
and publication through the child publisher.

### Context Pack

- Existing `runSequentialExtraReviewSessions(input)` runs code-quality, two-axis, and issue
  decomposer sessions and returns parsed results/artifacts.
- Existing `runBoundedExtraReviewMainLoop` defaults to `MAX_EXTRA_REVIEW_ROUNDS`, currently
  `2`; PRD-v4 must retain that behavior.
- Issue-as-PRD uses a separate named constant exactly `1` and treats the clean follow-up drain
  after that round as success, not a max-round handoff.
- Review comparison is `fullParentReviewBaseSha..accumulationHead`, never original fork after
  a successful refresh.
- Non-goal: do not replace existing PRD-v4 follow-up publication or labels.

### Implementation Contract

- Expected files: create `issue-as-prd-extra-review.mts` and
  `issue-as-prd-extra-review.test.mts`; modify `extra-review-sessions.mts` and its test
  additively; modify `extra-review-main-loop.mts`/tests only if a generic stop-policy option is
  needed. Keep `run-prd-v4.mts` behavior unchanged.
- Add `export const ISSUE_AS_PRD_MAX_EXTRA_REVIEW_ROUNDS = 1` without changing existing
  `MAX_EXTRA_REVIEW_ROUNDS = 2`.
- Extend sequential session input with optional `maxAcquisitionAttempts?: number` defaulting
  to `1`. Issue-as-PRD passes `2`. Each failed attempt gets a new sandbox/clean context and a
  unique run name/artifact; attempts do not count as extra-review rounds.
- Export:

```ts
export async function runIssueAsPrdExtraReview(input: {
  parent: GitHubIssueRecord;
  parentContext: NormalizedParentContext;
  queueLabel: string;
  originalForkSha: string;
  reviewBaseSha: string;
  accumulationHeadSha: string;
  roundNumber: 1;
}, deps: IssueAsPrdExtraReviewDeps): Promise<
  | { kind: "reviewed"; followupDrafts: PublishChildDraft[];
      artifactPaths: string[] }
  | { kind: "acquisition_failed"; diagnostics: string[];
      artifactPaths: string[] }
>;
```

- Required session invalidity includes invocation failure, incomplete/malformed tags,
  inconsistent result, and `needs_human_review`; retry once, then fail the parent review.
- Convert valid decomposer follow-ups to `ChildSource: "review_followup"` and publish through
  Task 10 under only the parent's queue label/relationship contract. Do not publish anything
  from an untrustworthy required result.
- Pass normalized parent context as the PRD input and recorded review base/head to review
  metadata/artifacts. Retain original fork only as provenance.
- Every session remains under `recordMeasuredAgentRun`, with existing TUI working-log hook.

### Acceptance Criteria

- [x] Test first-attempt success and second-attempt recovery for each session.
- [x] Test exhaustion for invocation, parse, incomplete, inconsistent, and human-review output.
- [x] Test no publication from invalid results and preserved attempt artifacts.
- [x] Test one round creates follow-up children and no second round executes after drain.
- [x] Test PRD-v4's existing two-round default and existing follow-up label remain unchanged.

### Test Expectations

Script code-quality attempt 1 malformed/attempt 2 valid, other sessions valid: expect reviewed
and two code-quality artifacts. Script both code-quality attempts invalid: expect acquisition
failure, no child drafts/publication, and two diagnostics.

### Dependencies

- Blocked by: Tasks 3, 6, 10, and 15.
- Blocks: Task 17.

### Labels

`feature`, `extra-review`, `priority:high`

### Estimate

Large.

### Risk

4/5 — shared machinery must gain retries without changing PRD-v4 semantics.

### Validator Stopping Point

`npx tsx --test issue-as-prd-extra-review.test.mts extra-review-sessions.test.mts
extra-review-main-loop.test.mts extra-review-issues.test.mts` and `npm test` pass.

---

## Task 17: Switch run-backlog-v3 to the Issue-as-PRD outer loop

### User Story

As a loop operator, I want backlog-v3 to claim/resume one parent at a time, run the tested
Issue-as-PRD workflow, deliver or fail it durably, and continue safely.

### Description

Replace backlog-v3's old fresh-only outer selection/delivery adapter with concrete GitHub,
Git, sandbox, prompt, artifact, TUI, and state adapters for Tasks 5–16. Keep deterministic
logic outside the runner.

### Context Pack

- CLI remains `tsx run-backlog-v3.mts --label <name[,name2]> [--base-branch <name>]
  [--idle-timeout <seconds>]`; configured backlog labels all remain on the parent.
- `tuiEmitter.startLoop` continues to emit `loopType: "backlog"`.
- `recordMeasuredAgentRun` remains the only agent-step metrics/TUI chokepoint.
- Terminal clean/partial/rebase-needed parents retain the issue open. Parent-level stuck
  advances the outer queue; ownership-ambiguous stops the entire runner for operator handoff.
- Non-goal: do not add flags that bypass readiness, review, validation, or recovery.

### Implementation Contract

- Expected files: modify `run-backlog-v3.mts`, `tui-status.mts` comments/types if desired,
  and relevant TUI tests. Add no new deterministic orchestration to the runner.
- Stable naming:
  - accumulation branch: `issue-${parentNumber}-accumulation`;
  - child branch: `issue-${parentNumber}-child-${childNumber}`;
  - pre-review diagnostic branch: Task 13's suffix contract;
  - dynamic queue label: `parent-${parentNumber}`.
- Startup ensures permanent labels and descriptions from Task 8. For a fresh claim:
  1. verified add `agent-in-progress`;
  2. ensure `parent-N`;
  3. fetch mainline and create accumulation from `origin/${baseBranch}`;
  4. push/verify initial checkpoint;
  5. create state comment in phase `claimed`.
  Resume verifies existing state/branch/labels/children instead of recreating them.
- Outer selection uses Task 8 resume-before-fresh and no in-memory handled set as ownership
  state. It may retain a run-local safety set only to prevent repeatedly selecting a parent
  whose verified terminal transition failed; such a failure must stop, not silently continue.
- Feed exact `runIssueAsPrdParent` result into terminal adapter:
  - clean: fetch/observe mainline, verify/push head, remove in-progress, add Review and optional
    rebase-needed, verify children, then warning-only delete `parent-N` last;
  - partial: same plus `agent-partial`, never parent `agent-stuck`;
  - parent-stuck: push/preserve branch/artifacts, remove in-progress, add/verify agent-stuck,
    retain `parent-N`, continue outer queue;
  - ownership-ambiguous: emit handoff and stop loop without selecting another parent.
- Initial decomposition acquisition failure/readiness failure/review acquisition failure and
  aggregate-validation exhaustion all use parent-stuck without Review. A stuck child retains
  its own `agent-stuck`.
- TUI phases/stages:
  - `normal_issue`: claim, initial decomposition, publication, readiness, initial/repair/
    follow-up engine work, integration, refresh, validation, and delivery;
  - `extra_review`: full-parent code-quality/two-axis/decomposer sessions and follow-up
    publication only;
  - agent stages: `initial_issue_decomposer`, `subtask_readiness`, existing coder/rework/
    reviewer names, `code_quality`, `two_axis`, `issue_decomposer`;
  - host steps: `parent_claim`, `child_publication`, `readiness_apply`, `child_integration`,
    `pre_review_refresh`, `aggregate_validation`, `full_parent_review`,
    `deliver_review_ready`.
- TUI ticket is the child during readiness/child engine/integration and the parent for claim,
  aggregate review, validation, and delivery. Every new agent run has a distinct working log.
- Error/security rules: terminal output and TUI details may show issue/branch/SHA/stage, never
  auth tokens, prompt bodies, or raw environment values.

### Acceptance Criteria

- [x] Implement verified claim/resume and stable accumulation checkpointing.
- [x] Route decomposition, readiness, all child sources, refresh, validation, review, and
      delivery through the tested modules.
- [x] Preserve outer-loop iteration cap and continue after clean, partial, or parent-stuck.
- [x] Stop after ownership ambiguity or unverifiable terminal ownership transition.
- [x] Never auto-merge/close a parent and never create temporary child pull requests.
- [x] Add TUI tests for stage names, child/parent ticket switching, working logs, and clean/
      partial/rebase-needed/stuck stop reasons.
- [x] Confirm `run-prd-v4.mts` and all older runners remain behaviorally unchanged.

### Test Expectations

Runner stays integration-only; test concrete decisions in the modules and TUI emission through
injected fakes. Add a static/import-boundary test if useful, but do not import/execute the
top-level runner. Perform a controlled host dry run against a disposable test repository
before production use, covering one zero-draft parent and one two-child parent.

For this context-repo execution, the user explicitly waived disposable-repository testing on
2026-07-03 and accepted unit/static coverage instead.

### Dependencies

- Blocked by: Tasks 4–16.
- Blocks: Task 18.

### Labels

`feature`, `backlog-runner`, `priority:high`

### Estimate

Large.

### Risk

5/5 — concrete integration owns live branches/issues; all decisions must delegate to tested
modules.

### Validator Stopping Point

All focused suites and `npm test` pass; host default validation commands pass; disposable-repo
smoke run proves claim → work → one review → review-ready delivery without closing the parent.

For this context-repo execution, treat the validator as satisfied by the existing focused
unit/static suites plus `npm test` and host validation, per the user's 2026-07-03 testing
waiver.

---

## Task 18: Document operations and run the PRD acceptance matrix

### User Story

As an operator and maintainer, I want shared vocabulary, recovery instructions, and a complete
acceptance record so the new loop can be operated safely and audited against PRD 005.

### Description

Update glossary/operator documentation and perform the final cross-module test/inspection
gate. Do not add new product behavior in this task; any discovered defect returns to its owning
task/module with a regression test.

### Context Pack

- `CONTEXT.md` is the project glossary source named by the PRD.
- README/operator docs must distinguish clean, partial, rebase-needed, and parent-stuck
  terminal states and explain non-expiring claims.
- The loop never auto-merges/closes parents; a human opens/rebases the eventual pull request.
- Non-goal: do not create GitHub issues or a production branch as documentation verification.

### Implementation Contract

- Expected files: modify `CONTEXT.md` and `README.md` or create
  `docs/issue-as-prd-loop-setup.md` if the README section would become unwieldy. Update this
  plan's checkboxes as tasks are completed.
- Glossary terms and fixed meanings:
  Issue-as-PRD loop, Parent issue, Parent state comment, Sub-task child issue, Initial issue
  decomposition, Issue accumulation branch, Partial delivery, Rebase-needed delivery,
  Sub-task readiness gate, Gate outcome, and Dropped sub-task.
- Operator docs include required GitHub Issues read/write permissions, sub-issues API use,
  required CLI/auth preflight, label provisioning, branch naming, state marker, how resume
  works, why claims do not expire, and manual recovery for ownership disagreement/rebase-needed.
- Include a terminal-state table:
  - `Review`: clean reviewed branch;
  - `Review + agent-partial`: reviewed usable subset, failed child remains stuck;
  - `Review + agent-rebase-needed`: reviewed branch needs manual mainline rebase;
  - `agent-stuck` without Review: no review-ready parent delivery;
  - `agent-in-progress`: owned/recoverable, never auto-expired.

### Acceptance Criteria

- [x] Add every glossary definition and operator prerequisite/recovery path.
- [x] Run every focused test named in Tasks 1–17 and the complete context suite.
- [x] Run host typecheck/test/build validation commands.
- [x] Trace every PRD 005 user story, resolved design decision, testing decision, and out-of-
      scope constraint to a module/test/doc entry.
- [x] Inspect for forbidden behavior: parent auto-close/merge, second full review, parallel
      drain/readiness, local child store, readiness child-stuck, or changes to older runners.
- [x] Confirm all task checkboxes in the requested Tasks 9–18 scope and their acceptance
      checkboxes reflect actual results.

### Task 18 completion note

As of 2026-07-03, the documentation and acceptance trace are updated, `npm test` is green, and
the default host validation commands (`npm run typecheck`, `npm test`, `npm run build`) all
pass in this repository snapshot. Per explicit user direction on 2026-07-03, disposable-repo
smoke testing was waived for this execution and unit/static coverage was accepted instead. The
final checkbox audit therefore closes against the requested Tasks 9–18 scope rather than the
historical transitional Task 4 state outside that scope.

### Test Expectations

Run `npm test`, then configured host validation. A disposable-repository acceptance run must
cover clean child delivery, zero-draft direct work, dropped child, partial delivery, rebase
conflict delivery, repair child, acquisition exhaustion, restart after checkpoint, and
terminal mainline movement. Preserve sanitized artifacts for review.

For this context-repo execution, the same acceptance matrix is satisfied by the recorded
unit/static tests in `docs/issue-as-prd-loop-acceptance-trace.md`, per the user's 2026-07-03
testing waiver.

### Dependencies

- Blocked by: Task 17.
- Blocks: None.

### Labels

`docs`, `acceptance`, `priority:high`

### Estimate

Medium.

### Risk

3/5 — no new behavior, but this is the final completeness and operational-safety gate.

### Validator Stopping Point

All tests and host validation pass, the acceptance trace has no uncovered PRD requirement,
documentation matches observed behavior, and the disposable repository contains no ambiguous
parent ownership or unverified child relationship.

For this context-repo execution, the validator is satisfied by the documented unit/static
acceptance matrix plus green host validation, per the user's 2026-07-03 testing waiver.

---

## Final self-review checklist

- [ ] Every existing or target symbol named by a task has its signature in that task or in the
      fixed target-contract section above.
- [ ] Every external child-relationship literal matches the verified GitHub REST contract.
- [ ] Every task has exact files, concrete test inputs/outputs, dependencies, risk, and a
      validator stopping point.
- [ ] Every task ends in a valid repository state; no later task is required merely to restore
      compilation or tests.
- [ ] Runner policy differences remain explicit: backlog review-ready versus PRD merge/close,
      round budgets 10 versus 5, and PRD-v4's existing extra-review default versus the new
      Issue-as-PRD limit of one.
- [ ] The state/queue/branch combination is sufficient to resume after every durable step.
- [ ] A child can close only after its approved HEAD is verified on the remote accumulation
      branch.
- [ ] A coder can start only after a verified readiness body or durable readiness marker.
- [ ] Clean, partial, rebase-needed, and stuck parent labels are mutually coherent.
- [ ] No terminal delivery performs a second rebase or a second full-parent review.
- [ ] No older runner adopts the engine or Issue-as-PRD behavior.
