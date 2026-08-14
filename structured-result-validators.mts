import type {
  InitialIssueDecomposition,
  IssueAsPrdParseFailureDetail,
  SubtaskImprovementResult,
  SubtaskReadinessResult,
} from "./issue-as-prd-contracts.mts";
import {
  parseInitialIssueDecompositionObject,
  parseSubtaskImprovementObject,
  parseSubtaskReadinessObject,
} from "./issue-as-prd-parsers.mts";
import type {
  CodeQualityExtraReview,
  FollowupIssues,
  ParseFailureDetail,
  TwoAxisExtraReview,
} from "./extra-review-contracts.mts";
import {
  parseCodeQualityReviewObject,
  parseFollowupIssuesObject,
  parseTwoAxisReviewObject,
} from "./extra-review-parsers.mts";
import { isRecord, type JsonRecord } from "./extra-review-parser-utils.mts";
import type { ReviewResult } from "./reviewer-result.mts";
import type { RebaseAgentResult } from "./rebase-agent-result.mts";
import type {
  PrReviewFixResult,
  SpecReview,
  SpecReviewFinding,
  StandardsReview,
  StandardsReviewFinding,
} from "./pr-review-specialists.mts";

/**
 * Shared Structured-result validation seam for the Structured-result MCP and
 * host acquisition. Tag/file extraction stays in parsers; this module owns
 * object-shape + semantic gates.
 */

export interface StructuredResultError {
  code: string;
  path: string;
  message: string;
}

export type StructuredResultValidation<T> =
  | { ok: true; canonical: T }
  | { ok: false; code: string; errors: StructuredResultError[] };

function okCanonical<T>(canonical: T): StructuredResultValidation<T> {
  return { ok: true, canonical };
}

function failValidation(
  errors: StructuredResultError[],
  fallbackCode = "wrong_top_level_shape",
): StructuredResultValidation<never> {
  const normalized =
    errors.length > 0
      ? errors
      : [
          {
            code: fallbackCode,
            path: "$",
            message: "Value did not match the required contract.",
          },
        ];
  return { ok: false, code: normalized[0]!.code, errors: normalized };
}

function fromDetails<T>(
  result: T | null,
  details: Array<{ code: string; path: string; message: string }>,
): StructuredResultValidation<T> {
  if (!result || details.length > 0) {
    return failValidation(
      details.map((d) => ({
        code: d.code,
        path: d.path,
        message: d.message,
      })),
    );
  }
  return okCanonical(result);
}

function requireRecord(
  value: unknown,
): StructuredResultValidation<JsonRecord> {
  if (!isRecord(value)) {
    return failValidation([
      {
        code: "wrong_top_level_shape",
        path: "$",
        message: "Top-level JSON value must be an object.",
      },
    ]);
  }
  return okCanonical(value);
}

export function validateInitialIssueDecomposition(
  value: unknown,
): StructuredResultValidation<InitialIssueDecomposition> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: IssueAsPrdParseFailureDetail[] = [];
  const result = parseInitialIssueDecompositionObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateSubtaskImprovement(
  value: unknown,
): StructuredResultValidation<SubtaskImprovementResult> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: IssueAsPrdParseFailureDetail[] = [];
  const result = parseSubtaskImprovementObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateSubtaskReadiness(
  value: unknown,
): StructuredResultValidation<SubtaskReadinessResult> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: IssueAsPrdParseFailureDetail[] = [];
  const result = parseSubtaskReadinessObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateCodeQualityExtraReview(
  value: unknown,
): StructuredResultValidation<CodeQualityExtraReview> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: ParseFailureDetail[] = [];
  const result = parseCodeQualityReviewObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateTwoAxisExtraReview(
  value: unknown,
): StructuredResultValidation<TwoAxisExtraReview> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: ParseFailureDetail[] = [];
  const result = parseTwoAxisReviewObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateFollowupIssues(
  value: unknown,
): StructuredResultValidation<FollowupIssues> {
  const record = requireRecord(value);
  if (!record.ok) return record;
  const details: ParseFailureDetail[] = [];
  const result = parseFollowupIssuesObject(record.canonical, details);
  return fromDetails(result, details);
}

export function validateReviewResult(
  value: unknown,
): StructuredResultValidation<ReviewResult> {
  if (!isReviewResultShape(value)) {
    return failValidation([
      {
        code: "wrong_shape",
        path: "$",
        message: "Review must include decision, summary, and findings[].",
      },
    ]);
  }
  if (value.decision === "approved" && value.findings.length > 0) {
    return failValidation([
      {
        code: "approved_with_findings",
        path: "$.findings",
        message: "`decision: approved` requires an empty findings array.",
      },
    ]);
  }
  if (value.decision !== "approved" && value.findings.length === 0) {
    return failValidation([
      {
        code: "blocking_without_findings",
        path: "$.findings",
        message: `\`decision: ${value.decision}\` requires at least one finding.`,
      },
    ]);
  }
  return okCanonical(value);
}

export function validateRebaseAgentResult(
  value: unknown,
): StructuredResultValidation<RebaseAgentResult> {
  if (!isRecord(value)) {
    return failValidation([
      {
        code: "wrong_top_level_shape",
        path: "$",
        message: "Rebase result must be a JSON object.",
      },
    ]);
  }
  const keys = [
    "kind",
    "outcome",
    "pre_rebase_sha",
    "target_mainline_sha",
    "rebased_sha",
    "conflicted_files",
    "resolution_summaries",
    "validation",
    "diagnostics",
  ] as const;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) {
    return failValidation([
      {
        code: "unexpected_field",
        path: "$",
        message: "Rebase result must contain exactly the required keys.",
      },
    ]);
  }
  const string = (key: string): string | undefined =>
    typeof value[key] === "string" ? (value[key] as string) : undefined;
  const array = (key: string): string[] | undefined =>
    Array.isArray(value[key]) &&
    (value[key] as unknown[]).every((item) => typeof item === "string")
      ? (value[key] as string[])
      : undefined;
  const kind = string("kind");
  const outcome = string("outcome");
  const pre = string("pre_rebase_sha");
  const target = string("target_mainline_sha");
  const rebased = string("rebased_sha");
  const conflicted = array("conflicted_files");
  const summaries = array("resolution_summaries");
  const validation = array("validation");
  const diagnostics = array("diagnostics");
  if (
    kind !== "rebase_result" ||
    (outcome !== "resolved" && outcome !== "unresolved") ||
    !isSha(pre) ||
    !isSha(target) ||
    rebased === undefined ||
    !conflicted ||
    !summaries ||
    !validation ||
    !diagnostics
  ) {
    return failValidation([
      {
        code: "invalid_field_value",
        path: "$",
        message: "Rebase result fields failed type or SHA checks.",
      },
    ]);
  }
  if (
    outcome === "resolved" &&
    (!isSha(rebased) ||
      conflicted.length === 0 ||
      summaries.length === 0 ||
      validation.length === 0)
  ) {
    return failValidation([
      {
        code: "inconsistent_disposition",
        path: "$.outcome",
        message:
          "Resolved rebase result needs a rebased SHA, conflicted files, resolution summaries, and validation results.",
      },
    ]);
  }
  if (outcome === "unresolved" && (rebased !== "" || diagnostics.length === 0)) {
    return failValidation([
      {
        code: "inconsistent_disposition",
        path: "$.outcome",
        message:
          "Unresolved rebase result needs empty rebased_sha and non-empty diagnostics.",
      },
    ]);
  }
  return okCanonical({
    kind,
    outcome,
    pre_rebase_sha: pre,
    target_mainline_sha: target,
    rebased_sha: rebased,
    conflicted_files: conflicted,
    resolution_summaries: summaries,
    validation,
    diagnostics,
  });
}

export type SpecialistReviewValidated<Finding> =
  | { status: "complete"; summary: string; findings: Finding[] }
  | { status: "blocked"; summary: string };

export function validatePrReviewFixResult(
  value: unknown,
): StructuredResultValidation<PrReviewFixResult> {
  if (!isRecord(value)) {
    return failValidation([
      {
        code: "wrong_top_level_shape",
        path: "$",
        message: "fix result must be an object",
      },
    ]);
  }
  if (!isIntegerInRange(value.risk, 0, 5)) {
    return failValidation([
      {
        code: "invalid_field_value",
        path: "$.risk",
        message: "fix result risk must be an integer from 0 through 5",
      },
    ]);
  }
  if (!isNonEmptyString(value.summary)) {
    return failValidation([
      {
        code: "empty_required_field",
        path: "$.summary",
        message: "fix result summary must be a non-empty string",
      },
    ]);
  }
  if (!Array.isArray(value.dispositions)) {
    return failValidation([
      {
        code: "invalid_field_type",
        path: "$.dispositions",
        message: "fix result dispositions must be an array",
      },
    ]);
  }
  const dispositions: PrReviewFixResult["dispositions"] = [];
  for (const [index, item] of value.dispositions.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.finding_id) ||
      (item.disposition !== "fixed" && item.disposition !== "not_fixed") ||
      !isNonEmptyString(item.reason)
    ) {
      return failValidation([
        {
          code: "invalid_field_value",
          path: `$.dispositions[${index}]`,
          message: `fix result dispositions[${index}] is invalid`,
        },
      ]);
    }
    dispositions.push({
      finding_id: item.finding_id,
      disposition: item.disposition,
      reason: item.reason,
    });
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    return failValidation([
      {
        code: "invalid_field_type",
        path: "$.notes",
        message: "fix result notes must be a string when present",
      },
    ]);
  }
  return okCanonical({
    risk: value.risk,
    summary: value.summary,
    dispositions,
    notes: value.notes as string | undefined,
  });
}

export function validateStandardsReview(
  value: unknown,
): StructuredResultValidation<SpecialistReviewValidated<StandardsReviewFinding>> {
  return validateSpecialistEnvelope(value, parseStandardsFindingLocal);
}

export function validateSpecReview(
  value: unknown,
): StructuredResultValidation<SpecialistReviewValidated<SpecReviewFinding>> {
  return validateSpecialistEnvelope(value, parseSpecFindingLocal);
}

function validateSpecialistEnvelope<Finding extends { id: string }>(
  value: unknown,
  parseFinding: (value: unknown, index: number) => Finding | string,
): StructuredResultValidation<SpecialistReviewValidated<Finding>> {
  if (!isRecord(value)) {
    return failValidation([
      {
        code: "wrong_top_level_shape",
        path: "$",
        message: "Specialist result must be an object.",
      },
    ]);
  }
  if (value.status !== "complete" && value.status !== "blocked") {
    return failValidation([
      {
        code: "invalid_field_value",
        path: "$.status",
        message: "Specialist status must be complete or blocked.",
      },
    ]);
  }
  if (!isNonEmptyString(value.summary)) {
    return failValidation([
      {
        code: "empty_required_field",
        path: "$.summary",
        message: "Specialist summary must be a non-empty string.",
      },
    ]);
  }
  if (!Array.isArray(value.findings)) {
    return failValidation([
      {
        code: "invalid_field_type",
        path: "$.findings",
        message: "Specialist findings must be an array.",
      },
    ]);
  }
  if (value.status === "blocked") {
    if (value.findings.length > 0) {
      return failValidation([
        {
          code: "inconsistent_disposition",
          path: "$.findings",
          message: "Blocked specialist result must not contain findings.",
        },
      ]);
    }
    return okCanonical({ status: "blocked", summary: value.summary });
  }
  const findings: Finding[] = [];
  const ids = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    const parsed = parseFinding(finding, index);
    if (typeof parsed === "string") {
      return failValidation([
        {
          code: "invalid_field_value",
          path: `$.findings[${index}]`,
          message: parsed,
        },
      ]);
    }
    if (ids.has(parsed.id)) {
      return failValidation([
        {
          code: "invalid_field_value",
          path: `$.findings[${index}].id`,
          message: `Duplicate specialist finding id ${parsed.id}.`,
        },
      ]);
    }
    ids.add(parsed.id);
    findings.push(parsed);
  }
  return okCanonical({
    status: "complete",
    summary: value.summary,
    findings,
  });
}

function isReviewResultShape(value: unknown): value is ReviewResult {
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
    value.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.problem === "string" &&
        typeof finding.remediation === "string",
    )
  );
}

function isSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/iu.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseCommonFindingLocal(
  value: Record<string, unknown>,
  index: number,
  label: string,
):
  | {
      severity: "high" | "medium" | "low";
      confidence: number;
      problem: string;
      impact: string;
      fix: string;
      file?: string;
      line?: number;
    }
  | string {
  if (
    value.severity !== "high" &&
    value.severity !== "medium" &&
    value.severity !== "low"
  ) {
    return `${label} finding[${index}].severity is invalid`;
  }
  if (!isIntegerInRange(value.confidence, 70, 100)) {
    return `${label} finding[${index}].confidence must be an integer from 70 through 100`;
  }
  if (
    !isNonEmptyString(value.problem) ||
    !isNonEmptyString(value.impact) ||
    !isNonEmptyString(value.fix)
  ) {
    return `${label} finding[${index}] must include problem, impact, and fix`;
  }
  if (
    value.file !== undefined &&
    value.file !== null &&
    typeof value.file !== "string"
  ) {
    return `${label} finding[${index}].file must be a string or null`;
  }
  if (
    value.line !== undefined &&
    value.line !== null &&
    (!Number.isInteger(value.line) || (value.line as number) < 1)
  ) {
    return `${label} finding[${index}].line must be a positive integer or null`;
  }
  return {
    severity: value.severity,
    confidence: value.confidence,
    problem: value.problem,
    impact: value.impact,
    fix: value.fix,
    file: typeof value.file === "string" ? value.file : undefined,
    line: typeof value.line === "number" ? value.line : undefined,
  };
}

function parseStandardsFindingLocal(
  value: unknown,
  index: number,
): StandardsReviewFinding | string {
  if (!isRecord(value)) return `standards finding[${index}] must be an object`;
  if (!/^STD-\d{3}$/.test(stringValue(value.id))) {
    return `standards finding[${index}].id must match STD-###`;
  }
  if (
    value.source !== "documented_standard" &&
    value.source !== "fowler_smell"
  ) {
    return `standards finding[${index}].source is invalid`;
  }
  if (!isNonEmptyString(value.rule) || !isNonEmptyString(value.reference)) {
    return `standards finding[${index}] must include rule and reference`;
  }
  const common = parseCommonFindingLocal(value, index, "standards");
  if (typeof common === "string") return common;
  return {
    id: value.id as string,
    source: value.source,
    rule: value.rule,
    reference: value.reference,
    ...common,
  };
}

function parseSpecFindingLocal(
  value: unknown,
  index: number,
): SpecReviewFinding | string {
  if (!isRecord(value)) return `spec finding[${index}] must be an object`;
  if (!/^SPEC-\d{3}$/.test(stringValue(value.id))) {
    return `spec finding[${index}].id must match SPEC-###`;
  }
  if (
    value.category !== "missing" &&
    value.category !== "partial" &&
    value.category !== "wrong" &&
    value.category !== "scope_creep"
  ) {
    return `spec finding[${index}].category is invalid`;
  }
  if (
    !isNonEmptyString(value.spec_source) ||
    !isNonEmptyString(value.spec_reference)
  ) {
    return `spec finding[${index}] must include spec_source and spec_reference`;
  }
  const common = parseCommonFindingLocal(value, index, "spec");
  if (typeof common === "string") return common;
  return {
    id: value.id as string,
    category: value.category,
    spec_source: value.spec_source,
    spec_reference: value.spec_reference,
    ...common,
  };
}

// Silence unused type imports used only as documentation anchors for MCP.
export type {
  StandardsReview,
  SpecReview,
};
