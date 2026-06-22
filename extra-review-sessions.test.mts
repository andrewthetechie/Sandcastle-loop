import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EXTRA_CODE_REVIEW_MODEL,
  EXTRA_CODE_REVIEW_PROMPT_FILE,
  EXTRA_DECOMPOSER_MAX_ITERATIONS,
  EXTRA_ISSUE_DECOMPOSER_MODEL,
  EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE,
  EXTRA_REVIEWER_MAX_ITERATIONS,
  EXTRA_TWO_AXIS_REVIEW_MODEL,
  EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE,
  decomposerSafeMetadata,
  resolveSequentialExtraReviewArtifactPaths,
  runSequentialExtraReviewSessions,
  type ExtraReviewSandbox,
  type ExtraReviewSandboxCreateInput,
  type ExtraReviewSandboxRunInput,
  type ExtraReviewSessionInputBundle,
} from "./extra-review-sessions.mts";
import type { ExtraReviewRoundArtifactInput } from "./extra-review-artifacts.mts";

test("runs reviewer sessions then decomposer with isolated prompt args", async () => {
  const reviewInputs = fixtureReviewInputs("mock-runs");
  const runCalls: ExtraReviewSandboxRunInput[] = [];
  const createCalls: ExtraReviewSandboxCreateInput[] = [];
  const artifactWrites: ExtraReviewRoundArtifactInput[] = [];
  const closeCalls: string[] = [];
  const stdout = [
    codeQualityStdout(),
    twoAxisStdout(),
    issueDecomposerStdout(),
  ];
  const stdoutQueue = [...stdout];

  const result = await runSequentialExtraReviewSessions({
    prd: { number: 1, label: "prd-001", path: "docs/prd/001-extra.md" },
    round: { id: "round-01-head-abc123", number: 1 },
    reviewInputs,
    completedPrdBranch: "prd-001",
    sandboxBaseBranch: "origin/prd-001",
    reviewBranch: "prd-001-extra-review-round-01",
    idleTimeoutSeconds: 123,
    copyToWorktree: ["extra-code-review-prompt-prd.md"],
    createAgent: (model) => ({ model }),
    createSandbox: (input) => {
      createCalls.push(input);
      return mockSandbox({
        runCalls,
        closeCalls,
        stdout: stdoutQueue,
      });
    },
    readDirtyStatus: () => "",
    writeArtifacts: (input) => {
      artifactWrites.push(cloneArtifactInput(input));
      return {
        paths: resolveSequentialExtraReviewArtifactPaths(input),
        writtenFiles: [],
        handoff: "",
      };
    },
  });

  assert.equal(createCalls.length, 3);
  assert.deepEqual(
    createCalls.map((call) => call.branch),
    [
      "prd-001-extra-review-round-01-code-quality",
      "prd-001-extra-review-round-01-two-axis",
      "prd-001-extra-review-round-01-issue-decomposer",
    ],
  );
  assert.deepEqual(
    createCalls.map((call) => call.baseBranch),
    ["origin/prd-001", "origin/prd-001", "origin/prd-001"],
  );
  assert.deepEqual(createCalls[0]!.copyToWorktree, [
    "extra-code-review-prompt-prd.md",
  ]);

  assert.deepEqual(
    runCalls.map((call) => call.name),
    [
      "extra code-quality review",
      "extra two-axis review",
      "extra issue decomposer",
    ],
  );
  assert.deepEqual(
    runCalls.map((call) => call.agent),
    [
      { model: EXTRA_CODE_REVIEW_MODEL },
      { model: EXTRA_TWO_AXIS_REVIEW_MODEL },
      { model: EXTRA_ISSUE_DECOMPOSER_MODEL },
    ],
  );
  assert.deepEqual(
    runCalls.map((call) => call.promptFile),
    [
      EXTRA_CODE_REVIEW_PROMPT_FILE,
      EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE,
      EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE,
    ],
  );
  assert.deepEqual(
    runCalls.map((call) => call.maxIterations),
    [
      EXTRA_REVIEWER_MAX_ITERATIONS,
      EXTRA_REVIEWER_MAX_ITERATIONS,
      EXTRA_DECOMPOSER_MAX_ITERATIONS,
    ],
  );
  assert.deepEqual(
    runCalls.map((call) => call.idleTimeoutSeconds),
    [123, 123, 123],
  );
  assert.deepEqual(
    runCalls.map((call) => call.completionSignal),
    ["</extra_review>", "</extra_review>", "</followup_issues>"],
  );

  const sharedArgs = {
    PRD_NUMBER: "1",
    PRD_BODY_PATH: reviewInputs.metadata.input_files.prd_body,
    REVIEW_METADATA_PATH: reviewInputs.metadata.input_files.metadata,
    CHANGED_FILES_PATH: reviewInputs.metadata.input_files.changed_files,
    DIFF_STAT_PATH: reviewInputs.metadata.input_files.diff_stat,
    DIFF_PATH: reviewInputs.metadata.input_files.diff,
    REVIEW_BASE_SHA: reviewInputs.metadata.resolved_review_base_sha,
    REVIEWED_HEAD_SHA: reviewInputs.metadata.reviewed_head_sha,
    ORIGINAL_REVIEW_BASE: reviewInputs.metadata.original_review_base,
  };
  assert.deepEqual(runCalls[0]!.promptArgs, sharedArgs);
  assert.deepEqual(runCalls[1]!.promptArgs, sharedArgs);
  assert.equal("CODE_QUALITY_REVIEW_PATH" in runCalls[0]!.promptArgs, false);
  assert.equal("TWO_AXIS_REVIEW_PATH" in runCalls[0]!.promptArgs, false);
  assert.equal("CODE_QUALITY_REVIEW_PATH" in runCalls[1]!.promptArgs, false);
  assert.equal("TWO_AXIS_REVIEW_PATH" in runCalls[1]!.promptArgs, false);

  assert.deepEqual(runCalls[2]!.promptArgs, {
    PRD_NUMBER: "1",
    PRD_BODY_PATH: reviewInputs.metadata.input_files.prd_body,
    REVIEW_METADATA_PATH: reviewInputs.metadata.input_files.metadata,
    CHANGED_FILES_PATH: reviewInputs.metadata.input_files.changed_files,
    DIFF_STAT_PATH: reviewInputs.metadata.input_files.diff_stat,
    CODE_QUALITY_REVIEW_PATH: reviewInputs.paths.files.codeReviewParsed,
    TWO_AXIS_REVIEW_PATH: reviewInputs.paths.files.twoAxisReviewParsed,
  });
  assert.equal("DIFF_PATH" in runCalls[2]!.promptArgs, false);

  assert.equal(result.outputs.codeReview?.parsed.kind, "extra_review");
  assert.equal(result.outputs.codeReview?.parsed.reviewer, "code_quality");
  assert.equal(result.outputs.twoAxisReview?.parsed.kind, "extra_review");
  assert.equal(result.outputs.twoAxisReview?.parsed.reviewer, "two_axis");
  assert.equal(result.outputs.issueDecomposer?.parsed.kind, "followup_issues");
  assert.equal(result.stopReason, "success");
  assert.equal(closeCalls.length, 3);

  const decomposerMetadata = JSON.parse(
    readFileSync(
      join(result.worktreePath, reviewInputs.metadata.input_files.metadata),
      "utf8",
    ),
  );
  assert.deepEqual(decomposerMetadata, decomposerSafeMetadata(reviewInputs.metadata));
  assert.equal("diff" in decomposerMetadata.input_files, false);
  assert.equal(
    existsSync(join(result.worktreePath, reviewInputs.paths.files.codeReviewParsed)),
    true,
  );
  assert.equal(
    existsSync(join(result.worktreePath, reviewInputs.paths.files.twoAxisReviewParsed)),
    true,
  );

  assert.equal(artifactWrites.length, 3);
  assert.equal(artifactWrites[0]!.outputs?.codeReview?.raw, stdout[0]);
  assert.equal(artifactWrites[0]!.outputs?.twoAxisReview, undefined);
  assert.equal(artifactWrites[1]!.outputs?.twoAxisReview?.raw, stdout[1]);
  assert.equal(artifactWrites[1]!.outputs?.issueDecomposer, undefined);
  assert.equal(artifactWrites[2]!.outputs?.issueDecomposer?.raw, stdout[2]);
});

test("custom session agents override prompt files and write definitions before each run", async () => {
  const reviewInputs = fixtureReviewInputs("mock-runs");
  const runCalls: ExtraReviewSandboxRunInput[] = [];
  const createCalls: Array<{ model: string; agentName?: string }> = [];
  const writeCalls: Array<{
    worktreePath: string;
    session: string;
    agentName: string;
  }> = [];
  const events: string[] = [];
  const expectedWorktreePaths = [
    mkdtempSync(join(tmpdir(), "custom-agent-code-quality-")),
    mkdtempSync(join(tmpdir(), "custom-agent-two-axis-")),
    mkdtempSync(join(tmpdir(), "custom-agent-issue-decomposer-")),
  ];
  const sandboxWorktreePaths = [...expectedWorktreePaths];
  const stdoutQueue = [
    codeQualityStdout(),
    twoAxisStdout(),
    issueDecomposerStdout(),
  ];

  await runSequentialExtraReviewSessions({
    prd: { number: 1, label: "prd-001" },
    round: { id: "round-01-custom", number: 1 },
    reviewInputs,
    completedPrdBranch: "prd-001",
    createAgent: (model, agentName) => {
      createCalls.push({ model, agentName });
      return { model, agentName };
    },
    sessionAgents: {
      code_quality: {
        agentName: "code-quality-agent",
        promptFile: "prompts/code-quality-user.md",
      },
      two_axis: {
        agentName: "two-axis-agent",
        promptFile: "prompts/two-axis-user.md",
      },
      issue_decomposer: {
        agentName: "issue-decomposer-agent",
        promptFile: "prompts/issue-decomposer-user.md",
      },
    },
    writeAgentDefinition: ({ worktreePath, session, agentName }) => {
      writeCalls.push({ worktreePath, session, agentName });
      events.push(`write:${session}:${agentName}:${worktreePath}`);
    },
    createSandbox: () =>
      mockSandbox({
        runCalls,
        closeCalls: [],
        stdout: stdoutQueue,
        worktreePath: sandboxWorktreePaths.shift(),
        onRun(call, worktreePath) {
          events.push(`run:${call.name}:${worktreePath}`);
        },
      }),
    readDirtyStatus: () => "",
  });

  assert.deepEqual(createCalls, [
    {
      model: EXTRA_CODE_REVIEW_MODEL,
      agentName: "code-quality-agent",
    },
    {
      model: EXTRA_TWO_AXIS_REVIEW_MODEL,
      agentName: "two-axis-agent",
    },
    {
      model: EXTRA_ISSUE_DECOMPOSER_MODEL,
      agentName: "issue-decomposer-agent",
    },
  ]);
  assert.deepEqual(
    runCalls.map((call) => call.agent),
    [
      { model: EXTRA_CODE_REVIEW_MODEL, agentName: "code-quality-agent" },
      { model: EXTRA_TWO_AXIS_REVIEW_MODEL, agentName: "two-axis-agent" },
      {
        model: EXTRA_ISSUE_DECOMPOSER_MODEL,
        agentName: "issue-decomposer-agent",
      },
    ],
  );
  assert.deepEqual(
    runCalls.map((call) => call.promptFile),
    [
      "prompts/code-quality-user.md",
      "prompts/two-axis-user.md",
      "prompts/issue-decomposer-user.md",
    ],
  );
  assert.deepEqual(writeCalls, [
    {
      session: "code_quality",
      agentName: "code-quality-agent",
      worktreePath: expectedWorktreePaths[0]!,
    },
    {
      session: "two_axis",
      agentName: "two-axis-agent",
      worktreePath: expectedWorktreePaths[1]!,
    },
    {
      session: "issue_decomposer",
      agentName: "issue-decomposer-agent",
      worktreePath: expectedWorktreePaths[2]!,
    },
  ]);
  assert.deepEqual(events, [
    `write:code_quality:code-quality-agent:${expectedWorktreePaths[0]!}`,
    `run:extra code-quality review:${expectedWorktreePaths[0]!}`,
    `write:two_axis:two-axis-agent:${expectedWorktreePaths[1]!}`,
    `run:extra two-axis review:${expectedWorktreePaths[1]!}`,
    `write:issue_decomposer:issue-decomposer-agent:${expectedWorktreePaths[2]!}`,
    `run:extra issue decomposer:${expectedWorktreePaths[2]!}`,
  ]);
});

test("custom session agents require a definition writer", async () => {
  const reviewInputs = fixtureReviewInputs("mock-runs");

  await assert.rejects(
    () =>
      runSequentialExtraReviewSessions({
        prd: { number: 1, label: "prd-001" },
        round: { id: "round-01-custom", number: 1 },
        reviewInputs,
        completedPrdBranch: "prd-001",
        createAgent: (model, agentName) => ({ model, agentName }),
        sessionAgents: {
          code_quality: {
            agentName: "code-quality-agent",
            promptFile: "prompts/code-quality-user.md",
          },
        },
        createSandbox: () =>
          mockSandbox({
            runCalls: [],
            closeCalls: [],
            stdout: [codeQualityStdout()],
          }),
        readDirtyStatus: () => "",
      }),
    /requires writeAgentDefinition/,
  );
});

test("dirty disposable worktree warnings are logged and recorded", async () => {
  const reviewInputs = fixtureReviewInputs("mock-runs");
  const runCalls: ExtraReviewSandboxRunInput[] = [];
  const createCalls: ExtraReviewSandboxCreateInput[] = [];
  const closeCalls: string[] = [];
  const artifactWrites: ExtraReviewRoundArtifactInput[] = [];
  const warnings: string[] = [];
  const statuses = [" M src/agent.ts", "", "?? scratch-note.md"];
  const stdoutQueue = [
    codeQualityStdout(),
    twoAxisStdout(),
    noWorkIssueDecomposerStdout(),
  ];

  const result = await runSequentialExtraReviewSessions({
    prd: { number: 1, label: "prd-001" },
    round: { id: "round-01-dirty" },
    reviewInputs,
    completedPrdBranch: "prd-001",
    createAgent: (model) => model,
    createSandbox: (input) => {
      createCalls.push(input);
      return mockSandbox({
        runCalls,
        closeCalls,
        stdout: stdoutQueue,
      });
    },
    readDirtyStatus: () => statuses.shift() ?? "",
    writeArtifacts: (input) => {
      artifactWrites.push(cloneArtifactInput(input));
      return {
        paths: resolveSequentialExtraReviewArtifactPaths(input),
        writtenFiles: [],
        handoff: "",
      };
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(runCalls.length, 3);
  assert.deepEqual(
    createCalls.map((call) => call.branch),
    [
      "prd-001-extra-review-round-01-dirty-code-quality",
      "prd-001-extra-review-round-01-dirty-two-axis",
      "prd-001-extra-review-round-01-dirty-issue-decomposer",
    ],
  );
  assert.deepEqual(
    createCalls.map((call) => call.baseBranch),
    ["prd-001", "prd-001", "prd-001"],
  );
  assert.equal(closeCalls.length, 3);
  assert.equal(result.dirtyWarnings.length, 2);
  assert.equal(result.dirtyWarnings[0]!.session, "code_quality");
  assert.equal(result.dirtyWarnings[1]!.session, "issue_decomposer");
  assert.match(warnings[0]!, /Dirty disposable review worktree after/);
  assert.match(warnings[0]!, /src\/agent\.ts/);
  assert.match(warnings[1]!, /scratch-note\.md/);

  const finalWrite = artifactWrites.at(-1)!;
  assert.deepEqual(finalWrite.stopDetails, warnings);
  assert.equal(finalWrite.stopReason, "no_work");
});

test("default artifact writer persists raw and parsed session artifacts", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "extra-review-sessions-"));
  try {
    const reviewInputs = fixtureReviewInputs(join(tempDir, "runs"));
    const stdoutQueue = [
      codeQualityStdout(),
      twoAxisStdout(),
      issueDecomposerStdout(),
    ];

    const result = await runSequentialExtraReviewSessions({
      prd: { number: 1, label: "prd-001" },
      round: { id: "round-01-artifacts" },
      reviewInputs,
      completedPrdBranch: "prd-001",
      createAgent: (model) => model,
      createSandbox: () =>
        mockSandbox({
          runCalls: [],
          closeCalls: [],
          stdout: stdoutQueue,
        }),
      readDirtyStatus: () => " M dirty-after-session.ts",
      logger: { warn() {} },
    });

    const files = result.artifactWrite.paths.files;
    assert.equal(existsSync(files.codeReviewRaw), true);
    assert.equal(existsSync(files.codeReviewParsed), true);
    assert.equal(existsSync(files.twoAxisReviewRaw), true);
    assert.equal(existsSync(files.twoAxisReviewParsed), true);
    assert.equal(existsSync(files.issueDecomposerRaw), true);
    assert.equal(existsSync(files.issueDecomposerParsed), true);
    assert.equal(existsSync(files.handoff), true);

    assert.match(read(files.codeReviewRaw), /CQ-001/);
    assert.equal(JSON.parse(read(files.codeReviewParsed)).reviewer, "code_quality");
    assert.equal(JSON.parse(read(files.twoAxisReviewParsed)).reviewer, "two_axis");
    assert.equal(JSON.parse(read(files.issueDecomposerParsed)).status, "issues");
    assert.match(read(files.handoff), /Dirty disposable review worktree/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function mockSandbox(input: {
  runCalls: ExtraReviewSandboxRunInput[];
  closeCalls: string[];
  stdout: string[];
  worktreePath?: string;
  onRun?: (call: ExtraReviewSandboxRunInput, worktreePath: string) => void;
}): ExtraReviewSandbox {
  const worktreePath =
    input.worktreePath ?? mkdtempSync(join(tmpdir(), "mock-review-worktree-"));
  return {
    worktreePath,
    async run(call) {
      input.runCalls.push(call);
      input.onRun?.(call, worktreePath);
      const stdout = input.stdout.shift();
      assert.equal(typeof stdout, "string", "mock stdout should be queued");
      return { stdout };
    },
    close() {
      input.closeCalls.push("close");
    },
  };
}

function fixtureReviewInputs(runsRootDir: string): ExtraReviewSessionInputBundle {
  const paths = resolveSequentialExtraReviewArtifactPaths({
    runsRootDir,
    prd: { number: 1, label: "prd-001" },
    round: { id: "round-01-head-abc123", number: 1 },
  });
  return {
    paths,
    metadata: {
      kind: "extra_review_inputs",
      prd_number: 1,
      prd_label: "prd-001",
      prd_branch: "prd-001",
      original_review_base: "main",
      resolved_review_base_sha: "base-sha",
      reviewed_head_sha: "head-sha",
      timestamp: "2026-06-01T12:00:00.000Z",
      round: {
        id: "round-01-head-abc123",
        number: 1,
        artifact_dir: paths.roundDir,
      },
      diff_excludes: [],
      diff_bytes: 1234,
      changed_file_count: 2,
      input_files: {
        prd_body: paths.files.inputPrdBody,
        metadata: paths.files.inputMetadata,
        changed_files: paths.files.inputChangedFiles,
        diff_stat: paths.files.inputDiffStat,
        diff: paths.files.inputDiff,
      },
    },
  };
}

function codeQualityStdout(): string {
  return `<extra_review>
{
  "reviewer": "code_quality",
  "decision": "followup_recommended",
  "summary": "Code-quality review found one maintainability follow-up.",
  "findings": [
    {
      "id": "CQ-001",
      "severity": "major",
      "confidence": 90,
      "title": "Extract review orchestration helper",
      "problem": "Session orchestration is duplicated in a large runner.",
      "impact": "Future PRD review changes will be fragile.",
      "recommendation": "Move the sequence into a focused helper.",
      "files": ["run-prd-extra-reviews.mts"],
      "source": "code_quality"
    }
  ]
}
</extra_review>`;
}

function twoAxisStdout(): string {
  return `<extra_review>
{
  "reviewer": "two_axis",
  "decision": "approved",
  "summary": "Standards and spec axes passed.",
  "standards_findings": [],
  "spec_findings": []
}
</extra_review>`;
}

function issueDecomposerStdout(): string {
  return `<followup_issues>
{
  "status": "issues",
  "summary": "Converted the actionable finding into one follow-up issue.",
  "issues": [
    {
      "title": "Extract review orchestration helper",
      "body": "## Context\\nCreate a focused helper.\\n\\n## Acceptance Criteria\\n- Session orchestration is isolated.\\n\\n## Provenance\\n- code_quality CQ-001",
      "priority": "high",
      "source_findings": [
        {
          "reviewer": "code_quality",
          "finding_id": "CQ-001",
          "axis": "code_quality",
          "title": "Extract review orchestration helper"
        }
      ],
      "files": ["run-prd-extra-reviews.mts"],
      "dedupe_key": "extract-review-orchestration-helper-cq-001"
    }
  ],
  "needs_human_review_reason": ""
}
</followup_issues>`;
}

function noWorkIssueDecomposerStdout(): string {
  return `<followup_issues>
{
  "status": "no_work",
  "summary": "No follow-up issues are needed.",
  "issues": [],
  "needs_human_review_reason": ""
}
</followup_issues>`;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function cloneArtifactInput(
  input: ExtraReviewRoundArtifactInput,
): ExtraReviewRoundArtifactInput {
  return structuredClone(input);
}
