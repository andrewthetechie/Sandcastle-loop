import type { GitHubIssueRecord } from "./github-issues.mts";
import type { PublishChildDraft } from "./issue-as-prd-children.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";
import type {
  ExtraReviewPrdArtifactIdentity,
  ExtraReviewRoundArtifactIdentity,
} from "./extra-review-artifacts.mts";
import {
  type ExtraReviewSessionInputBundle,
  type SequentialExtraReviewSessionsResult,
} from "./extra-review-sessions.mts";

export const ISSUE_AS_PRD_EXTRA_REVIEW_MAX_ACQUISITION_ATTEMPTS = 2 as const;

export interface IssueAsPrdExtraReviewDeps {
  prdIdentity(input: {
    parent: GitHubIssueRecord;
    queueLabel: string;
  }): ExtraReviewPrdArtifactIdentity;
  makeRound(input: {
    roundNumber: 1;
    accumulationHeadSha: string;
  }): ExtraReviewRoundArtifactIdentity & { number: 1 };
  writeReviewInputs(input: {
    parent: GitHubIssueRecord;
    parentContext: NormalizedParentContext;
    prd: ExtraReviewPrdArtifactIdentity;
    round: ExtraReviewRoundArtifactIdentity & { number: 1 };
    originalReviewBaseArg: string;
    resolvedReviewBaseSha: string;
    reviewedHeadSha: string;
  }): ExtraReviewSessionInputBundle;
  runSequentialSessions(
    input: {
      prd: ExtraReviewPrdArtifactIdentity;
      round: ExtraReviewRoundArtifactIdentity & { number: 1 };
      reviewInputs: ExtraReviewSessionInputBundle;
      completedPrdBranch: string;
      maxAcquisitionAttempts: 2;
    },
  ): Promise<SequentialExtraReviewSessionsResult>;
  completedPrdBranch(parent: GitHubIssueRecord): string;
}

export async function runIssueAsPrdExtraReview(input: {
  parent: GitHubIssueRecord;
  parentContext: NormalizedParentContext;
  queueLabel: string;
  originalForkSha: string;
  reviewBaseSha: string;
  accumulationHeadSha: string;
  roundNumber: 1;
}, deps: IssueAsPrdExtraReviewDeps): Promise<
  | { kind: "reviewed"; followupDrafts: PublishChildDraft[]; artifactPaths: string[] }
  | { kind: "acquisition_failed"; diagnostics: string[]; artifactPaths: string[] }
> {
  const prd = deps.prdIdentity({
    parent: input.parent,
    queueLabel: input.queueLabel,
  });
  const round = deps.makeRound({
    roundNumber: input.roundNumber,
    accumulationHeadSha: input.accumulationHeadSha,
  });
  const reviewInputs = deps.writeReviewInputs({
    parent: input.parent,
    parentContext: input.parentContext,
    prd,
    round,
    originalReviewBaseArg: input.originalForkSha,
    resolvedReviewBaseSha: input.reviewBaseSha,
    reviewedHeadSha: input.accumulationHeadSha,
  });

  const result = await deps.runSequentialSessions({
    prd,
    round,
    reviewInputs,
    completedPrdBranch: deps.completedPrdBranch(input.parent),
    maxAcquisitionAttempts: ISSUE_AS_PRD_EXTRA_REVIEW_MAX_ACQUISITION_ATTEMPTS,
  });
  const artifactPaths = result.artifactWrite.writtenFiles;

  if (result.stopReason !== "success" && result.stopReason !== "no_work") {
    return {
      kind: "acquisition_failed",
      diagnostics:
        result.stopDetails.length > 0
          ? result.stopDetails
          : [`extra review stopped with ${result.stopReason}`],
      artifactPaths,
    };
  }

  const parsed = result.outputs.issueDecomposer?.parsed;
  if (!parsed || parsed.kind !== "followup_issues") {
    return {
      kind: "acquisition_failed",
      diagnostics: ["Issue decomposer output was missing or invalid after review sessions."],
      artifactPaths,
    };
  }
  if (parsed.status === "needs_human_review") {
    return {
      kind: "acquisition_failed",
      diagnostics: [parsed.needs_human_review_reason || parsed.summary],
      artifactPaths,
    };
  }

  return {
    kind: "reviewed",
    followupDrafts:
      parsed.status === "issues"
        ? parsed.issues.map((draft) => ({
            title: draft.title,
            body: draft.body,
            priority: draft.priority,
            files: draft.files,
            dedupeKey: draft.dedupe_key,
            source: "review_followup" as const,
          }))
        : [],
    artifactPaths,
  };
}
