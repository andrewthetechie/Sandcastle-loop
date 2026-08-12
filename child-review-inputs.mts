import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persist child review round inputs as files inside the sandbox worktree so the
 * reviewer can read the full diff by path instead of receiving it inline on the
 * command line. Files are written under `.sandcastle/child-review/issue-<N>/`
 * relative to the worktree root (overwritten each child review round).
 */
export interface ChildReviewInputData {
  issueNumber: number;
  baseSha: string;
  diff: string;
  diffStat: string;
  changedFiles: string[];
  reviewAspects: string[];
  ecosystems: string[];
}

export interface ChildReviewInputPaths {
  diff: string;
  diffStat: string;
  changedFiles: string;
  metadata: string;
}

export interface ChildReviewInputMetadata {
  kind: "child_review_inputs";
  issue_number: number;
  base_sha: string;
  diff_bytes: number;
  review_aspects: string[];
  ecosystems: string[];
  input_files: ChildReviewInputPaths;
}

export interface WriteChildReviewInputsResult {
  inputs: ChildReviewInputData;
  paths: ChildReviewInputPaths;
  relativeDir: string;
  metadata: ChildReviewInputMetadata;
}

export function writeChildReviewInputs(
  worktreePath: string,
  inputs: ChildReviewInputData,
): WriteChildReviewInputsResult {
  const relativeDir = `.sandcastle/child-review/issue-${inputs.issueNumber}`;
  const dir = join(worktreePath, relativeDir);
  mkdirSync(dir, { recursive: true });

  const paths: ChildReviewInputPaths = {
    diff: `${relativeDir}/review-input.diff`,
    diffStat: `${relativeDir}/review-input.diff-stat.txt`,
    changedFiles: `${relativeDir}/review-input.changed-files.txt`,
    metadata: `${relativeDir}/review-input.metadata.json`,
  };

  writeFileSync(join(worktreePath, paths.diff), inputs.diff, "utf8");
  writeFileSync(join(worktreePath, paths.diffStat), inputs.diffStat, "utf8");
  writeFileSync(
    join(worktreePath, paths.changedFiles),
    inputs.changedFiles.join("\n"),
    "utf8",
  );

  const metadata: ChildReviewInputMetadata = {
    kind: "child_review_inputs",
    issue_number: inputs.issueNumber,
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
