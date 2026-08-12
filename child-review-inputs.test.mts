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
import { writeChildReviewInputs } from "./child-review-inputs.mts";

test("child review input writer persists file-backed review inputs", () => {
  withTempDir((worktree) => {
    const result = writeChildReviewInputs(worktree, {
      issueNumber: 42,
      baseSha: "abc123def456",
      diff: "diff --git a/file.ts b/file.ts\n+change\n",
      diffStat: " file.ts | 1 +\n 1 file changed, 1 insertion(+)\n",
      changedFiles: ["file.ts", "other.ts"],
      reviewAspects: ["code", "errors", "tests"],
      ecosystems: ["node"],
    });

    assert.equal(result.relativeDir, ".sandcastle/child-review/issue-42");
    assert.equal(
      result.paths.diff,
      ".sandcastle/child-review/issue-42/review-input.diff",
    );
    assert.equal(existsSync(join(worktree, result.paths.diff)), true);
    assert.equal(existsSync(join(worktree, result.paths.diffStat)), true);
    assert.equal(existsSync(join(worktree, result.paths.changedFiles)), true);
    assert.equal(existsSync(join(worktree, result.paths.metadata)), true);

    assert.equal(read(worktree, result.paths.diff), result.inputs.diff);
    assert.equal(read(worktree, result.paths.diffStat), result.inputs.diffStat);
    assert.equal(
      read(worktree, result.paths.changedFiles),
      result.inputs.changedFiles.join("\n"),
    );

    const metadata = JSON.parse(read(worktree, result.paths.metadata));
    assert.equal(metadata.kind, "child_review_inputs");
    assert.equal(metadata.issue_number, 42);
    assert.equal(metadata.base_sha, "abc123def456");
    assert.equal(metadata.diff_bytes, Buffer.byteLength(result.inputs.diff));
    assert.deepEqual(metadata.review_aspects, ["code", "errors", "tests"]);
    assert.deepEqual(metadata.ecosystems, ["node"]);
    assert.deepEqual(metadata.input_files, result.paths);
  });
});

test("child review input writer overwrites the same issue directory", () => {
  withTempDir((worktree) => {
    writeChildReviewInputs(worktree, {
      issueNumber: 7,
      baseSha: "aaa",
      diff: "first\n",
      diffStat: "stat1\n",
      changedFiles: ["a.ts"],
      reviewAspects: ["code"],
      ecosystems: [],
    });
    const second = writeChildReviewInputs(worktree, {
      issueNumber: 7,
      baseSha: "bbb",
      diff: "second\n",
      diffStat: "stat2\n",
      changedFiles: ["b.ts"],
      reviewAspects: ["tests"],
      ecosystems: ["python"],
    });

    assert.equal(read(worktree, second.paths.diff), "second\n");
    assert.equal(read(worktree, second.paths.diffStat), "stat2\n");
    assert.equal(read(worktree, second.paths.changedFiles), "b.ts");
    const metadata = JSON.parse(read(worktree, second.paths.metadata));
    assert.equal(metadata.base_sha, "bbb");
  });
});

function read(worktree: string, relativePath: string): string {
  return readFileSync(join(worktree, relativePath), "utf8");
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "child-review-inputs-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
