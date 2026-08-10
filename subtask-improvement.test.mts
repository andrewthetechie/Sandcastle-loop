import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSubtaskImprovementMarker,
  hasValidSubtaskImprovementMarker,
  stripSubtaskImprovementMarkers,
  validateImprovementForCurrentIssue,
  improveSubtaskJustInTime,
} from "./subtask-improvement.mts";
import { parseSubtaskImprovement } from "./issue-as-prd-parsers.mts";
import type { SubtaskImprovementResult } from "./issue-as-prd-contracts.mts";
import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";

const sha = "a".repeat(40);

function tagged(value: object): string {
  return `<subtask_improvement>\n${JSON.stringify(value)}\n</subtask_improvement>`;
}

function base(overrides: Partial<SubtaskImprovementResult> = {}): SubtaskImprovementResult {
  return {
    kind: "subtask_improvement",
    outcome: "improved",
    summary: "Tightened the implementation contract from repository evidence.",
    proposed_title: "Improve selected work",
    proposed_body: "## User Story\nDo the work.",
    changes: ["Added repository-specific acceptance criteria."],
    evidence: [{ claim: "The adjacent module owns this behavior.", classification: "Verified", source: "src/example.ts" }],
    close_reason: "",
    ...overrides,
  };
}

test("improvement parser accepts evidence-ledger actionable output", () => {
  const parsed = parseSubtaskImprovement(tagged(base()));
  assert.equal("kind" in parsed && parsed.kind, "subtask_improvement");
});

test("improvement parser rejects redundant work without a close reason", () => {
  const parsed = parseSubtaskImprovement(tagged(base({ outcome: "redundant", close_reason: "" })));
  assert.equal(parsed.kind, "parse_failure");
});

test("marker reuse is bound to both contract version and exact accumulation SHA", () => {
  const body = appendSubtaskImprovementMarker("Body", sha);
  assert.equal(hasValidSubtaskImprovementMarker(body, sha), true);
  assert.equal(hasValidSubtaskImprovementMarker(body, "b".repeat(40)), false);
  assert.equal(hasValidSubtaskImprovementMarker("<!-- sandcastle-subtask-readiness disposition=fixed -->", sha), false);
});

test("stale improvement markers are replaced instead of accumulated", () => {
  const stale = appendSubtaskImprovementMarker("Body", "b".repeat(40));
  const refreshed = appendSubtaskImprovementMarker(
    stripSubtaskImprovementMarkers(stale),
    sha,
  );
  assert.equal(refreshed.match(/sandcastle-subtask-improvement/gu)?.length, 1);
  assert.equal(hasValidSubtaskImprovementMarker(refreshed, sha), true);
  assert.equal(
    stripSubtaskImprovementMarkers(
      "Body\n\n<!-- sandcastle-subtask-readiness disposition=fixed -->",
    ),
    "Body",
  );
});

test("marker reuse re-reads the persisted child before handing it to the coder", async () => {
  const persisted: GitHubIssueRecord = {
    id: 1,
    number: 7,
    title: "Human-edited title",
    body: appendSubtaskImprovementMarker("Human-edited body", sha),
    state: "OPEN",
    labels: [],
    comments: [],
  };
  const result = await improveSubtaskJustInTime({
    child: { ...persisted, title: "Stale title", body: "Stale body" },
    accumulationSha: sha,
    client: {
      viewIssue: () => ({ ...persisted }),
    } as unknown as GitHubIssuesClient,
    acquire: async () => {
      throw new Error("matching persisted marker must be reused");
    },
  });

  assert.equal(result.kind, "actionable");
  if (result.kind !== "actionable") return;
  assert.equal(result.reused, true);
  assert.equal(result.child.title, "Human-edited title");
});

test("redundant closure records the verified evidence ledger", async () => {
  const issue: GitHubIssueRecord = {
    id: 1,
    number: 7,
    title: "Duplicate work",
    body: "Body",
    state: "OPEN",
    labels: [],
    comments: [],
  };
  let closureComment = "";
  const client = {
    viewIssue: () => ({ ...issue }),
    closeIssue(_number: number, comment: string) {
      closureComment = comment;
      issue.state = "CLOSED";
    },
  } as unknown as GitHubIssuesClient;

  const result = await improveSubtaskJustInTime({
    child: { ...issue },
    accumulationSha: sha,
    client,
    acquire: async () => ({
      ok: true as const,
      result: base({
        outcome: "redundant",
        proposed_title: issue.title,
        proposed_body: issue.body,
        changes: [],
        close_reason: "Already implemented.",
      }),
      attemptsUsed: 1 as const,
      artifacts: [{ attempt: 1 as const, stdout: "", diagnostics: [] }],
      diagnostics: [],
    }),
  });

  assert.equal(result.kind, "redundant");
  assert.match(closureComment, /Already implemented/);
  assert.match(closureComment, /\[Verified\].*adjacent module/s);
});

test("host ratchet rejects outcome/body inconsistencies and unverified redundant closure", () => {
  const current = { title: "Current", body: "Current body" };
  assert.match(
    validateImprovementForCurrentIssue({
      current,
      result: {
        ...base({ outcome: "improved", proposed_title: "Current", proposed_body: "Current body" }),
      },
    }).join("\n"),
    /did not change/,
  );
  assert.match(
    validateImprovementForCurrentIssue({
      current,
      result: {
        ...base({
          outcome: "redundant",
          close_reason: "Already done",
          evidence: [{ claim: "Maybe already done", classification: "Ambiguous", source: "guess" }],
        }),
      },
    }).join("\n"),
    /requires verified/,
  );
});

test("host atomically persists improved title/body and verifies the SHA-bound marker", async () => {
  const issue: GitHubIssueRecord = {
    id: 1,
    number: 7,
    title: "Old title",
    body: "Old body",
    state: "OPEN",
    labels: [],
    comments: [],
  };
  const mutations: string[] = [];
  const client = {
    editIssueTitleAndBody(input: { issueNumber: number; title: string; body: string }) {
      mutations.push(`edit:${input.issueNumber}`);
      issue.title = input.title;
      issue.body = input.body;
    },
    viewIssue() {
      return { ...issue };
    },
    closeIssue() {
      throw new Error("not expected");
    },
  } as unknown as GitHubIssuesClient;

  const result = await improveSubtaskJustInTime({
    child: { ...issue },
    accumulationSha: sha,
    client,
    acquire: async () => ({
      ok: true as const,
      result: base({ proposed_title: "Improved title", proposed_body: "Improved body" }),
      attemptsUsed: 1 as const,
      artifacts: [{ attempt: 1 as const, stdout: "", diagnostics: [] }],
      diagnostics: [],
    }),
  });

  assert.deepEqual(mutations, ["edit:7"]);
  assert.equal(result.kind, "actionable");
  assert.equal(issue.title, "Improved title");
  assert.equal(hasValidSubtaskImprovementMarker(issue.body, sha), true);
});
