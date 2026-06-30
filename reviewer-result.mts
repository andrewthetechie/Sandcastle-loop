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
  resultSource: "stdout" | "run_log";
  logFallbackUsed: boolean;
  logFilePath?: string;
  diagnostics: string[];
}

export interface ReviewerParseFailedAcquisition {
  kind: "parse_failed";
  code: ReviewerParseFailureCode;
  resultSource: "stdout" | "run_log";
  logFallbackUsed: boolean;
  logFilePath?: string;
  diagnostics: string[];
}

export interface ReviewerIncompleteAcquisition {
  kind: "incomplete";
  code: "missing_tag";
  resultSource: "none";
  logFallbackUsed: boolean;
  logFilePath?: string;
  diagnostics: string[];
}

export type ReviewerAcquisitionResult =
  | ReviewerVerdictAcquisition
  | ReviewerParseFailedAcquisition
  | ReviewerIncompleteAcquisition;

interface AcquireReviewerResultInput {
  stdout: string;
  runLogText?: string;
  runLogReadError?: string;
  logFilePath?: string;
}

interface SourceParseVerdict {
  kind: "verdict";
  review: ReviewResult;
}

interface SourceParseFailed {
  kind: "parse_failed";
  code: ReviewerParseFailureCode;
}

interface SourceIncomplete {
  kind: "incomplete";
  code: "missing_tag";
}

type SourceParseResult = SourceParseVerdict | SourceParseFailed | SourceIncomplete;

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
  const stdoutResult = parseReviewSource(input.stdout);
  if (stdoutResult.kind === "verdict") {
    return {
      kind: "verdict",
      review: stdoutResult.review,
      resultSource: "stdout",
      logFallbackUsed: false,
      logFilePath: input.logFilePath,
      diagnostics,
    };
  }

  let runLogResult: SourceParseResult | null = null;
  if (typeof input.runLogText === "string") {
    runLogResult = parseReviewSource(input.runLogText);
    if (runLogResult.kind === "verdict") {
      return {
        kind: "verdict",
        review: runLogResult.review,
        resultSource: "run_log",
        logFallbackUsed: true,
        logFilePath: input.logFilePath,
        diagnostics,
      };
    }
  } else if (input.runLogReadError) {
    diagnostics.push(`run log unavailable: ${input.runLogReadError}`);
  }

  const unsuccessful = chooseUnsuccessfulResult(stdoutResult, runLogResult);
  if (unsuccessful.kind === "parse_failed") {
    return {
      kind: "parse_failed",
      code: unsuccessful.code,
      resultSource:
        runLogResult?.kind === "parse_failed" ? "run_log" : "stdout",
      logFallbackUsed: false,
      logFilePath: input.logFilePath,
      diagnostics,
    };
  }

  return {
    kind: "incomplete",
    code: "missing_tag",
    resultSource: "none",
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
  const normalized = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�");
  const redacted = normalized
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [REDACTED]");
  const cappedLines = redacted.split("\n").slice(0, 12).join("\n");
  return cappedLines.slice(0, 800);
}

function chooseUnsuccessfulResult(
  stdoutResult: SourceParseResult,
  runLogResult: SourceParseResult | null,
): SourceParseResult {
  if (runLogResult?.kind === "parse_failed") return runLogResult;
  if (stdoutResult.kind === "parse_failed") return stdoutResult;
  if (runLogResult?.kind === "incomplete") return runLogResult;
  return stdoutResult;
}

function parseReviewSource(source: string): SourceParseResult {
  const matches = [...source.matchAll(/<review>([\s\S]*?)<\/review>/g)];
  if (matches.length === 0) {
    return { kind: "incomplete", code: "missing_tag" };
  }
  if (matches.length > 1) {
    return { kind: "parse_failed", code: "multiple_tags" };
  }

  const payload = matches[0]?.[1]?.trim() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "parse_failed", code: "invalid_json" };
  }
  if (!isReviewResult(parsed)) {
    return { kind: "parse_failed", code: "wrong_shape" };
  }
  if (parsed.decision === "approved" && parsed.findings.length > 0) {
    return { kind: "parse_failed", code: "approved_with_findings" };
  }
  if (parsed.decision !== "approved" && parsed.findings.length === 0) {
    return { kind: "parse_failed", code: "blocking_without_findings" };
  }
  return { kind: "verdict", review: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  return (
    isRecord(value) &&
    typeof value.problem === "string" &&
    typeof value.remediation === "string"
  );
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (!isRecord(value)) return false;
  if (
    value.decision !== "approved" &&
    value.decision !== "changes_requested" &&
    value.decision !== "needs_human_review"
  ) {
    return false;
  }
  return (
    typeof value.summary === "string" &&
    Array.isArray(value.findings) &&
    value.findings.every(isReviewFinding)
  );
}
