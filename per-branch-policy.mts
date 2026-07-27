import type { PerBranchEnginePolicy } from "./per-branch-engine.mts";

export const BACKLOG_V3_ENGINE_POLICY: Omit<
  PerBranchEnginePolicy,
  "reviewerMaxAttempts"
> = {
  maxReviewRounds: 10,
  coderMaxIterations: 30,
  failedRoundRepeatLimit: 3,
  maxRecoveryAttempts: 2,
  reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: true,
  hostOnlyReviewAfterBaseAdvance: false,
};

// Backlog v4 differs from v3 in one policy value: the round cap drops from 10
// to 6. v3 telemetry over 451 tasks showed rounds 7-10 consuming 62 rework runs
// (~20h wall-clock) at a 85-92% continue-to-next-round rate — i.e. almost all of
// that spend was on tasks that never converged. v4 spends the same budget on
// escalating the model at rounds 3 and 5 instead of on extra attempts by a model
// that has already failed. The ladder itself lives in coder-escalation-ladder.mts.
export const BACKLOG_V4_ENGINE_POLICY: Omit<
  PerBranchEnginePolicy,
  "reviewerMaxAttempts"
> = {
  maxReviewRounds: 6,
  coderMaxIterations: 30,
  failedRoundRepeatLimit: 3,
  maxRecoveryAttempts: 2,
  reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: true,
  hostOnlyReviewAfterBaseAdvance: false,
};

export const PRD_V4_ENGINE_POLICY: Omit<
  PerBranchEnginePolicy,
  "reviewerMaxAttempts"
> = {
  maxReviewRounds: 5,
  coderMaxIterations: 30,
  failedRoundRepeatLimit: 3,
  maxRecoveryAttempts: 2,
  reviewDiffMaxBytes: 60_000,
  preCoderRebaseGuard: false,
  hostOnlyReviewAfterBaseAdvance: true,
};
