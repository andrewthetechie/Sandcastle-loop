import {
  INITIAL_ISSUE_DECOMPOSITION_STATUSES,
  INITIAL_SUBTASK_PRIORITIES,
  SUBTASK_READINESS_DISPOSITIONS,
  type InitialIssueDecomposition,
  type InitialIssueDecompositionParseFailure,
  type InitialIssueDecompositionParseResult,
  type InitialSubtaskDraft,
  type IssueAsPrdParseFailure,
  type IssueAsPrdParseFailureCode,
  type IssueAsPrdParseFailureDetail,
  type IssueAsPrdParserName,
  type IssueAsPrdTag,
  type SubtaskReadinessParseFailure,
  type SubtaskReadinessParseResult,
  type SubtaskReadinessResult,
} from "./issue-as-prd-contracts.mts";
import {
  enumField,
  exactKeys,
  exactStringField,
  hasOwn,
  invalidType,
  isRecord,
  missingField,
  nonEmptyStringField,
  preview,
  stringArrayField,
  stringField,
  type JsonRecord,
} from "./extra-review-parser-utils.mts";

export function parseInitialIssueDecomposition(
  stdout: string,
): InitialIssueDecompositionParseResult {
  const parsed = parseStrictTaggedJsonObject(
    stdout,
    "initial_issue_decomposition",
    "initial_issue_decomposition",
  );
  if ("failure" in parsed) return initialIssueDecompositionFailure(parsed.failure);

  const details: IssueAsPrdParseFailureDetail[] = [];
  const result = parseInitialIssueDecompositionObject(parsed.value, details);
  if (details.length > 0 || !result) {
    return initialIssueDecompositionFailure(
      validationFailure(
        "initial_issue_decomposition",
        "initial_issue_decomposition",
        stdout,
        parsed.rawJson,
        details,
      ),
    );
  }

  return result;
}

export function parseSubtaskReadiness(
  stdout: string,
): SubtaskReadinessParseResult {
  const parsed = parseStrictTaggedJsonObject(
    stdout,
    "subtask_readiness",
    "subtask_readiness",
  );
  if ("failure" in parsed) return subtaskReadinessFailure(parsed.failure);

  const details: IssueAsPrdParseFailureDetail[] = [];
  const result = parseSubtaskReadinessObject(parsed.value, details);
  if (details.length > 0 || !result) {
    return subtaskReadinessFailure(
      validationFailure(
        "subtask_readiness",
        "subtask_readiness",
        stdout,
        parsed.rawJson,
        details,
      ),
    );
  }

  return result;
}

interface TaggedJsonObject {
  value: JsonRecord;
  rawJson: string;
}

function parseStrictTaggedJsonObject(
  stdout: string,
  tag: IssueAsPrdTag,
  parser: IssueAsPrdParserName,
): TaggedJsonObject | { failure: IssueAsPrdParseFailure } {
  const matches = [...stdout.matchAll(tagRegex(tag))];
  if (matches.length === 0) {
    const hasOpening = stdout.includes(`<${tag}>`);
    const hasClosing = stdout.includes(`</${tag}>`);
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "missing_tag",
        hasOpening || hasClosing
          ? `Missing complete <${tag}>...</${tag}> block.`
          : `Missing <${tag}>...</${tag}> block.`,
        [
          {
            code: "missing_tag",
            path: "$",
            message: `Expected exactly one <${tag}>...</${tag}> block.`,
            expected: `<${tag}>...</${tag}>`,
            actual: "no complete tag block",
          },
        ],
        stdout,
      ),
    };
  }

  if (matches.length > 1) {
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "multiple_tags",
        `Found ${matches.length} <${tag}> blocks; expected exactly one.`,
        [
          {
            code: "multiple_tags",
            path: "$",
            message: `Expected exactly one <${tag}>...</${tag}> block.`,
            expected: "1 tagged JSON block",
            actual: `${matches.length} tagged JSON blocks`,
          },
        ],
        stdout,
      ),
    };
  }

  const match = matches[0]!;
  const rawJson = match[1]!.trim();
  const before = stdout.slice(0, match.index ?? 0).trim();
  const after = stdout
    .slice((match.index ?? 0) + match[0]!.length)
    .trim();
  if (before || after) {
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "unexpected_text",
        `Unexpected text was present outside <${tag}>.</${tag}>`.replace(
          `.</${tag}>`,
          `...</${tag}>`,
        ),
        [
          {
            code: "unexpected_text",
            path: "$",
            message: `Do not include text before or after the <${tag}> block.`,
            expected: `<${tag}>...</${tag}> and nothing else`,
            actual: preview(`${before}\n${after}`.trim(), 300),
          },
        ],
        stdout,
      ),
    };
  }

  if (!rawJson) {
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "empty_tag",
        `<${tag}> block was empty.`,
        [
          {
            code: "empty_tag",
            path: "$",
            message: `Expected JSON object inside <${tag}>.`,
            expected: "JSON object",
            actual: "empty tag body",
          },
        ],
        stdout,
        rawJson,
      ),
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch (err) {
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "malformed_json",
        `JSON inside <${tag}> could not be parsed.`,
        [
          {
            code: "malformed_json",
            path: "$",
            message: err instanceof Error ? err.message : String(err),
            expected: "valid JSON object",
            actual: preview(rawJson, 300),
          },
        ],
        stdout,
        rawJson,
      ),
    };
  }

  if (!isRecord(value)) {
    return {
      failure: makeParseFailure(
        parser,
        tag,
        "wrong_top_level_shape",
        `JSON inside <${tag}> must be an object.`,
        [
          {
            code: "wrong_top_level_shape",
            path: "$",
            message: "Top-level JSON value must be an object.",
            expected: "object",
            actual: describeValue(value),
          },
        ],
        stdout,
        rawJson,
      ),
    };
  }

  return { value, rawJson };
}

function parseInitialIssueDecompositionObject(
  value: JsonRecord,
  details: IssueAsPrdParseFailureDetail[],
): InitialIssueDecomposition | null {
  exactKeys(
    value,
    ["kind", "status", "summary", "issues", "needs_human_review_reason"],
    "$",
    details,
  );
  const kind = exactStringField(
    value,
    "kind",
    "initial_issue_decomposition",
    "$.kind",
    details,
  );
  const status = enumField(
    value,
    "status",
    INITIAL_ISSUE_DECOMPOSITION_STATUSES,
    "$.status",
    details,
  );
  const summary = nonEmptyStringField(value, "summary", "$.summary", details);
  const issues = initialSubtaskDraftArray(value, "issues", "$.issues", details);
  const needsHumanReviewReason = stringField(
    value,
    "needs_human_review_reason",
    "$.needs_human_review_reason",
    details,
  );

  validateInitialStatus(
    status,
    issues?.length,
    needsHumanReviewReason,
    "$.status",
    details,
  );

  if (!kind || !status || !summary || !issues || needsHumanReviewReason === undefined) {
    return null;
  }

  if (status === "issues") {
    return {
      kind,
      status,
      summary,
      issues,
      needs_human_review_reason: "",
    };
  }

  if (status === "no_work") {
    return {
      kind,
      status,
      summary,
      issues: [],
      needs_human_review_reason: "",
    };
  }

  return {
    kind,
    status,
    summary,
    issues: [],
    needs_human_review_reason: needsHumanReviewReason,
  };
}

function parseSubtaskReadinessObject(
  value: JsonRecord,
  details: IssueAsPrdParseFailureDetail[],
): SubtaskReadinessResult | null {
  exactKeys(
    value,
    [
      "kind",
      "disposition",
      "summary",
      "evidence",
      "proposed_body",
      "close_reason",
    ],
    "$",
    details,
  );
  const kind = exactStringField(
    value,
    "kind",
    "subtask_readiness",
    "$.kind",
    details,
  );
  const disposition = enumField(
    value,
    "disposition",
    SUBTASK_READINESS_DISPOSITIONS,
    "$.disposition",
    details,
  );
  const summary = nonEmptyStringField(value, "summary", "$.summary", details);
  const evidence = nonEmptyStringArrayField(value, "evidence", "$.evidence", details);
  const proposedBody = nonEmptyStringField(
    value,
    "proposed_body",
    "$.proposed_body",
    details,
  );
  const closeReason = stringField(value, "close_reason", "$.close_reason", details);

  validateReadinessDisposition(
    disposition,
    proposedBody,
    closeReason,
    "$.disposition",
    details,
  );

  if (!kind || !disposition || !summary || !evidence || !proposedBody) return null;
  if (closeReason === undefined) return null;

  return {
    kind,
    disposition,
    summary,
    evidence,
    proposed_body: proposedBody,
    close_reason: closeReason,
  };
}

function initialSubtaskDraftArray(
  record: JsonRecord,
  key: string,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): InitialSubtaskDraft[] | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    invalidType(path, "array", value, details);
    return undefined;
  }

  const drafts: InitialSubtaskDraft[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      invalidType(`${path}[${index}]`, "object", item, details);
      return;
    }
    const draft = parseInitialSubtaskDraft(item, `${path}[${index}]`, details);
    if (draft) drafts.push(draft);
  });
  return drafts;
}

function parseInitialSubtaskDraft(
  value: JsonRecord,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): InitialSubtaskDraft | null {
  exactKeys(value, ["title", "body", "priority", "files", "dedupe_key"], path, details);
  const title = nonEmptyStringField(value, "title", `${path}.title`, details);
  const body = nonEmptyStringField(value, "body", `${path}.body`, details);
  const priority = enumField(
    value,
    "priority",
    INITIAL_SUBTASK_PRIORITIES,
    `${path}.priority`,
    details,
  );
  const files = uniqueStringArrayField(value, "files", `${path}.files`, details);
  const dedupeKey = nonEmptyStringField(
    value,
    "dedupe_key",
    `${path}.dedupe_key`,
    details,
  );

  if (!title || !body || !priority || !files || !dedupeKey) return null;

  return {
    title,
    body,
    priority,
    files,
    dedupe_key: dedupeKey,
  };
}

function uniqueStringArrayField(
  record: JsonRecord,
  key: string,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): string[] | undefined {
  const values = stringArrayField(record, key, path, details);
  if (!values) return undefined;
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      details.push({
        code: "invalid_field_value",
        path: `${path}[${index}]`,
        message: "String array entries must be unique.",
        expected: "unique strings",
        actual: JSON.stringify(value),
      });
      return;
    }
    seen.add(value);
  });
  return values;
}

function nonEmptyStringArrayField(
  record: JsonRecord,
  key: string,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): string[] | undefined {
  const values = stringArrayField(record, key, path, details);
  if (!values) return undefined;
  if (values.length === 0) {
    details.push({
      code: "invalid_field_value",
      path,
      message: "Array must contain at least one item.",
      expected: "non-empty array",
      actual: "[]",
    });
    return undefined;
  }
  return values;
}

function validateInitialStatus(
  status: InitialIssueDecomposition["status"] | undefined,
  issueCount: number | undefined,
  needsHumanReviewReason: string | undefined,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): void {
  if (!status || issueCount === undefined || needsHumanReviewReason === undefined) return;

  if (status === "issues") {
    if (issueCount === 0) {
      details.push({
        code: "inconsistent_status",
        path,
        message: "`status: issues` requires at least one issue draft.",
        expected: "one or more issues",
        actual: "0 issues",
      });
    }
    if (needsHumanReviewReason !== "") {
      details.push({
        code: "inconsistent_status",
        path: "$.needs_human_review_reason",
        message: "`status: issues` requires an empty needs_human_review_reason.",
        expected: "\"\"",
        actual: JSON.stringify(needsHumanReviewReason),
      });
    }
    return;
  }

  if (status === "no_work") {
    if (issueCount !== 0) {
      details.push({
        code: "inconsistent_status",
        path: "$.issues",
        message: "`status: no_work` requires an empty issues array.",
        expected: "[]",
        actual: `${issueCount} issues`,
      });
    }
    if (needsHumanReviewReason !== "") {
      details.push({
        code: "inconsistent_status",
        path: "$.needs_human_review_reason",
        message: "`status: no_work` requires an empty needs_human_review_reason.",
        expected: "\"\"",
        actual: JSON.stringify(needsHumanReviewReason),
      });
    }
    return;
  }

  if (issueCount !== 0) {
    details.push({
      code: "inconsistent_status",
      path: "$.issues",
      message: "`status: needs_human_review` requires an empty issues array.",
      expected: "[]",
      actual: `${issueCount} issues`,
    });
  }
  if (needsHumanReviewReason.trim() === "") {
    details.push({
      code: "inconsistent_status",
      path: "$.needs_human_review_reason",
      message: "`status: needs_human_review` requires a non-empty reason.",
      expected: "non-empty string",
      actual: JSON.stringify(needsHumanReviewReason),
    });
  }
}

function validateReadinessDisposition(
  disposition: SubtaskReadinessResult["disposition"] | undefined,
  proposedBody: string | undefined,
  closeReason: string | undefined,
  path: string,
  details: IssueAsPrdParseFailureDetail[],
): void {
  if (!disposition || !proposedBody || closeReason === undefined) return;

  if (disposition === "fixed" || disposition === "assumed") {
    if (closeReason !== "") {
      details.push({
        code: "inconsistent_disposition",
        path: "$.close_reason",
        message: `\`disposition: ${disposition}\` requires an empty close_reason.`,
        expected: "\"\"",
        actual: JSON.stringify(closeReason),
      });
    }
    if (
      disposition === "assumed" &&
      !/(^|\n)## Assumptions(\n|$)/u.test(proposedBody)
    ) {
      details.push({
        code: "inconsistent_disposition",
        path: "$.proposed_body",
        message: "`disposition: assumed` requires a `## Assumptions` section.",
        expected: "body containing `## Assumptions`",
        actual: "section missing",
      });
    }
    return;
  }

  if (closeReason.trim() === "") {
    details.push({
      code: "inconsistent_disposition",
      path: "$.close_reason",
      message: "`disposition: not_actionable` requires a non-empty close_reason.",
      expected: "non-empty string",
      actual: JSON.stringify(closeReason),
    });
  }
}

function validationFailure(
  parser: IssueAsPrdParserName,
  tag: IssueAsPrdTag,
  stdout: string,
  rawJson: string,
  details: IssueAsPrdParseFailureDetail[],
): IssueAsPrdParseFailure {
  const first = details[0] ?? {
    code: "wrong_top_level_shape",
    path: "$",
    message: "Parsed JSON did not match the required contract.",
  };
  return makeParseFailure(
    parser,
    tag,
    first.code,
    `Parsed ${parserLabel(parser)} JSON did not match the required contract: ${first.message}`,
    details.length > 0 ? details : [first],
    stdout,
    rawJson,
  );
}

function makeParseFailure(
  parser: IssueAsPrdParserName,
  tag: IssueAsPrdTag,
  code: IssueAsPrdParseFailureCode,
  summary: string,
  details: IssueAsPrdParseFailureDetail[],
  stdout: string,
  rawJson?: string,
): IssueAsPrdParseFailure {
  return {
    parser,
    expected_tag: tag,
    code,
    summary,
    details,
    stdout_preview: preview(stdout),
    ...(rawJson !== undefined ? { json_preview: preview(rawJson) } : {}),
  };
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

function tagRegex(tag: string): RegExp {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function parserLabel(parser: IssueAsPrdParserName): string {
  switch (parser) {
    case "initial_issue_decomposition":
      return "initial issue decomposition";
    case "subtask_readiness":
      return "subtask readiness";
  }
}
