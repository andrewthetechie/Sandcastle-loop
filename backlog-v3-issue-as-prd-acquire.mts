import type { GitHubIssueRecord } from "./github-issues.mts";
import { selectNextIssueAsPrdParent, type IssueAsPrdParentCandidate } from "./backlog-v3-issue-as-prd-adapter.mts";
import {
  claimFreshIssueAsPrdParent,
  type FreshParentClaimDeps,
} from "./backlog-v3-issue-as-prd-claim.mts";
import {
  reconcileResumableIssueAsPrdParent,
  type ResumableParentState,
} from "./backlog-v3-issue-as-prd-resume.mts";
import type { ObservedParentRecoveryState } from "./issue-as-prd-state-contracts.mts";
import {
  nextParentState,
  parseParentStateComment,
  renderParentStateComment,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";
import { ISSUE_AS_PRD_STATE_MARKER } from "./issue-parent-context.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";

export type AcquireNextIssueAsPrdParentResult =
  | { kind: "none" }
  | {
      kind: "claimed";
      parent: GitHubIssueRecord;
      commentId: number;
      state: IssueAsPrdParentState;
      normalizedContext: NormalizedParentContext;
    }
  | {
      kind: "resumed";
      parent: GitHubIssueRecord;
      commentId: number;
      state: IssueAsPrdParentState;
      normalizedContext: NormalizedParentContext;
    }
  | {
      kind: "ownership_ambiguous";
      parent: GitHubIssueRecord;
      diagnostics: string[];
      normalizedContext: NormalizedParentContext;
    }
  | {
      // The durable state comment records a terminal phase but the terminal
      // label plan was never (fully) applied — the loop crashed between the
      // state-comment write and the label mutation. The caller should finish
      // the label plan derived from `state` and move on to the next parent.
      kind: "terminal_label_repair";
      parent: GitHubIssueRecord;
      state: IssueAsPrdParentState;
      diagnostics: string[];
    };

export interface AcquireNextIssueAsPrdParentDeps extends FreshParentClaimDeps {
  now(): string;
  listOpenParents(): Promise<readonly IssueAsPrdParentCandidate[]> | readonly IssueAsPrdParentCandidate[];
  viewParent(parentNumber: number): Promise<GitHubIssueRecord> | GitHubIssueRecord;
  observeRecovery(parent: GitHubIssueRecord): Promise<ObservedParentRecoveryState> | ObservedParentRecoveryState;
  updateStateComment(input: {
    commentId: number;
    body: string;
  }): Promise<void> | void;
  removeStuckLabelFromOpenChildren(input: {
    parentNumber: number;
    queueLabel: string;
  }): Promise<void> | void;
}

export async function acquireNextIssueAsPrdParent(input: {
  backlogLabels: readonly string[];
  maxCommentBytes: number;
}, deps: AcquireNextIssueAsPrdParentDeps): Promise<AcquireNextIssueAsPrdParentResult> {
  const openIssues = await deps.listOpenParents();
  const selection = selectNextIssueAsPrdParent({
    openIssues,
    backlogLabels: input.backlogLabels,
  });
  if (selection.kind === "none") {
    return { kind: "none" };
  }

  const parent = await deps.viewParent(selection.issue.number);
  const observed = await deps.observeRecovery(parent);
  const reconciled = reconcileResumableIssueAsPrdParent({
    parent,
    observed,
    maxCommentBytes: input.maxCommentBytes,
  });

  if (selection.kind === "resume") {
    if (reconciled.kind === "create") {
      // The parent carries agent-in-progress but has no durable state
      // comment: a previous claim was interrupted between the label write
      // (first claim step) and the state-comment write (last claim step).
      // Every claim step is idempotent, so finish the claim instead of
      // declaring ownership ambiguous.
      return claimParentAndConfirm(parent, input, deps);
    }
    if (reconciled.kind === "disagreement") {
      const recorded = parseSingleMarkedStateComment(parent.comments);
      if (recorded && isTerminalPhase(recorded.phase)) {
        return {
          kind: "terminal_label_repair",
          parent,
          state: recorded,
          diagnostics: reconciled.diagnostics,
        };
      }
    }
    return resumeSelection(parent, reconciled);
  }

  switch (reconciled.kind) {
    case "create":
      return claimParentAndConfirm(parent, input, deps);
    case "resume":
      // A fresh-selected parent only reconciles as resumable when its
      // recorded phase is terminal (in-progress phases require the
      // agent-in-progress label, which fresh selection excludes). A recorded
      // 'failed' phase with the stuck label gone means a human requeued the
      // parent by removing agent-stuck — adopt it instead of skipping it.
      if (reconciled.state.phase === "failed") {
        return requeueFailedParent(parent, reconciled, input, deps);
      }
      return {
        kind: "ownership_ambiguous",
        parent,
        diagnostics: [
          `Fresh-selected parent #${parent.number} unexpectedly reconciled as resumable (phase '${reconciled.state.phase}').`,
        ],
        normalizedContext: reconciled.normalizedContext,
      };
    case "disagreement":
      return {
        kind: "ownership_ambiguous",
        parent,
        diagnostics: reconciled.diagnostics,
        normalizedContext: reconciled.normalizedContext,
      };
  }
}

// Requeue a parent whose durable state records 'failed' but whose agent-stuck
// label has been removed (the human gesture for "retry this"). Rewind the
// durable phase to 'claimed' — the orchestrator resumes published children
// from there and re-decomposes an empty queue — re-add the in-progress label,
// and unstick open children so the drain retries them too.
//
// Ordering: label first, state comment second. If the run dies in between,
// the parent reads as failed-with-in-progress-label, which the next run
// repairs through the existing terminal_label_repair path (back to a clean
// stuck state) instead of wedging as ownership-ambiguous.
async function requeueFailedParent(
  parent: GitHubIssueRecord,
  reconciled: Extract<ResumableParentState, { kind: "resume" }>,
  input: { maxCommentBytes: number },
  deps: AcquireNextIssueAsPrdParentDeps,
): Promise<AcquireNextIssueAsPrdParentResult> {
  const requeuedState = nextParentState({
    previous: reconciled.state,
    now: deps.now(),
    next: {
      ...reconciled.state,
      phase: "claimed",
      partialCauseChildNumber: null,
      rebaseConflictDiagnostics: [],
    },
  });
  await deps.addInProgressLabel(parent.number);
  await deps.updateStateComment({
    commentId: reconciled.commentId,
    body: renderParentStateComment(requeuedState),
  });
  await deps.removeStuckLabelFromOpenChildren({
    parentNumber: parent.number,
    queueLabel: requeuedState.queueLabel,
  });

  const refreshedParent = await deps.viewParent(parent.number);
  const refreshedObserved = await deps.observeRecovery(refreshedParent);
  const refreshedReconciled = reconcileResumableIssueAsPrdParent({
    parent: refreshedParent,
    observed: refreshedObserved,
    maxCommentBytes: input.maxCommentBytes,
  });
  if (refreshedReconciled.kind !== "resume") {
    return {
      kind: "ownership_ambiguous",
      parent: refreshedParent,
      diagnostics: [
        `Requeued failed parent #${parent.number} did not reconcile as resumable after repair.`,
        ...(refreshedReconciled.kind === "disagreement"
          ? refreshedReconciled.diagnostics
          : []),
      ],
      normalizedContext: refreshedReconciled.normalizedContext,
    };
  }
  return {
    kind: "resumed",
    parent: refreshedParent,
    commentId: refreshedReconciled.commentId,
    state: refreshedReconciled.state,
    normalizedContext: refreshedReconciled.normalizedContext,
  };
}

async function claimParentAndConfirm(
  parent: GitHubIssueRecord,
  input: { maxCommentBytes: number },
  deps: AcquireNextIssueAsPrdParentDeps,
): Promise<AcquireNextIssueAsPrdParentResult> {
  await claimFreshIssueAsPrdParent(
    {
      parent,
      now: deps.now(),
    },
    deps,
  );
  const refreshedParent = await deps.viewParent(parent.number);
  const refreshedObserved = await deps.observeRecovery(refreshedParent);
  const refreshedReconciled = reconcileResumableIssueAsPrdParent({
    parent: refreshedParent,
    observed: refreshedObserved,
    maxCommentBytes: input.maxCommentBytes,
  });
  if (refreshedReconciled.kind !== "resume") {
    return {
      kind: "ownership_ambiguous",
      parent: refreshedParent,
      diagnostics: [
        `Expected resumable parent #${parent.number}, observed ${refreshedReconciled.kind}.`,
        ...(refreshedReconciled.kind === "disagreement"
          ? refreshedReconciled.diagnostics
          : []),
      ],
      normalizedContext: refreshedReconciled.normalizedContext,
    };
  }
  return {
    kind: "claimed",
    parent: refreshedParent,
    commentId: refreshedReconciled.commentId,
    state: refreshedReconciled.state,
    normalizedContext: refreshedReconciled.normalizedContext,
  };
}

function resumeSelection(
  parent: GitHubIssueRecord,
  reconciled: ResumableParentState,
): AcquireNextIssueAsPrdParentResult {
  switch (reconciled.kind) {
    case "resume":
      return {
        kind: "resumed",
        parent,
        commentId: reconciled.commentId,
        state: reconciled.state,
        normalizedContext: reconciled.normalizedContext,
      };
    case "create":
      return {
        kind: "ownership_ambiguous",
        parent,
        diagnostics: [
          `Resume-selected parent #${parent.number} is missing its durable state comment.`,
        ],
        normalizedContext: reconciled.normalizedContext,
      };
    case "disagreement":
      return {
        kind: "ownership_ambiguous",
        parent,
        diagnostics: reconciled.diagnostics,
        normalizedContext: reconciled.normalizedContext,
      };
  }
}

function parseSingleMarkedStateComment(
  comments: GitHubIssueRecord["comments"],
): IssueAsPrdParentState | null {
  const marked = comments.filter((comment) =>
    comment.body.includes(ISSUE_AS_PRD_STATE_MARKER),
  );
  if (marked.length !== 1) return null;
  const parsed = parseParentStateComment(marked[0]!.body);
  return parsed.ok ? parsed.state : null;
}

function isTerminalPhase(phase: IssueAsPrdParentState["phase"]): boolean {
  return phase === "delivered" || phase === "failed";
}
