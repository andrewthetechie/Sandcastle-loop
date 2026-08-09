import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PrReviewInputData {
  prNumber: number;
  title: string;
  body: string;
  linkedIssues: string;
  baseSha: string;
  diff: string;
  diffStat: string;
  changedFiles: string[];
  reviewAspects: string[];
  ecosystems: string[];
}

export interface PrReviewInputPaths {
  diff: string;
  diffStat: string;
  changedFiles: string;
  prBody: string;
  linkedIssues: string;
  metadata: string;
}

export interface PrReviewInputMetadata {
  pr_number: number;
  title: string;
  base_sha: string;
  diff_bytes: number;
  review_aspects: string[];
  ecosystems: string[];
  input_files: PrReviewInputPaths;
}

export interface WritePrReviewInputsResult {
  inputs: PrReviewInputData;
  paths: PrReviewInputPaths;
  relativeDir: string;
  metadata: PrReviewInputMetadata;
}

/**
 * Persist PR review inputs as files inside the worktree so the coordinating
 * agent and its sub-agents can read them by path instead of receiving the full
 * diff/body inline on the command line. Files are written under
 * `.sandcastle/pr-review/pr-<N>/` relative to the worktree root.
 */
export function writePrReviewInputs(
  worktreePath: string,
  inputs: PrReviewInputData,
): WritePrReviewInputsResult {
  const relativeDir = `.sandcastle/pr-review/pr-${inputs.prNumber}`;
  const dir = join(worktreePath, relativeDir);
  mkdirSync(dir, { recursive: true });

  const paths: PrReviewInputPaths = {
    diff: `${relativeDir}/review-input.diff`,
    diffStat: `${relativeDir}/review-input.diff-stat.txt`,
    changedFiles: `${relativeDir}/review-input.changed-files.txt`,
    prBody: `${relativeDir}/review-input.pr-body.md`,
    linkedIssues: `${relativeDir}/review-input.linked-issues.md`,
    metadata: `${relativeDir}/review-input.metadata.json`,
  };

  writeFileSync(join(worktreePath, paths.diff), inputs.diff, "utf8");
  writeFileSync(join(worktreePath, paths.diffStat), inputs.diffStat, "utf8");
  writeFileSync(
    join(worktreePath, paths.changedFiles),
    inputs.changedFiles.join("\n"),
    "utf8",
  );
  writeFileSync(join(worktreePath, paths.prBody), inputs.body, "utf8");
  writeFileSync(
    join(worktreePath, paths.linkedIssues),
    inputs.linkedIssues,
    "utf8",
  );

  const metadata: PrReviewInputMetadata = {
    pr_number: inputs.prNumber,
    title: inputs.title,
    base_sha: inputs.baseSha,
    diff_bytes: Buffer.byteLength(inputs.diff, "utf8"),
    review_aspects: inputs.reviewAspects,
    ecosystems: inputs.ecosystems,
    input_files: paths,
  };
  writeFileSync(
    join(worktreePath, paths.metadata),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  return { inputs, paths, relativeDir, metadata };
}
