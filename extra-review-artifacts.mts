import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodeQualityExtraReviewParseResult,
  ExtraReviewParseFailure,
  FollowupIssuePriority,
  FollowupIssueSourceFinding,
  FollowupIssuesParseResult,
  TwoAxisExtraReviewParseResult,
} from "./extra-review-support.mts";

export const DEFAULT_EXTRA_REVIEW_RUNS_DIR = join(
  ".sandcastle",
  "extra-review-runs",
);

export type ExtraReviewRoundStopReason =
  | "success"
  | "parse_failure"
  | "needs_human_review"
  | "no_work"
  | "duplicate_only"
  | "skipped"
  | "failure";

export interface ExtraReviewPrdArtifactIdentity {
  number?: number;
  id?: string;
  label?: string;
  path?: string;
  title?: string;
}

export interface ExtraReviewRoundArtifactIdentity {
  number?: number;
  id?: string;
}

export interface ExtraReviewRoundPathInput {
  runsRootDir?: string;
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
}

export interface ExtraReviewRoundArtifactFiles {
  inputDiff: string;
  inputDiffStat: string;
  inputChangedFiles: string;
  inputPrdBody: string;
  inputMetadata: string;
  codeReviewRaw: string;
  codeReviewParsed: string;
  twoAxisReviewRaw: string;
  twoAxisReviewParsed: string;
  issueDecomposerRaw: string;
  issueDecomposerParsed: string;
  createdIssues: string;
  skippedDuplicateIssues: string;
  handoff: string;
}

export interface ExtraReviewRoundArtifactPaths {
  runsRootDir: string;
  prdDirName: string;
  prdDir: string;
  roundDirName: string;
  roundDir: string;
  files: ExtraReviewRoundArtifactFiles;
}

export interface ExtraReviewOutputArtifact<Parsed> {
  raw?: string;
  parsed?: Parsed;
}

export interface ExtraReviewRoundOutputArtifacts {
  codeReview?: ExtraReviewOutputArtifact<CodeQualityExtraReviewParseResult>;
  twoAxisReview?: ExtraReviewOutputArtifact<TwoAxisExtraReviewParseResult>;
  issueDecomposer?: ExtraReviewOutputArtifact<FollowupIssuesParseResult>;
}

export interface ExtraReviewCreatedIssueRecord {
  status: "created";
  title: string;
  dedupe_key: string;
  priority?: FollowupIssuePriority;
  body?: string;
  files?: string[];
  source_findings?: FollowupIssueSourceFinding[];
  issue_number?: number;
  issue_url?: string;
}

export interface ExtraReviewSkippedDuplicateIssueRecord {
  status: "skipped_duplicate";
  title: string;
  dedupe_key: string;
  reason: string;
  priority?: FollowupIssuePriority;
  body?: string;
  files?: string[];
  source_findings?: FollowupIssueSourceFinding[];
  existing_issue_number?: number;
  existing_issue_url?: string;
}

export interface ExtraReviewRoundArtifactInput extends ExtraReviewRoundPathInput {
  reviewBase: string;
  reviewedHead: string;
  stopReason: ExtraReviewRoundStopReason;
  stopDetails?: string[];
  outputs?: ExtraReviewRoundOutputArtifacts;
  createdIssues?: ExtraReviewCreatedIssueRecord[];
  skippedDuplicateIssues?: ExtraReviewSkippedDuplicateIssueRecord[];
}

export interface ExtraReviewRoundWriteResult {
  paths: ExtraReviewRoundArtifactPaths;
  writtenFiles: string[];
  handoff: string;
}

export class ExtraReviewArtifactWriteError extends Error {
  artifactPath: string;

  constructor(operation: string, artifactPath: string, cause: unknown) {
    super(
      `Could not ${operation} extra-review artifact at ${artifactPath}: ${describeError(cause)}`,
      { cause },
    );
    this.name = "ExtraReviewArtifactWriteError";
    this.artifactPath = artifactPath;
  }
}

export function resolveExtraReviewRoundArtifactPaths(
  input: ExtraReviewRoundPathInput,
): ExtraReviewRoundArtifactPaths {
  const runsRootDir = input.runsRootDir ?? DEFAULT_EXTRA_REVIEW_RUNS_DIR;
  const prdDirName = formatPrdArtifactId(input.prd);
  const roundDirName = formatRoundArtifactId(input.round);
  const prdDir = join(runsRootDir, prdDirName);
  const roundDir = join(prdDir, roundDirName);

  return {
    runsRootDir,
    prdDirName,
    prdDir,
    roundDirName,
    roundDir,
    files: {
      inputDiff: join(roundDir, "review-input.diff"),
      inputDiffStat: join(roundDir, "review-input.diff-stat.txt"),
      inputChangedFiles: join(roundDir, "review-input.changed-files.txt"),
      inputPrdBody: join(roundDir, "review-input.prd.md"),
      inputMetadata: join(roundDir, "review-input.metadata.json"),
      codeReviewRaw: join(roundDir, "code-review.raw.txt"),
      codeReviewParsed: join(roundDir, "code-review.parsed.json"),
      twoAxisReviewRaw: join(roundDir, "two-axis-review.raw.txt"),
      twoAxisReviewParsed: join(roundDir, "two-axis-review.parsed.json"),
      issueDecomposerRaw: join(roundDir, "issue-decomposer.raw.txt"),
      issueDecomposerParsed: join(roundDir, "issue-decomposer.parsed.json"),
      createdIssues: join(roundDir, "created-issues.json"),
      skippedDuplicateIssues: join(roundDir, "skipped-duplicate-issues.json"),
      handoff: join(roundDir, "HANDOFF.md"),
    },
  };
}

export function writeExtraReviewRoundArtifacts(
  input: ExtraReviewRoundArtifactInput,
): ExtraReviewRoundWriteResult {
  const paths = resolveExtraReviewRoundArtifactPaths(input);
  const writtenFiles: string[] = [];

  try {
    mkdirSync(paths.roundDir, { recursive: true });
  } catch (err) {
    throw new ExtraReviewArtifactWriteError(
      "create artifact directory for",
      paths.roundDir,
      err,
    );
  }

  const writeText = (artifactPath: string, contents: string): void => {
    try {
      writeFileSync(artifactPath, contents, "utf8");
      writtenFiles.push(artifactPath);
    } catch (err) {
      throw new ExtraReviewArtifactWriteError("write", artifactPath, err);
    }
  };

  const writeJson = (artifactPath: string, value: unknown): void => {
    writeText(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
  };

  if (input.outputs?.codeReview?.raw !== undefined) {
    writeText(paths.files.codeReviewRaw, input.outputs.codeReview.raw);
  }
  if (input.outputs?.codeReview?.parsed !== undefined) {
    writeJson(paths.files.codeReviewParsed, input.outputs.codeReview.parsed);
  }
  if (input.outputs?.twoAxisReview?.raw !== undefined) {
    writeText(paths.files.twoAxisReviewRaw, input.outputs.twoAxisReview.raw);
  }
  if (input.outputs?.twoAxisReview?.parsed !== undefined) {
    writeJson(paths.files.twoAxisReviewParsed, input.outputs.twoAxisReview.parsed);
  }
  if (input.outputs?.issueDecomposer?.raw !== undefined) {
    writeText(paths.files.issueDecomposerRaw, input.outputs.issueDecomposer.raw);
  }
  if (input.outputs?.issueDecomposer?.parsed !== undefined) {
    writeJson(
      paths.files.issueDecomposerParsed,
      input.outputs.issueDecomposer.parsed,
    );
  }

  writeJson(paths.files.createdIssues, input.createdIssues ?? []);
  writeJson(
    paths.files.skippedDuplicateIssues,
    input.skippedDuplicateIssues ?? [],
  );

  const handoff = renderExtraReviewHandoff(input, paths);
  writeText(paths.files.handoff, handoff);

  return { paths, writtenFiles, handoff };
}

export function renderExtraReviewHandoff(
  input: ExtraReviewRoundArtifactInput,
  paths = resolveExtraReviewRoundArtifactPaths(input),
): string {
  const createdIssues = input.createdIssues ?? [];
  const skippedDuplicateIssues = input.skippedDuplicateIssues ?? [];
  const parseFailures = collectParseFailures(input.outputs);
  const needsHumanReview = collectNeedsHumanReview(input.outputs);
  const sections = [
    "# Extra Review Round Handoff",
    "",
    "## Round",
    `- PRD: ${formatPrdDisplay(input.prd, paths.prdDirName)}`,
    `- Round: ${formatRoundDisplay(input.round, paths.roundDirName)}`,
    `- Review base: ${input.reviewBase}`,
    `- Reviewed head: ${input.reviewedHead}`,
    `- Stop reason: ${formatStopReason(input.stopReason)}`,
    `- Artifact directory: ${paths.roundDir}`,
  ];

  if (input.prd.path) sections.push(`- PRD file: ${input.prd.path}`);
  if (input.prd.title) sections.push(`- PRD title: ${input.prd.title}`);
  if (input.prd.label) sections.push(`- PRD label: ${input.prd.label}`);

  sections.push(
    "",
    "## Outcome",
    ...formatOutcome(input, createdIssues, skippedDuplicateIssues),
    "",
    "## Created Issues",
    ...formatCreatedIssues(createdIssues),
    "",
    "## Skipped Duplicates",
    ...formatSkippedDuplicates(skippedDuplicateIssues),
    "",
    "## Parse Failures",
    ...formatParseFailures(parseFailures),
    "",
    "## Needs Human Review",
    ...formatNeedsHumanReview(needsHumanReview),
    "",
    "## Raw Artifacts",
    ...formatRawArtifacts(input.outputs, paths),
    "",
    "## Artifact Index",
    `- Created issue records: ${paths.files.createdIssues}`,
    `- Skipped duplicate records: ${paths.files.skippedDuplicateIssues}`,
    `- Handoff: ${paths.files.handoff}`,
  );

  return `${sections.join("\n")}\n`;
}

export function formatPrdArtifactId(
  prd: ExtraReviewPrdArtifactIdentity,
): string {
  if (prd.id) return safePathComponent(prd.id, "PRD identity");
  if (prd.number !== undefined) {
    if (!Number.isInteger(prd.number) || prd.number < 1) {
      throw new Error(`PRD number must be a positive integer, got ${prd.number}`);
    }
    return `prd-${String(prd.number).padStart(3, "0")}`;
  }
  throw new Error("Extra-review artifact paths require a PRD number or id.");
}

export function formatRoundArtifactId(
  round: ExtraReviewRoundArtifactIdentity,
): string {
  if (round.id) return safePathComponent(round.id, "round identity");
  if (round.number !== undefined) {
    if (!Number.isInteger(round.number) || round.number < 1) {
      throw new Error(
        `Extra-review round number must be a positive integer, got ${round.number}`,
      );
    }
    return `round-${String(round.number).padStart(2, "0")}`;
  }
  throw new Error("Extra-review artifact paths require a round number or id.");
}

interface NamedParseFailure {
  label: string;
  failure: ExtraReviewParseFailure;
}

interface NeedsHumanReviewDetail {
  label: string;
  summary: string;
  reason?: string;
}

function collectParseFailures(
  outputs: ExtraReviewRoundOutputArtifacts | undefined,
): NamedParseFailure[] {
  const failures: NamedParseFailure[] = [];
  const codeReview = outputs?.codeReview?.parsed;
  if (codeReview?.kind === "parse_failure") {
    failures.push({ label: "Code-review", failure: codeReview.parse_failure });
  }
  const twoAxisReview = outputs?.twoAxisReview?.parsed;
  if (twoAxisReview?.kind === "parse_failure") {
    failures.push({
      label: "Two-axis review",
      failure: twoAxisReview.parse_failure,
    });
  }
  const issueDecomposer = outputs?.issueDecomposer?.parsed;
  if (issueDecomposer?.kind === "parse_failure") {
    failures.push({
      label: "Issue decomposer",
      failure: issueDecomposer.parse_failure,
    });
  }
  return failures;
}

function collectNeedsHumanReview(
  outputs: ExtraReviewRoundOutputArtifacts | undefined,
): NeedsHumanReviewDetail[] {
  const details: NeedsHumanReviewDetail[] = [];
  const codeReview = outputs?.codeReview?.parsed;
  if (codeReview?.kind === "extra_review" && codeReview.decision === "needs_human_review") {
    details.push({ label: "Code-review", summary: codeReview.summary });
  }

  const twoAxisReview = outputs?.twoAxisReview?.parsed;
  if (twoAxisReview?.kind === "extra_review" && twoAxisReview.decision === "needs_human_review") {
    details.push({ label: "Two-axis review", summary: twoAxisReview.summary });
  }

  const issueDecomposer = outputs?.issueDecomposer?.parsed;
  if (
    issueDecomposer?.kind === "followup_issues" &&
    issueDecomposer.status === "needs_human_review"
  ) {
    details.push({
      label: "Issue decomposer",
      summary: issueDecomposer.summary,
      reason: issueDecomposer.needs_human_review_reason,
    });
  }
  return details;
}

function formatOutcome(
  input: ExtraReviewRoundArtifactInput,
  createdIssues: ExtraReviewCreatedIssueRecord[],
  skippedDuplicateIssues: ExtraReviewSkippedDuplicateIssueRecord[],
): string[] {
  const details = input.stopDetails ?? [];
  const lines: string[] = [];

  switch (input.stopReason) {
    case "success":
      lines.push(
        `Round completed successfully with ${createdIssues.length} created issue(s) and ${skippedDuplicateIssues.length} skipped duplicate(s).`,
      );
      break;
    case "parse_failure":
      lines.push(
        "Round stopped because at least one extra-review output could not be parsed.",
      );
      break;
    case "needs_human_review":
      lines.push(
        "Round stopped because reviewer or decomposer output requires human review.",
      );
      break;
    case "no_work":
      lines.push(
        "No new issues were created because the decomposer reported no_work.",
      );
      break;
    case "duplicate_only":
      lines.push(
        "No new issues were created because all decomposed issues matched existing duplicates.",
      );
      break;
    case "skipped":
      lines.push("Round was skipped before extra-review work completed.");
      break;
    case "failure":
      lines.push("Round failed before structured completion.");
      break;
  }

  if (details.length > 0) {
    lines.push(...details.map((detail) => `- ${detail}`));
  }
  return lines;
}

function formatCreatedIssues(
  issues: ExtraReviewCreatedIssueRecord[],
): string[] {
  if (issues.length === 0) return ["No created issue records."];
  return issues.map((issue) => {
    const target = issue.issue_number
      ? `#${issue.issue_number}`
      : "unpublished issue";
    const url = issue.issue_url ? ` (${issue.issue_url})` : "";
    return `- ${target}${url}: ${issue.title} [dedupe_key: ${issue.dedupe_key}]`;
  });
}

function formatSkippedDuplicates(
  issues: ExtraReviewSkippedDuplicateIssueRecord[],
): string[] {
  if (issues.length === 0) return ["No skipped duplicate records."];
  return issues.map((issue) => {
    const target = issue.existing_issue_number
      ? `existing #${issue.existing_issue_number}`
      : "existing issue";
    const url = issue.existing_issue_url ? ` (${issue.existing_issue_url})` : "";
    return `- ${target}${url}: ${issue.title} [dedupe_key: ${issue.dedupe_key}; reason: ${issue.reason}]`;
  });
}

function formatParseFailures(failures: NamedParseFailure[]): string[] {
  if (failures.length === 0) return ["No parse failures recorded."];
  return failures.flatMap(({ label, failure }) => [
    `- ${label} output could not be parsed: ${failure.summary}`,
    `  - Parser: ${failure.parser}`,
    `  - Code: ${failure.code}`,
    `  - Details: ${failure.details.map((detail) => `${detail.path} ${detail.message}`).join("; ")}`,
  ]);
}

function formatNeedsHumanReview(details: NeedsHumanReviewDetail[]): string[] {
  if (details.length === 0) return ["No needs-human-review details recorded."];
  return details.map((detail) => {
    const reason = detail.reason ? ` Reason: ${detail.reason}` : "";
    return `- ${detail.label}: ${detail.summary}${reason}`;
  });
}

function formatRawArtifacts(
  outputs: ExtraReviewRoundOutputArtifacts | undefined,
  paths: ExtraReviewRoundArtifactPaths,
): string[] {
  const lines: string[] = [];
  if (outputs?.codeReview?.raw !== undefined) {
    lines.push(`- Raw code-review output: ${paths.files.codeReviewRaw}`);
  }
  if (outputs?.codeReview?.parsed !== undefined) {
    lines.push(`- Parsed code-review JSON: ${paths.files.codeReviewParsed}`);
  }
  if (outputs?.twoAxisReview?.raw !== undefined) {
    lines.push(`- Raw two-axis-review output: ${paths.files.twoAxisReviewRaw}`);
  }
  if (outputs?.twoAxisReview?.parsed !== undefined) {
    lines.push(`- Parsed two-axis-review JSON: ${paths.files.twoAxisReviewParsed}`);
  }
  if (outputs?.issueDecomposer?.raw !== undefined) {
    lines.push(`- Raw issue-decomposer output: ${paths.files.issueDecomposerRaw}`);
  }
  if (outputs?.issueDecomposer?.parsed !== undefined) {
    lines.push(
      `- Parsed issue-decomposer JSON: ${paths.files.issueDecomposerParsed}`,
    );
  }
  return lines.length > 0 ? lines : ["No raw agent output artifacts were provided."];
}

function formatPrdDisplay(
  prd: ExtraReviewPrdArtifactIdentity,
  fallbackId: string,
): string {
  const parts = [prd.label, prd.id, prd.number ? `#${prd.number}` : undefined]
    .filter(Boolean)
    .join(" / ");
  return parts || fallbackId;
}

function formatRoundDisplay(
  round: ExtraReviewRoundArtifactIdentity,
  fallbackId: string,
): string {
  const parts = [round.id, round.number ? `#${round.number}` : undefined]
    .filter(Boolean)
    .join(" / ");
  return parts || fallbackId;
}

function formatStopReason(reason: ExtraReviewRoundStopReason): string {
  return reason.replaceAll("_", "-");
}

function safePathComponent(raw: string, label: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error(`${label} must produce a non-empty path component.`);
  }
  return trimmed;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
