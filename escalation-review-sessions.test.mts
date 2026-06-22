import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EXTRA_ISSUE_DECOMPOSER_SESSION,
  resolveSequentialExtraReviewArtifactPaths,
  runSequentialExtraReviewSessions,
  sharedReviewerPromptArgs,
  type ExtraReviewSandbox,
  type ExtraReviewSandboxRunInput,
  type ExtraReviewSessionDefinition,
  type ExtraReviewSessionInputBundle,
} from "./extra-review-sessions.mts";
import type { ExtraReviewInputMetadata } from "./extra-review-inputs.mts";

const ESCALATION_MODEL = "anthropic/claude-sonnet-4-5";

function metadata(): ExtraReviewInputMetadata {
  return {
    kind: "extra_review_inputs",
    prd_number: 7,
    prd_label: "prd-007",
    prd_branch: "prd-007",
    prd_path: "docs/prd/007.md",
    original_review_base: "main",
    resolved_review_base_sha: "abcdef1234567890",
    reviewed_head_sha: "1234567890abcdef",
    timestamp: "2026-06-14T00:00:00.000Z",
    round: { id: "escalation-head-1234567", number: 3, artifact_dir: "d" },
    diff_excludes: [],
    diff_bytes: 10,
    changed_file_count: 1,
    input_files: {
      prd_body: ".sandcastle/runs/prd-007/input-prd-body.md",
      metadata: ".sandcastle/runs/prd-007/input-metadata.json",
      changed_files: ".sandcastle/runs/prd-007/input-changed-files.txt",
      diff_stat: ".sandcastle/runs/prd-007/input-diff-stat.txt",
      diff: ".sandcastle/runs/prd-007/input-diff.patch",
    },
  };
}

function reviewInputs(): ExtraReviewSessionInputBundle {
  const meta = metadata();
  return {
    metadata: meta,
    paths: resolveSequentialExtraReviewArtifactPaths({
      runsRootDir: ".sandcastle/runs",
      prd: { number: 7, label: "prd-007" },
      round: { id: "escalation-head-1234567", number: 3 },
    }),
  };
}

function mockSandbox(opts: {
  worktreePath: string;
  runCalls: ExtraReviewSandboxRunInput[];
  stdout: string[];
}): ExtraReviewSandbox {
  return {
    worktreePath: opts.worktreePath,
    async run(input) {
      opts.runCalls.push(input);
      return { stdout: opts.stdout.shift() ?? "" };
    },
    close() {},
  };
}

test("sharedReviewerPromptArgs exposes the review-base and head SHAs", () => {
  const args = sharedReviewerPromptArgs(metadata());
  assert.equal(args.REVIEW_BASE_SHA, "abcdef1234567890");
  assert.equal(args.REVIEWED_HEAD_SHA, "1234567890abcdef");
  assert.equal(args.ORIGINAL_REVIEW_BASE, "main");
});

test("sessionDefinitions override reviewer model + prompt; decomposer keeps default", async () => {
  const runCalls: ExtraReviewSandboxRunInput[] = [];
  const builtAgents: unknown[] = [];
  const stdout = [
    "<extra_review>\n" +
      JSON.stringify({
        reviewer: "code_quality",
        decision: "approved",
        summary: "ok",
        findings: [],
      }) +
      "\n</extra_review>",
    "<extra_review>\n" +
      JSON.stringify({
        reviewer: "two_axis",
        decision: "approved",
        summary: "ok",
        standards_findings: [],
        spec_findings: [],
      }) +
      "\n</extra_review>",
    "<followup_issues>\n" +
      JSON.stringify({
        status: "no_work",
        summary: "nothing",
        issues: [],
        needs_human_review_reason: "",
      }) +
      "\n</followup_issues>",
  ];

  const escalationReviewer = (
    promptFile: string,
    kind: "code_quality" | "two_axis",
  ): ExtraReviewSessionDefinition => ({
    kind,
    runName: `escalation ${kind}`,
    model: ESCALATION_MODEL,
    promptFile,
    maxIterations: 40,
    completionSignal: "</extra_review>",
  });

  await runSequentialExtraReviewSessions({
    prd: { number: 7, label: "prd-007" },
    round: { id: "escalation-head-1234567", number: 3 },
    reviewInputs: reviewInputs(),
    completedPrdBranch: "prd-007",
    sandboxBaseBranch: "origin/prd-007",
    createAgent: (model) => {
      const agent = { model };
      builtAgents.push(agent);
      return agent;
    },
    createSandbox: () =>
      mockSandbox({
        worktreePath: mkdtempSync(join(tmpdir(), "escalation-review-")),
        runCalls,
        stdout,
      }),
    readDirtyStatus: () => "",
    writeArtifacts: (input) => ({
      paths: resolveSequentialExtraReviewArtifactPaths(input),
      writtenFiles: [],
      handoff: "",
    }),
    sessionDefinitions: {
      code_quality: escalationReviewer(
        "./.sandcastle/escalation-code-review-prompt-prd.md",
        "code_quality",
      ),
      two_axis: escalationReviewer(
        "./.sandcastle/escalation-two-axis-review-prompt-prd.md",
        "two_axis",
      ),
    },
  });

  assert.equal(
    runCalls[0].promptFile,
    "./.sandcastle/escalation-code-review-prompt-prd.md",
  );
  assert.equal(
    runCalls[1].promptFile,
    "./.sandcastle/escalation-two-axis-review-prompt-prd.md",
  );
  assert.equal(runCalls[2].promptFile, EXTRA_ISSUE_DECOMPOSER_SESSION.promptFile);
  assert.equal(runCalls[0].promptArgs.REVIEW_BASE_SHA, "abcdef1234567890");
  assert.deepEqual(builtAgents[0], { model: ESCALATION_MODEL });
});
