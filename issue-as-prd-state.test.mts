import assert from "node:assert/strict";
import test from "node:test";
import {
  ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
  nextParentState,
  parseParentStateComment,
  reconcileParentState,
  renderParentStateComment,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";
import { normalizeParentContext, type ParentContextComment } from "./issue-parent-context.mts";

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
    phase: "claimed",
    queueLabel: "parent-42",
    completedExtraReviewRounds: 0,
    aggregateValidationRepairs: { pre_review: 0, pre_delivery: 0 },
    rebaseConflictDiagnostics: [],
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T12:00:00Z",
    ...overrides,
  };
}

function comment(id: number, body: string): { id: number; body: string } {
  return { id, body };
}

function parentComment(body: string): ParentContextComment {
  return {
    author: { login: "host" },
    createdAt: "2026-07-02T12:00:00Z",
    body,
  };
}

test("renderParentStateComment is deterministic pretty JSON and parse round-trips", () => {
  const input = state();

  const rendered = renderParentStateComment(input);
  const reparsed = parseParentStateComment(rendered);

  assert.match(
    rendered,
    /<!-- sandcastle-issue-as-prd-state -->\n<sandcastle_issue_as_prd_state>\n\{\n  "schemaVersion": 1,/,
  );
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.deepEqual(reparsed.state, input);
  assert.equal(rendered, renderParentStateComment(input));
});

test("parseParentStateComment rejects missing and multiple markers", () => {
  const missing = parseParentStateComment("<sandcastle_issue_as_prd_state>{}</sandcastle_issue_as_prd_state>");
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.match(missing.diagnostics[0]!, /Missing state marker/);

  const rendered = renderParentStateComment(state());
  const multiple = parseParentStateComment(`${rendered}\n<!-- sandcastle-issue-as-prd-state -->`);
  assert.equal(multiple.ok, false);
  if (multiple.ok) return;
  assert.match(multiple.diagnostics[0]!, /exactly one state marker/);
});

test("parseParentStateComment rejects bad schema, phase, queue label, invalid budgets, and invalid timestamp", () => {
  const rendered = renderParentStateComment(state());
  const broken = rendered
    .replace('"schemaVersion": 1', '"schemaVersion": 2')
    .replace('"phase": "claimed"', '"phase": "bogus"')
    .replace('"queueLabel": "parent-42"', '"queueLabel": "parent-41"')
    .replace('"pre_review": 0', '"pre_review": 2')
    .replace('"lastTransitionAt": "2026-07-02T12:00:00Z"', '"lastTransitionAt": "not-a-time"');

  const parsed = parseParentStateComment(broken);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.diagnostics.join("\n"), /Unsupported schemaVersion/);
  assert.match(parsed.diagnostics.join("\n"), /phase/);
  assert.match(parsed.diagnostics.join("\n"), /queueLabel must equal parent-42/);
  assert.match(parsed.diagnostics.join("\n"), /pre_review' must be 0 or 1|aggregateValidationRepairs\.pre_review/);
  assert.match(parsed.diagnostics.join("\n"), /valid ISO timestamp/);
});

test("nextParentState preserves the prior timestamp when no durable field changed", () => {
  const previous = state({ lastTransitionAt: "2026-07-02T12:00:00Z" });

  const unchanged = nextParentState({
    previous,
    next: {
      schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
      parentNumber: previous.parentNumber,
      accumulationBranch: previous.accumulationBranch,
      originalForkSha: previous.originalForkSha,
      fullParentReviewBaseSha: previous.fullParentReviewBaseSha,
      attemptedMainlineSha: previous.attemptedMainlineSha,
      latestMainlineShaAtDelivery: previous.latestMainlineShaAtDelivery,
      phase: previous.phase,
      queueLabel: previous.queueLabel,
      completedExtraReviewRounds: previous.completedExtraReviewRounds,
      aggregateValidationRepairs: previous.aggregateValidationRepairs,
      rebaseConflictDiagnostics: previous.rebaseConflictDiagnostics,
      partialCauseChildNumber: previous.partialCauseChildNumber,
    },
    now: "2026-07-02T13:00:00Z",
  });

  assert.equal(unchanged.lastTransitionAt, "2026-07-02T12:00:00Z");

  const changed = nextParentState({
    previous,
    next: { ...unchanged, phase: "decomposed" },
    now: "2026-07-02T13:00:00Z",
  });
  assert.equal(changed.lastTransitionAt, "2026-07-02T13:00:00Z");
});

test("reconcileParentState returns create when no state comment exists", () => {
  const result = reconcileParentState({
    parentNumber: 42,
    comments: [],
    observed: {
      accumulationBranchExists: false,
      localAccumulationHeadSha: null,
      remoteAccumulationHeadSha: null,
      parentLabels: [],
      openChildNumbers: [],
      closedChildNumbers: [],
    },
  });

  assert.deepEqual(result, { kind: "create" });
});

test("reconcileParentState reports duplicate marked comments and never chooses one", () => {
  const rendered = renderParentStateComment(state());
  const result = reconcileParentState({
    parentNumber: 42,
    comments: [comment(1, rendered), comment(2, rendered)],
    observed: {
      accumulationBranchExists: true,
      localAccumulationHeadSha: sha("c"),
      remoteAccumulationHeadSha: sha("c"),
      parentLabels: ["agent-in-progress", "parent-42"],
      openChildNumbers: [],
      closedChildNumbers: [],
    },
  });

  assert.equal(result.kind, "disagreement");
  if (result.kind !== "disagreement") return;
  assert.match(result.diagnostics[0]!, /exactly one marked state comment/);
});

test("reconcileParentState surfaces every observed-state disagreement", () => {
  const rendered = renderParentStateComment(state({ phase: "failed" }));
  const result = reconcileParentState({
    parentNumber: 42,
    comments: [comment(7, rendered)],
    observed: {
      accumulationBranchExists: false,
      localAccumulationHeadSha: null,
      remoteAccumulationHeadSha: sha("d"),
      parentLabels: ["agent-in-progress", "parent-99", "parent-100"],
      openChildNumbers: [10],
      closedChildNumbers: [11],
    },
  });

  assert.equal(result.kind, "disagreement");
  if (result.kind !== "disagreement") return;
  const joined = result.diagnostics.join("\n");
  assert.match(joined, /Accumulation branch 'issue-42-accumulation' is missing/);
  assert.match(joined, /Local accumulation head SHA is missing/);
  assert.match(joined, /Expected at most one parent-N queue label/);
  assert.match(joined, /Failed parent still has agent-in-progress/);
  assert.match(joined, /Failed parent must retain queue label 'parent-42'/);
});

test("reconcileParentState resumes when observed state matches", () => {
  const current = state({ phase: "decomposed" });
  const rendered = renderParentStateComment(current);

  const result = reconcileParentState({
    parentNumber: 42,
    comments: [comment(9, rendered)],
    observed: {
      accumulationBranchExists: true,
      localAccumulationHeadSha: sha("c"),
      remoteAccumulationHeadSha: sha("c"),
      parentLabels: ["agent-in-progress", "parent-42"],
      openChildNumbers: [100],
      closedChildNumbers: [],
    },
  });

  assert.equal(result.kind, "resume");
  if (result.kind !== "resume") return;
  assert.equal(result.commentId, 9);
  assert.deepEqual(result.state, current);
});

test("rendered state comments remain excluded by normalizeParentContext", () => {
  const result = normalizeParentContext({
    body: "Parent body",
    comments: [
      parentComment(renderParentStateComment(state())),
      {
        author: { login: "user" },
        createdAt: "2026-07-02T13:00:00Z",
        body: "keep this visible",
      },
    ],
    maxCommentBytes: 5000,
  });

  assert.doesNotMatch(result.rendered, /sandcastle-issue-as-prd-state/);
  assert.match(result.rendered, /keep this visible/);
});

test("reconcileParentState resumes a claimed parent that already has published children", () => {
  // Children land on GitHub before the 'decomposed' transition is persisted,
  // so claimed+children is an interrupted run that must stay resumable.
  const current = state({ phase: "claimed" });
  const rendered = renderParentStateComment(current);

  const result = reconcileParentState({
    parentNumber: 42,
    comments: [comment(9, rendered)],
    observed: {
      accumulationBranchExists: true,
      localAccumulationHeadSha: sha("c"),
      remoteAccumulationHeadSha: sha("c"),
      parentLabels: ["agent-in-progress", "parent-42"],
      openChildNumbers: [100, 101],
      closedChildNumbers: [102],
    },
  });

  assert.equal(result.kind, "resume");
  if (result.kind !== "resume") return;
  assert.deepEqual(result.state, current);
});
