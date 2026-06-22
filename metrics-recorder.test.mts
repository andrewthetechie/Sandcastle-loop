import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIssueOutcomeRecord,
  buildMeasuredAgentRunRecord,
  buildValidationRunRecord,
} from "./metrics-recorder.mts";

test("buildValidationRunRecord computes elapsed and tags the kind", () => {
  const record = buildValidationRunRecord(
    {
      prd: 2,
      issue: 47,
      round: 3,
      gate: "issue",
      command: "npm run test",
      commandIndex: 1,
    },
    { startedMs: 1_000, endedMs: 4_500, status: "failed", exitCode: 1 },
  );
  assert.equal(record.kind, "sandcastle_validation_run");
  assert.equal(record.schema_version, 1);
  assert.equal(record.prd, 2);
  assert.equal(record.issue, 47);
  assert.equal(record.gate, "issue");
  assert.equal(record.command, "npm run test");
  assert.equal(record.command_index, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.exit_code, 1);
  assert.equal(record.elapsed_ms, 3_500);
});

test("buildValidationRunRecord allows a base gate with no issue", () => {
  const record = buildValidationRunRecord(
    {
      prd: 2,
      round: "base",
      gate: "base",
      command: "npm run build",
      commandIndex: 2,
    },
    { startedMs: 0, endedMs: 10, status: "success", exitCode: 0 },
  );
  assert.equal(record.issue, undefined);
  assert.equal(record.gate, "base");
  assert.equal(record.elapsed_ms, 10);
});

test("buildMeasuredAgentRunRecord includes coder agent metadata", () => {
  const record = buildMeasuredAgentRunRecord(
    {
      prd: 3,
      issue: 7,
      stage: "implement",
      agent: "coder",
      round: 1,
      model: "claude-sonnet-4",
      runName: "prd-003-issue-007-coder",
      promptFile: "coder-user-prompt-prd.md",
      promptArgs: { zeta: "last", alpha: "first" },
    },
    {
      runId: "run-3-7-implement-1-1000-abc",
      startedMs: 1_000,
      endedMs: 2_500,
      status: "success",
    },
  );
  assert.equal(record.kind, "sandcastle_agent_run");
  assert.equal(record.schema_version, 1);
  assert.equal(record.stage, "implement");
  assert.equal(record.agent, "coder");
  assert.equal(record.model, "claude-sonnet-4");
  assert.equal(record.run_name, "prd-003-issue-007-coder");
  assert.equal(record.status, "success");
  assert.equal(record.elapsed_ms, 1_500);
  assert.deepEqual(record.prompt_arg_keys, ["alpha", "zeta"]);
});

test("buildMeasuredAgentRunRecord includes rework agent metadata", () => {
  const record = buildMeasuredAgentRunRecord(
    {
      prd: 3,
      issue: 7,
      stage: "rework",
      agent: "rework",
      round: 2,
      model: "claude-sonnet-4",
      runName: "prd-003-issue-007-rework",
    },
    {
      runId: "run-3-7-rework-2-5000-def",
      startedMs: 5_000,
      endedMs: 9_000,
      status: "error",
      error: "agent exited non-zero",
    },
  );
  assert.equal(record.kind, "sandcastle_agent_run");
  assert.equal(record.schema_version, 1);
  assert.equal(record.stage, "rework");
  assert.equal(record.agent, "rework");
  assert.equal(record.model, "claude-sonnet-4");
  assert.equal(record.run_name, "prd-003-issue-007-rework");
  assert.equal(record.status, "error");
  assert.equal(record.elapsed_ms, 4_000);
  assert.equal(record.error, "agent exited non-zero");
});

test("buildIssueOutcomeRecord records the terminal outcome and rounds", () => {
  const record = buildIssueOutcomeRecord({
    prd: 2,
    issue: 47,
    outcome: "stuck_no_progress",
    roundsUsed: 3,
  });
  assert.equal(record.kind, "sandcastle_issue_outcome");
  assert.equal(record.outcome, "stuck_no_progress");
  assert.equal(record.rounds_used, 3);
  assert.equal(record.issue, 47);
});

test("buildIssueOutcomeRecord records stuck_livelock outcome", () => {
  const record = buildIssueOutcomeRecord({
    prd: 3,
    issue: 14,
    outcome: "stuck_livelock",
    roundsUsed: 2,
  });
  assert.equal(record.kind, "sandcastle_issue_outcome");
  assert.equal(record.outcome, "stuck_livelock");
  assert.equal(record.rounds_used, 2);
  assert.equal(record.issue, 14);
});
