export interface RefreshGitDeps {
  readAccumulationHeads(input: {
    accumulationBranch: string;
  }): Promise<{ localHeadSha: string; remoteHeadSha: string }> | {
    localHeadSha: string;
    remoteHeadSha: string;
  };
  fetchMainline(input: { mainlineRef: string }): Promise<string> | string;
  createDiagnosticCheckpoint(input: {
    branchName: string;
    sourceSha: string;
  }): Promise<void> | void;
  rebaseAccumulationOntoMainline(input: {
    accumulationBranch: string;
    ontoSha: string;
  }): Promise<{ ok: true } | { ok: false; stderr: string }> | { ok: true } | { ok: false; stderr: string };
  abortRebase(input: { accumulationBranch: string }): Promise<void> | void;
  resetAccumulationToRef(input: {
    accumulationBranch: string;
    targetRef: string;
  }): Promise<void> | void;
  pushAccumulationWithLease(input: {
    accumulationBranch: string;
    expectedRemoteSha: string;
  }): Promise<void> | void;
  revParse(ref: string): Promise<string> | string;
}

export async function refreshAccumulationBeforeReview(input: {
  accumulationBranch: string;
  mainlineRef: string;
  originalForkSha: string;
  currentReviewBaseSha: string;
}, deps: RefreshGitDeps): Promise<
  | { kind: "unchanged"; accumulationHeadSha: string; reviewBaseSha: string; fetchedMainlineSha: string }
  | {
      kind: "rebased";
      accumulationHeadSha: string;
      reviewBaseSha: string;
      fetchedMainlineSha: string;
      diagnosticCheckpoint: string;
    }
  | {
      kind: "conflict";
      accumulationHeadSha: string;
      reviewBaseSha: string;
      attemptedMainlineSha: string;
      diagnosticCheckpoint: string;
      diagnostics: string[];
    }
> {
  void input.originalForkSha;
  const heads = await deps.readAccumulationHeads({
    accumulationBranch: input.accumulationBranch,
  });
  const fetchedMainlineSha = await deps.fetchMainline({ mainlineRef: input.mainlineRef });
  if (fetchedMainlineSha === input.currentReviewBaseSha) {
    return {
      kind: "unchanged",
      accumulationHeadSha: heads.localHeadSha,
      reviewBaseSha: input.currentReviewBaseSha,
      fetchedMainlineSha,
    };
  }

  const preRebaseHead = heads.localHeadSha;
  const diagnosticCheckpoint = buildPreReviewDiagnosticBranch(
    input.accumulationBranch,
    preRebaseHead,
  );

  await deps.createDiagnosticCheckpoint({
    branchName: diagnosticCheckpoint,
    sourceSha: preRebaseHead,
  });

  const rebase = await deps.rebaseAccumulationOntoMainline({
    accumulationBranch: input.accumulationBranch,
    ontoSha: fetchedMainlineSha,
  });
  if (!rebase.ok) {
    await deps.abortRebase({ accumulationBranch: input.accumulationBranch });
    let restoredHead = await deps.revParse(input.accumulationBranch);
    if (restoredHead !== preRebaseHead) {
      await deps.resetAccumulationToRef({
        accumulationBranch: input.accumulationBranch,
        targetRef: diagnosticCheckpoint,
      });
      restoredHead = await deps.revParse(input.accumulationBranch);
    }
    if (restoredHead !== preRebaseHead) {
      throw new Error(
        `Rebase abort did not restore ${input.accumulationBranch} to ${preRebaseHead}.`,
      );
    }
    return {
      kind: "conflict",
      accumulationHeadSha: preRebaseHead,
      reviewBaseSha: input.currentReviewBaseSha,
      attemptedMainlineSha: fetchedMainlineSha,
      diagnosticCheckpoint,
      diagnostics: [sanitizeGitStderr(rebase.stderr)],
    };
  }

  await deps.pushAccumulationWithLease({
    accumulationBranch: input.accumulationBranch,
    expectedRemoteSha: heads.remoteHeadSha,
  });
  return {
    kind: "rebased",
    accumulationHeadSha: await deps.revParse(input.accumulationBranch),
    reviewBaseSha: fetchedMainlineSha,
    fetchedMainlineSha,
    diagnosticCheckpoint,
  };
}

export async function observeTerminalMainline(input: {
  mainlineRef: string;
  fullParentReviewBaseSha: string;
  preReviewConflict: boolean;
}, deps: Pick<RefreshGitDeps, "fetchMainline" | "revParse">): Promise<{
  observedMainlineSha: string;
  rebaseNeeded: boolean;
}> {
  void deps.revParse;
  const observedMainlineSha = await deps.fetchMainline({ mainlineRef: input.mainlineRef });
  return {
    observedMainlineSha,
    rebaseNeeded:
      input.preReviewConflict || observedMainlineSha !== input.fullParentReviewBaseSha,
  };
}

export function buildPreReviewDiagnosticBranch(
  accumulationBranch: string,
  preRebaseHead: string,
): string {
  return `${accumulationBranch}-pre-review-${preRebaseHead.slice(0, 12)}`;
}

function sanitizeGitStderr(stderr: string): string {
  return stderr
    .replace(
      /\bhttps?:\/\/([^/\s:@]+):([^/\s@]+)@/gi,
      (_match, user: string) => `https://${user}:[REDACTED]@`,
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+\b/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .slice(0, 2000);
}
