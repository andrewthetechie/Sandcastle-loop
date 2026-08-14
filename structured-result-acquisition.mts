import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  CodeQualityExtraReview,
  CodeQualityExtraReviewParseFailure,
  CodeQualityExtraReviewParseResult,
  ExtraReviewParseFailure,
  ExtraReviewTag,
  FollowupIssues,
  FollowupIssuesParseFailure,
  FollowupIssuesParseResult,
  ParseFailureDetail,
  TwoAxisExtraReview,
  TwoAxisExtraReviewParseFailure,
  TwoAxisExtraReviewParseResult,
} from "./extra-review-contracts.mts";
import { preview } from "./extra-review-parser-utils.mts";
import type {
  InitialIssueDecomposition,
  InitialIssueDecompositionParseFailure,
  InitialIssueDecompositionParseResult,
  IssueAsPrdParseFailure,
  IssueAsPrdParseFailureCode,
  IssueAsPrdParseFailureDetail,
  IssueAsPrdParserName,
  IssueAsPrdTag,
  SubtaskImprovementParseFailure,
  SubtaskImprovementParseResult,
  SubtaskImprovementResult,
  SubtaskReadinessParseFailure,
  SubtaskReadinessParseResult,
  SubtaskReadinessResult,
} from "./issue-as-prd-contracts.mts";
import type { RebaseAgentResult } from "./rebase-agent-result.mts";
import type {
  PrReviewFixParseResult,
  PrReviewFixResult,
  PrReviewSpecialistParseResult,
  SpecReview,
  SpecReviewFinding,
  StandardsReview,
  StandardsReviewFinding,
} from "./pr-review-specialists.mts";
import type { ReviewResult } from "./reviewer-result.mts";
import {
  resolveStructuredResultRelativePath,
  type StructuredResultStageId,
} from "./structured-result-contracts.mts";
import {
  type SpecialistReviewValidated,
  type StructuredResultError,
} from "./structured-result-validators.mts";
import { validateStructuredResultStage } from "./structured-result-stage-validation.mts";

export type StructuredResultReadPathOptions = {
  prReviewRelativeDir?: string;
};

export type StructuredResultReadFailureCode =
  | "missing_result_file"
  | "malformed_json"
  | "wrong_top_level_shape";

export interface StructuredResultReadFailure {
  ok: false;
  code: StructuredResultReadFailureCode | string;
  message: string;
  resultPath: string;
  errors: StructuredResultError[];
}

export interface StructuredResultReadSuccess<T> {
  ok: true;
  canonical: T;
  resultPath: string;
}

export type StructuredResultReadResult<T> =
  | StructuredResultReadSuccess<T>
  | StructuredResultReadFailure;

export function readStructuredResultFromWorktree<T>(
  worktreePath: string,
  stageId: StructuredResultStageId,
  options: StructuredResultReadPathOptions = {},
): StructuredResultReadResult<T> {
  const resultPath = resolveStructuredResultRelativePath(stageId, options);
  const absolutePath = join(worktreePath, resultPath);
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      code: "missing_result_file",
      message: `Missing canonical structured-result file at ${resultPath}`,
      resultPath,
      errors: [
        {
          code: "missing_result_file",
          path: resultPath,
          message: "Structured-result MCP did not write the canonical result file.",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      code: "malformed_json",
      message: `Malformed JSON in ${resultPath}: ${error instanceof Error ? error.message : String(error)}`,
      resultPath,
      errors: [
        {
          code: "malformed_json",
          path: resultPath,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const validated = validateStructuredResultStage<T>(stageId, parsed);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code,
      message: validated.errors[0]?.message ?? "Structured result failed validation.",
      resultPath,
      errors: validated.errors,
    };
  }

  return {
    ok: true,
    canonical: validated.canonical,
    resultPath,
  };
}

/** Remove the previous canonical file so one invocation cannot reuse another's result. */
export function clearStructuredResultFromWorktree(
  worktreePath: string,
  stageId: StructuredResultStageId,
  options: StructuredResultReadPathOptions = {},
): void {
  const resultPath = resolveStructuredResultRelativePath(stageId, options);
  rmSync(join(worktreePath, resultPath), { force: true });
}

export function readInitialIssueDecompositionFromWorktree(
  worktreePath: string,
): InitialIssueDecompositionParseResult {
  return mapIssueAsPrdReadResult(
    readStructuredResultFromWorktree<InitialIssueDecomposition>(
      worktreePath,
      "initial_issue_decomposition",
    ),
    "initial_issue_decomposition",
    "initial_issue_decomposition",
    initialIssueDecompositionFailure,
  );
}

export function readSubtaskReadinessFromWorktree(
  worktreePath: string,
): SubtaskReadinessParseResult {
  return mapIssueAsPrdReadResult(
    readStructuredResultFromWorktree<SubtaskReadinessResult>(
      worktreePath,
      "subtask_readiness",
    ),
    "subtask_readiness",
    "subtask_readiness",
    subtaskReadinessFailure,
  );
}

export function readSubtaskImprovementFromWorktree(
  worktreePath: string,
): SubtaskImprovementParseResult {
  return mapIssueAsPrdReadResult(
    readStructuredResultFromWorktree<SubtaskImprovementResult>(
      worktreePath,
      "subtask_improvement",
    ),
    "subtask_improvement",
    "subtask_improvement",
    subtaskImprovementFailure,
  );
}

export function readCodeQualityExtraReviewFromWorktree(
  worktreePath: string,
): CodeQualityExtraReviewParseResult {
  return mapExtraReviewReadResult(
    readStructuredResultFromWorktree<CodeQualityExtraReview>(
      worktreePath,
      "code_quality_extra_review",
    ),
    "code_quality_extra_review",
    "extra_review",
    codeQualityFailure,
  );
}

export function readTwoAxisExtraReviewFromWorktree(
  worktreePath: string,
): TwoAxisExtraReviewParseResult {
  return mapExtraReviewReadResult(
    readStructuredResultFromWorktree<TwoAxisExtraReview>(
      worktreePath,
      "two_axis_extra_review",
    ),
    "two_axis_extra_review",
    "extra_review",
    twoAxisFailure,
  );
}

export function readFollowupIssuesFromWorktree(
  worktreePath: string,
): FollowupIssuesParseResult {
  return mapExtraReviewReadResult(
    readStructuredResultFromWorktree<FollowupIssues>(
      worktreePath,
      "followup_issues",
    ),
    "followup_issues",
    "followup_issues",
    followupFailure,
  );
}

export function readRebaseAgentResultFromWorktree(
  worktreePath: string,
): { ok: true; result: RebaseAgentResult } | { ok: false; diagnostics: string[] } {
  const read = readStructuredResultFromWorktree<RebaseAgentResult>(
    worktreePath,
    "rebase_result",
  );
  if (!read.ok) {
    return {
      ok: false,
      diagnostics: read.errors.map((error) => error.message),
    };
  }
  return { ok: true, result: read.canonical };
}

export function readStandardsReviewFromWorktree(
  worktreePath: string,
  options: StructuredResultReadPathOptions = {},
): PrReviewSpecialistParseResult<StandardsReview> {
  const read = readStructuredResultFromWorktree<
    SpecialistReviewValidated<StandardsReviewFinding>
  >(
    worktreePath,
    "standards_findings",
    options,
  );
  if (!read.ok) {
    return { kind: "parse_failure", message: read.message };
  }
  if (read.canonical.status === "blocked") {
    return { kind: "blocked", summary: read.canonical.summary };
  }
  return {
    kind: "review",
    review: {
      status: "complete",
      summary: read.canonical.summary,
      findings: read.canonical.findings,
    },
  };
}

export function readSpecReviewFromWorktree(
  worktreePath: string,
  options: StructuredResultReadPathOptions = {},
): PrReviewSpecialistParseResult<SpecReview> {
  const read = readStructuredResultFromWorktree<
    SpecialistReviewValidated<SpecReviewFinding>
  >(
    worktreePath,
    "spec_findings",
    options,
  );
  if (!read.ok) {
    return { kind: "parse_failure", message: read.message };
  }
  if (read.canonical.status === "blocked") {
    return { kind: "blocked", summary: read.canonical.summary };
  }
  return {
    kind: "review",
    review: {
      status: "complete",
      summary: read.canonical.summary,
      findings: read.canonical.findings,
    },
  };
}

export function readPrReviewFixResultFromWorktree(
  worktreePath: string,
  options: StructuredResultReadPathOptions = {},
): PrReviewFixParseResult {
  const read = readStructuredResultFromWorktree<PrReviewFixResult>(
    worktreePath,
    "pr_review_fix",
    options,
  );
  if (!read.ok) {
    return { kind: "parse_failure", message: read.message };
  }
  return { kind: "fix_result", result: read.canonical };
}

function mapIssueAsPrdReadResult<Result>(
  read: StructuredResultReadResult<Result>,
  parser: IssueAsPrdParserName,
  tag: IssueAsPrdTag,
  wrap: (failure: IssueAsPrdParseFailure) => { kind: "parse_failure"; parse_failure: IssueAsPrdParseFailure },
): Result | { kind: "parse_failure"; parse_failure: IssueAsPrdParseFailure } {
  if (read.ok) return read.canonical;
  return wrap(
    issueAsPrdParseFailureFromReadFailure(read, parser, tag),
  );
}

function mapExtraReviewReadResult<Result, Failure extends { kind: "parse_failure" }>(
  read: StructuredResultReadResult<Result>,
  parser: ExtraReviewParseFailure["parser"],
  tag: ExtraReviewTag,
  wrap: (failure: ExtraReviewParseFailure) => Failure,
): Result | Failure {
  if (read.ok) return read.canonical;
  return wrap(extraReviewParseFailureFromReadFailure(read, parser, tag));
}

function issueAsPrdParseFailureFromReadFailure(
  read: StructuredResultReadFailure,
  parser: IssueAsPrdParserName,
  tag: IssueAsPrdTag,
): IssueAsPrdParseFailure {
  const details = structuredErrorsToIssueAsPrdDetails(read.errors);
  const code = issueAsPrdFailureCode(read.code);
  return {
    parser,
    expected_tag: tag,
    code,
    summary: read.message,
    details,
    stdout_preview: preview(`structured-result:${read.resultPath}`),
    json_preview: preview(read.message),
  };
}

function extraReviewParseFailureFromReadFailure(
  read: StructuredResultReadFailure,
  parser: ExtraReviewParseFailure["parser"],
  tag: ExtraReviewTag,
): ExtraReviewParseFailure {
  const details = structuredErrorsToExtraReviewDetails(read.errors);
  const code = extraReviewFailureCode(read.code);
  return {
    parser,
    expected_tag: tag,
    code,
    summary: read.message,
    details,
    stdout_preview: preview(`structured-result:${read.resultPath}`),
    json_preview: preview(read.message),
  };
}

function structuredErrorsToIssueAsPrdDetails(
  errors: StructuredResultError[],
): IssueAsPrdParseFailureDetail[] {
  return errors.map((error) => ({
    code: issueAsPrdFailureCode(error.code),
    path: error.path,
    message: error.message,
  }));
}

function structuredErrorsToExtraReviewDetails(
  errors: StructuredResultError[],
): ParseFailureDetail[] {
  return errors.map((error) => ({
    code: extraReviewFailureCode(error.code),
    path: error.path,
    message: error.message,
  }));
}

function issueAsPrdFailureCode(code: string): IssueAsPrdParseFailureCode {
  switch (code) {
    case "missing_result_file":
      return "missing_tag";
    case "malformed_json":
      return "malformed_json";
    case "wrong_top_level_shape":
      return "wrong_top_level_shape";
    case "missing_required_field":
    case "empty_required_field":
    case "invalid_field_type":
    case "invalid_field_value":
    case "inconsistent_status":
    case "inconsistent_disposition":
    case "unexpected_field":
      return code;
    case "approved_with_findings":
    case "blocking_without_findings":
    case "wrong_shape":
      return "invalid_field_value";
    default:
      return "invalid_field_value";
  }
}

function extraReviewFailureCode(code: string): ExtraReviewParseFailure["code"] {
  switch (code) {
    case "missing_result_file":
      return "missing_tag";
    case "malformed_json":
      return "malformed_json";
    case "wrong_top_level_shape":
      return "wrong_top_level_shape";
    default:
      return "invalid_field_value";
  }
}

function initialIssueDecompositionFailure(
  parse_failure: IssueAsPrdParseFailure,
): InitialIssueDecompositionParseFailure {
  return { kind: "parse_failure", parse_failure };
}

function subtaskReadinessFailure(
  parse_failure: IssueAsPrdParseFailure,
): SubtaskReadinessParseFailure {
  return { kind: "parse_failure", parse_failure };
}

function subtaskImprovementFailure(
  parse_failure: IssueAsPrdParseFailure,
): SubtaskImprovementParseFailure {
  return { kind: "parse_failure", parse_failure };
}

function codeQualityFailure(
  parse_failure: ExtraReviewParseFailure,
): CodeQualityExtraReviewParseFailure {
  return {
    kind: "parse_failure",
    reviewer: "code_quality",
    decision: "needs_human_review",
    summary: parse_failure.summary,
    findings: [],
    parse_failure,
  };
}

function twoAxisFailure(
  parse_failure: ExtraReviewParseFailure,
): TwoAxisExtraReviewParseFailure {
  return {
    kind: "parse_failure",
    reviewer: "two_axis",
    decision: "needs_human_review",
    summary: parse_failure.summary,
    standards_findings: [],
    spec_findings: [],
    parse_failure,
  };
}

function followupFailure(
  parse_failure: ExtraReviewParseFailure,
): FollowupIssuesParseFailure {
  return {
    kind: "parse_failure",
    status: "needs_human_review",
    summary: parse_failure.summary,
    issues: [],
    needs_human_review_reason: parse_failure.summary,
    parse_failure,
  };
}
