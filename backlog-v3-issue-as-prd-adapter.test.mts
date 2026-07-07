import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulationBranchName,
  childBranchName,
  permanentIssueAsPrdParentLabels,
  queueLabelName,
  selectNextIssueAsPrdParent,
  terminalActionForParentResult,
  terminalRepairLabelPlan,
} from "./backlog-v3-issue-as-prd-adapter.mts";

test("resume parent is selected before an older fresh parent", () => {
  const result = selectNextIssueAsPrdParent({
    backlogLabels: ["bug"],
    openIssues: [
      issue(3, ["bug"]),
      issue(9, ["bug", "agent-in-progress"]),
    ],
  });

  assert.deepEqual(result, {
    kind: "resume",
    issue: issue(9, ["bug", "agent-in-progress"]),
  });
});

test("fresh eligible parent is selected when no resumable parent exists", () => {
  const result = selectNextIssueAsPrdParent({
    backlogLabels: ["bug"],
    openIssues: [
      issue(8, ["bug", "Review"]),
      issue(4, ["bug"]),
      issue(6, ["bug", "agent-stuck"]),
    ],
  });

  assert.deepEqual(result, {
    kind: "fresh",
    issue: issue(4, ["bug"]),
  });
});

test("stable branch and queue naming matches the task contract", () => {
  assert.equal(accumulationBranchName(42), "issue-42-accumulation");
  assert.equal(childBranchName(42, 7), "issue-42-child-7");
  assert.equal(queueLabelName(42), "parent-42");
});

test("terminal action mapping covers clean, partial, stuck, and ownership ambiguity", () => {
  assert.deepEqual(
    terminalActionForParentResult({
      kind: "clean_delivery",
      accumulationHeadSha: "a",
      observedMainlineSha: "b",
      rebaseNeeded: false,
    }),
    {
      kind: "deliver",
      labelPlan: {
        remove: ["agent-in-progress"],
        add: ["Review"],
        deleteQueueLabel: true,
      },
      shouldStopLoop: false,
    },
  );

  assert.deepEqual(
    terminalActionForParentResult({
      kind: "partial_delivery",
      accumulationHeadSha: "a",
      observedMainlineSha: "b",
      rebaseNeeded: true,
      stuckChildNumber: 13,
    }),
    {
      kind: "deliver",
      labelPlan: {
        remove: ["agent-in-progress"],
        add: ["Review", "agent-partial", "agent-rebase-needed"],
        deleteQueueLabel: true,
      },
      shouldStopLoop: false,
    },
  );

  assert.deepEqual(
    terminalActionForParentResult({
      kind: "parent_stuck",
      accumulationHeadSha: "a",
      reason: "validation_failed",
      diagnostics: ["test failed"],
    }),
    {
      kind: "mark_parent_stuck",
      labelPlan: {
        remove: ["agent-in-progress"],
        add: ["agent-stuck"],
        deleteQueueLabel: false,
      },
      shouldStopLoop: false,
      reason: "validation_failed",
      diagnostics: ["test failed"],
    },
  );

  assert.deepEqual(
    terminalActionForParentResult({
      kind: "ownership_ambiguous",
      reason: "state disagreement",
      diagnostics: ["multiple state comments"],
    }),
    {
      kind: "ownership_ambiguous",
      shouldStopLoop: true,
      reason: "state disagreement",
      diagnostics: ["multiple state comments"],
    },
  );
});

test("permanent parent labels are the Task 8 stable set", () => {
  assert.deepEqual(permanentIssueAsPrdParentLabels(), [
    {
      name: "agent-in-progress",
      color: "fbca04",
      description: "Issue-as-PRD parent currently owned by the agent loop",
    },
    {
      name: "agent-partial",
      color: "d93f0b",
      description: "Review-ready branch contains a partial parent implementation",
    },
    {
      name: "agent-rebase-needed",
      color: "d4c5f9",
      description: "Review-ready branch needs a manual rebase onto current mainline",
    },
  ]);
});

function issue(number: number, labels: string[]) {
  return {
    number,
    state: "OPEN" as const,
    labels: labels.map((name) => ({ name })),
  };
}

test("terminalRepairLabelPlan reconstructs the plan from persisted terminal state", () => {
  const base = {
    schemaVersion: 1 as const,
    parentNumber: 42,
    accumulationBranch: "issue-42-accumulation",
    originalForkSha: "a".repeat(40),
    fullParentReviewBaseSha: "b".repeat(40),
    attemptedMainlineSha: null,
    latestMainlineShaAtDelivery: null,
    phase: "delivered" as const,
    queueLabel: "parent-42",
    completedExtraReviewRounds: 1,
    aggregateValidationRepairs: { pre_review: 0 as const, pre_delivery: 0 as const },
    rebaseConflictDiagnostics: [] as string[],
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T12:00:00Z",
  };

  assert.deepEqual(terminalRepairLabelPlan({ ...base, phase: "failed" }), {
    remove: ["agent-in-progress"],
    add: ["agent-stuck"],
    deleteQueueLabel: false,
  });
  assert.deepEqual(
    terminalRepairLabelPlan({ ...base, latestMainlineShaAtDelivery: base.fullParentReviewBaseSha }),
    {
      remove: ["agent-in-progress"],
      add: ["Review"],
      deleteQueueLabel: true,
    },
  );
  assert.deepEqual(
    terminalRepairLabelPlan({
      ...base,
      partialCauseChildNumber: 101,
      latestMainlineShaAtDelivery: "c".repeat(40),
    }),
    {
      remove: ["agent-in-progress"],
      add: ["Review", "agent-partial", "agent-rebase-needed"],
      deleteQueueLabel: true,
    },
  );
});
