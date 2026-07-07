import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import type { SubtaskReadinessAcquisition } from "./issue-as-prd-contracts.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";
import {
  SUBTASK_READINESS_MARKER,
  appendSubtaskReadinessMarker,
  hasValidSubtaskReadinessMarker,
  runSubtaskReadinessBatch,
} from "./subtask-readiness.mts";

test("processes children in ascending issue number and applies fixed and assumed updates", async () => {
  const client = new MockGitHubIssuesClient([
    issue(12, "twelve"),
    issue(10, "ten"),
  ]);
  const acquireOrder: number[] = [];

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(12, "twelve"), issue(10, "ten")],
    siblingSummaries: [
      { number: 10, title: "ten", body: "Body ten" },
      { number: 12, title: "twelve", body: "Body twelve" },
    ],
    accumulationSha: "acc-sha",
    acquire: async (child) => {
      acquireOrder.push(child.number);
      return successReadiness(
        child.number === 10
          ? {
              disposition: "fixed",
              proposed_body:
                "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Acceptance Criteria\n- Exact body.",
            }
          : {
              disposition: "assumed",
              proposed_body:
                "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Assumptions\n- assume one thing.\n## Acceptance Criteria\n- Exact body.",
            },
      );
    },
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(acquireOrder, [10, 12]);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.deepEqual(result.ready.map((child) => child.number), [10, 12]);
  assert.ok(
    client.issues.get(10)!.body.includes(`<!-- ${SUBTASK_READINESS_MARKER} disposition=fixed -->`),
  );
  assert.ok(
    client.issues.get(12)!.body.includes(`<!-- ${SUBTASK_READINESS_MARKER} disposition=assumed -->`),
  );
});

test("excludes the child under evaluation from its own active-sibling list", async () => {
  // A single-child decomposition (child scope == whole parent) must never be
  // shown its own body as an active sibling: doing so lets the readiness agent
  // close it as a self-duplicate and strand the parent with an empty queue.
  const client = new MockGitHubIssuesClient([issue(10, "ten"), issue(12, "twelve")]);
  const seenSiblings = new Map<number, number[]>();

  await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(10, "ten"), issue(12, "twelve")],
    siblingSummaries: [
      { number: 10, title: "ten", body: "Body ten" },
      { number: 12, title: "twelve", body: "Body twelve" },
    ],
    accumulationSha: "acc-sha",
    acquire: async (child, activeSiblings) => {
      seenSiblings.set(child.number, activeSiblings.map((sibling) => sibling.number));
      return successReadiness({
        disposition: "fixed",
        proposed_body:
          "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Acceptance Criteria\n- Exact body.",
      });
    },
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(seenSiblings.get(10), [12]);
  assert.deepEqual(seenSiblings.get(12), [10]);
});

test("not_actionable child is closed and dropped without becoming ready", async () => {
  const client = new MockGitHubIssuesClient([issue(10, "ten")]);

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(10, "ten")],
    siblingSummaries: [{ number: 10, title: "ten", body: "Body ten" }],
    accumulationSha: "acc-sha",
    acquire: async () =>
      successReadiness({
        disposition: "not_actionable",
        close_reason: "Already implemented by sibling.",
      }),
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(result, { kind: "ready", ready: [], dropped: [10] });
  assert.equal(client.issues.get(10)!.state, "CLOSED");
});

test("existing valid readiness marker skips acquisition and includes child in ready", async () => {
  const marked = issue(
    10,
    appendSubtaskReadinessMarker(
      "## User Story\nBody",
      "fixed",
    ),
  );
  const client = new MockGitHubIssuesClient([marked]);
  let acquireCalls = 0;

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [marked],
    siblingSummaries: [{ number: 10, title: "ten", body: marked.body }],
    accumulationSha: "acc-sha",
    acquire: async () => {
      acquireCalls += 1;
      return successReadiness();
    },
    client: client as unknown as GitHubIssuesClient,
  });

  assert.equal(acquireCalls, 0);
  assert.deepEqual(result, { kind: "ready", ready: [marked], dropped: [] });
});

test("body read-back mismatch retries exactly three times then returns parent failure", async () => {
  const client = new MockGitHubIssuesClient([issue(10, "ten")], {
    forceBodyMismatchFor: new Set([10]),
  });

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(10, "ten")],
    siblingSummaries: [{ number: 10, title: "ten", body: "Body ten" }],
    accumulationSha: "acc-sha",
    acquire: async () =>
      successReadiness({
        disposition: "fixed",
        proposed_body:
          "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Acceptance Criteria\n- Exact body.",
      }),
    client: client as unknown as GitHubIssuesClient,
  });

  assert.equal(result.kind, "parent_failure");
  if (result.kind !== "parent_failure") return;
  assert.equal(result.ready.length, 0);
  assert.equal(client.editAttempts.get(10), 3);
});

test("acquisition exhaustion stops the batch before later children", async () => {
  const client = new MockGitHubIssuesClient([issue(10, "ten"), issue(12, "twelve")]);
  const acquireOrder: number[] = [];

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(12, "twelve"), issue(10, "ten")],
    siblingSummaries: [
      { number: 10, title: "ten", body: "Body ten" },
      { number: 12, title: "twelve", body: "Body twelve" },
    ],
    accumulationSha: "acc-sha",
    acquire: async (child) => {
      acquireOrder.push(child.number);
      return child.number === 10
        ? exhaustedReadiness(["attempt 1 bad", "attempt 2 bad"])
        : successReadiness();
    },
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(acquireOrder, [10]);
  assert.equal(result.kind, "parent_failure");
});

test("mutation exhaustion stops the batch before later children", async () => {
  const client = new MockGitHubIssuesClient([issue(10, "ten"), issue(12, "twelve")], {
    forceBodyMismatchFor: new Set([10]),
  });
  const acquireOrder: number[] = [];

  const result = await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(12, "twelve"), issue(10, "ten")],
    siblingSummaries: [
      { number: 10, title: "ten", body: "Body ten" },
      { number: 12, title: "twelve", body: "Body twelve" },
    ],
    accumulationSha: "acc-sha",
    acquire: async (child) => {
      acquireOrder.push(child.number);
      return successReadiness({
        disposition: "fixed",
        proposed_body:
          "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Acceptance Criteria\n- Exact body.",
      });
    },
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(acquireOrder, [10]);
  assert.equal(result.kind, "parent_failure");
});

test("module never adds agent-stuck to a child", async () => {
  const client = new MockGitHubIssuesClient([issue(10, "ten")]);

  await runSubtaskReadinessBatch({
    parentContext: parentContext(),
    children: [issue(10, "ten")],
    siblingSummaries: [{ number: 10, title: "ten", body: "Body ten" }],
    accumulationSha: "acc-sha",
    acquire: async () => successReadiness(),
    client: client as unknown as GitHubIssuesClient,
  });

  assert.deepEqual(client.calls.addLabel, []);
});

test("marker helpers accept only fixed/assumed markers", () => {
  assert.equal(
    hasValidSubtaskReadinessMarker(
      appendSubtaskReadinessMarker("Body", "fixed"),
    ),
    true,
  );
  assert.equal(
    hasValidSubtaskReadinessMarker(
      appendSubtaskReadinessMarker("Body", "assumed"),
    ),
    true,
  );
  assert.equal(
    hasValidSubtaskReadinessMarker(
      `Body\n\n<!-- ${SUBTASK_READINESS_MARKER} disposition=not_actionable -->`,
    ),
    false,
  );
});

class MockGitHubIssuesClient {
  readonly issues = new Map<number, GitHubIssueRecord>();
  readonly calls = {
    editIssueBody: [] as Array<{ issueNumber: number; body: string }>,
    closeIssue: [] as Array<{ issueNumber: number; comment: string }>,
    viewIssue: [] as number[],
    addLabel: [] as Array<{ issueNumber: number; label: string }>,
  };
  readonly editAttempts = new Map<number, number>();

  constructor(
    issues: GitHubIssueRecord[],
    private readonly options: { forceBodyMismatchFor?: Set<number> } = {},
  ) {
    for (const issue of issues) this.issues.set(issue.number, cloneIssue(issue));
  }

  viewIssue(issueNumber: number): GitHubIssueRecord {
    this.calls.viewIssue.push(issueNumber);
    const issue = this.issues.get(issueNumber);
    assert.ok(issue, `missing issue #${issueNumber}`);
    return cloneIssue(issue);
  }

  editIssueBody(issueNumber: number, body: string): void {
    this.calls.editIssueBody.push({ issueNumber, body });
    const issue = this.issues.get(issueNumber)!;
    const attempts = (this.editAttempts.get(issueNumber) ?? 0) + 1;
    this.editAttempts.set(issueNumber, attempts);
    if (this.options.forceBodyMismatchFor?.has(issueNumber)) {
      issue.body = `${body} `;
      return;
    }
    issue.body = body;
  }

  closeIssue(issueNumber: number, comment: string): void {
    this.calls.closeIssue.push({ issueNumber, comment });
    const issue = this.issues.get(issueNumber)!;
    issue.state = "CLOSED";
  }

  addLabel(issueNumber: number, label: string): void {
    this.calls.addLabel.push({ issueNumber, label });
    const issue = this.issues.get(issueNumber)!;
    if (!issue.labels.some((item) => item.name === label)) {
      issue.labels.push({ name: label });
    }
  }
}

function successReadiness(
  overrides: Partial<{
    disposition: "fixed" | "assumed" | "not_actionable";
    summary: string;
    evidence: string[];
    proposed_body: string;
    close_reason: string;
  }> = {},
): SubtaskReadinessAcquisition {
  const disposition = overrides.disposition ?? "fixed";
  return {
    ok: true,
    attemptsUsed: 1,
    artifacts: [{ attempt: 1, stdout: "ok", diagnostics: [] }],
    diagnostics: [],
    result: {
      kind: "subtask_readiness",
      disposition,
      summary: overrides.summary ?? "Ready.",
      evidence: overrides.evidence ?? ["Grounded in parent context."],
      proposed_body:
        overrides.proposed_body ??
        "## User Story\nAs a user...\n## Context\nNeed exact body.\n## Acceptance Criteria\n- Exact body.",
      close_reason:
        overrides.close_reason ??
        (disposition === "not_actionable" ? "Not actionable." : ""),
    },
  };
}

function exhaustedReadiness(diagnostics: string[]): SubtaskReadinessAcquisition {
  return {
    ok: false,
    attemptsUsed: 2,
    artifacts: [
      { attempt: 1, stdout: "", diagnostics: [] },
      { attempt: 2, stdout: "", diagnostics: [] },
    ],
    diagnostics,
  };
}

function issue(number: number, body: string): GitHubIssueRecord {
  return {
    id: number + 1000,
    number,
    title: `Issue ${number}`,
    body,
    state: "OPEN",
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    comments: [],
  };
}

function cloneIssue(issue: GitHubIssueRecord): GitHubIssueRecord {
  return {
    ...issue,
    labels: issue.labels.map((label) => ({ ...label })),
    comments: issue.comments.map((comment) => ({
      ...comment,
      author: { ...comment.author },
    })),
  };
}

function parentContext(): NormalizedParentContext {
  return {
    body: "Parent body",
    comments: "Parent comments",
    rendered: "Parent body\n\nParent comments:\n\nParent comments",
    omittedCommentCount: 0,
  };
}
