import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubIssuesClient } from "./github-issues.mts";
import {
  closeIssueAsPrdAlreadySatisfiedChild,
  listIssueAsPrdParentChildren,
  markIssueAsPrdChildStuck,
} from "./backlog-v3-issue-as-prd-children-adapter.mts";

test("listIssueAsPrdParentChildren lists queue-labelled children in ascending order", () => {
  const calls: unknown[] = [];
  const client = {
    listIssues(input: unknown) {
      calls.push(input);
      return [
        issue(12, "OPEN", ["parent-42"]),
        issue(42, "OPEN", ["parent-42"]),
        issue(10, "CLOSED", ["parent-42"]),
        issue(11, "OPEN", ["parent-42"]),
      ];
    },
  } as unknown as GitHubIssuesClient;

  const result = listIssueAsPrdParentChildren({
    parentNumber: 42,
    queueLabel: "parent-42",
    client,
  });

  assert.deepEqual(calls, [
    {
      state: "all",
      labels: ["parent-42"],
      limit: 1000,
    },
  ]);
  assert.deepEqual(result.map((child) => child.number), [10, 11, 12]);
});

test("closeIssueAsPrdAlreadySatisfiedChild closes and verifies the child", async () => {
  const calls: string[] = [];
  let stateValue: "OPEN" | "CLOSED" = "OPEN";
  const client = {
    closeIssue(issueNumber: number, comment: string) {
      calls.push(`close:${issueNumber}:${comment.includes("Evidence:")}`);
      stateValue = "CLOSED";
    },
    viewIssue(issueNumber: number) {
      calls.push(`view:${issueNumber}:${stateValue}`);
      return issue(issueNumber, stateValue, []);
    },
  } as unknown as GitHubIssuesClient;

  await closeIssueAsPrdAlreadySatisfiedChild({
    child: { number: 42 },
    evidence: "empty diff",
    client,
  });

  assert.deepEqual(calls, [
    "close:42:true",
    "view:42:CLOSED",
  ]);
});

test("markIssueAsPrdChildStuck comments first, then adds and verifies agent-stuck", async () => {
  const calls: string[] = [];
  let labels: string[] = [];
  const client = {
    createComment(issueNumber: number, body: string) {
      calls.push(`comment:${issueNumber}:${body.includes("Reason:")}`);
      return { id: 91 };
    },
    addLabel(issueNumber: number, label: string) {
      calls.push(`addLabel:${issueNumber}:${label}`);
      labels = [...labels, label];
    },
    viewIssue(issueNumber: number) {
      calls.push(`view:${issueNumber}:${labels.join(",")}`);
      return issue(issueNumber, "OPEN", labels);
    },
  } as unknown as GitHubIssuesClient;

  await markIssueAsPrdChildStuck({
    child: { number: 42 },
    reason: "validation failed",
    client,
  });

  assert.deepEqual(calls, [
    "comment:42:true",
    "addLabel:42:agent-stuck",
    "view:42:agent-stuck",
  ]);
});

function issue(
  number: number,
  state: "OPEN" | "CLOSED",
  labels: string[],
) {
  return {
    id: number,
    number,
    title: `Issue ${number}`,
    body: "",
    state,
    labels: labels.map((name) => ({ name })),
    comments: [],
  };
}
