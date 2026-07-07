import type { GitHubIssueRecord } from "./github-issues.mts";
import {
  reconcileResumableIssueAsPrdParent,
} from "./backlog-v3-issue-as-prd-resume.mts";
import type { ObservedParentRecoveryState } from "./issue-as-prd-state-contracts.mts";
import type { IssueAsPrdParentState } from "./issue-as-prd-state.mts";

export function verifyIssueAsPrdParentOwnership(input: {
  parent: Pick<GitHubIssueRecord, "number" | "body" | "comments">;
  expectedState: IssueAsPrdParentState;
  observed: ObservedParentRecoveryState;
  maxCommentBytes: number;
}): { ok: true } | { ok: false; diagnostics: string[] } {
  const reconciled = reconcileResumableIssueAsPrdParent({
    parent: input.parent,
    observed: input.observed,
    maxCommentBytes: input.maxCommentBytes,
  });

  if (reconciled.kind !== "resume") {
    return {
      ok: false,
      diagnostics:
        reconciled.kind === "disagreement"
          ? reconciled.diagnostics
          : [`Expected resumable parent #${input.parent.number}, observed ${reconciled.kind}.`],
    };
  }

  if (JSON.stringify(reconciled.state) !== JSON.stringify(input.expectedState)) {
    return {
      ok: false,
      diagnostics: [
        `Recorded parent state for #${input.parent.number} changed since acquisition.`,
      ],
    };
  }

  return { ok: true };
}
