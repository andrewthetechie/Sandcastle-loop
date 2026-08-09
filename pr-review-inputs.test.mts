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
import { writePrReviewInputs } from "./pr-review-inputs.mts";

test("PR review input writer persists file-backed review inputs", () => {
  withTempDir((worktree) => {
    const result = writePrReviewInputs(worktree, {
      prNumber: 328,
      title: "Fix the thing",
      body: "PR body line 1\nPR body line 2\n",
      linkedIssues: "### Issue #42: The thing\n\nIssue body.\n",
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
