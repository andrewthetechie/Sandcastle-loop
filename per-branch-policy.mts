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
