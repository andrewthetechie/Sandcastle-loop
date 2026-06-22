import type {
  ExtraReviewParseFailure,
  ExtraReviewParserName,
  ExtraReviewTag,
  ParseFailureCode,
  ParseFailureDetail,
} from "./extra-review-contracts.mts";

export type JsonRecord = Record<string, unknown>;

export interface TaggedJsonObject {
  value: JsonRecord;
  rawJson: string;
}

export function parseTaggedJsonObject(
  stdout: string,
  tag: ExtraReviewTag,
  parser: ExtraReviewParserName,
): TaggedJsonObject | { failure: ExtraReviewParseFailure } {
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

export function validationFailure(
  parser: ExtraReviewParserName,
  tag: ExtraReviewTag,
  stdout: string,
  rawJson: string,
  details: ParseFailureDetail[],
): ExtraReviewParseFailure {
  const fallback: ParseFailureDetail = {
    code: "wrong_top_level_shape",
    path: "$",
    message: "Parsed JSON did not match the required contract.",
  };
  const first = details[0] ?? fallback;
  return makeParseFailure(
    parser,
    tag,
    first.code,
    `Parsed ${parserLabel(parser)} JSON did not match the required contract: ${first.message}`,
    details.length > 0 ? details : [fallback],
    stdout,
    rawJson,
  );
}

export function exactKeys(
  record: JsonRecord,
  keys: readonly string[],
  path: string,
  details: ParseFailureDetail[],
): void {
  const keySet = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!keySet.has(key)) {
      details.push({
        code: "unexpected_field",
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: `Unexpected field '${key}'.`,
        expected: `fields: ${keys.join(", ")}`,
        actual: key,
      });
    }
  }
}

export function nonEmptyStringField(
  record: JsonRecord,
  key: string,
  path: string,
  details: ParseFailureDetail[],
): string | undefined {
  const value = stringField(record, key, path, details);
  if (typeof value !== "string") return undefined;
  if (value.trim() === "") {
    details.push({
      code: "empty_required_field",
      path,
      message: "Required string field must not be empty.",
      expected: "non-empty string",
      actual: JSON.stringify(value),
    });
    return undefined;
  }
  return value;
}

export function stringField(
  record: JsonRecord,
  key: string,
  path: string,
  details: ParseFailureDetail[],
): string | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string") {
    invalidType(path, "string", value, details);
    return undefined;
  }
  return value;
}

export function exactStringField<Expected extends string>(
  record: JsonRecord,
  key: string,
  expected: Expected,
  path: string,
  details: ParseFailureDetail[],
): Expected | undefined {
  const value = stringField(record, key, path, details);
  if (value === undefined) return undefined;
  if (value !== expected) {
    details.push({
      code: "invalid_field_value",
      path,
      message: `Field must be ${expected}.`,
      expected,
      actual: value,
    });
    return undefined;
  }
  return expected;
}

export function enumField<Allowed extends readonly string[]>(
  record: JsonRecord,
  key: string,
  allowed: Allowed,
  path: string,
  details: ParseFailureDetail[],
): Allowed[number] | undefined {
  const value = stringField(record, key, path, details);
  if (value === undefined) return undefined;
  const allowedValues: readonly string[] = allowed;
  if (!allowedValues.includes(value)) {
    details.push({
      code: "invalid_field_value",
      path,
      message: `Field must be one of: ${allowed.join(", ")}.`,
      expected: allowed.join(" | "),
      actual: value,
    });
    return undefined;
  }
  return value;
}

export function integerRangeField(
  record: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: string,
  details: ParseFailureDetail[],
): number | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidType(path, `integer from ${min} to ${max}`, value, details);
    return undefined;
  }
  if (value < min || value > max) {
    details.push({
      code: "invalid_field_value",
      path,
      message: `Integer field must be from ${min} to ${max}.`,
      expected: `${min}..${max}`,
      actual: String(value),
    });
    return undefined;
  }
  return value;
}

export function stringArrayField(
  record: JsonRecord,
  key: string,
  path: string,
  details: ParseFailureDetail[],
): string[] | undefined {
  if (!hasOwn(record, key)) {
    missingField(path, details);
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    invalidType(path, "array of strings", value, details);
    return undefined;
  }

  const strings: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      invalidType(`${path}[${index}]`, "string", item, details);
      return;
    }
    if (item.trim() === "") {
      details.push({
        code: "empty_required_field",
        path: `${path}[${index}]`,
        message: "String array entries must not be empty.",
        expected: "non-empty string",
        actual: JSON.stringify(item),
      });
      return;
    }
    strings.push(item);
  });
  return strings;
}

export function missingField(
  path: string,
  details: ParseFailureDetail[],
): void {
  details.push({
    code: "missing_required_field",
    path,
    message: "Missing required field.",
    expected: "field present",
    actual: "undefined",
  });
}

export function invalidType(
  path: string,
  expected: string,
  value: unknown,
  details: ParseFailureDetail[],
): void {
  details.push({
    code: "invalid_field_type",
    path,
    message: `Invalid field type; expected ${expected}.`,
    expected,
    actual: describeValue(value),
  });
}

export function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function preview(value: string, max = 1000): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function makeParseFailure(
  parser: ExtraReviewParserName,
  tag: ExtraReviewTag,
  code: ParseFailureCode,
  summary: string,
  details: ParseFailureDetail[],
  stdout: string,
  rawJson?: string,
): ExtraReviewParseFailure {
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

function tagRegex(tag: string): RegExp {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function parserLabel(parser: ExtraReviewParserName): string {
  switch (parser) {
    case "code_quality_extra_review":
      return "code-quality extra-review";
    case "two_axis_extra_review":
      return "two-axis extra-review";
    case "followup_issues":
      return "follow-up issue decomposer";
  }
}
