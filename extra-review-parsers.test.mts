import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCodeQualityExtraReview,
  parseFollowupIssues,
  parseTwoAxisExtraReview,
} from "./extra-review-parsers.mts";
import type { ParseFailureCode } from "./extra-review-contracts.mts";

test("parser fixtures accept valid reviewer outputs", () => {
  const codeQuality = parseCodeQualityExtraReview(
    tagged("extra_review", validCodeQualityReview()),
  );
  const twoAxis = parseTwoAxisExtraReview(
    tagged("extra_review", validTwoAxisReview()),
  );

  assert.equal(codeQuality.kind, "extra_review");
  assert.equal(codeQuality.reviewer, "code_quality");
  assert.equal(codeQuality.decision, "followup_recommended");
  assert.equal(codeQuality.findings[0]!.source, "code_quality");

  assert.equal(twoAxis.kind, "extra_review");
  assert.equal(twoAxis.reviewer, "two_axis");
  assert.equal(twoAxis.decision, "approved");
  assert.deepEqual(twoAxis.standards_findings, []);
  assert.deepEqual(twoAxis.spec_findings, []);
});

test("parser fixtures accept valid decomposer output", () => {
  const result = parseFollowupIssues(
    tagged("followup_issues", validFollowupIssues()),
  );

  assert.equal(result.kind, "followup_issues");
  assert.equal(result.status, "issues");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.title, "Extract review orchestration helper");
  assert.equal(result.issues[0]!.priority, "high");
  assert.equal(result.issues[0]!.source_findings[0]!.reviewer, "code_quality");
  assert.equal(result.needs_human_review_reason, "");
});

test("parser fixtures reject missing tags", () => {
  assertParseFailure(
    parseCodeQualityExtraReview("reviewer emitted untagged prose"),
    "missing_tag",
  );
  assertParseFailure(
    parseFollowupIssues("decomposer emitted untagged prose"),
    "missing_tag",
  );
});

test("parser fixtures reject malformed JSON", () => {
  assertParseFailure(
    parseFollowupIssues(
      "<followup_issues>{\"status\":\"issues\",\"summary\":</followup_issues>",
    ),
    "malformed_json",
  );
});

test("parser fixtures ignore stray text around a single tagged block", () => {
  const twoAxis = parseTwoAxisExtraReview(
    [
      "Let me think through the standards and spec findings first.",
      tagged("extra_review", validTwoAxisReview()),
      "Done.",
    ].join("\n\n"),
  );
  const followups = parseFollowupIssues(
    [
      "Now I have all the inputs. Let me analyze and decompose the findings.",
      tagged("followup_issues", validFollowupIssues()),
      "Finished decomposing the issues.",
    ].join("\n\n"),
  );

  assert.equal(twoAxis.kind, "extra_review");
  assert.equal(twoAxis.reviewer, "two_axis");
  assert.equal(followups.kind, "followup_issues");
  assert.equal(followups.status, "issues");
  assert.equal(followups.issues.length, 1);
});

test("parser fixtures reject wrong top-level shapes", () => {
  assertParseFailure(
    parseCodeQualityExtraReview("<extra_review>[]</extra_review>"),
    "wrong_top_level_shape",
  );
});

test("parser fixtures reject inconsistent reviewer and decomposer states", () => {
  assertParseFailure(
    parseCodeQualityExtraReview(
      tagged("extra_review", {
        ...validCodeQualityReview(),
        decision: "approved",
      }),
    ),
    "inconsistent_decision",
  );
  assertParseFailure(
    parseFollowupIssues(
      tagged("followup_issues", {
        ...validFollowupIssues(),
        status: "no_work",
      }),
    ),
    "inconsistent_status",
  );
  assertParseFailure(
    parseFollowupIssues(
      tagged("followup_issues", {
        ...validFollowupIssues(),
        issues: [
          {
            ...validFollowupIssues().issues[0],
            source_findings: [
              {
                reviewer: "two_axis",
                finding_id: "CQ-001",
                axis: "code_quality",
                title: "Extract review orchestration helper",
              },
            ],
          },
        ],
      }),
    ),
    "inconsistent_provenance",
  );
});

function tagged(tag: "extra_review" | "followup_issues", value: unknown): string {
  return `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
}

function assertParseFailure(
  result:
    | ReturnType<typeof parseCodeQualityExtraReview>
    | ReturnType<typeof parseTwoAxisExtraReview>
    | ReturnType<typeof parseFollowupIssues>,
  code: ParseFailureCode,
): void {
  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, code);
  assert.equal(result.parse_failure.details[0]!.code, code);
}

function validCodeQualityReview() {
  return {
    reviewer: "code_quality",
    decision: "followup_recommended",
    summary: "Code-quality review found one maintainability follow-up.",
    findings: [
      {
        id: "CQ-001",
        severity: "major",
        confidence: 90,
        title: "Extract review orchestration helper",
        problem: "Session orchestration is duplicated in the runner.",
        impact: "Future extra-review changes will be fragile.",
        recommendation: "Move the sequence into a focused helper.",
        files: ["run-prd-extra-reviews.mts"],
        source: "code_quality",
      },
    ],
  };
}

function validTwoAxisReview() {
  return {
    reviewer: "two_axis",
    decision: "approved",
    summary: "Standards and spec axes passed.",
    standards_findings: [],
    spec_findings: [],
  };
}

function validFollowupIssues() {
  return {
    status: "issues",
    summary: "Converted the actionable finding into one follow-up issue.",
    issues: [
      {
        title: "Extract review orchestration helper",
        body: [
          "## Context",
          "Create a focused helper for sequential extra-review orchestration.",
          "",
          "## Acceptance Criteria",
          "- Session orchestration is isolated from the runner.",
          "",
          "## Provenance",
          "- code_quality CQ-001",
        ].join("\n"),
        priority: "high",
        source_findings: [
          {
            reviewer: "code_quality",
            finding_id: "CQ-001",
            axis: "code_quality",
            title: "Extract review orchestration helper",
          },
        ],
        files: ["run-prd-extra-reviews.mts"],
        dedupe_key: "extract-review-orchestration-helper-cq-001",
      },
    ],
    needs_human_review_reason: "",
  };
}
