import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPrReviewResult,
  combinePrReviewFindings,
  parsePrReviewFixResult,
  parseSpecReview,
  parseStandardsReview,
} from "./pr-review-specialists.mts";

const standardsOutput = `<standards_findings>
{
  "status": "complete",
  "summary": "Found one documented standards violation.",
  "findings": [
    {
      "id": "STD-001",
      "source": "documented_standard",
      "rule": "Service boundaries",
      "reference": "AGENTS.md § Architecture",
      "severity": "high",
      "confidence": 96,
      "file": "src/service.ts",
      "line": 42,
      "problem": "The route bypasses the required service boundary.",
      "impact": "Authorization policy is not applied.",
      "fix": "Route the operation through the existing service boundary."
    }
  ]
}
</standards_findings>`;

const specOutput = `<spec_findings>
{
  "status": "complete",
  "summary": "The headline CLI contract is missing.",
  "findings": [
    {
      "id": "SPEC-001",
      "category": "missing",
      "severity": "high",
      "confidence": 94,
      "spec_source": "Issue #17",
      "spec_reference": "Expose the ingest-game CLI command",
      "file": null,
      "line": null,
      "problem": "The required ingest-game CLI entry point is absent.",
      "impact": "The primary user flow cannot be invoked.",
      "fix": "Implement the required CLI contract; the architecture may require human selection."
    }
  ]
}
</spec_findings>`;

test("architectural standards and spec blockers survive specialist parsing", () => {
  const standards = parseStandardsReview(standardsOutput);
  const spec = parseSpecReview(specOutput);

  assert.equal(standards.kind, "review");
  assert.equal(spec.kind, "review");
  if (standards.kind !== "review" || spec.kind !== "review") return;

  const findings = combinePrReviewFindings(standards.review, spec.review);
  assert.deepEqual(
    findings.map((finding) => ({
      id: finding.id,
      axis: finding.axis,
      severity: finding.severity,
      problem: finding.problem,
    })),
    [
      {
        id: "STD-001",
        axis: "standards",
        severity: "high",
        problem: "The route bypasses the required service boundary.",
      },
      {
        id: "SPEC-001",
        axis: "spec",
        severity: "high",
        problem: "The required ingest-game CLI entry point is absent.",
      },
    ],
  );
});

test("an unresolved high-severity finding still produces a complete review result", () => {
  const standards = parseStandardsReview(standardsOutput);
  const spec = parseSpecReview(specOutput);
  assert.equal(standards.kind, "review");
  assert.equal(spec.kind, "review");
  if (standards.kind !== "review" || spec.kind !== "review") return;
  const findings = combinePrReviewFindings(standards.review, spec.review);

  const parsedFix = parsePrReviewFixResult(JSON.stringify({
    risk: 4,
    summary: "Fixed the service-boundary violation; the CLI contract needs a human architecture decision.",
    dispositions: [
      {
        finding_id: "STD-001",
        disposition: "fixed",
        reason: "Routed the changed endpoint through the existing service and validated its tests.",
      },
      {
        finding_id: "SPEC-001",
        disposition: "not_fixed",
        reason: "The required contract is clear, but selecting the owning CLI architecture is not safe to guess.",
      },
    ],
    notes: "Review completed with one unresolved blocker.",
  }));
  assert.equal(parsedFix.kind, "fix_result");
  if (parsedFix.kind !== "fix_result") return;

  const built = buildPrReviewResult(findings, parsedFix.result);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.result.findings.length, 2);
  assert.deepEqual(
    built.result.fixes_applied.map((finding) => finding.id),
    ["STD-001"],
  );
  assert.match(
    built.result.fixes_applied[0]!.description,
    /Routed the changed endpoint/,
  );
  assert.deepEqual(
    built.result.not_fixed.map((finding) => finding.finding_id),
    ["SPEC-001"],
  );
});

test("finding accounting rejects omissions, duplicates, and unknown ids", () => {
  const standards = parseStandardsReview(standardsOutput);
  const spec = parseSpecReview(specOutput);
  assert.equal(standards.kind, "review");
  assert.equal(spec.kind, "review");
  if (standards.kind !== "review" || spec.kind !== "review") return;
  const findings = combinePrReviewFindings(standards.review, spec.review);

  for (const dispositions of [
    [
      {
        finding_id: "STD-001",
        disposition: "fixed",
        reason: "fixed",
      },
    ],
    [
      {
        finding_id: "STD-001",
        disposition: "fixed",
        reason: "fixed",
      },
      {
        finding_id: "STD-001",
        disposition: "not_fixed",
        reason: "duplicate",
      },
      {
        finding_id: "SPEC-001",
        disposition: "not_fixed",
        reason: "not fixed",
      },
    ],
    [
      {
        finding_id: "STD-001",
        disposition: "fixed",
        reason: "fixed",
      },
      {
        finding_id: "SPEC-001",
        disposition: "not_fixed",
        reason: "not fixed",
      },
      {
        finding_id: "SPEC-999",
        disposition: "fixed",
        reason: "unknown",
      },
    ],
  ]) {
    const parsed = parsePrReviewFixResult(JSON.stringify({
      risk: 3,
      summary: "Disposition test",
      dispositions,
    }));
    assert.equal(parsed.kind, "fix_result");
    if (parsed.kind !== "fix_result") continue;
    const built = buildPrReviewResult(findings, parsed.result);
    assert.equal(built.ok, false);
  }
});

test("specialist parsers reject malformed or blocked acquisition results", () => {
  assert.deepEqual(parseStandardsReview("no tagged result"), {
    kind: "parse_failure",
    message: "missing <standards_findings> block",
  });

  const blocked = parseSpecReview(
    `<spec_findings>{"status":"blocked","summary":"diff missing","findings":[]}</spec_findings>`,
  );
  assert.equal(blocked.kind, "blocked");

  const lowConfidence = parseStandardsReview(
    standardsOutput.replace('"confidence": 96', '"confidence": 69'),
  );
  assert.equal(lowConfidence.kind, "parse_failure");
});
