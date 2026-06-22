import {
  type ExtraReviewPrdArtifactIdentity,
  type ExtraReviewRoundArtifactIdentity,
  type ExtraReviewRoundWriteResult,
  writeExtraReviewRoundArtifacts,
} from "./extra-review-artifacts.mts";

export const DEFAULT_EXTRA_REVIEW_STUCK_LABEL = "agent-stuck";

export type ExtraReviewQueueAction =
  | "start_extra_review"
  | "continue_issue_loop"
  | "stop_with_handoff";

export type ExtraReviewQueueDecisionReason =
  | "clean_drain"
  | "open_non_stuck_issues"
  | "stuck_issues"
  | "iteration_cap_exhausted"
  | "base_validation_failed";

export type ExtraReviewQueueIssueLabel = string | { name: string };

export interface ExtraReviewQueueIssue {
  number: number;
  title?: string;
  labels?: readonly ExtraReviewQueueIssueLabel[];
}

export interface ExtraReviewQueueIssueSummary {
  number: number;
  title: string;
}

export interface ExtraReviewQueuePartition {
  openNonStuckIssues: ExtraReviewQueueIssueSummary[];
  stuckIssues: ExtraReviewQueueIssueSummary[];
}

export interface ExtraReviewOuterLoopState {
  capExhausted: boolean;
  completedIterations: number;
  maxIterations: number;
}

export type ExtraReviewBaseValidationState =
  | { ok: true }
  | {
      ok: false;
      summary?: string;
      feedback?: string;
      command?: string;
      exitCode?: number;
    };

export interface ExtraReviewQueueDecisionInput {
  openIssues: readonly ExtraReviewQueueIssue[];
  outerLoop: ExtraReviewOuterLoopState;
  baseValidation: ExtraReviewBaseValidationState;
  stuckLabel?: string;
}

export interface ExtraReviewQueueDecision extends ExtraReviewQueuePartition {
  action: ExtraReviewQueueAction;
  reason: ExtraReviewQueueDecisionReason;
  shouldStartExtraReview: boolean;
  outerLoop: ExtraReviewOuterLoopState;
  baseValidation: ExtraReviewBaseValidationState;
}

export interface ExtraReviewQueueSkipHandoffInput {
  runsRootDir?: string;
  prd: ExtraReviewPrdArtifactIdentity;
  decision: ExtraReviewQueueDecision;
  reviewBase: string;
  reviewedHead: string;
  round?: ExtraReviewRoundArtifactIdentity;
}

export function partitionOpenPrdIssues(
  openIssues: readonly ExtraReviewQueueIssue[],
  stuckLabel = DEFAULT_EXTRA_REVIEW_STUCK_LABEL,
): ExtraReviewQueuePartition {
  const openNonStuckIssues: ExtraReviewQueueIssueSummary[] = [];
  const stuckIssues: ExtraReviewQueueIssueSummary[] = [];

  for (const issue of openIssues) {
    const target = hasLabel(issue, stuckLabel)
      ? stuckIssues
      : openNonStuckIssues;
    target.push(toIssueSummary(issue));
  }

  return {
    openNonStuckIssues: sortIssueSummaries(openNonStuckIssues),
    stuckIssues: sortIssueSummaries(stuckIssues),
  };
}

export function decideExtraReviewQueueAction(
  input: ExtraReviewQueueDecisionInput,
): ExtraReviewQueueDecision {
  const partition = partitionOpenPrdIssues(input.openIssues, input.stuckLabel);
  const base = {
    ...partition,
    outerLoop: input.outerLoop,
    baseValidation: input.baseValidation,
  };

  if (input.outerLoop.capExhausted) {
    return {
      ...base,
      action: "stop_with_handoff",
      reason: "iteration_cap_exhausted",
      shouldStartExtraReview: false,
    };
  }

  if (partition.openNonStuckIssues.length > 0) {
    return {
      ...base,
      action: "continue_issue_loop",
      reason: "open_non_stuck_issues",
      shouldStartExtraReview: false,
    };
  }

  if (partition.stuckIssues.length > 0) {
    return {
      ...base,
      action: "stop_with_handoff",
      reason: "stuck_issues",
      shouldStartExtraReview: false,
    };
  }

  if (!input.baseValidation.ok) {
    return {
      ...base,
      action: "stop_with_handoff",
      reason: "base_validation_failed",
      shouldStartExtraReview: false,
    };
  }

  return {
    ...base,
    action: "start_extra_review",
    reason: "clean_drain",
    shouldStartExtraReview: true,
  };
}

export function renderExtraReviewQueueSkipDetails(
  decision: ExtraReviewQueueDecision,
): string[] {
  switch (decision.reason) {
    case "stuck_issues":
      return [
        "PRD-level quality gates did not run because open stuck PRD issues remain.",
        `Stuck issue count: ${decision.stuckIssues.length}.`,
        ...formatIssueDetailLines("Stuck issues", decision.stuckIssues),
      ];
    case "iteration_cap_exhausted":
      return [
        "PRD-level quality gates did not run because the outer issue-processing safety cap was exhausted.",
        `Iterations: ${decision.outerLoop.completedIterations}/${decision.outerLoop.maxIterations}.`,
        `Open non-stuck issue count: ${decision.openNonStuckIssues.length}.`,
        `Stuck issue count: ${decision.stuckIssues.length}.`,
        ...formatIssueDetailLines(
          "Remaining open non-stuck issues",
          decision.openNonStuckIssues,
        ),
        ...formatIssueDetailLines("Remaining stuck issues", decision.stuckIssues),
      ];
    case "base_validation_failed":
      return [
        "PRD-level quality gates did not run because base validation failed before extra review setup.",
        ...formatValidationFailureDetails(decision.baseValidation),
      ];
    case "open_non_stuck_issues":
      return [
        "Extra review did not start because open non-stuck PRD issues still need normal issue-loop processing.",
        `Open non-stuck issue count: ${decision.openNonStuckIssues.length}.`,
        ...formatIssueDetailLines(
          "Open non-stuck issues",
          decision.openNonStuckIssues,
        ),
      ];
    case "clean_drain":
      return [
        "The PRD queue drained cleanly; no skip handoff is required before extra review setup.",
      ];
  }
}

export function writeExtraReviewQueueSkipHandoff(
  input: ExtraReviewQueueSkipHandoffInput,
): ExtraReviewRoundWriteResult {
  if (input.decision.action !== "stop_with_handoff") {
    throw new Error(
      `Queue decision ${input.decision.reason} does not require a skip handoff.`,
    );
  }

  return writeExtraReviewRoundArtifacts({
    runsRootDir: input.runsRootDir,
    prd: input.prd,
    round: input.round ?? { id: `queue-skip-${input.decision.reason}` },
    reviewBase: input.reviewBase,
    reviewedHead: input.reviewedHead,
    stopReason: "skipped",
    stopDetails: renderExtraReviewQueueSkipDetails(input.decision),
  });
}

function hasLabel(
  issue: ExtraReviewQueueIssue,
  labelName: string,
): boolean {
  return (issue.labels ?? []).some((label) =>
    typeof label === "string" ? label === labelName : label.name === labelName,
  );
}

function toIssueSummary(
  issue: ExtraReviewQueueIssue,
): ExtraReviewQueueIssueSummary {
  return {
    number: issue.number,
    title: issue.title?.trim() || "(untitled issue)",
  };
}

function sortIssueSummaries(
  issues: ExtraReviewQueueIssueSummary[],
): ExtraReviewQueueIssueSummary[] {
  return [...issues].sort((a, b) => a.number - b.number);
}

function formatIssueDetailLines(
  label: string,
  issues: readonly ExtraReviewQueueIssueSummary[],
): string[] {
  if (issues.length === 0) return [`${label}: none.`];
  return [`${label}: ${issues.map(formatIssueSummary).join("; ")}.`];
}

function formatIssueSummary(issue: ExtraReviewQueueIssueSummary): string {
  return `#${issue.number} ${issue.title}`;
}

function formatValidationFailureDetails(
  baseValidation: ExtraReviewBaseValidationState,
): string[] {
  if (baseValidation.ok) {
    return ["Validation state was reported as passing."];
  }

  const lines: string[] = [];
  if (baseValidation.summary) {
    lines.push(`Validation failure: ${baseValidation.summary}`);
  }
  if (baseValidation.command) {
    lines.push(`Command: ${baseValidation.command}`);
  }
  if (baseValidation.exitCode !== undefined) {
    lines.push(`Exit code: ${baseValidation.exitCode}`);
  }
  if (baseValidation.feedback) {
    lines.push(`Validation feedback: ${baseValidation.feedback.slice(0, 4000)}`);
  }
  return lines.length > 0 ? lines : ["Validation failed without details."];
}
