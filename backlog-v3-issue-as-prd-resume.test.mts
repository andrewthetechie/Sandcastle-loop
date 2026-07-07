import assert from "node:assert/strict";
import test from "node:test";
import { reconcileResumableIssueAsPrdParent } from "./backlog-v3-issue-as-prd-resume.mts";
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
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T12:00:00Z",
    ...overrides,
  };
}

test("resume reconciliation returns resume with normalized context excluding state comments", () => {
  const rendered = renderParentStateComment(state());
  const result = reconcileResumableIssueAsPrdParent({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [
        {
          id: 9,
          author: { login: "host" },
          createdAt: "2026-07-02T12:00:00Z",
          body: rendered,
        },
        {
          id: 10,
          author: { login: "user" },
          createdAt: "2026-07-02T13:00:00Z",
          body: "keep this visible",
        },
      ],
    },
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

  assert.equal(result.kind, "resume");
  if (result.kind !== "resume") return;
  assert.equal(result.commentId, 9);
  assert.equal(result.state.phase, "decomposed");
  assert.doesNotMatch(result.normalizedContext.rendered, /sandcastle-issue-as-prd-state/);
  assert.match(result.normalizedContext.rendered, /keep this visible/);
});

test("resume reconciliation returns create when no state comment exists", () => {
  const result = reconcileResumableIssueAsPrdParent({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [],
    },
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

  assert.equal(result.kind, "create");
  if (result.kind !== "create") return;
  assert.equal(result.normalizedContext.body, "Parent body");
});

test("resume reconciliation returns disagreement with normalized context when observed state mismatches", () => {
  const rendered = renderParentStateComment(state({ phase: "failed" }));
  const result = reconcileResumableIssueAsPrdParent({
    parent: {
      number: 42,
      body: "Parent body",
      comments: [
        {
          id: 7,
          author: { login: "host" },
          createdAt: "2026-07-02T12:00:00Z",
          body: rendered,
        },
        {
          id: 8,
          author: { login: "user" },
          createdAt: "2026-07-02T13:00:00Z",
          body: "operator note",
        },
      ],
    },
    observed: {
      accumulationBranchExists: false,
      localAccumulationHeadSha: null,
      remoteAccumulationHeadSha: sha("d"),
      parentLabels: ["agent-in-progress", "parent-99", "parent-100"],
      openChildNumbers: [10],
      closedChildNumbers: [11],
    },
    maxCommentBytes: 5000,
  });

  assert.equal(result.kind, "disagreement");
  if (result.kind !== "disagreement") return;
  assert.match(result.diagnostics.join("\n"), /Accumulation branch 'issue-42-accumulation' is missing/);
  assert.match(result.normalizedContext.rendered, /operator note/);
});
