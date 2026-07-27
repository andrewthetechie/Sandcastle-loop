// Behavioural tests for the backlog-v4 escalation hook on the shared engine.
//
// The load-bearing claim: without the model-change fingerprint reset, a task
// that fails identically every round is killed by `failedRoundRepeatLimit`
// before the ladder ever escalates it — i.e. the ladder would never fire on
// exactly the tasks it exists to rescue.

import assert from "node:assert/strict";
import test from "node:test";

import {
  runPerBranchEngine,
  type EngineReviewerAcquisitionResult,
  type EngineSandbox,
  type PerBranchEngineDeps,
  type PerBranchEnginePolicy,
  type PerBranchTask,
} from "./per-branch-engine.mts";
import {
  coderTierModelIdentity,
  type CoderEscalationLadder,
} from "./coder-escalation-ladder.mts";

const TASK: PerBranchTask = {
  number: 7,
  title: "Escalation test",
  body: "body",
  comments: "(none)",
  branch: "issue-7",
  baseRef: "origin/main",
};

// Mirrors BACKLOG_V4_ENGINE_POLICY: 6 rounds, repeat limit 3.
const POLICY: PerBranchEnginePolicy = {
  maxReviewRounds: 6,
  coderMaxIterations: 30,
  failedRoundRepeatLimit: 3,
  maxRecoveryAttempts: 2,
  reviewerMaxAttempts: 2,
  reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: true,
  hostOnlyReviewAfterBaseAdvance: false,
};

// The realistic shape: coder and rework tier 1 are the same local model, so the
// only model changes happen at the tier 2 and tier 3 thresholds.
const LADDER: CoderEscalationLadder = {
  tier1Model: "local/small",
  tier2Model: "vendor/medium",
  tier3Model: "vendor/large",
  tier2FromRound: 3,
  tier3FromRound: 5,
};
const CODER_MODEL = "local/small";

/** Identical changes_requested verdict every round -> a stable fingerprint. */
function reviewerChangesRequested(): EngineReviewerAcquisitionResult {
  return {
    kind: "verdict",
    review: {
      decision: "changes_requested",
      summary: "same problem every time",
      findings: [{ problem: "still broken", remediation: "fix it" }],
    },
    resultSource: "stdout",
    logFallbackUsed: false,
    diagnostics: [],
  };
}

function buildDeps(options: {
  agentModelForRound?: (input: { round: number; isRework: boolean }) => string;
}) {
  const escalations: Array<{
    round: number;
    fromModel: string;
    toModel: string;
  }> = [];
  const modelsByRound: Array<{ round: number; model: string }> = [];
  const sandbox: EngineSandbox = {
    worktreePath: "/tmp/worktree",
    async close() {},
  };

  const deps: PerBranchEngineDeps = {
    async createSandbox() {
      return sandbox;
    },
    async preCoderRebaseGuard() {
      return { ok: true };
    },
    async invokeCoder(input) {
      if (options.agentModelForRound) {
        modelsByRound.push({
          round: input.round,
          model: options.agentModelForRound({
            round: input.round,
            isRework: input.isRework,
          }),
        });
      }
      return { kind: "committed", committedCount: 1 };
    },
    async prepareBranchForReview() {
      return { ok: true, reviewedBaseSha: "base-1" };
    },
    async recoverBranch() {
      return { ok: true, feedback: "" };
    },
    async computeReviewContext() {
      return {
        baseSha: "base-1",
        diff: "stable-diff",
        diffBytes: 10,
        diffStat: "1 file changed",
        changedFiles: ["file.ts"],
        reviewAspects: ["code"],
        ecosystems: ["node"],
      };
    },
    async runValidation() {
      return { ok: true };
    },
    async acquireReviewer() {
      return reviewerChangesRequested();
    },
    currentHeadSha() {
      return "head-1";
    },
    currentTreeSha() {
      return "tree-1";
    },
    ...(options.agentModelForRound
      ? {
          agentModelForRound: options.agentModelForRound,
          onModelEscalation(input: {
            round: number;
            fromModel: string;
            toModel: string;
          }) {
            escalations.push(input);
          },
        }
      : {}),
  };

  return { deps, escalations, modelsByRound };
}

function ladderModelForRound(input: { round: number; isRework: boolean }): string {
  return input.isRework
    ? coderTierModelIdentity(LADDER, input.round)
    : CODER_MODEL;
}

test("without the hook, an identical failure stalls on the repeat limit at round 4", async () => {
  const { deps } = buildDeps({});
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });

  assert.equal(result.kind, "stuck");
  assert.equal(
    result.kind === "stuck" ? result.reason : null,
    "stuck_no_progress",
  );
  // Round 4 is where repeatCount reaches the limit of 3. This is the round the
  // ladder's tier 2 (round 3) and tier 3 (round 5) would otherwise inhabit.
  assert.equal(result.roundsUsed, 4);
});

test("the model-change reset lets every ladder tier get its own attempts", async () => {
  const { deps, escalations } = buildDeps({
    agentModelForRound: ladderModelForRound,
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });

  // Same identical failure as the previous test, but now the task survives the
  // repeat limit and runs the full round budget, reaching tier 3.
  assert.equal(result.kind, "stuck");
  assert.equal(
    result.kind === "stuck" ? result.reason : null,
    "stuck_rounds_exhausted",
  );
  assert.equal(result.roundsUsed, POLICY.maxReviewRounds);

  assert.deepEqual(
    escalations.map((entry) => entry.round),
    [3, 5],
  );
  assert.deepEqual(escalations[0], {
    round: 3,
    fromModel: "local/small",
    toModel: "vendor/medium",
  });
  assert.deepEqual(escalations[1], {
    round: 5,
    fromModel: "vendor/medium",
    toModel: "vendor/large",
  });
});

test("a flat ladder resets nothing and stalls exactly like the unhooked engine", async () => {
  const flat: CoderEscalationLadder = {
    ...LADDER,
    tier2Model: "local/small",
    tier3Model: "local/small",
  };
  const { deps, escalations } = buildDeps({
    agentModelForRound: (input) =>
      input.isRework ? coderTierModelIdentity(flat, input.round) : CODER_MODEL,
  });
  const result = await runPerBranchEngine({ task: TASK, policy: POLICY, deps });

  assert.equal(
    result.kind === "stuck" ? result.reason : null,
    "stuck_no_progress",
  );
  assert.equal(result.roundsUsed, 4);
  assert.deepEqual(escalations, []);
});

test("round 1 runs the fresh-start coder model, rework rounds follow the ladder", async () => {
  const { deps, modelsByRound } = buildDeps({
    agentModelForRound: ladderModelForRound,
  });
  await runPerBranchEngine({ task: TASK, policy: POLICY, deps });

  assert.deepEqual(modelsByRound, [
    { round: 1, model: "local/small" },
    { round: 2, model: "local/small" },
    { round: 3, model: "vendor/medium" },
    { round: 4, model: "vendor/medium" },
    { round: 5, model: "vendor/large" },
    { round: 6, model: "vendor/large" },
  ]);
});
