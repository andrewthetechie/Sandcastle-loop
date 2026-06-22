import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRunEscalationReview } from "./escalation-review-trigger.mts";

test("runs escalation only on clean-exhaustion reasons", () => {
  for (const reason of [
    "max_extra_review_rounds",
    "no_work",
    "duplicate_only",
  ] as const) {
    assert.equal(shouldRunEscalationReview(reason), true, reason);
  }
});

test("skips escalation on every non-clean reason", () => {
  for (const reason of [
    "iteration_cap_exhausted",
    "stuck_issues",
    "open_non_stuck_issues",
    "base_validation_failed",
    "parse_failure",
    "needs_human_review",
    "failure",
    "skipped",
    "success",
  ] as const) {
    assert.equal(shouldRunEscalationReview(reason), false, reason);
  }
});
