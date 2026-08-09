import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allRiskLabels,
  isRiskLabel,
  renderPrReviewComment,
  validatePrReviewResult,
} from "./pr-review-result.mts";

function validResult(): ReturnType<typeof validatePrReviewResult> & { ok: true } {
  const raw = JSON.stringify({
    risk: 2,
    summary: "Small refactor with clean tests.",
    findings: [
      {
        severity: "warning",
        description: "Variable name shadowed outer scope.",
        file: "src/lib.ts",
        line: 42,
      },
    ],
    fixes_applied: [
      {
        severity: "warning",
        description: "Renamed variable to avoid shadowing.",
        file: "src/lib.ts",
      },
    ],
    not_fixed: [
      {
        original_finding: "Consider caching the lookup.",
        reason: "Performance claim was speculative; no measurable issue shown.",
      },
    ],
    notes: "Validated with existing test suite.",
  });
  const validated = validatePrReviewResult(raw);
  assert.equal(validated.ok, true);
  return validated as ReturnType<typeof validatePrReviewResult> & { ok: true };
}

test("validates a complete result", () => {
  const { result } = validResult();
  assert.equal(result.risk, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.fixes_applied[0]!.severity, "warning");
});

test("rejects invalid JSON", () => {
  const outcome = validatePrReviewResult("not json");
  assert.equal(outcome.ok, false);
  assert.match((outcome as { errors: string[] }).errors[0]!, /invalid JSON/);
});

test("rejects missing or out-of-range risk", () => {
  for (const risk of [-1, 6, 1.5, "two"]) {
    const outcome = validatePrReviewResult(
      JSON.stringify({
        risk,
        summary: "x",
        findings: [],
        fixes_applied: [],
        not_fixed: [],
      }),
    );
    assert.equal(outcome.ok, false);
    assert.ok(
      (outcome as { errors: string[] }).errors.some((e) =>
        e.includes("risk must be an integer between 0 and 5"),
      ),
      `expected risk error for ${JSON.stringify(risk)}`,
    );
  }
});

test("rejects missing summary", () => {
  const outcome = validatePrReviewResult(
    JSON.stringify({
      risk: 1,
      findings: [],
      fixes_applied: [],
      not_fixed: [],
    }),
  );
  assert.equal(outcome.ok, false);
  assert.ok(
    (outcome as { errors: string[] }).errors.some((e) =>
      e.includes("summary must be a non-empty string"),
    ),
  );
});

test("rejects malformed findings", () => {
  const outcome = validatePrReviewResult(
    JSON.stringify({
      risk: 1,
      summary: "x",
      findings: [{ severity: "bad", description: "desc" }],
      fixes_applied: [],
      not_fixed: [],
    }),
  );
  assert.equal(outcome.ok, false);
  assert.ok(
    (outcome as { errors: string[] }).errors.some((e) =>
      e.includes("severity must be one of"),
    ),
  );
});

test("rejects malformed rejected findings", () => {
  const outcome = validatePrReviewResult(
    JSON.stringify({
      risk: 1,
      summary: "x",
      findings: [],
      fixes_applied: [],
      not_fixed: [{ reason: "reason only" }],
    }),
  );
  assert.equal(outcome.ok, false);
  assert.ok(
    (outcome as { errors: string[] }).errors.some((e) =>
      e.includes("original_finding"),
    ),
  );
});

test("renderPrReviewComment includes risk, SHA, sections and fix count", () => {
  const { result } = validResult();
  const comment = renderPrReviewComment({
    result,
    reviewedHeadSha: "abc1234",
    commitCount: 1,
  });
  assert.match(comment, /risk 2\/5/);
  assert.match(comment, /Reviewed HEAD: `abc1234`/);
  assert.match(comment, /The reviewer applied 1 fix commit\(s\)\./);
  assert.match(comment, /### Findings/);
  assert.match(comment, /### Fixes applied/);
  assert.match(comment, /### Not fixed and why/);
  assert.match(comment, /### Notes/);
  assert.match(comment, /src\/lib\.ts:42/);
});

test("renderPrReviewComment omits fix count and notes when absent", () => {
  const { result } = validResult();
  const comment = renderPrReviewComment({
    result: { ...result, notes: undefined },
    reviewedHeadSha: "def5678",
    commitCount: 0,
  });
  assert.doesNotMatch(comment, /fix commit/);
  assert.doesNotMatch(comment, /### Notes/);
});

test("isRiskLabel and allRiskLabels", () => {
  assert.equal(isRiskLabel("risk-2"), true);
  assert.equal(isRiskLabel("risk-6"), false);
  assert.equal(isRiskLabel("ai-review-complete"), false);
  assert.deepEqual(allRiskLabels(), [
    "risk-0",
    "risk-1",
    "risk-2",
    "risk-3",
    "risk-4",
    "risk-5",
  ]);
});
