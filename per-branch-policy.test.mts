import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKLOG_V3_ENGINE_POLICY,
  PRD_V4_ENGINE_POLICY,
} from "./per-branch-policy.mts";

test("BACKLOG_V3_ENGINE_POLICY matches the backlog-v3 literals", () => {
  assert.deepEqual(BACKLOG_V3_ENGINE_POLICY, {
    maxReviewRounds: 10,
    coderMaxIterations: 30,
    failedRoundRepeatLimit: 3,
    maxRecoveryAttempts: 2,
    reviewDiffMaxBytes: 2_000_000,
    preCoderRebaseGuard: true,
    hostOnlyReviewAfterBaseAdvance: false,
  });
});

test("PRD_V4_ENGINE_POLICY matches the prd-v4 literals", () => {
  assert.deepEqual(PRD_V4_ENGINE_POLICY, {
    maxReviewRounds: 5,
    coderMaxIterations: 30,
    failedRoundRepeatLimit: 3,
    maxRecoveryAttempts: 2,
    reviewDiffMaxBytes: 60_000,
    preCoderRebaseGuard: false,
    hostOnlyReviewAfterBaseAdvance: true,
  });
});
