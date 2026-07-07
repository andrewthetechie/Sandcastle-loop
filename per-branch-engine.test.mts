import assert from "node:assert/strict";
import test from "node:test";

import {
  runPerBranchEngine,
  type EngineCoderResult,
  type EnginePrepResult,
  type EngineReviewContext,
  type EngineReviewerAcquisitionResult,
  type EngineSandbox,
  type EngineValidationResult,
  type PerBranchEngineDeps,
  type PerBranchEnginePolicy,
  type PerBranchTask,
} from "./per-branch-engine.mts";

const TASK: PerBranchTask = {
  number: 42,
  title: "Test issue",
  body: "Implement test issue",
  comments: "(none)",
  branch: "issue-42",
  baseRef: "origin/main",
};

const POLICY: PerBranchEnginePolicy = {
  maxReviewRounds: 4,
  coderMaxIterations: 30,
  failedRoundRepeatLimit: 3,
  maxRecoveryAttempts: 2,
  reviewerMaxAttempts: 2,
  reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: true,
  hostOnlyReviewAfterBaseAdvance: false,
};

const REVIEW_CONTEXT: EngineReviewContext = {
  baseSha: "base-1",
  diff: "diff-1",
  diffBytes: 10,
  diffStat: "1 file changed",
  changedFiles: ["file.ts"],
  reviewAspects: ["code"],
  ecosystems: ["node"],
};

function reviewerApproved(): EngineReviewerAcquisitionResult {
  return {
    kind: "verdict",
    review: { decision: "approved", summary: "ok", findings: [] },
    resultSource: "stdout",
    logFallbackUsed: false,
    diagnostics: [],
  };
}

function reviewerChangesRequested(): EngineReviewerAcquisitionResult {
  return {
    kind: "verdict",
    review: {
      decision: "changes_requested",
      summary: "fix it",
      findings: [
        {
          problem: "broken",
          remediation: "fix it",
        },
      ],
    },
    resultSource: "stdout",
    logFallbackUsed: false,
    diagnostics: [],
  };
}

function reviewerNeedsHuman(): EngineReviewerAcquisitionResult {
  return {
    kind: "verdict",
    review: {
      decision: "needs_human_review",
      summary: "uncertain",
      findings: [{ problem: "complex", remediation: "human check" }],
    },
    resultSource: "stdout",
    logFallbackUsed: false,
    diagnostics: [],
  };
}

interface ScriptedSteps {
  coder?: EngineCoderResult[];
  prep?: EnginePrepResult[];
  recover?: { ok: boolean; feedback: string }[];
  validation?: EngineValidationResult[];
  reviewer?: EngineReviewerAcquisitionResult[];
}

function buildDeps(steps: ScriptedSteps = {}) {
  const calls = {
    invokeCoder: [] as Array<{ round: number; isRework: boolean; feedback: string }>,
    acquireReviewer: [] as Array<{ round: number; attempt: number }>,
    closeCount: 0,
    hostSteps: [] as Array<{ name: string; detail?: string }>,
  };
  const sandbox: EngineSandbox = {
    worktreePath: "/tmp/worktree",
    async close() {
      calls.closeCount++;
    },
  };

  const coderQueue = [...(steps.coder ?? [{ kind: "committed", committedCount: 1 }])];
  const prepQueue = [...(steps.prep ?? [{ ok: true, reviewedBaseSha: "base-1" }])];
  const recoverQueue = [...(steps.recover ?? [{ ok: true, feedback: "" }])];
  const validationQueue = [...(steps.validation ?? [{ ok: true }])];
  const reviewerQueue = [...(steps.reviewer ?? [reviewerApproved()])];

  const deps: PerBranchEngineDeps = {
    async createSandbox() {
      return sandbox;
    },
    async preCoderRebaseGuard() {
      return { ok: true };
    },
    async invokeCoder(input) {
      calls.invokeCoder.push({
        round: input.round,
        isRework: input.isRework,
        feedback: input.feedback,
      });
      const next = coderQueue.shift();
      assert.ok(next, "missing scripted coder result");
      return next;
    },
    async prepareBranchForReview() {
      const next = prepQueue.shift();
      assert.ok(next, "missing scripted prep result");
      return next;
    },
    async recoverBranch() {
      const next = recoverQueue.shift();
      assert.ok(next, "missing scripted recover result");
      return next;
    },
    async computeReviewContext() {
      return REVIEW_CONTEXT;
    },
    async runValidation() {
      const next = validationQueue.shift();
      assert.ok(next, "missing scripted validation result");
      return next;
    },
    async acquireReviewer(input) {
      calls.acquireReviewer.push({ round: input.round, attempt: input.attempt });
      const next = reviewerQueue.shift();
      assert.ok(next, "missing scripted reviewer result");
      return next;
    },
    currentHeadSha() {
      return "head-1";
    },
    currentTreeSha() {
      return "tree-1";
    },
    onHostStep(name, detail) {
      calls.hostSteps.push({ name, detail });
    },
  };

  return { deps, calls };
}

test("approved path returns approved outcome", async () => {
  const { deps, calls } = buildDeps();
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.deepEqual(result, {
    kind: "approved",
    reviewedBaseSha: "base-1",
    approvedHeadSha: "head-1",
    roundsUsed: 1,
  });
  assert.equal(calls.closeCount, 1);
});

test("changes requested then approval uses same round counter for reviewer retries", async () => {
  const { deps, calls } = buildDeps({
    coder: [
      { kind: "committed", committedCount: 1 },
      { kind: "committed", committedCount: 1 },
    ],
    prep: [
      { ok: true, reviewedBaseSha: "base-1" },
      { ok: true, reviewedBaseSha: "base-1" },
    ],
    validation: [{ ok: true }, { ok: true }],
    reviewer: [reviewerChangesRequested(), reviewerApproved()],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "approved");
  assert.deepEqual(calls.invokeCoder, [
    { round: 1, isRework: false, feedback: "" },
    {
      round: 2,
      isRework: true,
      feedback: `## Reviewer requested changes\n\n**Summary:** fix it\n\n### Finding 1\n**Problem:** broken\n**Fix:** fix it`,
    },
  ]);
  assert.deepEqual(calls.acquireReviewer, [
    { round: 1, attempt: 1 },
    { round: 2, attempt: 1 },
  ]);
});

test("already satisfied returns typed outcome", async () => {
  const { deps, calls } = buildDeps({
    coder: [{ kind: "already_satisfied", evidence: "no work needed" }],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.deepEqual(result, {
    kind: "already_satisfied",
    reviewedBaseSha: "",
    headSha: "head-1",
    evidence: "no work needed",
    roundsUsed: 1,
  });
  assert.equal(calls.closeCount, 1);
});

test("repeated validation failure yields stuck_no_progress", async () => {
  const { deps } = buildDeps({
    coder: new Array(4).fill({ kind: "committed", committedCount: 1 }),
    prep: new Array(4).fill({ ok: true, reviewedBaseSha: "base-1" }),
    validation: new Array(4).fill({
      ok: false,
      command: "npm test",
      exitCode: 1,
      feedback: "## Validation failed",
    }),
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_no_progress");
});

test("reviewer parse failure exhausts attempts and returns stuck", async () => {
  const { deps } = buildDeps({
    reviewer: [
      {
        kind: "parse_failed",
        code: "invalid_json",
        resultSource: "stdout",
        logFallbackUsed: false,
        diagnostics: ["bad json"],
      },
      {
        kind: "parse_failed",
        code: "invalid_json",
        resultSource: "stdout",
        logFallbackUsed: false,
        diagnostics: ["bad json"],
      },
    ],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_reviewer_parse_failure");
});

test("reviewer incomplete exhausts attempts and returns stuck", async () => {
  const { deps } = buildDeps({
    reviewer: [
      {
        kind: "incomplete",
        code: "missing_tag",
        resultSource: "none",
        logFallbackUsed: false,
        diagnostics: ["missing tag"],
      },
      {
        kind: "incomplete",
        code: "missing_tag",
        resultSource: "none",
        logFallbackUsed: false,
        diagnostics: ["missing tag"],
      },
    ],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_reviewer_incomplete");
});

test("repeated workflow-pollution prep failure yields stuck_no_progress", async () => {
  const workflowPollutionPrep: EnginePrepResult = {
    ok: false,
    feedback: [
      "## Diff includes workflow-file pollution",
      "",
      "The review diff includes `.sandcastle/` workflow files alongside product files.",
    ].join("\n"),
    recoverable: false,
  };
  const { deps } = buildDeps({
    coder: new Array(4).fill({ kind: "committed", committedCount: 1 }),
    prep: new Array(4).fill(workflowPollutionPrep),
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_no_progress");
  assert.match(result.lastFeedback, /workflow_pollution/);
});

test("reviewer host input limit becomes actionable no-progress instead of terminal incomplete", async () => {
  const { deps, calls } = buildDeps({
    coder: new Array(4).fill({ kind: "committed", committedCount: 1 }),
    prep: new Array(4).fill({ ok: true, reviewedBaseSha: "base-1" }),
    validation: new Array(4).fill({ ok: true }),
    reviewer: new Array(4).fill({
      kind: "incomplete",
      code: "host_input_limit",
      resultSource: "none",
      logFallbackUsed: false,
      diagnostics: ["argv exceeded"],
    }),
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_no_progress");
  assert.match(result.lastFeedback, /review_input_limit/);
  assert.equal(calls.invokeCoder[1]?.round, 2);
  assert.equal(calls.invokeCoder[1]?.isRework, true);
  assert.match(calls.invokeCoder[1]?.feedback ?? "", /Reviewer incomplete/);
});

test("reviewer terminal failures preserve provided excerpt evidence", async () => {
  const { deps } = buildDeps({
    reviewer: [
      {
        kind: "parse_failed",
        code: "invalid_json",
        resultSource: "run_log",
        logFallbackUsed: true,
        logFilePath: "/tmp/reviewer.log",
        diagnostics: ["bad json"],
        excerpt: "assistant said <review>{not json}</review>",
      },
      {
        kind: "parse_failed",
        code: "invalid_json",
        resultSource: "run_log",
        logFallbackUsed: true,
        logFilePath: "/tmp/reviewer.log",
        diagnostics: ["bad json"],
        excerpt: "assistant said <review>{not json}</review>",
      },
    ],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_reviewer_parse_failure");
  assert.match(result.lastFeedback, /assistant said <review>\{not json\}<\/review>/);
  assert.match(result.lastFeedback, /\/tmp\/reviewer\.log/);
});

test("needs human review becomes stuck", async () => {
  const { deps } = buildDeps({ reviewer: [reviewerNeedsHuman()] });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_needs_human_review");
});

test("round-one rebase conflict becomes terminal stuck", async () => {
  const { deps } = buildDeps();
  deps.preCoderRebaseGuard = async () => ({
    ok: false,
    feedback: "## Rebase conflict with base branch",
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.deepEqual(result, {
    kind: "stuck",
    reason: "stuck_rebase_conflict",
    headSha: "head-1",
    lastFeedback: "## Rebase conflict with base branch",
    roundsUsed: 1,
  });
});

test("coder livelock becomes stuck_livelock", async () => {
  const { deps } = buildDeps({
    coder: [{ kind: "livelock", feedback: "## Livelock" }],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_livelock");
});

test("round exhaustion returns stuck_rounds_exhausted", async () => {
  const { deps } = buildDeps({
    coder: new Array(4).fill({ kind: "failed", feedback: "## Try again" }),
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "stuck");
  assert.equal(result.reason, "stuck_rounds_exhausted");
});

test("unexpected dependency throw returns crashed", async () => {
  const { deps } = buildDeps();
  deps.runValidation = async () => {
    throw new Error("boom");
  };
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "crashed");
  assert.match(result.error, /boom/);
});

test("recoverable prep failure uses recoverBranch before retrying", async () => {
  const { deps, calls } = buildDeps({
    prep: [
      { ok: false, feedback: "recover me", recoverable: true },
      { ok: true, reviewedBaseSha: "base-1" },
    ],
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });
  assert.equal(result.kind, "approved");
  assert.equal(calls.closeCount, 1);
});
