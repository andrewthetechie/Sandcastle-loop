import type { GitHubIssueRecord } from "./github-issues.mts";
import {
  normalizeParentContext,
  type NormalizedParentContext,
} from "./issue-parent-context.mts";
import { reconcileParentState, type IssueAsPrdParentState } from "./issue-as-prd-state.mts";
import type {
  ObservedParentRecoveryState,
  ParentStateReconciliation,
} from "./issue-as-prd-state-contracts.mts";

export type ResumableParentState =
  | {
      kind: "create";
      normalizedContext: NormalizedParentContext;
    }
  | {
      kind: "resume";
      commentId: number;
      state: IssueAsPrdParentState;
      normalizedContext: NormalizedParentContext;
    }
  | {
      kind: "disagreement";
      diagnostics: string[];
      normalizedContext: NormalizedParentContext;
    };

export function reconcileResumableIssueAsPrdParent(input: {
  parent: Pick<GitHubIssueRecord, "number" | "body" | "comments">;
  observed: ObservedParentRecoveryState;
  maxCommentBytes: number;
}): ResumableParentState {
  const normalizedContext = normalizeParentContext({
    body: input.parent.body,
    comments: input.parent.comments,
    maxCommentBytes: input.maxCommentBytes,
  });

  const reconciled = reconcileParentState({
    parentNumber: input.parent.number,
    comments: input.parent.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
    })),
    observed: input.observed,
  });

  return withNormalizedContext(reconciled, normalizedContext);
}

function withNormalizedContext(
  reconciled: ParentStateReconciliation<IssueAsPrdParentState>,
  normalizedContext: NormalizedParentContext,
): ResumableParentState {
  switch (reconciled.kind) {
    case "create":
      return {
        kind: "create",
        normalizedContext,
      };
    case "resume":
      return {
        kind: "resume",
        commentId: reconciled.commentId,
        state: reconciled.state,
        normalizedContext,
      };
    case "disagreement":
      return {
        kind: "disagreement",
        diagnostics: reconciled.diagnostics,
        normalizedContext,
      };
  }
}
