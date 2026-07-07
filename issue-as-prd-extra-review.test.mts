import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubIssueRecord } from "./github-issues.mts";
import { runIssueAsPrdExtraReview } from "./issue-as-prd-extra-review.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";
import type { SequentialExtraReviewSessionsResult } from "./extra-review-sessions.mts";

test("first-attempt success returns review_followup drafts and artifact paths", async () => {
  const deps = createDeps({
    stopReason: "success",
    issueDecomposer: issuesOutput(),
  });

  const result = await runIssueAsPrdExtraReview(input(), deps);

  assert.deepEqual(result, {
    kind: "reviewed",
    followupDrafts: [
      {
        title: "Extract helper",
        body: "Body",
        priority: "high",
        files: ["a.ts"],
        dedupeKey: "extract-helper",
        source: "review_followup",
      },
    ],
    artifactPaths: ["/tmp/code.raw", "/tmp/decomposer.raw"],
  });
  assert.equal(deps.calls.maxAcquisitionAttempts, 2);
});

test("no_work is still reviewed and produces zero drafts", async () => {
  const deps = createDeps({
    stopReason: "no_work",
    issueDecomposer: {
      kind: "followup_issues",
      status: "no_work",
      summary: "none",
      issues: [],
      needs_human_review_reason: "",
    },
  });

  const result = await runIssueAsPrdExtraReview(input(), deps);

  assert.deepEqual(result, {
    kind: "reviewed",
    followupDrafts: [],
    artifactPaths: ["/tmp/code.raw", "/tmp/decomposer.raw"],
  });
});

test("invalid required output after retries returns acquisition_failed with preserved artifacts", async () => {
  const deps = createDeps({
    stopReason: "parse_failure",
    stopDetails: ["attempt 1 malformed", "attempt 2 malformed"],
    issueDecomposer: issuesOutput(),
  });

  const result = await runIssueAsPrdExtraReview(input(), deps);

  assert.deepEqual(result, {
    kind: "acquisition_failed",
    diagnostics: ["attempt 1 malformed", "attempt 2 malformed"],
    artifactPaths: ["/tmp/code.raw", "/tmp/decomposer.raw"],
  });
});

function input() {
  return {
    parent: parent(),
    parentContext: context(),
    queueLabel: "parent-4",
    originalForkSha: "a".repeat(40),
    reviewBaseSha: "b".repeat(40),
    accumulationHeadSha: "c".repeat(40),
    roundNumber: 1 as const,
  };
}

function createDeps(options: {
  stopReason: "success" | "no_work" | "parse_failure" | "needs_human_review";
  stopDetails?: string[];
  issueDecomposer: any;
}) {
  const calls: { maxAcquisitionAttempts?: number } = {};
  return {
    calls,
    prdIdentity() {
      return { number: 4, label: "issue-4" };
    },
    makeRound() {
      return { id: "round-1", number: 1 as const };
    },
    writeReviewInputs() {
      return {
        paths: {
          runsRootDir: ".sandcastle/extra-review-runs",
          prdDirName: "prd-4",
          prdDir: ".sandcastle/extra-review-runs/prd-4",
          roundDirName: "round-1",
          roundDir: ".sandcastle/extra-review-runs/prd-4/round-1",
          files: {
            inputDiff: "diff",
            inputDiffStat: "diffstat",
            inputChangedFiles: "changed",
            inputPrdBody: "prd",
            inputMetadata: "meta",
            codeReviewRaw: "code.raw",
            codeReviewParsed: "code.parsed",
            twoAxisReviewRaw: "two.raw",
            twoAxisReviewParsed: "two.parsed",
            issueDecomposerRaw: "decomp.raw",
            issueDecomposerParsed: "decomp.parsed",
            createdIssues: "created",
            skippedDuplicateIssues: "dupes",
            handoff: "handoff",
          },
        },
        metadata: {
          kind: "extra_review_inputs" as const,
          prd_number: 4,
          prd_label: "issue-4",
          prd_branch: "issue-4-accumulation",
          original_review_base: "origin/main",
          resolved_review_base_sha: "b".repeat(40),
          reviewed_head_sha: "c".repeat(40),
          timestamp: "2026-07-02T00:00:00.000Z",
          round: { id: "round-1", number: 1, artifact_dir: "dir" },
          diff_excludes: [],
          diff_bytes: 1,
          changed_file_count: 1,
          input_files: {
            prd_body: "prd",
            metadata: "meta",
            changed_files: "changed",
            diff_stat: "diffstat",
            diff: "diff",
          },
        },
      };
    },
    async runSequentialSessions(
      input: { maxAcquisitionAttempts?: number },
    ): Promise<SequentialExtraReviewSessionsResult> {
      calls.maxAcquisitionAttempts = input.maxAcquisitionAttempts;
      return {
        reviewBranch: "issue-4-extra-review",
        sandboxBaseBranch: "issue-4-accumulation",
        worktreePath: "/tmp/worktree",
        outputs: {
          codeReview: {
            raw: "raw",
            parsed: {
              kind: "extra_review",
              reviewer: "code_quality",
              decision: "approved",
              summary: "ok",
              findings: [],
            },
          },
          twoAxisReview: {
            raw: "raw",
            parsed: {
              kind: "extra_review",
              reviewer: "two_axis",
              decision: "approved",
              summary: "ok",
              standards_findings: [],
              spec_findings: [],
            },
          },
          issueDecomposer: {
            raw: "raw",
            parsed: options.issueDecomposer,
          },
        },
        dirtyWarnings: [],
        stopReason: options.stopReason,
        stopDetails: options.stopDetails ?? [],
        artifactWrite: {
          paths: {} as never,
          writtenFiles: ["/tmp/code.raw", "/tmp/decomposer.raw"],
          handoff: "",
        },
      };
    },
    completedPrdBranch() {
      return "issue-4-accumulation";
    },
  };
}

function parent(): GitHubIssueRecord {
  return {
    id: 4,
    number: 4,
    title: "Parent",
    body: "Parent",
    state: "OPEN",
    labels: [],
    comments: [],
  };
}

function context(): NormalizedParentContext {
  return {
    body: "Parent body",
    comments: "",
    rendered: "Parent body",
    omittedCommentCount: 0,
  };
}

function issuesOutput() {
  return {
    kind: "followup_issues",
    status: "issues",
    summary: "one issue",
    issues: [
      {
        title: "Extract helper",
        body: "Body",
        priority: "high",
        source_findings: [],
        files: ["a.ts"],
        dedupe_key: "extract-helper",
      },
    ],
    needs_human_review_reason: "",
  } as const;
}
