import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStuckIssueComment } from "./mark-stuck-comment.mts";

test("no-progress uses the round that stalled", () => {
  const body = formatStuckIssueComment({
    roundsUsed: 2,
    maxReviewRounds: 5,
    terminalReason: "stuck_no_progress",
    lastFeedback: "## No progress\n\nValidation failed",
  });
  assert.match(body, /stopped early after round 2 \(no progress\)/);
  assert.match(body, /Last feedback:\n\n## No progress/);
});

test("round limit exhausted reports rounds used vs cap", () => {
  const body = formatStuckIssueComment({
    roundsUsed: 5,
    maxReviewRounds: 5,
    terminalReason: "stuck_rounds_exhausted",
    lastFeedback: "## Reviewer requested changes",
  });
  assert.match(body, /gave up after 5 of 5 review round\(s\)/);
});

test("blocked reports the blocking round", () => {
  const body = formatStuckIssueComment({
    roundsUsed: 1,
    maxReviewRounds: 5,
    terminalReason: "blocked",
    lastFeedback: "Needs a human decision.",
  });
  assert.match(body, /signaled blocked on round 1/);
});

test("livelock reports the round and preserves feedback", () => {
  const lastFeedback =
    "## Agent invocation livelock\n\nRepeated `read_file` 5 times with no worktree progress.";
  const body = formatStuckIssueComment({
    roundsUsed: 2,
    maxReviewRounds: 5,
    terminalReason: "stuck_livelock",
    lastFeedback,
  });
  assert.match(body, /stopped after a livelock on round 2/);
  assert.match(body, /Last feedback:\n\n## Agent invocation livelock/);
  assert.match(body, /Repeated `read_file` 5 times with no worktree progress/);
});

test("host headline bypasses round-based copy", () => {
  const body = formatStuckIssueComment({
    headline:
      "Reviewer approved but the host could not complete the merge. Manual intervention required.",
    lastFeedback: "merge conflict",
  });
  assert.match(body, /^Reviewer approved but the host could not complete the merge/);
  assert.doesNotMatch(body, /review round/);
});

test("reviewer parse failure preserves operator-facing headline and feedback", () => {
  const body = formatStuckIssueComment({
    headline:
      "Reviewer attempts exhausted without a valid review verdict (parse failure).",
    lastFeedback:
      "## Reviewer parse failure\n\nAttempt 2/2\nFailure code: invalid_json\nLog: /tmp/reviewer.log",
  });

  assert.match(body, /parse failure/);
  assert.match(body, /Failure code: invalid_json/);
  assert.match(body, /\/tmp\/reviewer\.log/);
});
