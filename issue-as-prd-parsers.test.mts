import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseInitialIssueDecomposition,
  parseSubtaskReadiness,
} from "./issue-as-prd-parsers.mts";

test("parses initial issue decomposition issues result", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "issues",
  "summary": "Two independent slices are required.",
  "issues": [
    {
      "title": "Extract parser contract",
      "body": "## User Story\\nAs a host...\\n## Context\\nNeed strict parsing.\\n## Acceptance Criteria\\n- Parse tagged JSON.",
      "priority": "high",
      "files": ["issue-as-prd-parsers.mts", "issue-as-prd-contracts.mts"],
      "dedupe_key": "extract-parser-contract-json"
    }
  ],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "initial_issue_decomposition");
  assert.equal(result.status, "issues");
  assert.equal(result.issues.length, 1);
});

test("parses initial issue decomposition no_work result", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "no_work",
  "summary": "The parent issue is already implementation-ready.",
  "issues": [],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "initial_issue_decomposition");
  assert.equal(result.status, "no_work");
});

test("parses initial issue decomposition needs_human_review result", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "needs_human_review",
  "summary": "The requirements conflict.",
  "issues": [],
  "needs_human_review_reason": "Parent comments demand mutually exclusive approaches."
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "initial_issue_decomposition");
  assert.equal(result.status, "needs_human_review");
});

test("parses readiness fixed result", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "fixed",
  "summary": "The body was clarified from the parent context.",
  "evidence": ["Parent body names the exact module.", "Sibling list shows no overlap."],
  "proposed_body": "## User Story\\nAs an operator...\\n## Context\\nNeed exact module scope.\\n## Acceptance Criteria\\n- Update one parser only.",
  "close_reason": ""
}
</subtask_readiness>`);

  assert.equal(result.kind, "subtask_readiness");
  assert.equal(result.disposition, "fixed");
});

test("parses readiness assumed result when the body contains an assumptions section", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "assumed",
  "summary": "One narrow assumption is required to make the task implementable.",
  "evidence": ["No parent comment defines the retry budget."],
  "proposed_body": "## User Story\\nAs an operator...\\n## Context\\nNeed a safe default.\\n## Assumptions\\n- Retry budget remains two attempts.\\n## Acceptance Criteria\\n- Mention the retry budget explicitly.",
  "close_reason": ""
}
</subtask_readiness>`);

  assert.equal(result.kind, "subtask_readiness");
  assert.equal(result.disposition, "assumed");
});

test("parses readiness not_actionable result", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "not_actionable",
  "summary": "The child would only duplicate a sibling issue.",
  "evidence": ["Sibling #42 already owns the exact file set."],
  "proposed_body": "## User Story\\nAs an operator...\\n## Context\\nThis would duplicate sibling work.\\n## Acceptance Criteria\\n- Do not open the child.",
  "close_reason": "Duplicate of active sibling #42."
}
</subtask_readiness>`);

  assert.equal(result.kind, "subtask_readiness");
  assert.equal(result.disposition, "not_actionable");
});

test("rejects surrounding prose outside the initial decomposition tag", () => {
  const result = parseInitialIssueDecomposition(`
note first
<initial_issue_decomposition>
{"kind":"initial_issue_decomposition","status":"no_work","summary":"done","issues":[],"needs_human_review_reason":""}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "unexpected_text");
});

test("rejects missing initial decomposition tag", () => {
  const result = parseInitialIssueDecomposition(`{"status":"no_work"}`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "missing_tag");
});

test("rejects multiple initial decomposition tags", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>{"kind":"initial_issue_decomposition","status":"no_work","summary":"a","issues":[],"needs_human_review_reason":""}</initial_issue_decomposition>
<initial_issue_decomposition>{"kind":"initial_issue_decomposition","status":"no_work","summary":"b","issues":[],"needs_human_review_reason":""}</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "multiple_tags");
});

test("rejects malformed initial decomposition JSON", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{"kind":"initial_issue_decomposition",
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "malformed_json");
});

test("rejects initial decomposition with an unknown top-level field", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "no_work",
  "summary": "done",
  "issues": [],
  "needs_human_review_reason": "",
  "extra": true
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "unexpected_field");
});

test("rejects initial decomposition with duplicate file paths", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "issues",
  "summary": "Need one issue.",
  "issues": [
    {
      "title": "Duplicate files",
      "body": "Body",
      "priority": "high",
      "files": ["a.ts", "a.ts"],
      "dedupe_key": "duplicate-files"
    }
  ],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "invalid_field_value");
});

test("rejects initial decomposition issues status with an empty issues array", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "issues",
  "summary": "Need work.",
  "issues": [],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_status");
});

test("rejects initial decomposition no_work status with issues present", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "no_work",
  "summary": "No work.",
  "issues": [
    {
      "title": "Should not exist",
      "body": "Body",
      "priority": "low",
      "files": ["a.ts"],
      "dedupe_key": "should-not-exist"
    }
  ],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_status");
});

test("rejects initial decomposition needs_human_review status with an empty reason", () => {
  const result = parseInitialIssueDecomposition(`
<initial_issue_decomposition>
{
  "kind": "initial_issue_decomposition",
  "status": "needs_human_review",
  "summary": "Blocked.",
  "issues": [],
  "needs_human_review_reason": ""
}
</initial_issue_decomposition>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_status");
});

test("rejects readiness with missing tag", () => {
  const result = parseSubtaskReadiness(`{"kind":"subtask_readiness"}`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "missing_tag");
});

test("rejects readiness with surrounding prose", () => {
  const result = parseSubtaskReadiness(`
prefix
<subtask_readiness>
{"kind":"subtask_readiness","disposition":"fixed","summary":"ok","evidence":["a"],"proposed_body":"Body","close_reason":""}
</subtask_readiness>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "unexpected_text");
});

test("rejects readiness with an empty evidence array", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "fixed",
  "summary": "Missing evidence.",
  "evidence": [],
  "proposed_body": "Body",
  "close_reason": ""
}
</subtask_readiness>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "invalid_field_value");
});

test("rejects readiness assumed result without an assumptions section", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "assumed",
  "summary": "Assumption required.",
  "evidence": ["No parent comment names the command."],
  "proposed_body": "## User Story\\nAs an operator...\\n## Context\\nNeed a default.\\n## Acceptance Criteria\\n- Add a default.",
  "close_reason": ""
}
</subtask_readiness>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_disposition");
});

test("rejects readiness fixed result with a close reason", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "fixed",
  "summary": "Should stay open.",
  "evidence": ["The task is actionable."],
  "proposed_body": "Body",
  "close_reason": "should be empty"
}
</subtask_readiness>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_disposition");
});

test("rejects readiness not_actionable result with an empty close reason", () => {
  const result = parseSubtaskReadiness(`
<subtask_readiness>
{
  "kind": "subtask_readiness",
  "disposition": "not_actionable",
  "summary": "Cannot proceed.",
  "evidence": ["Missing an upstream product decision."],
  "proposed_body": "Body",
  "close_reason": ""
}
</subtask_readiness>`);

  assert.equal(result.kind, "parse_failure");
  assert.equal(result.parse_failure.code, "inconsistent_disposition");
});
