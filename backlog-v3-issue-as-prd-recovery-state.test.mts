import assert from "node:assert/strict";
import test from "node:test";
import { splitQueueChildren } from "./backlog-v3-issue-as-prd-recovery-state.mts";

test("splitQueueChildren excludes the parent issue from parent-N queue children", () => {
  const result = splitQueueChildren({
    parentNumber: 604,
    queueIssues: [
      { number: 604, state: "OPEN" },
      { number: 608, state: "OPEN" },
      { number: 609, state: "CLOSED" },
      { number: 607, state: "OPEN" },
    ],
  });

  assert.deepEqual(result, {
    openChildNumbers: [607, 608],
    closedChildNumbers: [609],
  });
});

test("splitQueueChildren returns empty child lists when the parent is the only queued issue", () => {
  const result = splitQueueChildren({
    parentNumber: 604,
    queueIssues: [{ number: 604, state: "OPEN" }],
  });

  assert.deepEqual(result, {
    openChildNumbers: [],
    closedChildNumbers: [],
  });
});
