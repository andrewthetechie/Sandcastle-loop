import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeCompletedBranchReviewInputs } from "./extra-review-inputs.mts";

test("completed-branch input writer persists full file-backed review inputs", () => {
  withGitFixture((repo) => {
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "prd-001"]);

    mkdirSync(join(repo, "src"), { recursive: true });
    const featureSource =
      `export const feature = "${"x".repeat(70_000)}";\n` +
      'export const marker = "end-of-large-diff";\n';
    writeFileSync(
      join(repo, "src", "feature.ts"),
      featureSource,
      "utf8",
    );
    mkdirSync(join(repo, "frontend"), { recursive: true });
    writeFileSync(
      join(repo, "frontend", "package-lock.json"),
      '{"lockfileVersion": 3, "ignoredByReviewInputExcludes": true}\n',
      "utf8",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Complete PRD branch"]);
    const headSha = git(repo, ["rev-parse", "HEAD"]);

    const prdBody = "# PRD 001\n\nReview input fixture.\n";
    const result = writeCompletedBranchReviewInputs({
      worktreePath: repo,
      runsRootDir: join(repo, ".sandcastle", "extra-review-runs"),
      prd: {
        number: 1,
        label: "prd-001",
        branch: "prd-001",
        path: "docs/prd/001-extra-review.md",
        body: prdBody,
      },
      round: { number: 1, id: "round-01-head-fixture" },
      originalReviewBaseArg: baseSha.slice(0, 12),
      timestamp: "2026-06-01T12:00:00.000Z",
    });

    for (const file of result.writtenFiles) {
      assert.equal(existsSync(file), true, `${file} should exist`);
    }

    const diff = read(result.paths.files.inputDiff);
    assert.ok(Buffer.byteLength(diff, "utf8") > 60_000);
    assert.match(diff, /src\/feature\.ts/);
    assert.match(diff, /end-of-large-diff/);
    assert.doesNotMatch(diff, /package-lock\.json/);

    const changedFiles = read(result.paths.files.inputChangedFiles);
    assert.equal(changedFiles.trim(), "src/feature.ts");
    assert.deepEqual(result.changedFiles, ["src/feature.ts"]);

    const diffStat = read(result.paths.files.inputDiffStat);
    assert.match(diffStat, /src\/feature\.ts/);
    assert.doesNotMatch(diffStat, /package-lock\.json/);
    assert.equal(read(result.paths.files.inputPrdBody), prdBody);

    const metadata = JSON.parse(read(result.paths.files.inputMetadata));
    assert.equal(metadata.kind, "extra_review_inputs");
    assert.equal(metadata.prd_number, 1);
    assert.equal(metadata.prd_label, "prd-001");
    assert.equal(metadata.prd_branch, "prd-001");
    assert.equal(metadata.prd_path, "docs/prd/001-extra-review.md");
    assert.equal(metadata.original_review_base, baseSha.slice(0, 12));
    assert.equal(metadata.resolved_review_base_sha, baseSha);
    assert.equal(metadata.reviewed_head_sha, headSha);
    assert.equal(metadata.timestamp, "2026-06-01T12:00:00.000Z");
    assert.equal(metadata.round.number, 1);
    assert.equal(metadata.round.id, "round-01-head-fixture");
    assert.equal(metadata.diff_bytes, Buffer.byteLength(diff, "utf8"));
    assert.equal(metadata.changed_file_count, 1);
    assert.equal(metadata.input_files.diff, result.paths.files.inputDiff);
    assert.deepEqual(metadata.diff_excludes, [
      ":(exclude)**/package-lock.json",
      ":(exclude)**/yarn.lock",
      ":(exclude)**/pnpm-lock.yaml",
      ":(exclude)**/bun.lockb",
      ":(exclude)**/poetry.lock",
      ":(exclude)**/uv.lock",
      ":(exclude)**/Cargo.lock",
    ]);
  });
});

function withGitFixture(fn: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "extra-review-inputs-"));
  try {
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "user.name", "Extra Review Test"]);
    mkdirSync(join(repo, "docs", "prd"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    writeFileSync(
      join(repo, "docs", "prd", "001-extra-review.md"),
      "# Existing PRD\n",
      "utf8",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Base"]);
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}
