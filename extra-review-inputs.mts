import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type {
  ExtraReviewPrdArtifactIdentity,
  ExtraReviewRoundArtifactPaths,
  ExtraReviewRoundPathInput,
} from "./extra-review-support.mts";
import { resolveExtraReviewRoundArtifactPaths } from "./extra-review-support.mts";

export const EXTRA_REVIEW_INPUT_DIFF_EXCLUDES: readonly string[] = [
  ":(exclude)**/package-lock.json",
  ":(exclude)**/yarn.lock",
  ":(exclude)**/pnpm-lock.yaml",
  ":(exclude)**/bun.lockb",
  ":(exclude)**/poetry.lock",
  ":(exclude)**/uv.lock",
  ":(exclude)**/Cargo.lock",
];

export interface ExtraReviewInputPrd
  extends Omit<ExtraReviewPrdArtifactIdentity, "number" | "label" | "id"> {
  number: number;
  label: string;
  branch: string;
  body: string;
}

export interface WriteCompletedBranchReviewInputsInput {
  worktreePath?: string;
  runsRootDir?: string;
  prd: ExtraReviewInputPrd;
  round: ExtraReviewRoundPathInput["round"];
  originalReviewBaseArg: string;
  resolvedReviewBaseSha?: string;
  reviewedHeadSha?: string;
  timestamp?: Date | string;
  diffExcludes?: readonly string[];
}

export interface ExtraReviewInputMetadata {
  kind: "extra_review_inputs";
  prd_number: number;
  prd_label: string;
  prd_branch: string;
  prd_path?: string;
  original_review_base: string;
  resolved_review_base_sha: string;
  reviewed_head_sha: string;
  timestamp: string;
  round: {
    id?: string;
    number?: number;
    artifact_dir: string;
  };
  diff_excludes: string[];
  diff_bytes: number;
  changed_file_count: number;
  input_files: {
    prd_body: string;
    metadata: string;
    changed_files: string;
    diff_stat: string;
    diff: string;
  };
}

export interface WriteCompletedBranchReviewInputsResult {
  paths: ExtraReviewRoundArtifactPaths;
  metadata: ExtraReviewInputMetadata;
  writtenFiles: string[];
  changedFiles: string[];
}

export class ExtraReviewInputWriteError extends Error {
  artifactPath?: string;

  constructor(operation: string, detail: string, cause?: unknown) {
    super(
      `Could not ${operation} extra-review input ${detail}: ${describeError(cause)}`,
      { cause },
    );
    this.name = "ExtraReviewInputWriteError";
    this.artifactPath = detail;
  }
}

export function writeCompletedBranchReviewInputs(
  input: WriteCompletedBranchReviewInputsInput,
): WriteCompletedBranchReviewInputsResult {
  validateInput(input);

  const worktreePath = input.worktreePath ?? process.cwd();
  const paths = resolveExtraReviewRoundArtifactPaths({
    runsRootDir: input.runsRootDir,
    prd: {
      number: input.prd.number,
      label: input.prd.label,
      path: input.prd.path,
      title: input.prd.title,
    },
    round: input.round,
  });
  const writtenFiles: string[] = [];

  try {
    mkdirSync(paths.roundDir, { recursive: true });
  } catch (err) {
    throw new ExtraReviewInputWriteError(
      "create artifact directory for",
      paths.roundDir,
      err,
    );
  }

  const resolvedReviewBaseSha =
    input.resolvedReviewBaseSha ??
    resolveCommitish(worktreePath, input.originalReviewBaseArg, "review base");
  const reviewedHeadSha =
    input.reviewedHeadSha ??
    resolveCommitish(worktreePath, input.prd.branch, "completed PRD branch");
  const diffExcludes = [
    ...(input.diffExcludes ?? EXTRA_REVIEW_INPUT_DIFF_EXCLUDES),
  ];
  const reviewRange = `${resolvedReviewBaseSha}..${reviewedHeadSha}`;

  writeGitOutputFile(
    worktreePath,
    ["diff", reviewRange, "--", ".", ...diffExcludes],
    paths.files.inputDiff,
  );
  writtenFiles.push(paths.files.inputDiff);

  writeGitOutputFile(
    worktreePath,
    ["diff", "--stat", reviewRange, "--", ".", ...diffExcludes],
    paths.files.inputDiffStat,
  );
  writtenFiles.push(paths.files.inputDiffStat);

  writeGitOutputFile(
    worktreePath,
    ["diff", "--name-only", reviewRange, "--", ".", ...diffExcludes],
    paths.files.inputChangedFiles,
  );
  writtenFiles.push(paths.files.inputChangedFiles);

  writeText(paths.files.inputPrdBody, input.prd.body);
  writtenFiles.push(paths.files.inputPrdBody);

  const changedFiles = readLineList(paths.files.inputChangedFiles);
  const metadata: ExtraReviewInputMetadata = {
    kind: "extra_review_inputs",
    prd_number: input.prd.number,
    prd_label: input.prd.label,
    prd_branch: input.prd.branch,
    ...(input.prd.path ? { prd_path: input.prd.path } : {}),
    original_review_base: input.originalReviewBaseArg,
    resolved_review_base_sha: resolvedReviewBaseSha,
    reviewed_head_sha: reviewedHeadSha,
    timestamp: normalizeTimestamp(input.timestamp),
    round: {
      ...(input.round.id ? { id: input.round.id } : {}),
      ...(input.round.number !== undefined
        ? { number: input.round.number }
        : {}),
      artifact_dir: paths.roundDir,
    },
    diff_excludes: diffExcludes,
    diff_bytes: statSync(paths.files.inputDiff).size,
    changed_file_count: changedFiles.length,
    input_files: {
      prd_body: paths.files.inputPrdBody,
      metadata: paths.files.inputMetadata,
      changed_files: paths.files.inputChangedFiles,
      diff_stat: paths.files.inputDiffStat,
      diff: paths.files.inputDiff,
    },
  };

  writeText(paths.files.inputMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
  writtenFiles.push(paths.files.inputMetadata);

  return { paths, metadata, writtenFiles, changedFiles };
}

function validateInput(input: WriteCompletedBranchReviewInputsInput): void {
  if (!Number.isInteger(input.prd.number) || input.prd.number < 1) {
    throw new Error(
      `PRD number must be a positive integer, got ${input.prd.number}`,
    );
  }
  assertNonEmpty(input.prd.label, "PRD label");
  assertNonEmpty(input.prd.branch, "PRD branch");
  assertNonEmpty(input.originalReviewBaseArg, "original review base");
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}

function resolveCommitish(
  worktreePath: string,
  ref: string,
  label: string,
): string {
  const result = runGit(worktreePath, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  const sha = result.stdout.trim();
  if (!sha) {
    throw new Error(`Could not resolve ${label} ${ref} to a commit.`);
  }
  return sha;
}

function writeGitOutputFile(
  worktreePath: string,
  args: string[],
  artifactPath: string,
): void {
  let fd: number | undefined;
  try {
    fd = openSync(artifactPath, "w");
    const result = spawnSync("git", args, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", fd, "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        [
          `git ${args.join(" ")} exited ${formatExit(result.status, result.signal)}`,
          result.stderr?.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  } catch (err) {
    throw new ExtraReviewInputWriteError("write", artifactPath, err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeText(artifactPath: string, contents: string): void {
  try {
    writeFileSync(artifactPath, contents, "utf8");
  } catch (err) {
    throw new ExtraReviewInputWriteError("write", artifactPath, err);
  }
}

function runGit(worktreePath: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} exited ${formatExit(result.status, result.signal)}`,
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function readLineList(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeTimestamp(timestamp: Date | string | undefined): string {
  if (timestamp === undefined) return new Date().toISOString();
  if (typeof timestamp === "string") {
    assertNonEmpty(timestamp, "timestamp");
    return timestamp;
  }
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("timestamp must be valid.");
  }
  return timestamp.toISOString();
}

function formatExit(
  status: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (status !== null) return `with status ${status}`;
  return signal ? `after signal ${signal}` : "without an exit status";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
