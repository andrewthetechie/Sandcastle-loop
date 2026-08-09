// Pure module for the PR review result artifact: schema, validation, and
// markdown rendering for the comment the host posts on the PR.

export interface PrReviewFinding {
  severity: "info" | "warning" | "error" | "blocked";
  description: string;
  file?: string;
  line?: number;
}

export interface PrReviewRejectedFinding {
  original_finding: string;
  reason: string;
}

export interface PrReviewResult {
  risk: number;
  summary: string;
  findings: PrReviewFinding[];
  fixes_applied: PrReviewFinding[];
  not_fixed: PrReviewRejectedFinding[];
  notes?: string;
}

export interface ValidatedPrReviewResult {
  result: PrReviewResult;
  commentMarkdown: string;
}

export type PrReviewResultValidationError =
  | { kind: "invalid_json"; message: string }
  | { kind: "schema"; message: string };

const RISK_LABELS = ["risk-0", "risk-1", "risk-2", "risk-3", "risk-4", "risk-5"];

export function isRiskLabel(label: string): boolean {
  return RISK_LABELS.includes(label);
}

export function allRiskLabels(): readonly string[] {
  return RISK_LABELS;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const VALID_SEVERITIES = ["info", "warning", "error", "blocked"] as const;

function validateFinding(value: unknown, index: number): string | undefined {
  if (!isObject(value)) {
    return `finding[${index}] is not an object`;
  }
  if (!isString(value.description) || value.description.trim().length === 0) {
    return `finding[${index}].description must be a non-empty string`;
  }
  if (
    !isString(value.severity) ||
    !(VALID_SEVERITIES as readonly string[]).includes(value.severity)
  ) {
    return `finding[${index}].severity must be one of ${VALID_SEVERITIES.join(", ")}`;
  }
  if (value.file !== undefined && !isString(value.file)) {
    return `finding[${index}].file must be a string`;
  }
  if (value.line !== undefined && !isNumber(value.line)) {
    return `finding[${index}].line must be an integer`;
  }
  return undefined;
}

function validateRejectedFinding(
  value: unknown,
  index: number,
): string | undefined {
  if (!isObject(value)) {
    return `not_fixed[${index}] is not an object`;
  }
  if (
    !isString(value.original_finding) ||
    value.original_finding.trim().length === 0
  ) {
    return `not_fixed[${index}].original_finding must be a non-empty string`;
  }
  if (!isString(value.reason) || value.reason.trim().length === 0) {
    return `not_fixed[${index}].reason must be a non-empty string`;
  }
  return undefined;
}

export function validatePrReviewResult(
  raw: string,
): { ok: true; result: PrReviewResult } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`invalid JSON: ${message}`] };
  }

  if (!isObject(parsed)) {
    return { ok: false, errors: ["result is not a JSON object"] };
  }

  const errors: string[] = [];

  if (!isNumber(parsed.risk) || parsed.risk < 0 || parsed.risk > 5) {
    errors.push("risk must be an integer between 0 and 5");
  }

  if (!isString(parsed.summary) || parsed.summary.trim().length === 0) {
    errors.push("summary must be a non-empty string");
  }

  if (!isArray(parsed.findings)) {
    errors.push("findings must be an array");
  } else {
    for (let i = 0; i < parsed.findings.length; i++) {
      const err = validateFinding(parsed.findings[i], i);
      if (err) errors.push(err);
    }
  }

  if (!isArray(parsed.fixes_applied)) {
    errors.push("fixes_applied must be an array");
  } else {
    for (let i = 0; i < parsed.fixes_applied.length; i++) {
      const err = validateFinding(parsed.fixes_applied[i], i);
      if (err) errors.push(err);
    }
  }

  if (!isArray(parsed.not_fixed)) {
    errors.push("not_fixed must be an array");
  } else {
    for (let i = 0; i < parsed.not_fixed.length; i++) {
      const err = validateRejectedFinding(parsed.not_fixed[i], i);
      if (err) errors.push(err);
    }
  }

  if (parsed.notes !== undefined && !isString(parsed.notes)) {
    errors.push("notes must be a string");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    result: {
      risk: parsed.risk as number,
      summary: parsed.summary as string,
      findings: parsed.findings as PrReviewFinding[],
      fixes_applied: parsed.fixes_applied as PrReviewFinding[],
      not_fixed: parsed.not_fixed as PrReviewRejectedFinding[],
      notes: parsed.notes as string | undefined,
    },
  };
}

export function renderPrReviewComment(input: {
  result: PrReviewResult;
  reviewedHeadSha: string;
  commitCount: number;
}): string {
  const { result, reviewedHeadSha, commitCount } = input;

  const lines: string[] = [
    `## AI PR review complete — risk ${result.risk}/5`,
    "",
    `Reviewed HEAD: \`${reviewedHeadSha}\``,
    "",
    result.summary,
  ];

  if (commitCount > 0) {
    lines.push("", `The reviewer applied ${commitCount} fix commit(s).`);
  }

  lines.push(
    "",
    "### Findings",
    "",
    formatFindingList(result.findings),
  );

  lines.push(
    "",
    "### Fixes applied",
    "",
    formatFindingList(result.fixes_applied),
  );

  lines.push(
    "",
    "### Not fixed and why",
    "",
    formatRejectedList(result.not_fixed),
  );

  if (result.notes) {
    lines.push("", "### Notes", "", result.notes);
  }

  return lines.join("\n");
}

function formatFindingList(findings: PrReviewFinding[]): string {
  if (findings.length === 0) {
    return "_None recorded._";
  }
  return findings
    .map((finding) => {
      const location =
        finding.file !== undefined
          ? `**${finding.file}${
              finding.line !== undefined ? `:${finding.line}` : ""
            }** — `
          : "";
      return `- ${location}[${finding.severity}] ${finding.description}`;
    })
    .join("\n");
}

function formatRejectedList(findings: PrReviewRejectedFinding[]): string {
  if (findings.length === 0) {
    return "_None recorded._";
  }
  return findings
    .map(
      (finding) =>
        `- **${finding.original_finding}** — ${finding.reason}`,
    )
    .join("\n");
}
