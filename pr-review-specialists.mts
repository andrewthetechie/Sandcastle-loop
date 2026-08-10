import type {
  PrReviewFinding,
  PrReviewResult,
} from "./pr-review-result.mts";

export type PrReviewAxis = "standards" | "spec";
export type PrReviewSpecialistSeverity = "high" | "medium" | "low";

export interface PrReviewCandidateFinding {
  id: string;
  axis: PrReviewAxis;
  severity: PrReviewSpecialistSeverity;
  confidence: number;
  file?: string;
  line?: number;
  problem: string;
  impact: string;
  fix: string;
  reference: string;
}

export interface StandardsReviewFinding {
  id: string;
  source: "documented_standard" | "fowler_smell";
  rule: string;
  reference: string;
  severity: PrReviewSpecialistSeverity;
  confidence: number;
  file?: string;
  line?: number;
  problem: string;
  impact: string;
  fix: string;
}

export interface StandardsReview {
  status: "complete";
  summary: string;
  findings: StandardsReviewFinding[];
}

export interface SpecReviewFinding {
  id: string;
  category: "missing" | "partial" | "wrong" | "scope_creep";
  severity: PrReviewSpecialistSeverity;
  confidence: number;
  spec_source: string;
  spec_reference: string;
  file?: string;
  line?: number;
  problem: string;
  impact: string;
  fix: string;
}

export interface SpecReview {
  status: "complete";
  summary: string;
  findings: SpecReviewFinding[];
}

export type PrReviewSpecialistParseResult<T> =
  | { kind: "review"; review: T }
  | { kind: "blocked"; summary: string }
  | { kind: "parse_failure"; message: string };

export interface PrReviewFixDisposition {
  finding_id: string;
  disposition: "fixed" | "not_fixed";
  reason: string;
}

export interface PrReviewFixResult {
  risk: number;
  summary: string;
  dispositions: PrReviewFixDisposition[];
  notes?: string;
}

export type PrReviewFixParseResult =
  | { kind: "fix_result"; result: PrReviewFixResult }
  | { kind: "parse_failure"; message: string };

export function parseStandardsReview(
  stdout: string,
): PrReviewSpecialistParseResult<StandardsReview> {
  const tagged = parseTaggedObject(stdout, "standards_findings");
  if (!tagged.ok) return tagged.failure;
  return parseSpecialistEnvelope(tagged.value, parseStandardsFinding);
}

export function parseSpecReview(
  stdout: string,
): PrReviewSpecialistParseResult<SpecReview> {
  const tagged = parseTaggedObject(stdout, "spec_findings");
  if (!tagged.ok) return tagged.failure;
  return parseSpecialistEnvelope(tagged.value, parseSpecFinding);
}

export function combinePrReviewFindings(
  standards: StandardsReview,
  spec: SpecReview,
): PrReviewCandidateFinding[] {
  return [
    ...standards.findings.map((finding): PrReviewCandidateFinding => ({
      id: finding.id,
      axis: "standards",
      severity: finding.severity,
      confidence: finding.confidence,
      file: finding.file,
      line: finding.line,
      problem: finding.problem,
      impact: finding.impact,
      fix: finding.fix,
      reference: `${finding.reference} — ${finding.rule}`,
    })),
    ...spec.findings.map((finding): PrReviewCandidateFinding => ({
      id: finding.id,
      axis: "spec",
      severity: finding.severity,
      confidence: finding.confidence,
      file: finding.file,
      line: finding.line,
      problem: finding.problem,
      impact: finding.impact,
      fix: finding.fix,
      reference: `${finding.spec_source} — ${finding.spec_reference}`,
    })),
  ];
}

export function parsePrReviewFixResult(raw: string): PrReviewFixParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "parse_failure",
      message: `invalid fix-result JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(value)) {
    return { kind: "parse_failure", message: "fix result must be an object" };
  }
  if (!isIntegerInRange(value.risk, 0, 5)) {
    return {
      kind: "parse_failure",
      message: "fix result risk must be an integer from 0 through 5",
    };
  }
  if (!isNonEmptyString(value.summary)) {
    return {
      kind: "parse_failure",
      message: "fix result summary must be a non-empty string",
    };
  }
  if (!Array.isArray(value.dispositions)) {
    return {
      kind: "parse_failure",
      message: "fix result dispositions must be an array",
    };
  }

  const dispositions: PrReviewFixDisposition[] = [];
  for (const [index, item] of value.dispositions.entries()) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.finding_id) ||
      (item.disposition !== "fixed" && item.disposition !== "not_fixed") ||
      !isNonEmptyString(item.reason)
    ) {
      return {
        kind: "parse_failure",
        message: `fix result dispositions[${index}] is invalid`,
      };
    }
    dispositions.push({
      finding_id: item.finding_id,
      disposition: item.disposition,
      reason: item.reason,
    });
  }

  if (value.notes !== undefined && typeof value.notes !== "string") {
    return {
      kind: "parse_failure",
      message: "fix result notes must be a string when present",
    };
  }

  return {
    kind: "fix_result",
    result: {
      risk: value.risk,
      summary: value.summary,
      dispositions,
      notes: value.notes,
    },
  };
}

export function buildPrReviewResult(
  findings: readonly PrReviewCandidateFinding[],
  fixResult: PrReviewFixResult,
): { ok: true; result: PrReviewResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const findingsById = new Map<string, PrReviewCandidateFinding>();
  for (const finding of findings) {
    if (findingsById.has(finding.id)) {
      errors.push(`duplicate specialist finding id ${finding.id}`);
    }
    findingsById.set(finding.id, finding);
  }

  const dispositionsById = new Map<string, PrReviewFixDisposition>();
  for (const disposition of fixResult.dispositions) {
    if (!findingsById.has(disposition.finding_id)) {
      errors.push(`unknown finding disposition ${disposition.finding_id}`);
    }
    if (dispositionsById.has(disposition.finding_id)) {
      errors.push(`duplicate finding disposition ${disposition.finding_id}`);
    }
    dispositionsById.set(disposition.finding_id, disposition);
  }
  for (const finding of findings) {
    if (!dispositionsById.has(finding.id)) {
      errors.push(`missing finding disposition ${finding.id}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const renderedFindings = findings.map(renderCandidateFinding);
  const fixesApplied: PrReviewFinding[] = [];
  const notFixed: PrReviewResult["not_fixed"] = [];
  for (const finding of findings) {
    const disposition = dispositionsById.get(finding.id)!;
    if (disposition.disposition === "fixed") {
      fixesApplied.push({
        ...renderCandidateFinding(finding),
        description: disposition.reason,
      });
    } else {
      notFixed.push({
        finding_id: finding.id,
        original_finding: finding.problem,
        reason: disposition.reason,
      });
    }
  }

  return {
    ok: true,
    result: {
      risk: fixResult.risk,
      summary: fixResult.summary,
      findings: renderedFindings,
      fixes_applied: fixesApplied,
      not_fixed: notFixed,
      notes: fixResult.notes,
    },
  };
}

function renderCandidateFinding(
  finding: PrReviewCandidateFinding,
): PrReviewFinding {
  return {
    id: finding.id,
    axis: finding.axis,
    severity:
      finding.severity === "high"
        ? "error"
        : finding.severity === "medium"
          ? "warning"
          : "info",
    description: `${finding.problem} Impact: ${finding.impact} Required outcome: ${finding.fix}`,
    file: finding.file,
    line: finding.line,
  };
}

function parseSpecialistEnvelope<T>(
  value: Record<string, unknown>,
  parseFinding: (value: unknown, index: number) => T | string,
): PrReviewSpecialistParseResult<{
  status: "complete";
  summary: string;
  findings: T[];
}> {
  if (value.status !== "complete" && value.status !== "blocked") {
    return {
      kind: "parse_failure",
      message: "specialist status must be complete or blocked",
    };
  }
  if (!isNonEmptyString(value.summary)) {
    return {
      kind: "parse_failure",
      message: "specialist summary must be a non-empty string",
    };
  }
  if (!Array.isArray(value.findings)) {
    return {
      kind: "parse_failure",
      message: "specialist findings must be an array",
    };
  }
  if (value.status === "blocked") {
    if (value.findings.length > 0) {
      return {
        kind: "parse_failure",
        message: "blocked specialist result must not contain findings",
      };
    }
    return { kind: "blocked", summary: value.summary };
  }

  const findings: T[] = [];
  const ids = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    const parsed = parseFinding(finding, index);
    if (typeof parsed === "string") {
      return { kind: "parse_failure", message: parsed };
    }
    const id = (parsed as { id: string }).id;
    if (ids.has(id)) {
      return {
        kind: "parse_failure",
        message: `duplicate specialist finding id ${id}`,
      };
    }
    ids.add(id);
    findings.push(parsed);
  }
  return {
    kind: "review",
    review: { status: "complete", summary: value.summary, findings },
  };
}

function parseStandardsFinding(
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
  const common = parseCommonFinding(value, index, "standards");
  if (typeof common === "string") return common;
  if (!isNonEmptyString(value.rule) || !isNonEmptyString(value.reference)) {
    return `standards finding[${index}] must name its rule and reference`;
  }
  return {
    ...common,
    id: stringValue(value.id),
    source: value.source,
    rule: value.rule,
    reference: value.reference,
  };
}

function parseSpecFinding(
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
  const common = parseCommonFinding(value, index, "spec");
  if (typeof common === "string") return common;
  if (
    !isNonEmptyString(value.spec_source) ||
    !isNonEmptyString(value.spec_reference)
  ) {
    return `spec finding[${index}] must name its spec source and reference`;
  }
  return {
    ...common,
    id: stringValue(value.id),
    category: value.category,
    spec_source: value.spec_source,
    spec_reference: value.spec_reference,
  };
}

function parseCommonFinding(
  value: Record<string, unknown>,
  index: number,
  label: string,
): Omit<
  PrReviewCandidateFinding,
  "id" | "axis" | "reference"
> | string {
  if (!isSpecialistSeverity(value.severity)) {
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

function parseTaggedObject(
  stdout: string,
  tag: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; failure: { kind: "parse_failure"; message: string } } {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const matches = [...stdout.matchAll(pattern)];
  if (matches.length === 0) {
    return {
      ok: false,
      failure: { kind: "parse_failure", message: `missing <${tag}> block` },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      failure: { kind: "parse_failure", message: `multiple <${tag}> blocks` },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(matches[0]![1]!.trim());
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "parse_failure",
        message: `invalid <${tag}> JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      failure: {
        kind: "parse_failure",
        message: `<${tag}> content must be an object`,
      },
    };
  }
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function isSpecialistSeverity(
  value: unknown,
): value is PrReviewSpecialistSeverity {
  return value === "high" || value === "medium" || value === "low";
}
