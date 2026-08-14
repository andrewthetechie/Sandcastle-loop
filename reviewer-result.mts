import { validateReviewResult } from "./structured-result-validators.mts";
import { readStructuredResultFromWorktree } from "./structured-result-acquisition.mts";

export interface ReviewFinding {
  aspect?: string;
  confidence?: number;
  severity?: string;
  file?: string;
  line?: number;
  problem: string;
  remediation: string;
}

export interface ReviewResult {
  decision: "approved" | "changes_requested" | "needs_human_review";
  summary: string;
  findings: ReviewFinding[];
}

export type ReviewerParseFailureCode =
  | "invalid_json"
  | "wrong_shape"
  | "approved_with_findings"
  | "blocking_without_findings"
  | "multiple_tags";

export interface ReviewerVerdictAcquisition {
  kind: "verdict";
  review: ReviewResult;
  resultSource: "structured_result_file";
  logFallbackUsed: false;
  logFilePath?: string;
  diagnostics: string[];
}

export interface ReviewerParseFailedAcquisition {
  kind: "parse_failed";
  code: ReviewerParseFailureCode;
  resultSource: "structured_result_file";
  logFallbackUsed: false;
  logFilePath?: string;
  diagnostics: string[];
}

export interface ReviewerIncompleteAcquisition {
  kind: "incomplete";
  code: "missing_tag";
  resultSource: "none";
  logFallbackUsed: false;
  logFilePath?: string;
  diagnostics: string[];
}

export type ReviewerAcquisitionResult =
  | ReviewerVerdictAcquisition
  | ReviewerParseFailedAcquisition
  | ReviewerIncompleteAcquisition;

interface AcquireReviewerResultInput {
  worktreePath: string;
  logFilePath?: string;
}

export function buildReviewerAttemptRunName(
  issueNumber: number,
  round: number,
  attempt: number,
): string {
  return `reviewer #${issueNumber} r${round} a${attempt}`;
}

export function acquireReviewerResult(
  input: AcquireReviewerResultInput,
): ReviewerAcquisitionResult {
  const diagnostics: string[] = [];
  const read = readStructuredResultFromWorktree<ReviewResult>(
    input.worktreePath,
    "review",
  );
  if (!read.ok) {
    if (read.code === "missing_result_file") {
      diagnostics.push(read.message);
      return {
        kind: "incomplete",
        code: "missing_tag",
        resultSource: "none",
        logFallbackUsed: false,
        logFilePath: input.logFilePath,
        diagnostics,
      };
    }
    diagnostics.push(read.message);
    return {
      kind: "parse_failed",
      code: mapReviewerParseFailureCode(read.code),
      resultSource: "structured_result_file",
      logFallbackUsed: false,
      logFilePath: input.logFilePath,
      diagnostics,
    };
  }

  return {
    kind: "verdict",
    review: read.canonical,
    resultSource: "structured_result_file",
    logFallbackUsed: false,
    logFilePath: input.logFilePath,
    diagnostics,
  };
}

export function summarizeReviewerAttemptFailure(
  result: ReviewerParseFailedAcquisition | ReviewerIncompleteAcquisition,
): string {
  return [
    `status: ${result.kind}`,
    `code: ${result.code}`,
    `source: ${result.resultSource}`,
    result.logFilePath ? `log: ${result.logFilePath}` : null,
    result.diagnostics.length > 0
      ? `diagnostics: ${result.diagnostics.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function sanitizeReviewerExcerpt(text: string): string {
  const normalized = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const redacted = normalized
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [REDACTED]");
  const cappedLines = redacted.split("\n").slice(0, 12).join("\n");
  return cappedLines.slice(0, 800);
}

function mapReviewerParseFailureCode(code: string): ReviewerParseFailureCode {
  switch (code) {
    case "approved_with_findings":
    case "blocking_without_findings":
    case "wrong_shape":
      return code;
    case "malformed_json":
      return "invalid_json";
    default:
      return "wrong_shape";
  }
}

// Silence unused import used only to keep validator export reachable from tests.
export { validateReviewResult };
