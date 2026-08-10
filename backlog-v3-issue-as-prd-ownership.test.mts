import assert from "node:assert/strict";
import test from "node:test";
import { verifyIssueAsPrdParentOwnership } from "./backlog-v3-issue-as-prd-ownership.mts";
import {
  ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
  renderParentStateComment,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";

function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

function state(overrides: Partial<IssueAsPrdParentState> = {}): IssueAsPrdParentState {
  return {
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    parentNumber: 42,
    accumulationBranch: "issue-42-accumulation",
    originalForkSha: sha("a"),
    fullParentReviewBaseSha: sha("b"),
    attemptedMainlineSha: null,
    latestMainlineShaAtDelivery: null,
    phase: "decomposed",
    queueLabel: "parent-42",
    completedExtraReviewRounds: 0,
    aggregateValidationRepairs: { pre_review: 0, pre_delivery: 0 },
    rebaseConflictDiagnostics: [],
    accumulationDiverged: false,
    mainlineRefresh: null,
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T12:00:00Z",
    ...overrides,
  };
}

test("ownership verification returns ok when observed state still matches the acquired state", () => {
  const expectedState = state();
  const result = verifyIssueAsPrdParentOwnership({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [
        {
          id: 9,
          author: { login: "host" },
          createdAt: "2026-07-02T12:00:00Z",
          body: renderParentStateComment(expectedState),
        },
      ],
    },
    expectedState,
    observed: {
      accumulationBranchExists: true,
      localAccumulationHeadSha: sha("c"),
      remoteAccumulationHeadSha: sha("c"),
      parentLabels: ["agent-in-progress", "parent-42"],
      openChildNumbers: [100],
      closedChildNumbers: [],
    },
    maxCommentBytes: 5000,
  });

  assert.deepEqual(result, { ok: true });
});

test("ownership verification fails when the state comment changed since acquisition", () => {
  const expectedState = state();
  const result = verifyIssueAsPrdParentOwnership({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [
        {
          id: 9,
          author: { login: "host" },
          createdAt: "2026-07-02T12:00:00Z",
          body: renderParentStateComment(state({ phase: "initial_ready" })),
        },
      ],
    },
    expectedState,
    observed: {
      accumulationBranchExists: true,
      localAccumulationHeadSha: sha("c"),
      remoteAccumulationHeadSha: sha("c"),
      parentLabels: ["agent-in-progress", "parent-42"],
      openChildNumbers: [100],
      closedChildNumbers: [],
    },
    maxCommentBytes: 5000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.diagnostics[0]!, /changed since acquisition/);
});

test("ownership verification forwards disagreement diagnostics when durable state no longer reconciles", () => {
  const expectedState = state();
  const result = verifyIssueAsPrdParentOwnership({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [
        {
          id: 9,
          author: { login: "host" },
          createdAt: "2026-07-02T12:00:00Z",
          body: renderParentStateComment(expectedState),
        },
      ],
    },
    expectedState,
    observed: {
      accumulationBranchExists: false,
      localAccumulationHeadSha: null,
      remoteAccumulationHeadSha: null,
      parentLabels: [],
      openChildNumbers: [],
      closedChildNumbers: [],
    },
    maxCommentBytes: 5000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.diagnostics.join("\n"), /Accumulation branch 'issue-42-accumulation' is missing/);
});
