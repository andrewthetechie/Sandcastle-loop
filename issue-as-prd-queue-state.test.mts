import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_STUCK_LABEL,
  ISSUE_AS_PRD_LABELS,
  REVIEW_LABEL,
  cleanDeliveryLabelPlan,
  decideDrainState,
  parentFailureLabelPlan,
  parentQueueLabel,
  partialDeliveryLabelPlan,
  rebaseNeededCleanDeliveryLabelPlan,
  rebaseNeededPartialDeliveryLabelPlan,
  selectNextChild,
  selectParent,
  type QueueIssue,
} from "./issue-as-prd-queue-state.mts";

test("selectParent chooses a resumable parent before any fresh parent", () => {
  const result = selectParent({
    openIssues: [
      issue(9, ["backlog", "feature", ISSUE_AS_PRD_LABELS.inProgress.name]),
      issue(3, ["backlog", "feature"]),
      issue(4, ["backlog", "feature"]),
    ],
    backlogLabels: ["backlog", "feature"],
  });

  assert.equal(result.kind, "resume");
  assert.equal(result.issue.number, 9);
});

test("selectParent chooses the lowest-number fresh parent when no resumable parent exists", () => {
  const result = selectParent({
    openIssues: [
      issue(4, ["backlog", "feature"]),
      issue(3, ["backlog", "feature"]),
      issue(2, ["backlog"]),
    ],
    backlogLabels: ["backlog", "feature"],
  });

  assert.equal(result.kind, "fresh");
  assert.equal(result.issue.number, 3);
});

test("selectParent requires all backlog labels and excludes in-progress, Review, and stuck from fresh selection", () => {
  const result = selectParent({
    openIssues: [
      issue(1, ["backlog"]),
      issue(2, ["backlog", ISSUE_AS_PRD_LABELS.inProgress.name]),
      issue(3, ["backlog", "feature", REVIEW_LABEL]),
      issue(4, ["backlog", "feature", AGENT_STUCK_LABEL]),
    ],
    backlogLabels: ["backlog", "feature"],
  });

  assert.deepEqual(result, { kind: "none" });
});

test("selectNextChild returns the lowest-number open queued child and skips stuck and closed children", () => {
  const queueLabel = parentQueueLabel(42);
  const result = selectNextChild({
    openIssues: [
      issue(12, [queueLabel]),
      issue(10, [queueLabel, AGENT_STUCK_LABEL]),
      issue(11, [queueLabel], "CLOSED"),
      issue(9, ["other"]),
      issue(8, [queueLabel]),
    ],
    queueLabel,
  });

  assert.equal(result.kind, "next");
  if (result.kind !== "next") return;
  assert.equal(result.issue.number, 8);
});

test("decideDrainState continues while a selectable child remains", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [issue(7, [queueLabel])],
    queueLabel,
    fullParentReviewBaseSha: "base",
    accumulationHeadSha: "head",
  });

  assert.equal(result.kind, "continue");
  if (result.kind !== "continue") return;
  assert.equal(result.issue.number, 7);
});

test("decideDrainState returns parent_stuck_empty for an initial stuck child with no integrated work", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [issue(7, [queueLabel, AGENT_STUCK_LABEL])],
    queueLabel,
    fullParentReviewBaseSha: "same",
    accumulationHeadSha: "same",
  });

  assert.deepEqual(result, { kind: "parent_stuck_empty", openStuckNumbers: [7] });
});

test("decideDrainState returns queue_starved_empty when no open children remain and nothing integrated", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [issue(7, [queueLabel], "CLOSED")],
    queueLabel,
    fullParentReviewBaseSha: "same",
    accumulationHeadSha: "same",
  });

  assert.deepEqual(result, { kind: "queue_starved_empty" });
});

test("decideDrainState returns partial_review for a stuck child after integrated work exists", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [issue(7, [queueLabel, AGENT_STUCK_LABEL])],
    queueLabel,
    fullParentReviewBaseSha: "base",
    accumulationHeadSha: "head",
  });

  assert.deepEqual(result, { kind: "partial_review" });
});

test("decideDrainState returns ready_for_full_review after a clean drain with integrated work", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [],
    queueLabel,
    fullParentReviewBaseSha: "base",
    accumulationHeadSha: "head",
  });

  assert.deepEqual(result, { kind: "ready_for_full_review" });
});

test("follow-up stuck still resolves to partial_review and never another continue path", () => {
  const queueLabel = parentQueueLabel(42);
  const result = decideDrainState({
    openIssues: [
      issue(15, [queueLabel, AGENT_STUCK_LABEL]),
      issue(16, [queueLabel, AGENT_STUCK_LABEL]),
    ],
    queueLabel,
    fullParentReviewBaseSha: "base",
    accumulationHeadSha: "head",
  });

  assert.deepEqual(result, { kind: "partial_review" });
});

test("label constants and parentQueueLabel use the exact names, colors, descriptions, and format", () => {
  assert.deepEqual(ISSUE_AS_PRD_LABELS, {
    inProgress: {
      name: "agent-in-progress",
      color: "fbca04",
      description: "Issue-as-PRD parent currently owned by the agent loop",
    },
    partial: {
      name: "agent-partial",
      color: "d93f0b",
      description: "Review-ready branch contains a partial parent implementation",
    },
    rebaseNeeded: {
      name: "agent-rebase-needed",
      color: "d4c5f9",
      description: "Review-ready branch needs a manual rebase onto current mainline",
    },
    parentQueue: {
      color: "1d76db",
      description: "Temporary Issue-as-PRD queue for parent #N",
    },
  });
  assert.equal(parentQueueLabel(42), "parent-42");
});

test("terminal label plans preserve exact add/remove ordering and queue-label cleanup semantics", () => {
  assert.deepEqual(cleanDeliveryLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["Review"],
    deleteQueueLabel: true,
  });
  assert.deepEqual(partialDeliveryLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["Review", "agent-partial"],
    deleteQueueLabel: true,
  });
  assert.deepEqual(rebaseNeededCleanDeliveryLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["Review", "agent-rebase-needed"],
    deleteQueueLabel: true,
  });
  assert.deepEqual(rebaseNeededPartialDeliveryLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["Review", "agent-partial", "agent-rebase-needed"],
    deleteQueueLabel: true,
  });
  assert.deepEqual(parentFailureLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["agent-stuck"],
    deleteQueueLabel: false,
  });
});

test("restart decisions are idempotent when labels are already partly applied", () => {
  const selection = selectParent({
    openIssues: [
      issue(20, [
        "backlog",
        "feature",
        ISSUE_AS_PRD_LABELS.inProgress.name,
        REVIEW_LABEL,
      ]),
      issue(21, ["backlog", "feature"]),
    ],
    backlogLabels: ["backlog", "feature"],
  });

  assert.equal(selection.kind, "resume");
  assert.equal(selection.issue.number, 20);

  assert.deepEqual(parentFailureLabelPlan(), {
    remove: ["agent-in-progress"],
    add: ["agent-stuck"],
    deleteQueueLabel: false,
  });
});

function issue(
  number: number,
  labels: readonly string[] = [],
  state: "OPEN" | "CLOSED" = "OPEN",
): QueueIssue {
  return { number, labels, state, title: `Issue ${number}` };
}
