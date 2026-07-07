import type { GitHubIssueRecord } from "./github-issues.mts";
import {
  ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
  renderParentStateComment,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";
import {
  accumulationBranchName,
  queueLabelName,
} from "./backlog-v3-issue-as-prd-adapter.mts";

export interface FreshParentClaimDeps {
  addInProgressLabel(parentNumber: number): Promise<void> | void;
  ensureQueueLabel(parentNumber: number): Promise<void> | void;
  fetchMainline(): Promise<string> | string;
  createAccumulationBranch(input: {
    branchName: string;
    baseSha: string;
  }): Promise<void> | void;
  // Push the freshly-created accumulation branch to origin as the initial
  // checkpoint and return the resolved accumulation head SHA. Normally this
  // equals `expectedHeadSha`, but when the push is rejected as non-fast-forward
  // because a prior interrupted claim already left a remote accumulation
  // branch at a different SHA, the implementation may adopt that remote tip as
  // the base instead of clobbering it; the returned SHA then becomes the
  // parent's `originalForkSha` and `fullParentReviewBaseSha`.
  pushInitialCheckpoint(input: {
    branchName: string;
    expectedHeadSha: string;
  }): Promise<string> | string;
  createStateComment(input: {
    parentNumber: number;
    body: string;
  }): Promise<number> | number;
}

export interface FreshParentClaimResult {
  state: IssueAsPrdParentState;
  commentBody: string;
  commentId: number;
}

export async function claimFreshIssueAsPrdParent(input: {
  parent: Pick<GitHubIssueRecord, "number">;
  now: string;
}, deps: FreshParentClaimDeps): Promise<FreshParentClaimResult> {
  await deps.addInProgressLabel(input.parent.number);
  await deps.ensureQueueLabel(input.parent.number);

  const originalForkSha = await deps.fetchMainline();
  const accumulationBranch = accumulationBranchName(input.parent.number);
  await deps.createAccumulationBranch({
    branchName: accumulationBranch,
    baseSha: originalForkSha,
  });
  // `pushInitialCheckpoint` returns the accumulation branch's resolved head SHA.
  // On a clean first push it equals `originalForkSha`; on recovery from a
  // non-fast-forward rejection it adopts the remote tip as the parent's true
  // original fork so the durable state records the SHA the branch actually
  // started from, not the mainline tip we tried (and failed) to overwrite it
  // with. Subsequent full-parent review base comparison depends on this.
  const resolvedAccumulationHeadSha = await deps.pushInitialCheckpoint({
    branchName: accumulationBranch,
    expectedHeadSha: originalForkSha,
  });

  const state: IssueAsPrdParentState = {
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    parentNumber: input.parent.number,
    accumulationBranch,
    originalForkSha: resolvedAccumulationHeadSha,
    fullParentReviewBaseSha: resolvedAccumulationHeadSha,
    attemptedMainlineSha: null,
    latestMainlineShaAtDelivery: null,
    phase: "claimed",
    queueLabel: queueLabelName(input.parent.number),
    completedExtraReviewRounds: 0,
    aggregateValidationRepairs: { pre_review: 0, pre_delivery: 0 },
    rebaseConflictDiagnostics: [],
    partialCauseChildNumber: null,
    lastTransitionAt: input.now,
  };
  const commentBody = renderParentStateComment(state);
  const commentId = await deps.createStateComment({
    parentNumber: input.parent.number,
    body: commentBody,
  });

  return {
    state,
    commentBody,
    commentId,
  };
}
