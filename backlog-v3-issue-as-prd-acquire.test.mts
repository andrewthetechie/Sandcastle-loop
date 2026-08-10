import assert from "node:assert/strict";
import test from "node:test";
import { acquireNextIssueAsPrdParent } from "./backlog-v3-issue-as-prd-acquire.mts";
import { renderParentStateComment, ISSUE_AS_PRD_STATE_SCHEMA_VERSION, type IssueAsPrdParentState } from "./issue-as-prd-state.mts";

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

test("returns none when no eligible parent exists", async () => {
  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [],
      viewParent() {
        throw new Error("should not view parent");
      },
      observeRecovery() {
        throw new Error("should not observe");
      },
      addInProgressLabel() {
        throw new Error("should not claim");
      },
      ensureQueueLabel() {
        throw new Error("should not claim");
      },
      fetchMainline() {
        throw new Error("should not claim");
      },
      createAccumulationBranch() {
        throw new Error("should not claim");
      },
      pushInitialCheckpoint() {
        throw new Error("should not claim");
      },
      createStateComment() {
        throw new Error("should not claim");
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.deepEqual(result, { kind: "none" });
});

test("fresh selected parent with no durable state is claimed", async () => {
  const calls: string[] = [];
  const mainlineSha = sha("a");
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }],
    comments: [],
  };
  const resumed = {
    ...parent,
    labels: [{ name: "bug" }, { name: "agent-in-progress" }, { name: "parent-42" }],
    comments: [
      {
        id: 91,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: renderParentStateComment(
          state({
            phase: "claimed",
            originalForkSha: mainlineSha,
            fullParentReviewBaseSha: mainlineSha,
            lastTransitionAt: "2026-07-02T12:00:00Z",
          }),
        ),
      },
    ],
  };
  let viewCount = 0;
  let observeCount = 0;

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [{ number: 42, state: "OPEN", labels: [{ name: "bug" }] }],
      viewParent: () => (++viewCount === 1 ? parent : resumed),
      observeRecovery: () => {
        observeCount += 1;
        return observeCount === 1
          ? {
              accumulationBranchExists: false,
              localAccumulationHeadSha: null,
              remoteAccumulationHeadSha: null,
              parentLabels: [],
              openChildNumbers: [],
              closedChildNumbers: [],
            }
          : {
              accumulationBranchExists: true,
              localAccumulationHeadSha: mainlineSha,
              remoteAccumulationHeadSha: mainlineSha,
              parentLabels: ["bug", "agent-in-progress", "parent-42"],
              openChildNumbers: [],
              closedChildNumbers: [],
            };
      },
      addInProgressLabel(parentNumber) {
        calls.push(`addInProgressLabel:${parentNumber}`);
      },
      ensureQueueLabel(parentNumber) {
        calls.push(`ensureQueueLabel:${parentNumber}`);
      },
      fetchMainline() {
        calls.push("fetchMainline");
        return mainlineSha;
      },
      createAccumulationBranch({ branchName, baseSha }) {
        calls.push(`createAccumulationBranch:${branchName}:${baseSha}`);
      },
      pushInitialCheckpoint({ branchName, expectedHeadSha }) {
        calls.push(`pushInitialCheckpoint:${branchName}:${expectedHeadSha}`);
        return expectedHeadSha;
      },
      createStateComment({ parentNumber }) {
        calls.push(`createStateComment:${parentNumber}`);
        return 91;
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "claimed");
  if (result.kind !== "claimed") return;
  assert.equal(result.commentId, 91);
  assert.equal(result.state.phase, "claimed");
  assert.equal(result.parent.comments.length, 1);
  assert.deepEqual(calls, [
    "addInProgressLabel:42",
    "ensureQueueLabel:42",
    "fetchMainline",
    `createAccumulationBranch:issue-42-accumulation:${mainlineSha}`,
    `pushInitialCheckpoint:issue-42-accumulation:${mainlineSha}`,
    "createStateComment:42",
  ]);
});

test("fresh claim stops as ownership_ambiguous when durable state is still not resumable after claim", async () => {
  const mainlineSha = sha("a");
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }],
    comments: [],
  };

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [{ number: 42, state: "OPEN", labels: [{ name: "bug" }] }],
      viewParent: () => parent,
      observeRecovery: (() => {
        let count = 0;
        return () => {
          count += 1;
          return count === 1
            ? {
                accumulationBranchExists: false,
                localAccumulationHeadSha: null,
                remoteAccumulationHeadSha: null,
                parentLabels: [],
                openChildNumbers: [],
                closedChildNumbers: [],
              }
            : {
                accumulationBranchExists: true,
                localAccumulationHeadSha: mainlineSha,
                remoteAccumulationHeadSha: mainlineSha,
                parentLabels: ["bug", "agent-in-progress", "parent-42"],
                openChildNumbers: [],
                closedChildNumbers: [],
              };
        };
      })(),
      addInProgressLabel() {},
      ensureQueueLabel() {},
      fetchMainline() {
        return mainlineSha;
      },
      createAccumulationBranch() {},
      pushInitialCheckpoint() {
        return mainlineSha;
      },
      createStateComment() {
        return 91;
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "ownership_ambiguous");
  if (result.kind !== "ownership_ambiguous") return;
  assert.match(result.diagnostics[0]!, /Expected resumable parent #42, observed create/);
});

test("resume-selected parent returns resumed state without fresh-claim side effects", async () => {
  const current = state();
  const rendered = renderParentStateComment(current);
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }, { name: "agent-in-progress" }],
    comments: [
      {
        id: 9,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: rendered,
      },
    ],
  };

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [{ number: 42, state: "OPEN", labels: [{ name: "bug" }, { name: "agent-in-progress" }] }],
      viewParent: () => parent,
      observeRecovery: () => ({
        accumulationBranchExists: true,
        localAccumulationHeadSha: sha("c"),
        remoteAccumulationHeadSha: sha("c"),
        parentLabels: ["agent-in-progress", "parent-42"],
        openChildNumbers: [100],
        closedChildNumbers: [],
      }),
      addInProgressLabel() {
        throw new Error("should not claim fresh");
      },
      ensureQueueLabel() {
        throw new Error("should not claim fresh");
      },
      fetchMainline() {
        throw new Error("should not claim fresh");
      },
      createAccumulationBranch() {
        throw new Error("should not claim fresh");
      },
      pushInitialCheckpoint() {
        throw new Error("should not claim fresh");
      },
      createStateComment() {
        throw new Error("should not claim fresh");
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "resumed");
  if (result.kind !== "resumed") return;
  assert.equal(result.commentId, 9);
  assert.deepEqual(result.state, current);
});

test("fresh selection with unexpected resumable state stops as ownership_ambiguous", async () => {
  const current = state();
  const rendered = renderParentStateComment(current);
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }],
    comments: [
      {
        id: 9,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: rendered,
      },
    ],
  };

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [{ number: 42, state: "OPEN", labels: [{ name: "bug" }] }],
      viewParent: () => parent,
      observeRecovery: () => ({
        accumulationBranchExists: true,
        localAccumulationHeadSha: sha("c"),
        remoteAccumulationHeadSha: sha("c"),
        parentLabels: ["agent-in-progress", "parent-42"],
        openChildNumbers: [100],
        closedChildNumbers: [],
      }),
      addInProgressLabel() {
        throw new Error("should not claim fresh");
      },
      ensureQueueLabel() {
        throw new Error("should not claim fresh");
      },
      fetchMainline() {
        throw new Error("should not claim fresh");
      },
      createAccumulationBranch() {
        throw new Error("should not claim fresh");
      },
      pushInitialCheckpoint() {
        throw new Error("should not claim fresh");
      },
      createStateComment() {
        throw new Error("should not claim fresh");
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "ownership_ambiguous");
  if (result.kind !== "ownership_ambiguous") return;
  assert.match(result.diagnostics[0]!, /unexpectedly reconciled as resumable/);
});

test("resume-selected parent missing its durable state comment completes the interrupted claim", async () => {
  const calls: string[] = [];
  const mainlineSha = sha("a");
  // agent-in-progress is already applied (first claim step) but the claim was
  // interrupted before the state comment (last claim step) landed.
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }, { name: "agent-in-progress" }],
    comments: [],
  };
  const reclaimed = {
    ...parent,
    labels: [{ name: "bug" }, { name: "agent-in-progress" }, { name: "parent-42" }],
    comments: [
      {
        id: 91,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: renderParentStateComment(
          state({
            phase: "claimed",
            originalForkSha: mainlineSha,
            fullParentReviewBaseSha: mainlineSha,
            lastTransitionAt: "2026-07-02T12:00:00Z",
          }),
        ),
      },
    ],
  };
  let viewCount = 0;
  let observeCount = 0;

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [
        { number: 42, state: "OPEN", labels: [{ name: "bug" }, { name: "agent-in-progress" }] },
      ],
      viewParent: () => (++viewCount === 1 ? parent : reclaimed),
      observeRecovery: () => {
        observeCount += 1;
        return observeCount === 1
          ? {
              accumulationBranchExists: false,
              localAccumulationHeadSha: null,
              remoteAccumulationHeadSha: null,
              parentLabels: ["bug", "agent-in-progress"],
              openChildNumbers: [],
              closedChildNumbers: [],
            }
          : {
              accumulationBranchExists: true,
              localAccumulationHeadSha: mainlineSha,
              remoteAccumulationHeadSha: mainlineSha,
              parentLabels: ["bug", "agent-in-progress", "parent-42"],
              openChildNumbers: [],
              closedChildNumbers: [],
            };
      },
      addInProgressLabel(parentNumber) {
        calls.push(`addInProgressLabel:${parentNumber}`);
      },
      ensureQueueLabel(parentNumber) {
        calls.push(`ensureQueueLabel:${parentNumber}`);
      },
      fetchMainline() {
        calls.push("fetchMainline");
        return mainlineSha;
      },
      createAccumulationBranch({ branchName, baseSha }) {
        calls.push(`createAccumulationBranch:${branchName}:${baseSha}`);
      },
      pushInitialCheckpoint({ branchName, expectedHeadSha }) {
        calls.push(`pushInitialCheckpoint:${branchName}:${expectedHeadSha}`);
        return expectedHeadSha;
      },
      createStateComment({ parentNumber }) {
        calls.push(`createStateComment:${parentNumber}`);
        return 91;
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "claimed");
  if (result.kind !== "claimed") return;
  assert.equal(result.commentId, 91);
  assert.equal(result.state.phase, "claimed");
  assert.deepEqual(calls, [
    "addInProgressLabel:42",
    "ensureQueueLabel:42",
    "fetchMainline",
    `createAccumulationBranch:issue-42-accumulation:${mainlineSha}`,
    `pushInitialCheckpoint:issue-42-accumulation:${mainlineSha}`,
    "createStateComment:42",
  ]);
});

test("resume-selected parent with terminal recorded phase returns terminal_label_repair", async () => {
  // The state comment says 'failed' but agent-in-progress was never removed:
  // the loop crashed between the terminal state write and the label apply.
  const failedState = state({ phase: "failed" });
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }, { name: "agent-in-progress" }, { name: "parent-42" }],
    comments: [
      {
        id: 9,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: renderParentStateComment(failedState),
      },
    ],
  };

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-02T12:00:00Z",
      listOpenParents: () => [
        {
          number: 42,
          state: "OPEN",
          labels: [{ name: "bug" }, { name: "agent-in-progress" }, { name: "parent-42" }],
        },
      ],
      viewParent: () => parent,
      observeRecovery: () => ({
        accumulationBranchExists: true,
        localAccumulationHeadSha: sha("c"),
        remoteAccumulationHeadSha: sha("c"),
        parentLabels: ["bug", "agent-in-progress", "parent-42"],
        openChildNumbers: [],
        closedChildNumbers: [],
      }),
      addInProgressLabel() {
        throw new Error("should not claim fresh");
      },
      ensureQueueLabel() {
        throw new Error("should not claim fresh");
      },
      fetchMainline() {
        throw new Error("should not claim fresh");
      },
      createAccumulationBranch() {
        throw new Error("should not claim fresh");
      },
      pushInitialCheckpoint() {
        throw new Error("should not claim fresh");
      },
      createStateComment() {
        throw new Error("should not claim fresh");
      },
      updateStateComment() {
        throw new Error("should not requeue");
      },
      removeStuckLabelFromOpenChildren() {
        throw new Error("should not requeue");
      },
    },
  );

  assert.equal(result.kind, "terminal_label_repair");
  if (result.kind !== "terminal_label_repair") return;
  assert.equal(result.state.phase, "failed");
  assert.match(result.diagnostics.join("\n"), /Failed parent still has agent-in-progress/);
});

test("fresh-selected failed parent (agent-stuck removed by a human) is requeued to claimed", async () => {
  const calls: string[] = [];
  const failedState = state({
    phase: "failed",
    partialCauseChildNumber: 101,
    rebaseConflictDiagnostics: ["old conflict"],
  });
  const parent = {
    id: 1,
    number: 42,
    title: "Parent",
    body: "Parent body",
    state: "OPEN" as const,
    labels: [{ name: "bug" }, { name: "parent-42" }],
    comments: [
      {
        id: 9,
        author: { login: "host" },
        createdAt: "2026-07-02T12:00:00Z",
        body: renderParentStateComment(failedState),
      },
    ],
  };
  let updatedBody = "";
  let viewCount = 0;
  let observeCount = 0;

  const result = await acquireNextIssueAsPrdParent(
    {
      backlogLabels: ["bug"],
      maxCommentBytes: 5000,
    },
    {
      now: () => "2026-07-03T09:00:00Z",
      listOpenParents: () => [
        { number: 42, state: "OPEN", labels: [{ name: "bug" }, { name: "parent-42" }] },
      ],
      viewParent: () => {
        viewCount += 1;
        if (viewCount === 1) return parent;
        return {
          ...parent,
          labels: [
            { name: "bug" },
            { name: "parent-42" },
            { name: "agent-in-progress" },
          ],
          comments: [
            {
              id: 9,
              author: { login: "host" },
              createdAt: "2026-07-02T12:00:00Z",
              body: updatedBody,
            },
          ],
        };
      },
      observeRecovery: () => {
        observeCount += 1;
        return {
          accumulationBranchExists: true,
          localAccumulationHeadSha: sha("c"),
          remoteAccumulationHeadSha: sha("c"),
          parentLabels:
            observeCount === 1
              ? ["bug", "parent-42"]
              : ["bug", "parent-42", "agent-in-progress"],
          openChildNumbers: [101],
          closedChildNumbers: [100],
        };
      },
      addInProgressLabel(parentNumber) {
        calls.push(`addInProgressLabel:${parentNumber}`);
      },
      ensureQueueLabel() {
        throw new Error("should not claim fresh");
      },
      fetchMainline() {
        throw new Error("should not claim fresh");
      },
      createAccumulationBranch() {
        throw new Error("should not claim fresh");
      },
      pushInitialCheckpoint() {
        throw new Error("should not claim fresh");
      },
      createStateComment() {
        throw new Error("should not claim fresh");
      },
      updateStateComment({ commentId, body }) {
        calls.push(`updateStateComment:${commentId}`);
        updatedBody = body;
      },
      removeStuckLabelFromOpenChildren({ parentNumber, queueLabel }) {
        calls.push(`unstickChildren:${parentNumber}:${queueLabel}`);
      },
    },
  );

  assert.equal(result.kind, "resumed");
  if (result.kind !== "resumed") return;
  assert.equal(result.commentId, 9);
  assert.equal(result.state.phase, "claimed");
  assert.equal(result.state.partialCauseChildNumber, null);
  assert.deepEqual(result.state.rebaseConflictDiagnostics, []);
  assert.match(updatedBody, /"phase": "claimed"/);
  assert.deepEqual(calls, [
    "addInProgressLabel:42",
    "updateStateComment:9",
    "unstickChildren:42:parent-42",
  ]);
});
