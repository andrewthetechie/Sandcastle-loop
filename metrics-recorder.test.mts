import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { test } from "node:test";
import {
  buildIssueOutcomeRecord,
  buildMeasuredAgentRunRecord,
  buildReviewerResultRecord,
  buildValidationRunRecord,
  recordMeasuredAgentRun,
} from "./metrics-recorder.mts";

interface AgentStepCall {
  stage: string;
  agent?: string;
  model?: string;
  worktreePath?: string;
  activeLogPath?: string;
}

/**
 * Run `body` with cwd pointed at a throwaway dir so the metric append lands in a
 * temp `.sandcastle/metrics/runs.jsonl` instead of the repo's.
 */
async function withTempCwd(body: () => Promise<void>): Promise<void> {
  const previous = cwd();
  const dir = mkdtempSync(join(tmpdir(), "metrics-recorder-"));
  chdir(dir);
  try {
    await body();
  } finally {
    chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test("buildIssueOutcomeRecord records reviewer terminal outcomes distinctly", () => {
  const parseFailure = buildIssueOutcomeRecord({
    prd: 3,
    issue: 14,
    outcome: "stuck_reviewer_parse_failure",
    roundsUsed: 2,
  });
  assert.equal(parseFailure.outcome, "stuck_reviewer_parse_failure");

  const incomplete = buildIssueOutcomeRecord({
    prd: 3,
    issue: 14,
    outcome: "stuck_reviewer_incomplete",
    roundsUsed: 2,
  });
  assert.equal(incomplete.outcome, "stuck_reviewer_incomplete");

  const humanReview = buildIssueOutcomeRecord({
    prd: 3,
    issue: 14,
    outcome: "stuck_needs_human_review",
    roundsUsed: 1,
  });
  assert.equal(humanReview.outcome, "stuck_needs_human_review");
});

test("recordMeasuredAgentRun reports the agent step exactly once on success", async () => {
  await withTempCwd(async () => {
    const calls: AgentStepCall[] = [];
    const result = await recordMeasuredAgentRun(
      {
        prd: 4,
        issue: 7,
        stage: "coder",
        agent: "coder",
        round: 1,
        model: "anthropic/claude-sonnet-4-5",
        runName: "prd-004-issue-007-coder",
        worktreePath: "/worktree",
        activeLogPath: "/repo/.sandcastle/tui/logs/coder.log",
      },
      async () => "run-value",
      { beginAgentStep: (input) => calls.push(input) },
    );

    assert.equal(result, "run-value");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      stage: "coder",
      agent: "coder",
      model: "anthropic/claude-sonnet-4-5",
      worktreePath: "/worktree",
      activeLogPath: "/repo/.sandcastle/tui/logs/coder.log",
    });
  });
});

test("recordMeasuredAgentRun reports the agent step once even when the run throws", async () => {
  await withTempCwd(async () => {
    let calls = 0;
    await assert.rejects(
      recordMeasuredAgentRun(
        {
          prd: 4,
          stage: "reviewer",
          agent: "reviewer",
          round: 1,
          model: "glm",
          runName: "reviewer #7 r1 a1",
        },
        async () => {
          throw new Error("agent boom");
        },
        {
          beginAgentStep: () => {
            calls += 1;
          },
        },
      ),
      /agent boom/,
    );
    assert.equal(calls, 1);
  });
});

test("buildReviewerResultRecord captures attempt metadata and result source", () => {
  const record = buildReviewerResultRecord({
    prd: 3,
    issue: 14,
    round: 2,
    attempt: 2,
    maxAttempts: 3,
    status: "changes_requested",
    resultSource: "run_log",
    logFallbackUsed: true,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(record.kind, "sandcastle_reviewer_result");
  assert.equal(record.status, "changes_requested");
  assert.equal(record.result_source, "run_log");
  assert.equal(record.log_fallback_used, true);
  assert.equal(record.attempt, 2);
  assert.equal(record.max_attempts, 3);
});
