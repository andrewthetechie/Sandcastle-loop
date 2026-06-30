import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireReviewerResult,
  buildReviewerAttemptRunName,
  sanitizeReviewerExcerpt,
  summarizeReviewerAttemptFailure,
  type ReviewResult,
} from "./reviewer-result.mts";

function approved(summary = "Looks good."): ReviewResult {
  return { decision: "approved", summary, findings: [] };
}

test("accepts a valid stdout verdict", () => {
  const result = acquireReviewerResult({
    stdout: `<review>${JSON.stringify(approved())}</review>`,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "verdict");
  assert.equal(result.resultSource, "stdout");
  assert.equal(result.logFallbackUsed, false);
  assert.equal(result.review.decision, "approved");
});

test("falls back to the current attempt run log when stdout is missing the tag", () => {
  const result = acquireReviewerResult({
    stdout: "plain prose only",
    runLogText: `noise\n<review>${JSON.stringify(approved("Recovered from log."))}</review>\nfooter`,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "verdict");
  assert.equal(result.resultSource, "run_log");
  assert.equal(result.logFallbackUsed, true);
  assert.equal(result.review.summary, "Recovered from log.");
});

test("classifies missing tags in both sources as incomplete", () => {
  const result = acquireReviewerResult({
    stdout: "no review tag",
    runLogText: "still no review tag",
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "incomplete");
  assert.equal(result.code, "missing_tag");
  assert.equal(result.resultSource, "none");
});

test("classifies invalid json inside a complete tag as parse_failed", () => {
  const result = acquireReviewerResult({
    stdout: "<review>{not json}</review>",
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "parse_failed");
  assert.equal(result.code, "invalid_json");
  assert.equal(result.resultSource, "stdout");
});

test("classifies approved with findings as parse_failed", () => {
  const result = acquireReviewerResult({
    stdout: `<review>${JSON.stringify({
      decision: "approved",
      summary: "Inconsistent",
      findings: [
        {
          problem: "Bug",
          remediation: "Fix it",
        },
      ],
    })}</review>`,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "parse_failed");
  assert.equal(result.code, "approved_with_findings");
});

test("classifies blocking decisions without findings as parse_failed", () => {
  const result = acquireReviewerResult({
    stdout: `<review>${JSON.stringify({
      decision: "changes_requested",
      summary: "Missing findings",
      findings: [],
    })}</review>`,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "parse_failed");
  assert.equal(result.code, "blocking_without_findings");
});

test("classifies multiple review tags as parse_failed", () => {
  const result = acquireReviewerResult({
    stdout: `<review>${JSON.stringify(approved("one"))}</review>\n<review>${JSON.stringify(approved("two"))}</review>`,
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "parse_failed");
  assert.equal(result.code, "multiple_tags");
});

test("does not throw when the current attempt run log cannot be read", () => {
  const result = acquireReviewerResult({
    stdout: "no tag",
    runLogReadError: "EACCES",
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "incomplete");
  assert.equal(result.code, "missing_tag");
  assert.match(result.diagnostics.join("\n"), /EACCES/);
});

test("accepts a valid verdict even when footer text surrounds the tag", () => {
  const result = acquireReviewerResult({
    stdout: [
      "max iterations reached",
      `<review>${JSON.stringify(approved("Safe despite footer."))}</review>`,
      "display footer",
    ].join("\n"),
    logFilePath: "/tmp/reviewer.log",
  });

  assert.equal(result.kind, "verdict");
  assert.equal(result.review.summary, "Safe despite footer.");
});

test("sanitizes reviewer excerpts with redaction and line and length caps", () => {
  const excerpt = sanitizeReviewerExcerpt(
    [
      "authorization: Bearer abc123",
      "token = shhh",
      "password: swordfish",
      "cookie: session=abc",
      "api_key: 123",
      "secret: xyz",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
      "line 13",
    ].join("\n") + "\u0000",
  );

  assert.match(excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(excerpt, /abc123|shhh|swordfish|session=abc|123|xyz/);
  assert.ok(excerpt.split("\n").length <= 12);
  assert.ok(excerpt.length <= 800);
});

test("buildReviewerAttemptRunName includes round and attempt indexes", () => {
  assert.equal(buildReviewerAttemptRunName(17, 3, 2), "reviewer #17 r3 a2");
});

test("summarizeReviewerAttemptFailure includes code, source, and log path", () => {
  const result = acquireReviewerResult({
    stdout: "<review>{bad json}</review>",
    logFilePath: "/tmp/reviewer.log",
  });
  assert.equal(result.kind, "parse_failed");
  const summary = summarizeReviewerAttemptFailure(result);

  assert.match(summary, /invalid_json/);
  assert.match(summary, /stdout/);
  assert.match(summary, /\/tmp\/reviewer\.log/);
});
