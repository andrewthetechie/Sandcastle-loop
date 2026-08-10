import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { test } from "node:test";
import {
  INITIAL_ISSUE_DECOMPOSER_STAGE,
  SUBTASK_READINESS_STAGE,
  acquireInitialDecomposition,
  acquireSubtaskImprovement,
  acquireSubtaskReadiness,
  buildInitialIssueDecomposerRunName,
  buildSubtaskReadinessRunName,
  extractSingleTaggedOutput,
} from "./issue-as-prd-sessions.mts";

interface AgentStepCall {
  stage: string;
  agent?: string;
  model?: string;
  worktreePath?: string;
  activeLogPath?: string;
}

async function withTempCwd(body: () => Promise<void>): Promise<void> {
  const previous = cwd();
  const dir = mkdtempSync(join(tmpdir(), "issue-as-prd-sessions-"));
  chdir(dir);
  try {
    await body();
  } finally {
    chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("acquireInitialDecomposition succeeds on the first valid attempt and records the measured run", async () => {
  await withTempCwd(async () => {
    const calls: AgentStepCall[] = [];
    const attempts: Array<1 | 2> = [];

    const result = await acquireInitialDecomposition({
      prd: 5,
      parentIssueNumber: 17,
      model: "glm",
      round: 1,
      worktreePath: "/repo/worktree",
      promptFile: "./initial-issue-decomposer-user-prompt-prd.md",
      promptArgs: { PARENT_ISSUE_NUMBER: "17" },
      workingLogPathForAttempt: (attempt) => `/logs/initial-${attempt}.log`,
      measuredRunDeps: { beginAgentStep: (input) => calls.push(input) },
      runAttempt: async (attempt) => {
        attempts.push(attempt);
        return {
          stdout: `
<initial_issue_decomposition>
{"kind":"initial_issue_decomposition","status":"no_work","summary":"Already scoped.","issues":[],"needs_human_review_reason":""}
</initial_issue_decomposition>`,
        };
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attemptsUsed, 1);
    assert.deepEqual(attempts, [1]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.logFilePath), [
      "/logs/initial-1.log",
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      stage: INITIAL_ISSUE_DECOMPOSER_STAGE,
      agent: INITIAL_ISSUE_DECOMPOSER_STAGE,
      model: "glm",
      worktreePath: "/repo/worktree",
      activeLogPath: "/logs/initial-1.log",
    });
  });
});

test("acquireInitialDecomposition retries after malformed output and succeeds on attempt two", async () => {
  await withTempCwd(async () => {
    const attempts: Array<1 | 2> = [];

    const result = await acquireInitialDecomposition({
      prd: 5,
      parentIssueNumber: 17,
      model: "glm",
      round: 1,
      promptFile: "./initial-issue-decomposer-user-prompt-prd.md",
      promptArgs: { PARENT_ISSUE_NUMBER: "17" },
      workingLogPathForAttempt: (attempt) => `/logs/initial-${attempt}.log`,
      runAttempt: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          return { stdout: "<initial_issue_decomposition>{</initial_issue_decomposition>" };
        }
        return {
          stdout: `
<initial_issue_decomposition>
{"kind":"initial_issue_decomposition","status":"issues","summary":"Need one child.","issues":[{"title":"Child","body":"## User Story\\nAs a host...\\n## Context\\nNeed a child.\\n## Acceptance Criteria\\n- Open one child.","priority":"high","files":["a.ts"],"dedupe_key":"child-a"}],"needs_human_review_reason":""}
</initial_issue_decomposition>`,
        };
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attemptsUsed, 2);
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(result.artifacts.length, 2);
    assert.match(result.artifacts[0]!.diagnostics[0]!, /parse failure/);
  });
});

test("acquireInitialDecomposition consumes the second attempt after needs_human_review and fails exhausted when both attempts stay non-usable", async () => {
  await withTempCwd(async () => {
    const result = await acquireInitialDecomposition({
      prd: 5,
      parentIssueNumber: 17,
      model: "glm",
      round: 1,
      promptFile: "./initial-issue-decomposer-user-prompt-prd.md",
      promptArgs: { PARENT_ISSUE_NUMBER: "17" },
      runAttempt: async (attempt) => ({
        stdout: `
<initial_issue_decomposition>
{"kind":"initial_issue_decomposition","status":"needs_human_review","summary":"Blocked on ambiguity.","issues":[],"needs_human_review_reason":"attempt ${attempt} ambiguous"}
</initial_issue_decomposition>`,
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.artifacts.length, 2);
    assert.match(result.artifacts[0]!.diagnostics[0]!, /needs_human_review/);
    assert.match(result.artifacts[1]!.diagnostics[0]!, /needs_human_review/);
  });
});

test("acquireInitialDecomposition retains invocation and parser diagnostics across exhaustion", async () => {
  await withTempCwd(async () => {
    const result = await acquireInitialDecomposition({
      prd: 5,
      parentIssueNumber: 17,
      model: "glm",
      round: 1,
      promptFile: "./initial-issue-decomposer-user-prompt-prd.md",
      promptArgs: { PARENT_ISSUE_NUMBER: "17" },
      runAttempt: async (attempt) => {
        if (attempt === 1) throw new Error("sandbox exited non-zero");
        return {
          stdout: "<initial_issue_decomposition>{</initial_issue_decomposition>",
        };
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.artifacts[0]!.stdout, "");
    assert.match(result.artifacts[0]!.diagnostics[0]!, /invocation error/);
    assert.match(result.artifacts[1]!.diagnostics[0]!, /parse failure/);
    assert.equal(result.diagnostics.length, 2);
  });
});

test("acquireSubtaskReadiness retries after missing tag and succeeds on attempt two", async () => {
  await withTempCwd(async () => {
    const calls: AgentStepCall[] = [];

    const result = await acquireSubtaskReadiness({
      prd: 5,
      childIssueNumber: 22,
      model: "glm",
      round: 4,
      worktreePath: "/repo/worktree",
      promptFile: "./subtask-readiness-user-prompt-prd.md",
      promptArgs: { SUBTASK_TITLE: "Child" },
      workingLogPathForAttempt: (attempt) => `/logs/readiness-${attempt}.log`,
      measuredRunDeps: { beginAgentStep: (input) => calls.push(input) },
      runAttempt: async (attempt) => {
        if (attempt === 1) return { stdout: "no tagged output" };
        return {
          stdout: `
<subtask_readiness>
{"kind":"subtask_readiness","disposition":"assumed","summary":"One assumption was added.","evidence":["No parent comment defines the command."],"proposed_body":"## User Story\\nAs an operator...\\n## Context\\nNeed a default command.\\n## Assumptions\\n- Use npm test.\\n## Acceptance Criteria\\n- Mention npm test explicitly.","close_reason":""}
</subtask_readiness>`,
        };
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.result.disposition, "assumed");
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.stage),
      [SUBTASK_READINESS_STAGE, SUBTASK_READINESS_STAGE],
    );
    assert.deepEqual(
      calls.map((call) => call.activeLogPath),
      ["/logs/readiness-1.log", "/logs/readiness-2.log"],
    );
  });
});

test("acquireSubtaskImprovement spends the second attempt on an issue-specific contract failure", async () => {
  await withTempCwd(async () => {
    const result = await acquireSubtaskImprovement({
      prd: 5,
      childIssueNumber: 22,
      model: "glm",
      round: "initial",
      promptFile: "./subtask-improvement-user-prompt-prd.md",
      promptArgs: { SUBTASK_TITLE: "Child" },
      validateResult: (candidate) =>
        candidate.proposed_title === "Current"
          ? ["Improved result did not change the issue."]
          : [],
      runAttempt: async (attempt) => ({
        stdout: `<subtask_improvement>${JSON.stringify({
          kind: "subtask_improvement",
          outcome: "improved",
          summary: "Evidence-backed improvement.",
          proposed_title: attempt === 1 ? "Current" : "Improved",
          proposed_body: "Implementation-ready body.",
          changes: ["Tightened title."],
          evidence: [{ claim: "Module exists.", classification: "Verified", source: "src/module.ts" }],
          close_reason: "",
        })}</subtask_improvement>`,
      }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attemptsUsed, 2);
    assert.match(result.artifacts[0]!.diagnostics[0]!, /contract failure/);
    assert.equal(result.result.proposed_title, "Improved");
  });
});

test("run-name helpers are stable and distinct by attempt", () => {
  assert.equal(
    buildInitialIssueDecomposerRunName(17, 1),
    "initial issue decomposer #17 a1",
  );
  assert.equal(
    buildInitialIssueDecomposerRunName(17, 2),
    "initial issue decomposer #17 a2",
  );
  assert.equal(
    buildSubtaskReadinessRunName(22, 1),
    "subtask readiness #22 a1",
  );
  assert.equal(
    buildSubtaskReadinessRunName(22, 2),
    "subtask readiness #22 a2",
  );
});

test("extractSingleTaggedOutput recovers one strict contract block from an agent log", () => {
  const tag = "initial_issue_decomposition";
  const block = `<${tag}>{"kind":"initial_issue_decomposition"}</${tag}>`;

  assert.equal(
    extractSingleTaggedOutput(`tool output\n${block}\nAgent stopped`, tag),
    block,
  );
  assert.equal(extractSingleTaggedOutput("untagged output", tag), undefined);
  assert.equal(
    extractSingleTaggedOutput(`${block}\n${block}`, tag),
    undefined,
  );
});

test("extractSingleTaggedOutput isolates the latest agent run in an appended log", () => {
  const tag = "initial_issue_decomposition";
  const oldBlock = `<${tag}>{"kind":"old"}</${tag}>`;
  const currentBlock = `<${tag}>{"kind":"current"}</${tag}>`;
  const currentRun = "--- Run started: 2026-07-03T16:56:14.949Z ---";

  assert.equal(
    extractSingleTaggedOutput(`${oldBlock}\n${currentRun}\n${currentBlock}`, tag),
    currentBlock,
  );
  assert.equal(
    extractSingleTaggedOutput(`${currentRun}\n${currentBlock}\n${currentBlock}`, tag),
    undefined,
  );
});
