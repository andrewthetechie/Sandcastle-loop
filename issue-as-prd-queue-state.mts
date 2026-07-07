export const ISSUE_AS_PRD_LABELS = {
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
} as const;

export const REVIEW_LABEL = "Review";
export const AGENT_STUCK_LABEL = "agent-stuck";

export type QueueIssueLabel = string | { name: string };

export interface QueueIssue {
  number: number;
  title?: string;
  state?: "OPEN" | "CLOSED";
  labels?: readonly QueueIssueLabel[];
}

export type ParentSelection =
  | { kind: "resume" | "fresh"; issue: QueueIssue }
  | { kind: "none" };

export type ChildSelection =
  | { kind: "next"; issue: QueueIssue }
  | { kind: "none" };

export type DrainState =
  | { kind: "continue"; issue: QueueIssue }
  | { kind: "ready_for_full_review" }
  | { kind: "partial_review" }
  | { kind: "parent_stuck_empty" };

export interface LabelMutationPlan {
  remove: string[];
  add: string[];
  deleteQueueLabel: boolean;
}

export function parentQueueLabel(parentNumber: number): string {
  return `parent-${parentNumber}`;
}

export function selectParent(input: {
  openIssues: readonly QueueIssue[];
  backlogLabels: readonly string[];
}): ParentSelection {
  const resume = lowestByNumber(
    input.openIssues.filter(
      (issue) =>
        issue.state !== "CLOSED" &&
        hasAllLabels(issue, input.backlogLabels) &&
        hasLabel(issue, ISSUE_AS_PRD_LABELS.inProgress.name),
    ),
  );
  if (resume) return { kind: "resume", issue: resume };

  const fresh = lowestByNumber(
    input.openIssues.filter(
      (issue) =>
        issue.state !== "CLOSED" &&
        hasAllLabels(issue, input.backlogLabels) &&
        !hasLabel(issue, ISSUE_AS_PRD_LABELS.inProgress.name) &&
        !hasLabel(issue, REVIEW_LABEL) &&
        !hasLabel(issue, AGENT_STUCK_LABEL),
    ),
  );
  if (fresh) return { kind: "fresh", issue: fresh };

  return { kind: "none" };
}

export function selectNextChild(input: {
  openIssues: readonly QueueIssue[];
  queueLabel: string;
}): ChildSelection {
  const next = lowestByNumber(
    input.openIssues.filter(
      (issue) =>
        issue.state !== "CLOSED" &&
        hasLabel(issue, input.queueLabel) &&
        !hasLabel(issue, AGENT_STUCK_LABEL),
    ),
  );
  return next ? { kind: "next", issue: next } : { kind: "none" };
}

export function decideDrainState(input: {
  openIssues: readonly QueueIssue[];
  queueLabel: string;
  fullParentReviewBaseSha: string;
  accumulationHeadSha: string;
}): DrainState {
  const next = selectNextChild({
    openIssues: input.openIssues,
    queueLabel: input.queueLabel,
  });
  if (next.kind === "next") return { kind: "continue", issue: next.issue };

  const integrated = input.accumulationHeadSha !== input.fullParentReviewBaseSha;
  const openStuck = input.openIssues
    .filter(
      (issue) =>
        issue.state !== "CLOSED" &&
        hasLabel(issue, input.queueLabel) &&
        hasLabel(issue, AGENT_STUCK_LABEL),
    )
    .sort(compareByNumber);

  if (openStuck.length > 0) {
    return integrated
      ? { kind: "partial_review" }
      : { kind: "parent_stuck_empty" };
  }

  return integrated
    ? { kind: "ready_for_full_review" }
    : { kind: "parent_stuck_empty" };
}

export function cleanDeliveryLabelPlan(): LabelMutationPlan {
  return {
    remove: [ISSUE_AS_PRD_LABELS.inProgress.name],
    add: [REVIEW_LABEL],
    deleteQueueLabel: true,
  };
}

export function partialDeliveryLabelPlan(): LabelMutationPlan {
  return {
    remove: [ISSUE_AS_PRD_LABELS.inProgress.name],
    add: [REVIEW_LABEL, ISSUE_AS_PRD_LABELS.partial.name],
    deleteQueueLabel: true,
  };
}

export function rebaseNeededCleanDeliveryLabelPlan(): LabelMutationPlan {
  return {
    remove: [ISSUE_AS_PRD_LABELS.inProgress.name],
    add: [REVIEW_LABEL, ISSUE_AS_PRD_LABELS.rebaseNeeded.name],
    deleteQueueLabel: true,
  };
}

export function rebaseNeededPartialDeliveryLabelPlan(): LabelMutationPlan {
  return {
    remove: [ISSUE_AS_PRD_LABELS.inProgress.name],
    add: [
      REVIEW_LABEL,
      ISSUE_AS_PRD_LABELS.partial.name,
      ISSUE_AS_PRD_LABELS.rebaseNeeded.name,
    ],
    deleteQueueLabel: true,
  };
}

export function parentFailureLabelPlan(): LabelMutationPlan {
  return {
    remove: [ISSUE_AS_PRD_LABELS.inProgress.name],
    add: [AGENT_STUCK_LABEL],
    deleteQueueLabel: false,
  };
}

function hasAllLabels(issue: QueueIssue, labels: readonly string[]): boolean {
  return labels.every((label) => hasLabel(issue, label));
}

function hasLabel(issue: QueueIssue, name: string): boolean {
  return (issue.labels ?? []).some((label) =>
    typeof label === "string" ? label === name : label.name === name,
  );
}

function lowestByNumber(issues: readonly QueueIssue[]): QueueIssue | undefined {
  return [...issues].sort(compareByNumber)[0];
}

function compareByNumber(left: QueueIssue, right: QueueIssue): number {
  return left.number - right.number;
}
