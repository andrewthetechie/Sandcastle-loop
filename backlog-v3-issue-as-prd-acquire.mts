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
  parseParentStateComment,
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
      return {
        kind: "ownership_ambiguous",
        parent,
        diagnostics: [
          `Fresh-selected parent #${parent.number} unexpectedly reconciled as resumable.`,
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
