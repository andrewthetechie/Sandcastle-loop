import assert from "node:assert/strict";
import test from "node:test";

import {
  ISSUE_AS_PRD_STATE_MARKER,
  normalizeParentContext,
  type ParentContextComment,
} from "./issue-parent-context.mts";

function comment(
  login: string,
  createdAt: string,
  body: string,
): ParentContextComment {
  return {
    author: { login },
    createdAt,
    body,
  };
}

test("normalizeParentContext keeps body primary and renders selected comments chronologically", () => {
  const old = comment("old", "2026-07-01T10:00:00Z", "old");
  const middle = comment("middle", "2026-07-01T11:00:00Z", "middle");
  const newer = comment("new", "2026-07-01T12:00:00Z", "new");
  const middleRendered = "Author: middle\nTimestamp: 2026-07-01T11:00:00Z\nmiddle";
  const newRendered = "Author: new\nTimestamp: 2026-07-01T12:00:00Z\nnew";
  const cap =
    Buffer.byteLength(middleRendered, "utf8") +
    Buffer.byteLength(newRendered, "utf8");

  const result = normalizeParentContext({
    body: "Parent body",
    comments: [newer, old, middle],
    maxCommentBytes: cap,
  });

  assert.equal(result.body, "Parent body");
  assert.equal(result.omittedCommentCount, 1);
  assert.match(
    result.comments,
    /\[Older parent comments omitted: 1 exceeded the \d+-byte context cap.\]/,
  );
  assert.match(
    result.rendered,
    /Parent body[\s\S]*Author: middle[\s\S]*Timestamp: 2026-07-01T11:00:00Z[\s\S]*middle[\s\S]*Author: new[\s\S]*Timestamp: 2026-07-01T12:00:00Z[\s\S]*new/,
  );
});

test("normalizeParentContext omits a single oversized comment whole", () => {
  const oversized = comment(
    "big",
    "2026-07-01T10:00:00Z",
    "x".repeat(200),
  );

  const result = normalizeParentContext({
    body: "Parent body",
    comments: [oversized],
    maxCommentBytes: 50,
  });

  assert.equal(result.comments, "[Older parent comments omitted: 1 exceeded the 50-byte context cap.]");
  assert.equal(result.omittedCommentCount, 1);
});

test("normalizeParentContext excludes state-marker comments before counting toward the cap", () => {
  const stateComment = comment(
    "host",
    "2026-07-01T09:00:00Z",
    `<!-- ${ISSUE_AS_PRD_STATE_MARKER} -->\n{"phase":"resume"}`,
  );
  const userComment = comment("user", "2026-07-01T10:00:00Z", "keep me");

  const result = normalizeParentContext({
    body: "Parent body",
    comments: [stateComment, userComment],
    maxCommentBytes: 80,
  });

  assert.equal(result.omittedCommentCount, 0);
  assert.doesNotMatch(result.comments, /sandcastle-issue-as-prd-state/);
  assert.match(result.comments, /Author: user/);
});

test("normalizeParentContext handles invalid timestamps by keeping deterministic ordering", () => {
  const invalid = comment("invalid", "not-a-date", "first");
  const valid = comment("valid", "2026-07-01T10:00:00Z", "second");

  const result = normalizeParentContext({
    body: "Parent body",
    comments: [valid, invalid],
    maxCommentBytes: 1000,
  });

  assert.match(
    result.comments,
    /^Author: invalid[\s\S]*Author: valid/s,
  );
});
