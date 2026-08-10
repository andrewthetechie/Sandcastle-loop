import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  writePrReviewInputs,
  writePrReviewSpecialistArtifacts,
} from "./pr-review-inputs.mts";

test("PR review input writer persists file-backed review inputs", () => {
  withTempDir((worktree) => {
    const result = writePrReviewInputs(worktree, {
      prNumber: 328,
      title: "Fix the thing",
      body: "PR body line 1\nPR body line 2\n",
      linkedIssues: "### Issue #42: The thing\n\nIssue body.\n",
      commitList: "abc1234 Implement the thing (#42)\n",
      standardsFiles: ["AGENTS.md", "docs/conventions.md"],
      baseSha: "abc123def456",
      diff: "diff --git a/file.ts b/file.ts\n+change\n",
      diffStat: " file.ts | 1 +\n 1 file changed, 1 insertion(+)\n",
      changedFiles: ["file.ts", "other.ts"],
      reviewAspects: ["code", "errors", "tests"],
      ecosystems: ["node"],
    });

    assert.equal(
      existsSync(join(worktree, result.paths.diff)),
      true,
      "diff file should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.diffStat)),
      true,
      "diff stat file should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.changedFiles)),
      true,
      "changed files list should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.prBody)),
      true,
      "PR body file should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.linkedIssues)),
      true,
      "linked issues file should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.commitList)),
      true,
      "commit list file should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.standardsFiles)),
      true,
      "standards files list should exist",
    );
    assert.equal(
      existsSync(join(worktree, result.paths.metadata)),
      true,
      "metadata file should exist",
    );

    assert.equal(read(worktree, result.paths.diff), result.inputs.diff);
    assert.equal(read(worktree, result.paths.diffStat), result.inputs.diffStat);
    assert.equal(
      read(worktree, result.paths.changedFiles),
      result.inputs.changedFiles.join("\n"),
    );
    assert.equal(read(worktree, result.paths.prBody), result.inputs.body);
    assert.equal(
      read(worktree, result.paths.linkedIssues),
      result.inputs.linkedIssues,
    );
    assert.equal(
      read(worktree, result.paths.commitList),
      result.inputs.commitList,
    );
    assert.equal(
      read(worktree, result.paths.standardsFiles),
      result.inputs.standardsFiles.join("\n"),
    );

    const metadata = JSON.parse(read(worktree, result.paths.metadata));
    assert.equal(metadata.pr_number, 328);
    assert.equal(metadata.title, "Fix the thing");
    assert.equal(metadata.base_sha, "abc123def456");
    assert.equal(metadata.diff_bytes, Buffer.byteLength(result.inputs.diff));
    assert.deepEqual(metadata.review_aspects, ["code", "errors", "tests"]);
    assert.deepEqual(metadata.ecosystems, ["node"]);
    assert.equal(
      metadata.input_files.diff,
      `.sandcastle/pr-review/pr-328/review-input.diff`,
    );
    assert.equal(
      metadata.input_files.commitList,
      `.sandcastle/pr-review/pr-328/review-input.commits.txt`,
    );
    assert.equal(
      metadata.input_files.standardsFiles,
      `.sandcastle/pr-review/pr-328/review-input.standards-files.txt`,
    );

    assert.equal(
      result.relativeDir,
      `.sandcastle/pr-review/pr-328`,
    );
  });
});

test("PR review input writer accepts empty optional arrays/bodies", () => {
  withTempDir((worktree) => {
    const result = writePrReviewInputs(worktree, {
      prNumber: 7,
      title: "Tiny fix",
      body: "",
      linkedIssues: "(no linked issues)",
      commitList: "",
      standardsFiles: [],
      baseSha: "000000000000",
      diff: "",
      diffStat: "",
      changedFiles: [],
      reviewAspects: [],
      ecosystems: [],
    });

    assert.equal(read(worktree, result.paths.diff), "");
    assert.equal(read(worktree, result.paths.prBody), "");
    assert.equal(read(worktree, result.paths.changedFiles), "");

    const metadata = JSON.parse(read(worktree, result.paths.metadata));
    assert.deepEqual(metadata.review_aspects, []);
    assert.deepEqual(metadata.ecosystems, []);
    assert.equal(metadata.diff_bytes, 0);
  });
});

test("specialist artifact writer persists parsed reviews and combined findings", () => {
  withTempDir((worktree) => {
    const paths = writePrReviewSpecialistArtifacts(
      worktree,
      ".sandcastle/pr-review/pr-9",
      {
        standardsRaw: "<standards_findings>raw standards</standards_findings>",
        standardsReview: { status: "complete", summary: "standards", findings: [] },
        specRaw: "<spec_findings>raw spec</spec_findings>",
        specReview: { status: "complete", summary: "spec", findings: [] },
        findings: [
          {
            id: "SPEC-001",
            axis: "spec",
            severity: "high",
            confidence: 95,
            problem: "Required behavior is missing.",
            impact: "The main user flow cannot complete.",
            fix: "Implement the requirement.",
            reference: "Issue #9 — acceptance criterion 1",
          },
        ],
      },
    );

    assert.equal(
      paths.standardsRaw,
      ".sandcastle/pr-review/pr-9/review-output.standards.raw.txt",
    );
    assert.equal(
      paths.standardsReview,
      ".sandcastle/pr-review/pr-9/review-output.standards.json",
    );
    assert.equal(
      paths.fixResult,
      ".sandcastle/pr-review/pr-9/review-fix-result.json",
    );
    assert.equal(
      JSON.parse(read(worktree, paths.findings))[0].id,
      "SPEC-001",
    );
    assert.equal(
      JSON.parse(read(worktree, paths.specReview)).summary,
      "spec",
    );
    assert.match(read(worktree, paths.standardsRaw), /raw standards/);
    assert.match(read(worktree, paths.specRaw), /raw spec/);
  });
});

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-inputs-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function read(worktree: string, relativePath: string): string {
  return readFileSync(join(worktree, relativePath), "utf8");
}
