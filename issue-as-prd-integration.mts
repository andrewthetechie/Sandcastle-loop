import type { GitHubIssueRecord } from "./github-issues.mts";

export interface ChildIntegrationInput {
  childNumber: number;
  accumulationBranch: string;
  reviewedBaseSha: string;
  approvedHeadSha: string;
}

export type ChildIntegrationRecoveryPoint =
  | "after_local_fast_forward"
  | "after_remote_push"
  | "after_child_close";

export interface ChildIntegrationDeps {
  readAccumulationHeads(input: {
    accumulationBranch: string;
  }): Promise<{ localHeadSha: string; remoteHeadSha: string }> | {
    localHeadSha: string;
    remoteHeadSha: string;
  };
  isAncestor(input: {
    ancestorSha: string;
    descendantSha: string;
  }): Promise<boolean> | boolean;
  fastForwardLocalAccumulation(input: {
    accumulationBranch: string;
    targetSha: string;
  }): Promise<void> | void;
  pushAccumulationBranch(input: {
    accumulationBranch: string;
    expectedHeadSha: string;
  }): Promise<void> | void;
  closeChildIssue(input: {
    childNumber: number;
    comment: string;
  }): Promise<"closed" | "already_closed"> | "closed" | "already_closed";
  readChildIssue(input: {
    childNumber: number;
  }): Promise<Pick<GitHubIssueRecord, "state">> | Pick<GitHubIssueRecord, "state">;
}

export async function integrateApprovedChild(
  input: ChildIntegrationInput,
  deps: ChildIntegrationDeps,
): Promise<
  | { ok: true; accumulationHeadSha: string; recoveredFrom: ChildIntegrationRecoveryPoint | null }
  | {
      ok: false;
      reason:
        | "reviewed_base_mismatch"
        | "non_descendant"
        | "push_failed"
        | "remote_verification_failed"
        | "close_failed";
      diagnostics: string[];
    }
> {
  const diagnostics: string[] = [];
  const heads = await deps.readAccumulationHeads({
    accumulationBranch: input.accumulationBranch,
  });

  const localAtApproved = heads.localHeadSha === input.approvedHeadSha;
  const remoteAtApproved = heads.remoteHeadSha === input.approvedHeadSha;
  const bothAtApproved = localAtApproved && remoteAtApproved;

  if (!bothAtApproved) {
    const localAtBase = heads.localHeadSha === input.reviewedBaseSha;
    const remoteAtBase = heads.remoteHeadSha === input.reviewedBaseSha;
    const baseMatches = localAtBase && remoteAtBase;
    const resumablePartial =
      (localAtApproved && remoteAtBase) ||
      (remoteAtApproved && localAtBase);

    // Recoverable divergence: local sits exactly at the reviewed base (the clean
    // pre-integration state this loop exclusively owns) but the remote
    // accumulation branch has fallen strictly behind it — e.g. a push that never
    // landed after an interrupted run, or a pre-review rebase whose push was
    // lost. The remote is then a clean fast-forward ancestor of local, so
    // advancing it to the approved head (a descendant) loses no history and
    // clobbers nothing. Without this, a merely-behind remote is misread as a
    // hard conflict and permanently strands the parent. A genuinely divergent
    // remote (not an ancestor of the reviewed base) still fails below.
    const remoteBehindBase =
      localAtBase &&
      !remoteAtBase &&
      !remoteAtApproved &&
      (await deps.isAncestor({
        ancestorSha: heads.remoteHeadSha,
        descendantSha: input.reviewedBaseSha,
      }));

    if (!baseMatches && !resumablePartial && !remoteBehindBase) {
      return {
        ok: false,
        reason: "reviewed_base_mismatch",
        diagnostics: [
          `Accumulation branch '${input.accumulationBranch}' heads do not match reviewed base ${input.reviewedBaseSha}: local=${heads.localHeadSha} remote=${heads.remoteHeadSha}.`,
        ],
      };
    }
  }

  let recoveredFrom: ChildIntegrationRecoveryPoint | null = null;
  if (bothAtApproved) {
    recoveredFrom = "after_remote_push";
  } else if (localAtApproved && heads.remoteHeadSha === input.reviewedBaseSha) {
    recoveredFrom = "after_local_fast_forward";
  } else if (heads.localHeadSha === input.reviewedBaseSha && remoteAtApproved) {
    recoveredFrom = "after_remote_push";
  }

  if (!remoteAtApproved) {
    if (!localAtApproved) {
      const descendant = await safeStep(
        diagnostics,
        async () =>
          deps.isAncestor({
            ancestorSha: input.reviewedBaseSha,
            descendantSha: input.approvedHeadSha,
          }),
        "non_descendant",
        "Git ancestry check failed",
      );
      if (descendant === "failed") {
        return { ok: false, reason: "non_descendant", diagnostics };
      }
      if (!descendant) {
        diagnostics.push(
          `Approved head ${input.approvedHeadSha} is not a descendant of reviewed base ${input.reviewedBaseSha}.`,
        );
        return { ok: false, reason: "non_descendant", diagnostics };
      }

      const fastForwarded = await safeStep(
        diagnostics,
        async () =>
          deps.fastForwardLocalAccumulation({
            accumulationBranch: input.accumulationBranch,
            targetSha: input.approvedHeadSha,
          }),
        "push_failed",
        "Local fast-forward failed",
      );
      if (fastForwarded === "failed") {
        return { ok: false, reason: "push_failed", diagnostics };
      }
      recoveredFrom ??= null;
    }

    const pushed = await safeStep(
      diagnostics,
      async () =>
        deps.pushAccumulationBranch({
          accumulationBranch: input.accumulationBranch,
          expectedHeadSha: input.approvedHeadSha,
        }),
      "push_failed",
      "Push failed",
    );
    if (pushed === "failed") {
      return { ok: false, reason: "push_failed", diagnostics };
    }

    const verifiedHeads = await safeStep(
      diagnostics,
      async () =>
        deps.readAccumulationHeads({
          accumulationBranch: input.accumulationBranch,
        }),
      "remote_verification_failed",
      "Remote verification read failed",
    );
    if (verifiedHeads === "failed") {
      return { ok: false, reason: "remote_verification_failed", diagnostics };
    }
    if (verifiedHeads.remoteHeadSha !== input.approvedHeadSha) {
      diagnostics.push(
        `Remote accumulation head mismatch after push: expected ${input.approvedHeadSha}, observed ${verifiedHeads.remoteHeadSha}.`,
      );
      return { ok: false, reason: "remote_verification_failed", diagnostics };
    }
  }

  const issueBeforeOrAfterClose = await closeAndVerifyChild(
    input,
    deps,
    diagnostics,
  );
  if (!issueBeforeOrAfterClose.ok) {
    return issueBeforeOrAfterClose;
  }

  return {
    ok: true,
    accumulationHeadSha: input.approvedHeadSha,
    recoveredFrom:
      issueBeforeOrAfterClose.wasAlreadyClosed
        ? "after_child_close"
        : recoveredFrom,
  };
}

async function closeAndVerifyChild(
  input: ChildIntegrationInput,
  deps: ChildIntegrationDeps,
  diagnostics: string[],
): Promise<
  | { ok: true; wasAlreadyClosed: boolean }
  | { ok: false; reason: "close_failed"; diagnostics: string[] }
> {
  const closeResult = await safeStep(
    diagnostics,
    async () =>
      deps.closeChildIssue({
        childNumber: input.childNumber,
        comment: checkpointComment(input.approvedHeadSha),
      }),
    "close_failed",
    "Issue close failed",
  );
  if (closeResult === "failed") {
    return { ok: false, reason: "close_failed", diagnostics };
  }

  const verified = await safeStep(
    diagnostics,
    async () => deps.readChildIssue({ childNumber: input.childNumber }),
    "close_failed",
    "Issue verification read failed",
  );
  if (verified === "failed") {
    return { ok: false, reason: "close_failed", diagnostics };
  }
  if (verified.state !== "CLOSED") {
    diagnostics.push(
      `Child issue #${input.childNumber} remained ${verified.state} after close attempt.`,
    );
    return { ok: false, reason: "close_failed", diagnostics };
  }
  return { ok: true, wasAlreadyClosed: closeResult === "already_closed" };
}

async function safeStep<T>(
  diagnostics: string[],
  run: () => Promise<T> | T,
  _reason:
    | "non_descendant"
    | "push_failed"
    | "remote_verification_failed"
    | "close_failed",
  label: string,
): Promise<T | "failed"> {
  try {
    return await run();
  } catch (error) {
    diagnostics.push(`${label}: ${sanitizeDiagnostic(error)}`);
    return "failed";
  }
}

function checkpointComment(approvedHeadSha: string): string {
  return `Checkpointed approved child into accumulation branch at ${approvedHeadSha}.`;
}

function sanitizeDiagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(
      /\bhttps?:\/\/([^/\s:@]+):([^/\s@]+)@/gi,
      (_match, user: string) => `https://${user}:[REDACTED]@`,
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+\b/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .slice(0, 1000);
}
