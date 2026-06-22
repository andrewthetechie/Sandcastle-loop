import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExtraReviewArtifactWriteError,
  type ExtraReviewCreatedIssueRecord,
  type ExtraReviewSkippedDuplicateIssueRecord,
  writeExtraReviewRoundArtifacts,
} from "./extra-review-support.mts";
import type {
  CodeQualityExtraReviewParseResult,
  FollowupIssueDraft,
  FollowupIssuesParseResult,
  TwoAxisExtraReviewParseResult,
} from "./extra-review-support.mts";

test("successful round writes raw, parsed, issue records, and handoff", () => {
  withTempRunsRoot((runsRootDir) => {
    const result = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: {
        number: 1,
        label: "prd-001",
        path: "docs/prd/001-extra-review.md",
        title: "Extra review",
      },
      round: { id: "round-01-head-abc123", number: 1 },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "success",
      outputs: successfulOutputs(),
      createdIssues: [createdIssueRecord()],
      skippedDuplicateIssues: [skippedDuplicateRecord()],
    });

    assert.equal(result.paths.prdDirName, "prd-001");
    assert.equal(result.paths.roundDirName, "round-01-head-abc123");
    assertFile(result.paths.files.codeReviewRaw);
    assertFile(result.paths.files.codeReviewParsed);
    assertFile(result.paths.files.twoAxisReviewRaw);
    assertFile(result.paths.files.twoAxisReviewParsed);
    assertFile(result.paths.files.issueDecomposerRaw);
    assertFile(result.paths.files.issueDecomposerParsed);
    assertFile(result.paths.files.createdIssues);
    assertFile(result.paths.files.skippedDuplicateIssues);
    assertFile(result.paths.files.handoff);

    const createdRecords = JSON.parse(read(result.paths.files.createdIssues));
    assert.equal(createdRecords[0].issue_number, 101);
    const skippedRecords = JSON.parse(
      read(result.paths.files.skippedDuplicateIssues),
    );
    assert.equal(skippedRecords[0].existing_issue_number, 88);

    const handoff = read(result.paths.files.handoff);
    assert.match(handoff, /^# Extra Review Round Handoff/m);
    assert.match(handoff, /PRD: prd-001 \/ #1/);
    assert.match(handoff, /Round: round-01-head-abc123 \/ #1/);
    assert.match(handoff, /Review base: base-sha/);
    assert.match(handoff, /Reviewed head: head-sha/);
    assert.match(handoff, /Stop reason: success/);
    assert.match(handoff, /#101/);
    assert.match(handoff, /existing #88/);
    assert.match(handoff, /Raw code-review output:/);
  });
});

test("parse-failure round writes raw failing output and handoff", () => {
  withTempRunsRoot((runsRootDir) => {
    const result = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-02-parse-failure" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "parse_failure",
      outputs: {
        codeReview: {
          raw: "reviewer emitted prose without a tag",
          parsed: codeReviewParseFailure(),
        },
      },
    });

    assertFile(result.paths.files.codeReviewRaw);
    assertFile(result.paths.files.codeReviewParsed);
    assertFile(result.paths.files.createdIssues);
    assertFile(result.paths.files.skippedDuplicateIssues);

    const handoff = read(result.paths.files.handoff);
    assert.match(handoff, /Stop reason: parse-failure/);
    assert.match(handoff, /could not be parsed/);
    assert.match(handoff, /Code-review output could not be parsed/);
    assert.match(handoff, /missing_tag/);
  });
});

test("needs-human-review decomposition round writes available data and handoff", () => {
  withTempRunsRoot((runsRootDir) => {
    const result = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-03-human-review" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "needs_human_review",
      outputs: {
        codeReview: {
          raw: "<extra_review>{...}</extra_review>",
          parsed: codeQualityReview("approved"),
        },
        issueDecomposer: {
          raw: "<followup_issues>{...}</followup_issues>",
          parsed: {
            kind: "followup_issues",
            status: "needs_human_review",
            summary: "Findings conflict and require a person.",
            issues: [],
            needs_human_review_reason:
              "The two reviewers disagree about whether the diff is in scope.",
          },
        },
      },
    });

    assertFile(result.paths.files.codeReviewRaw);
    assertFile(result.paths.files.issueDecomposerParsed);
    const handoff = read(result.paths.files.handoff);
    assert.match(handoff, /Stop reason: needs-human-review/);
    assert.match(handoff, /requires human review/);
    assert.match(handoff, /two reviewers disagree/);
  });
});

test("no-work round handoff explains why no issues were created", () => {
  withTempRunsRoot((runsRootDir) => {
    const result = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-04-no-work" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "no_work",
      outputs: {
        issueDecomposer: {
          raw: "<followup_issues>{...}</followup_issues>",
          parsed: {
            kind: "followup_issues",
            status: "no_work",
            summary: "Reviewers approved the completed branch.",
            issues: [],
            needs_human_review_reason: "",
          },
        },
      },
    });

    const handoff = read(result.paths.files.handoff);
    assert.match(handoff, /Stop reason: no-work/);
    assert.match(handoff, /decomposer reported no_work/);
    assert.match(handoff, /No created issue records/);
  });
});

test("duplicate-only round handoff explains that all issues were skipped", () => {
  withTempRunsRoot((runsRootDir) => {
    const result = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-05-duplicates" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "duplicate_only",
      outputs: {
        issueDecomposer: {
          raw: "<followup_issues>{...}</followup_issues>",
          parsed: followupIssuesWithDraft(),
        },
      },
      skippedDuplicateIssues: [skippedDuplicateRecord()],
    });

    const handoff = read(result.paths.files.handoff);
    assert.match(handoff, /Stop reason: duplicate-only/);
    assert.match(handoff, /all decomposed issues matched existing duplicates/);
    assert.match(handoff, /existing #88/);
  });
});

test("skipped and failure rounds write handoffs without agent outputs", () => {
  withTempRunsRoot((runsRootDir) => {
    const skipped = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-06-skipped" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "skipped",
      stopDetails: ["Operator skipped the extra review gate for this fixture."],
    });
    const failed = writeExtraReviewRoundArtifacts({
      runsRootDir,
      prd: { number: 1 },
      round: { id: "round-07-failure" },
      reviewBase: "base-sha",
      reviewedHead: "head-sha",
      stopReason: "failure",
      stopDetails: ["Fixture command exited 2 before producing JSON."],
    });

    const skippedHandoff = read(skipped.paths.files.handoff);
    assert.match(skippedHandoff, /Stop reason: skipped/);
    assert.match(skippedHandoff, /Operator skipped/);
    assert.match(skippedHandoff, /No raw agent output artifacts were provided/);

    const failedHandoff = read(failed.paths.files.handoff);
    assert.match(failedHandoff, /Stop reason: failure/);
    assert.match(failedHandoff, /Fixture command exited 2/);
    assert.match(failedHandoff, /Round failed before structured completion/);
  });
});

test("artifact write failures throw a clear error", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "extra-review-artifacts-"));
  try {
    const runsRootDir = join(tempDir, "runs-root-file");
    writeFileSync(runsRootDir, "not a directory", "utf8");

    assert.throws(
      () =>
        writeExtraReviewRoundArtifacts({
          runsRootDir,
          prd: { number: 1 },
          round: { id: "round-08-write-failure" },
          reviewBase: "base-sha",
          reviewedHead: "head-sha",
          stopReason: "failure",
        }),
      (err) => {
        assert.ok(err instanceof ExtraReviewArtifactWriteError);
        assert.match(err.message, /Could not create artifact directory/);
        assert.match(err.message, /extra-review artifact/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function successfulOutputs() {
  return {
    codeReview: {
      raw: "<extra_review>{...code quality...}</extra_review>",
      parsed: codeQualityReview("followup_recommended"),
    },
    twoAxisReview: {
      raw: "<extra_review>{...two axis...}</extra_review>",
      parsed: twoAxisReview(),
    },
    issueDecomposer: {
      raw: "<followup_issues>{...issues...}</followup_issues>",
      parsed: followupIssuesWithDraft(),
    },
  };
}

function codeQualityReview(
  decision: "approved" | "followup_recommended",
): CodeQualityExtraReviewParseResult {
  return {
    kind: "extra_review",
    reviewer: "code_quality",
    decision,
    summary: "One maintainability follow-up was found.",
    findings:
      decision === "approved"
        ? []
        : [
            {
              id: "cq-1",
              severity: "major",
              confidence: 88,
              title: "Persist round artifacts",
              problem: "Review outputs are not saved.",
              impact: "Operators cannot resume failed review rounds.",
              recommendation: "Write raw and parsed artifacts per round.",
              files: ["run-prd-extra-reviews.mts"],
              source: "code_quality",
            },
          ],
  };
}

function twoAxisReview(): TwoAxisExtraReviewParseResult {
  return {
    kind: "extra_review",
    reviewer: "two_axis",
    decision: "followup_recommended",
    summary: "The implementation needs a handoff artifact.",
    standards_findings: [
      {
        id: "std-1",
        severity: "major",
        confidence: 91,
        title: "Missing handoff",
        problem: "The round has no continuation document.",
        impact: "A human cannot pick up from the failure point.",
        recommendation: "Write HANDOFF.md with stop reason and artifacts.",
        files: ["run-prd-extra-reviews.mts"],
        source: "standards",
      },
    ],
    spec_findings: [],
  };
}

function followupIssuesWithDraft(): FollowupIssuesParseResult {
  return {
    kind: "followup_issues",
    status: "issues",
    summary: "Create one follow-up issue.",
    issues: [issueDraft()],
    needs_human_review_reason: "",
  };
}

function codeReviewParseFailure(): CodeQualityExtraReviewParseResult {
  return {
    kind: "parse_failure",
    reviewer: "code_quality",
    decision: "needs_human_review",
    summary: "Code-review output was missing the required tag.",
    findings: [],
    parse_failure: {
      parser: "code_quality_extra_review",
      expected_tag: "extra_review",
      code: "missing_tag",
      summary: "Missing <extra_review>...</extra_review> block.",
      details: [
        {
          code: "missing_tag",
          path: "$",
          message: "Expected exactly one <extra_review>...</extra_review> block.",
          expected: "<extra_review>...</extra_review>",
          actual: "no complete tag block",
        },
      ],
      stdout_preview: "reviewer emitted prose without a tag",
    },
  };
}

function createdIssueRecord(): ExtraReviewCreatedIssueRecord {
  return {
    status: "created",
    title: "Persist extra-review artifacts",
    dedupe_key: "extra-review-artifacts",
    priority: "high",
    body: issueDraft().body,
    files: issueDraft().files,
    source_findings: issueDraft().source_findings,
    issue_number: 101,
    issue_url: "https://example.invalid/issues/101",
  };
}

function skippedDuplicateRecord(): ExtraReviewSkippedDuplicateIssueRecord {
  return {
    status: "skipped_duplicate",
    title: "Persist extra-review artifacts",
    dedupe_key: "extra-review-artifacts",
    reason: "Matching dedupe_key already exists.",
    priority: "high",
    body: issueDraft().body,
    files: issueDraft().files,
    source_findings: issueDraft().source_findings,
    existing_issue_number: 88,
    existing_issue_url: "https://example.invalid/issues/88",
  };
}

function issueDraft(): FollowupIssueDraft {
  return {
    title: "Persist extra-review artifacts",
    body: [
      "## Description",
      "Persist extra-review round artifacts.",
      "",
      "## Acceptance Criteria",
      "- Raw and parsed outputs are written.",
      "",
      "## Provenance",
      "- Source finding cq-1.",
    ].join("\n"),
    priority: "high",
    source_findings: [
      {
        reviewer: "code_quality",
        finding_id: "cq-1",
        axis: "code_quality",
        title: "Persist round artifacts",
      },
    ],
    files: ["extra-review-artifacts.mts"],
    dedupe_key: "extra-review-artifacts",
  };
}

function withTempRunsRoot(fn: (runsRootDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "extra-review-artifacts-"));
  try {
    fn(join(tempDir, ".sandcastle", "extra-review-runs"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertFile(path: string): void {
  assert.equal(existsSync(path), true, `${path} should exist`);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}
