import {
  AXES,
  FOLLOWUP_STATUSES,
  ISSUE_PRIORITIES,
  REVIEW_DECISIONS,
  REVIEWERS,
  SEVERITIES,
  type CodeQualityExtraReview,
  type CodeQualityExtraReviewParseFailure,
  type CodeQualityExtraReviewParseResult,
  type ExtraReviewAxis,
  type ExtraReviewDecision,
  type ExtraReviewFinding,
  type ExtraReviewParseFailure,
  type FollowupIssueDraft,
  type FollowupIssueSourceFinding,
  type FollowupIssueStatus,
  type FollowupIssues,
  type FollowupIssuesParseFailure,
  type FollowupIssuesParseResult,
  type ParseFailureDetail,
  type TwoAxisExtraReview,
  type TwoAxisExtraReviewParseFailure,
  type TwoAxisExtraReviewParseResult,
} from "./extra-review-contracts.mts";
import {
  enumField,
  exactKeys,
  exactStringField,
  hasOwn,
  integerRangeField,
  invalidType,
  isRecord,
  type JsonRecord,
  missingField,
  nonEmptyStringField,
  parseTaggedJsonObject,
  preview,
  stringArrayField,
  stringField,
  validationFailure,
} from "./extra-review-parser-utils.mts";

export function parseCodeQualityExtraReview(
  stdout: string,
): CodeQualityExtraReviewParseResult {
  const parsed = parseTaggedJsonObject(
    stdout,
    "extra_review",
    "code_quality_extra_review",
  );
  if ("failure" in parsed) return codeQualityFailure(parsed.failure);

  const details: ParseFailureDetail[] = [];
  const review = parseCodeQualityReviewObject(parsed.value, details);
  if (details.length > 0 || !review) {
    return codeQualityFailure(
      validationFailure(
        "code_quality_extra_review",
        "extra_review",
        stdout,
        parsed.rawJson,
        details,
      ),
    );
  }

  return review;
}

export function parseTwoAxisExtraReview(
  stdout: string,
): TwoAxisExtraReviewParseResult {
  const parsed = parseTaggedJsonObject(
    stdout,
    "extra_review",
    "two_axis_extra_review",
  );
  if ("failure" in parsed) return twoAxisFailure(parsed.failure);

  const details: ParseFailureDetail[] = [];
  const review = parseTwoAxisReviewObject(parsed.value, details);
  if (details.length > 0 || !review) {
    return twoAxisFailure(
      validationFailure(
        "two_axis_extra_review",
        "extra_review",
        stdout,
        parsed.rawJson,
        details,
      ),
    );
  }

  return review;
}

export function parseFollowupIssues(
  stdout: string,
): FollowupIssuesParseResult {
  const parsed = parseTaggedJsonObject(
    stdout,
    "followup_issues",
    "followup_issues",
  );
  if ("failure" in parsed) return followupIssuesFailure(parsed.failure);

  const details: ParseFailureDetail[] = [];
  const issues = parseFollowupIssuesObject(parsed.value, details);
  if (details.length > 0 || !issues) {
    return followupIssuesFailure(
      validationFailure(
        "followup_issues",
        "followup_issues",
        stdout,
        parsed.rawJson,
        details,
      ),
    );
  }

  return issues;
}

export function parseCodeQualityReviewObject(
  value: JsonRecord,
  details: ParseFailureDetail[],
): CodeQualityExtraReview | null {
  exactKeys(value, ["reviewer", "decision", "summary", "findings"], "$", details);
  const reviewer = exactStringField(
    value,
    "reviewer",
    "code_quality",
    "$.reviewer",
    details,
  );
  const decision = enumField(
    value,
    "decision",
    REVIEW_DECISIONS,
    "$.decision",
    details,
  );
  const summary = nonEmptyStringField(
    value,
    "summary",
    "$.summary",
    details,
  );
  const findings = findingArray(
    value,
    "findings",
    "code_quality",
    "$.findings",
    details,
  );

  validateReviewDecision(decision, findings?.length, "$.decision", details);

  if (!reviewer || !decision || !summary || !findings) return null;
  return {
    kind: "extra_review",
    reviewer,
    decision,
    summary,
    findings,
  };
}

export function parseTwoAxisReviewObject(
  value: JsonRecord,
  details: ParseFailureDetail[],
): TwoAxisExtraReview | null {
  exactKeys(
    value,
    [
      "reviewer",
      "decision",
      "summary",
      "standards_findings",
      "spec_findings",
    ],
    "$",
    details,
  );
  const reviewer = exactStringField(
    value,
    "reviewer",
    "two_axis",
    "$.reviewer",
    details,
  );
  const decision = enumField(
    value,
    "decision",
    REVIEW_DECISIONS,
    "$.decision",
    details,
  );
  const summary = nonEmptyStringField(
    value,
    "summary",
    "$.summary",
    details,
  );
  const standardsFindings = findingArray(
    value,
    "standards_findings",
    "standards",
    "$.standards_findings",
    details,
  );
  const specFindings = findingArray(
    value,
    "spec_findings",
    "spec",
    "$.spec_findings",
    details,
  );
  const findingCount =
    standardsFindings && specFindings
      ? standardsFindings.length + specFindings.length
      : undefined;

  validateReviewDecision(decision, findingCount, "$.decision", details);

  if (!reviewer || !decision || !summary || !standardsFindings || !specFindings) {
    return null;
  }
  return {
    kind: "extra_review",
    reviewer,
    decision,
    summary,
    standards_findings: standardsFindings,
    spec_findings: specFindings,
  };
}

export function parseFollowupIssuesObject(
  value: JsonRecord,
  details: ParseFailureDetail[],
): FollowupIssues | null {
  exactKeys(
    value,
    ["status", "summary", "issues", "needs_human_review_reason"],
    "$",
    details,
  );
  const status = enumField(
    value,
    "status",
    FOLLOWUP_STATUSES,
    "$.status",
    details,
  );
  const summary = nonEmptyStringField(
    value,
    "summary",
    "$.summary",
    details,
  );
  const issues = issueDraftArray(value, "issues", "$.issues", details);
  const needsHumanReviewReason = stringField(
    value,
    "needs_human_review_reason",
    "$.needs_human_review_reason",
    details,
  );

  validateFollowupStatus(
    status,
    issues?.length,
    needsHumanReviewReason,
    "$.status",
    details,
  );

  if (!status || !summary || !issues || needsHumanReviewReason === undefined) {
    return null;
  }

  if (status === "issues") {
    return {
      kind: "followup_issues",
      status,
      summary,
      issues,
      needs_human_review_reason: "",
    };
  }

  if (status === "no_work") {
    return {
      kind: "followup_issues",
      status,
      summary,
      issues: [],
      needs_human_review_reason: "",
    };
  }

  return {
    kind: "followup_issues",
    status,
    summary,
    issues: [],
    needs_human_review_reason: needsHumanReviewReason,
  };
}

function findingArray<Source extends ExtraReviewAxis>(
  record: JsonRecord,
  key: string,
  source: Source,
  path: string,
  details: ParseFailureDetail[],
): ExtraReviewFinding<Source>[] | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    invalidType(path, "array", value, details);
    return undefined;
  }

  const findings: ExtraReviewFinding<Source>[] = [];
  value.forEach((item, index) => {
    const finding = parseFinding(item, source, `${path}[${index}]`, details);
    if (finding) findings.push(finding);
  });
  return findings;
}

function parseFinding<Source extends ExtraReviewAxis>(
  value: unknown,
  source: Source,
  path: string,
  details: ParseFailureDetail[],
): ExtraReviewFinding<Source> | null {
  if (!isRecord(value)) {
    invalidType(path, "object", value, details);
    return null;
  }

  exactKeys(
    value,
    [
      "id",
      "severity",
      "confidence",
      "title",
      "problem",
      "impact",
      "recommendation",
      "files",
      "source",
    ],
    path,
    details,
  );

  const id = nonEmptyStringField(value, "id", `${path}.id`, details);
  const severity = enumField(
    value,
    "severity",
    SEVERITIES,
    `${path}.severity`,
    details,
  );
  const confidence = integerRangeField(
    value,
    "confidence",
    0,
    100,
    `${path}.confidence`,
    details,
  );
  const title = nonEmptyStringField(value, "title", `${path}.title`, details);
  const problem = nonEmptyStringField(
    value,
    "problem",
    `${path}.problem`,
    details,
  );
  const impact = nonEmptyStringField(
    value,
    "impact",
    `${path}.impact`,
    details,
  );
  const recommendation = nonEmptyStringField(
    value,
    "recommendation",
    `${path}.recommendation`,
    details,
  );
  const files = stringArrayField(value, "files", `${path}.files`, details);
  const actualSource = exactStringField(
    value,
    "source",
    source,
    `${path}.source`,
    details,
  );

  if (
    !id ||
    !severity ||
    confidence === undefined ||
    !title ||
    !problem ||
    !impact ||
    !recommendation ||
    !files ||
    !actualSource
  ) {
    return null;
  }

  return {
    id,
    severity,
    confidence,
    title,
    problem,
    impact,
    recommendation,
    files,
    source: actualSource,
  };
}

function issueDraftArray(
  record: JsonRecord,
  key: string,
  path: string,
  details: ParseFailureDetail[],
): FollowupIssueDraft[] | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    invalidType(path, "array", value, details);
    return undefined;
  }

  const issues: FollowupIssueDraft[] = [];
  value.forEach((item, index) => {
    const issue = parseIssueDraft(item, `${path}[${index}]`, details);
    if (issue) issues.push(issue);
  });
  return issues;
}

function parseIssueDraft(
  value: unknown,
  path: string,
  details: ParseFailureDetail[],
): FollowupIssueDraft | null {
  if (!isRecord(value)) {
    invalidType(path, "object", value, details);
    return null;
  }

  exactKeys(
    value,
    ["title", "body", "priority", "source_findings", "files", "dedupe_key"],
    path,
    details,
  );
  const title = nonEmptyStringField(value, "title", `${path}.title`, details);
  const body = nonEmptyStringField(value, "body", `${path}.body`, details);
  const priority = enumField(
    value,
    "priority",
    ISSUE_PRIORITIES,
    `${path}.priority`,
    details,
  );
  const sourceFindings = sourceFindingArray(
    value,
    "source_findings",
    `${path}.source_findings`,
    details,
  );
  const files = stringArrayField(value, "files", `${path}.files`, details);
  const dedupeKey = nonEmptyStringField(
    value,
    "dedupe_key",
    `${path}.dedupe_key`,
    details,
  );

  if (typeof body === "string") {
    if (!/\bacceptance\s+criteria\b/i.test(body)) {
      details.push({
        code: "invalid_field_value",
        path: `${path}.body`,
        message: "Issue body must include acceptance criteria.",
        expected: "body containing 'acceptance criteria'",
        actual: preview(body, 120),
      });
    }
    if (!/\bprovenance\b/i.test(body)) {
      details.push({
        code: "invalid_field_value",
        path: `${path}.body`,
        message: "Issue body must include provenance.",
        expected: "body containing 'provenance'",
        actual: preview(body, 120),
      });
    }
  }

  if (sourceFindings && sourceFindings.length === 0) {
    details.push({
      code: "empty_required_field",
      path: `${path}.source_findings`,
      message: "Follow-up issues must preserve at least one source finding.",
      expected: "one or more source findings",
      actual: "[]",
    });
  }

  if (!title || !body || !priority || !sourceFindings || !files || !dedupeKey) {
    return null;
  }

  return {
    title,
    body,
    priority,
    source_findings: sourceFindings,
    files,
    dedupe_key: dedupeKey,
  };
}

function sourceFindingArray(
  record: JsonRecord,
  key: string,
  path: string,
  details: ParseFailureDetail[],
): FollowupIssueSourceFinding[] | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    invalidType(path, "array", value, details);
    return undefined;
  }

  const sourceFindings: FollowupIssueSourceFinding[] = [];
  value.forEach((item, index) => {
    const sourceFinding = parseSourceFinding(
      item,
      `${path}[${index}]`,
      details,
    );
    if (sourceFinding) sourceFindings.push(sourceFinding);
  });
  return sourceFindings;
}

function parseSourceFinding(
  value: unknown,
  path: string,
  details: ParseFailureDetail[],
): FollowupIssueSourceFinding | null {
  if (!isRecord(value)) {
    invalidType(path, "object", value, details);
    return null;
  }

  exactKeys(value, ["reviewer", "finding_id", "axis", "title"], path, details);
  const reviewer = enumField(
    value,
    "reviewer",
    REVIEWERS,
    `${path}.reviewer`,
    details,
  );
  const findingId = nonEmptyStringField(
    value,
    "finding_id",
    `${path}.finding_id`,
    details,
  );
  const axis = enumField(value, "axis", AXES, `${path}.axis`, details);
  const title = nonEmptyStringField(value, "title", `${path}.title`, details);

  if (reviewer && axis) {
    if (reviewer === "code_quality" && axis !== "code_quality") {
      details.push({
        code: "inconsistent_provenance",
        path,
        message: "Code-quality source findings must use axis code_quality.",
        expected: "reviewer code_quality with axis code_quality",
        actual: `reviewer ${reviewer} with axis ${axis}`,
      });
    }
    if (reviewer === "two_axis" && axis === "code_quality") {
      details.push({
        code: "inconsistent_provenance",
        path,
        message: "Two-axis source findings must use axis standards or spec.",
        expected: "reviewer two_axis with axis standards or spec",
        actual: `reviewer ${reviewer} with axis ${axis}`,
      });
    }
  }

  if (!reviewer || !findingId || !axis || !title) return null;
  return {
    reviewer,
    finding_id: findingId,
    axis,
    title,
  };
}

function validateReviewDecision(
  decision: ExtraReviewDecision | undefined,
  findingCount: number | undefined,
  path: string,
  details: ParseFailureDetail[],
): void {
  if (!decision || findingCount === undefined) return;

  if (decision === "approved" && findingCount > 0) {
    details.push({
      code: "inconsistent_decision",
      path,
      message: "Approved extra reviews must not include findings.",
      expected: "approved with zero findings",
      actual: `approved with ${findingCount} finding(s)`,
    });
  }
  if (decision === "followup_recommended" && findingCount === 0) {
    details.push({
      code: "inconsistent_decision",
      path,
      message: "followup_recommended extra reviews must include findings.",
      expected: "followup_recommended with one or more findings",
      actual: "followup_recommended with zero findings",
    });
  }
}

function validateFollowupStatus(
  status: FollowupIssueStatus | undefined,
  issueCount: number | undefined,
  needsHumanReviewReason: string | undefined,
  path: string,
  details: ParseFailureDetail[],
): void {
  if (!status || issueCount === undefined || needsHumanReviewReason === undefined) {
    return;
  }

  if (status === "issues") {
    if (issueCount === 0) {
      details.push({
        code: "inconsistent_status",
        path,
        message: "issues status requires at least one issue draft.",
        expected: "status issues with one or more issues",
        actual: "status issues with zero issues",
      });
    }
    if (needsHumanReviewReason !== "") {
      details.push({
        code: "inconsistent_status",
        path: "$.needs_human_review_reason",
        message: "issues status must not include a human-review reason.",
        expected: '""',
        actual: needsHumanReviewReason,
      });
    }
  }

  if (status === "no_work") {
    if (issueCount !== 0) {
      details.push({
        code: "inconsistent_status",
        path,
        message: "no_work status must not include issue drafts.",
        expected: "status no_work with zero issues",
        actual: `status no_work with ${issueCount} issue(s)`,
      });
    }
    if (needsHumanReviewReason !== "") {
      details.push({
        code: "inconsistent_status",
        path: "$.needs_human_review_reason",
        message: "no_work status must not include a human-review reason.",
        expected: '""',
        actual: needsHumanReviewReason,
      });
    }
  }

  if (status === "needs_human_review") {
    if (issueCount !== 0) {
      details.push({
        code: "inconsistent_status",
        path,
        message: "needs_human_review status must not include issue drafts.",
        expected: "status needs_human_review with zero issues",
        actual: `status needs_human_review with ${issueCount} issue(s)`,
      });
    }
    if (needsHumanReviewReason.trim() === "") {
      details.push({
        code: "empty_required_field",
        path: "$.needs_human_review_reason",
        message: "needs_human_review status requires a reason.",
        expected: "non-empty string",
        actual: JSON.stringify(needsHumanReviewReason),
      });
    }
  }
}

function codeQualityFailure(
  parseFailure: ExtraReviewParseFailure,
): CodeQualityExtraReviewParseFailure {
  return {
    kind: "parse_failure",
    reviewer: "code_quality",
    decision: "needs_human_review",
    summary: parseFailure.summary,
    findings: [],
    parse_failure: parseFailure,
  };
}

function twoAxisFailure(
  parseFailure: ExtraReviewParseFailure,
): TwoAxisExtraReviewParseFailure {
  return {
    kind: "parse_failure",
    reviewer: "two_axis",
    decision: "needs_human_review",
    summary: parseFailure.summary,
    standards_findings: [],
    spec_findings: [],
    parse_failure: parseFailure,
  };
}

function followupIssuesFailure(
  parseFailure: ExtraReviewParseFailure,
): FollowupIssuesParseFailure {
  return {
    kind: "parse_failure",
    status: "needs_human_review",
    summary: parseFailure.summary,
    issues: [],
    needs_human_review_reason: parseFailure.summary,
    parse_failure: parseFailure,
  };
}
