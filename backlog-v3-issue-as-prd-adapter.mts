import {
  cleanDeliveryLabelPlan,
  ISSUE_AS_PRD_LABELS,
  parentFailureLabelPlan,
  parentQueueLabel,
  partialDeliveryLabelPlan,
  rebaseNeededCleanDeliveryLabelPlan,
  rebaseNeededPartialDeliveryLabelPlan,
  selectParent,
  type ParentSelection,
  type QueueIssue,
} from "./issue-as-prd-queue-state.mts";
import type { ParentRunResult } from "./issue-as-prd-orchestrator.mts";
import type { IssueAsPrdParentState } from "./issue-as-prd-state.mts";

export interface IssueAsPrdParentCandidate extends QueueIssue {
  labels?: readonly (string | { name: string })[];
}

export type BacklogTerminalAction =
  | {
      kind: "deliver";
      labelPlan: {
        remove: string[];
        add: string[];
        deleteQueueLabel: boolean;
      };
      shouldStopLoop: false;
    }
  | {
      kind: "mark_parent_stuck";
      labelPlan: {
        remove: string[];
        add: string[];
        deleteQueueLabel: boolean;
      };
      shouldStopLoop: false;
      reason: string;
      diagnostics: string[];
    }
  | {
      kind: "ownership_ambiguous";
      shouldStopLoop: true;
      reason: string;
      diagnostics: string[];
    };

export function selectNextIssueAsPrdParent(input: {
  openIssues: readonly IssueAsPrdParentCandidate[];
  backlogLabels: readonly string[];
}): ParentSelection {
  return selectParent({
    openIssues: input.openIssues,
    backlogLabels: input.backlogLabels,
  });
}

export function accumulationBranchName(parentNumber: number): string {
  return `issue-${parentNumber}-accumulation`;
}

export function childBranchName(parentNumber: number, childNumber: number): string {
  return `issue-${parentNumber}-child-${childNumber}`;
}

export function queueLabelName(parentNumber: number): string {
  return parentQueueLabel(parentNumber);
}

export function terminalActionForParentResult(
  result: ParentRunResult,
): BacklogTerminalAction {
  switch (result.kind) {
    case "clean_delivery":
      return {
        kind: "deliver",
        labelPlan: result.rebaseNeeded
          ? rebaseNeededCleanDeliveryLabelPlan()
          : cleanDeliveryLabelPlan(),
        shouldStopLoop: false,
      };
    case "partial_delivery":
      return {
        kind: "deliver",
        labelPlan: result.rebaseNeeded
          ? rebaseNeededPartialDeliveryLabelPlan()
          : partialDeliveryLabelPlan(),
        shouldStopLoop: false,
      };
    case "parent_stuck":
      return {
        kind: "mark_parent_stuck",
        labelPlan: parentFailureLabelPlan(),
        shouldStopLoop: false,
        reason: result.reason,
        diagnostics: result.diagnostics,
      };
    case "ownership_ambiguous":
      return {
        kind: "ownership_ambiguous",
        shouldStopLoop: true,
        reason: result.reason,
        diagnostics: result.diagnostics,
      };
  }
}

// Label plan for a parent whose durable state comment already records a
// terminal phase but whose terminal labels were never (fully) applied — the
// loop crashed between the state-comment write and the label mutation.
// Reconstructs the original plan from the persisted state fields.
export function terminalRepairLabelPlan(state: IssueAsPrdParentState): {
  remove: string[];
  add: string[];
  deleteQueueLabel: boolean;
} {
  if (state.phase === "failed") return parentFailureLabelPlan();
  const rebaseNeeded =
    state.rebaseConflictDiagnostics.length > 0 ||
    (state.latestMainlineShaAtDelivery !== null &&
      state.latestMainlineShaAtDelivery !== state.fullParentReviewBaseSha);
  const partial = state.partialCauseChildNumber !== null;
  if (partial && rebaseNeeded) return rebaseNeededPartialDeliveryLabelPlan();
  if (partial) return partialDeliveryLabelPlan();
  if (rebaseNeeded) return rebaseNeededCleanDeliveryLabelPlan();
  return cleanDeliveryLabelPlan();
}

export function permanentIssueAsPrdParentLabels() {
  return [
    ISSUE_AS_PRD_LABELS.inProgress,
    ISSUE_AS_PRD_LABELS.partial,
    ISSUE_AS_PRD_LABELS.rebaseNeeded,
  ] as const;
}
