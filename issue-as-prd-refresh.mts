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

export interface MainlineRefreshJournal {
  preRebaseAccumulationSha: string;
  targetMainlineSha: string;
  candidateSha: string;
}

export type ContinuousMainlineRefreshResult =
  | {
      kind: "unchanged" | "refreshed";
      accumulationHeadSha: string;
      attemptedMainlineSha: string;
    }
  | {
      kind: "diverged";
      accumulationHeadSha: string;
      attemptedMainlineSha: string;
      diagnostics: string[];
    };

export interface ContinuousMainlineRefreshDeps {
  readAccumulationHeads(input: {
    accumulationBranch: string;
  }): Promise<{ localHeadSha: string; remoteHeadSha: string }> | {
    localHeadSha: string;
    remoteHeadSha: string;
  };
  fetchMainline(input: { mainlineRef: string }): Promise<string> | string;
  isAncestor(input: {
    ancestorSha: string;
    descendantSha: string;
  }): Promise<boolean> | boolean;
  buildDeterministicCandidate(input: {
    accumulationBranch: string;
    preRebaseAccumulationSha: string;
    targetMainlineSha: string;
  }): Promise<
    | { kind: "candidate"; candidateSha: string }
    | { kind: "conflict"; diagnostics: string[] }
    | { kind: "failure"; diagnostics: string[] }
  >;
  runRebaseAgent(input: {
    accumulationBranch: string;
    preRebaseAccumulationSha: string;
    targetMainlineSha: string;
  }): Promise<
    | {
        kind: "resolved";
        preRebaseAccumulationSha: string;
        targetMainlineSha: string;
        candidateSha: string;
      }
    | { kind: "unresolved"; diagnostics: string[] }
    | { kind: "invalid"; diagnostics: string[] }
  >;
  verifyCandidate(input: {
    candidateSha: string;
    targetMainlineSha: string;
    validation: "structural" | "full";
  }): Promise<{ ok: true } | { ok: false; diagnostics: string[] }>;
  verifyPreservedCheckpoint(input: {
    accumulationBranch: string;
    expectedSha: string;
  }): Promise<{ ok: true } | { ok: false; diagnostics: string[] }>;
  persistJournal(journal: MainlineRefreshJournal | null): Promise<void>;
  promoteCandidate(input: {
    accumulationBranch: string;
    preRebaseAccumulationSha: string;
    candidateSha: string;
  }): Promise<void>;
}

export async function refreshAccumulationContinuously(input: {
  accumulationBranch: string;
  mainlineRef: string;
  accumulationHeadSha: string;
}, deps: ContinuousMainlineRefreshDeps): Promise<ContinuousMainlineRefreshResult> {
  const heads = await deps.readAccumulationHeads({
    accumulationBranch: input.accumulationBranch,
  });
  if (
    heads.localHeadSha !== input.accumulationHeadSha ||
    heads.remoteHeadSha !== input.accumulationHeadSha
  ) {
    throw new Error(
      `Refresh requires verified accumulation checkpoint ${input.accumulationHeadSha}; local=${heads.localHeadSha} remote=${heads.remoteHeadSha}.`,
    );
  }

  // One trigger observes exactly one freshly fetched mainline tip. Every
  // later decision, including the agent path, stays bound to this SHA.
  const targetMainlineSha = await deps.fetchMainline({ mainlineRef: input.mainlineRef });
  if (await deps.isAncestor({
    ancestorSha: targetMainlineSha,
    descendantSha: input.accumulationHeadSha,
  })) {
    return {
      kind: "unchanged",
      accumulationHeadSha: input.accumulationHeadSha,
      attemptedMainlineSha: targetMainlineSha,
    };
  }

  const deterministic = await deps.buildDeterministicCandidate({
    accumulationBranch: input.accumulationBranch,
    preRebaseAccumulationSha: input.accumulationHeadSha,
    targetMainlineSha,
  });
  if (deterministic.kind === "failure") {
    throw new Error(
      `Deterministic mainline refresh failed: ${sanitizeRefreshDiagnostics(deterministic.diagnostics).join("; ")}`,
    );
  }
  if (deterministic.kind === "candidate") {
    const verified = await deps.verifyCandidate({
      candidateSha: deterministic.candidateSha,
      targetMainlineSha,
      validation: "structural",
    });
    if (!verified.ok) {
      return divergedResult({
        accumulationBranch: input.accumulationBranch,
        accumulationHeadSha: input.accumulationHeadSha,
        targetMainlineSha,
        diagnostics: verified.diagnostics,
        deps,
      });
    }
    await journalAndPromote({
      accumulationBranch: input.accumulationBranch,
      preRebaseAccumulationSha: input.accumulationHeadSha,
      targetMainlineSha,
      candidateSha: deterministic.candidateSha,
      deps,
    });
    return {
      kind: "refreshed",
      accumulationHeadSha: deterministic.candidateSha,
      attemptedMainlineSha: targetMainlineSha,
    };
  }

  let agent:
    | Awaited<ReturnType<ContinuousMainlineRefreshDeps["runRebaseAgent"]>>
    | { kind: "invalid"; diagnostics: string[] };
  try {
    agent = await deps.runRebaseAgent({
      accumulationBranch: input.accumulationBranch,
      preRebaseAccumulationSha: input.accumulationHeadSha,
      targetMainlineSha,
    });
  } catch (error) {
    agent = {
      kind: "invalid",
      diagnostics: [
        `Rebase agent invocation failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (agent.kind !== "resolved") {
    return divergedResult({
      accumulationBranch: input.accumulationBranch,
      accumulationHeadSha: input.accumulationHeadSha,
      targetMainlineSha,
      diagnostics: [...deterministic.diagnostics, ...agent.diagnostics],
      deps,
    });
  }
  if (
    agent.preRebaseAccumulationSha !== input.accumulationHeadSha ||
    agent.targetMainlineSha !== targetMainlineSha
  ) {
    return divergedResult({
      accumulationBranch: input.accumulationBranch,
      accumulationHeadSha: input.accumulationHeadSha,
      targetMainlineSha,
      diagnostics: [
        ...deterministic.diagnostics,
        "Rebase agent result did not bind to the requested checkpoint and mainline target.",
      ],
      deps,
    });
  }

  const verified = await deps.verifyCandidate({
    candidateSha: agent.candidateSha,
    targetMainlineSha,
    validation: "full",
  });
  if (!verified.ok) {
    return divergedResult({
      accumulationBranch: input.accumulationBranch,
      accumulationHeadSha: input.accumulationHeadSha,
      targetMainlineSha,
      diagnostics: [...deterministic.diagnostics, ...verified.diagnostics],
      deps,
    });
  }
  await journalAndPromote({
    accumulationBranch: input.accumulationBranch,
    preRebaseAccumulationSha: input.accumulationHeadSha,
    targetMainlineSha,
    candidateSha: agent.candidateSha,
    deps,
  });
  return {
    kind: "refreshed",
    accumulationHeadSha: agent.candidateSha,
    attemptedMainlineSha: targetMainlineSha,
  };
}

export interface MainlineRefreshRecoveryDeps {
  readAccumulationHeads(input: {
    accumulationBranch: string;
  }): Promise<{ localHeadSha: string; remoteHeadSha: string }> | {
    localHeadSha: string;
    remoteHeadSha: string;
  };
  updateLocalAccumulation(input: {
    accumulationBranch: string;
    expectedCurrentSha: string;
    targetSha: string;
  }): Promise<void> | void;
  persistJournal(journal: null): Promise<void>;
}

export async function recoverMainlineRefreshJournal(input: {
  accumulationBranch: string;
  journal: MainlineRefreshJournal;
}, deps: MainlineRefreshRecoveryDeps): Promise<{
  kind: "completed" | "abandoned";
  accumulationHeadSha: string;
}> {
  const heads = await deps.readAccumulationHeads({
    accumulationBranch: input.accumulationBranch,
  });
  const { preRebaseAccumulationSha, candidateSha } = input.journal;
  const allowed = new Set([preRebaseAccumulationSha, candidateSha]);
  if (!allowed.has(heads.localHeadSha) || !allowed.has(heads.remoteHeadSha)) {
    throw new Error(
      `Refresh journal cannot own local=${heads.localHeadSha} remote=${heads.remoteHeadSha}; expected ${preRebaseAccumulationSha} or ${candidateSha}.`,
    );
  }

  if (heads.remoteHeadSha === candidateSha) {
    if (heads.localHeadSha !== candidateSha) {
      await deps.updateLocalAccumulation({
        accumulationBranch: input.accumulationBranch,
        expectedCurrentSha: heads.localHeadSha,
        targetSha: candidateSha,
      });
    }
    await deps.persistJournal(null);
    return { kind: "completed", accumulationHeadSha: candidateSha };
  }

  if (heads.localHeadSha !== preRebaseAccumulationSha) {
    await deps.updateLocalAccumulation({
      accumulationBranch: input.accumulationBranch,
      expectedCurrentSha: heads.localHeadSha,
      targetSha: preRebaseAccumulationSha,
    });
  }
  await deps.persistJournal(null);
  return { kind: "abandoned", accumulationHeadSha: preRebaseAccumulationSha };
}

async function journalAndPromote(input: {
  accumulationBranch: string;
  preRebaseAccumulationSha: string;
  targetMainlineSha: string;
  candidateSha: string;
  deps: ContinuousMainlineRefreshDeps;
}): Promise<void> {
  await input.deps.persistJournal({
    preRebaseAccumulationSha: input.preRebaseAccumulationSha,
    targetMainlineSha: input.targetMainlineSha,
    candidateSha: input.candidateSha,
  });
  await input.deps.promoteCandidate({
    accumulationBranch: input.accumulationBranch,
    preRebaseAccumulationSha: input.preRebaseAccumulationSha,
    candidateSha: input.candidateSha,
  });
  await input.deps.persistJournal(null);
}

async function divergedResult(input: {
  accumulationBranch: string;
  accumulationHeadSha: string;
  targetMainlineSha: string;
  diagnostics: string[];
  deps: ContinuousMainlineRefreshDeps;
}): Promise<ContinuousMainlineRefreshResult> {
  const preserved = await input.deps.verifyPreservedCheckpoint({
    accumulationBranch: input.accumulationBranch,
    expectedSha: input.accumulationHeadSha,
  });
  if (!preserved.ok) {
    throw new Error(
      `Could not verify preserved accumulation checkpoint: ${sanitizeRefreshDiagnostics(preserved.diagnostics).join("; ")}`,
    );
  }
  return {
    kind: "diverged",
    accumulationHeadSha: input.accumulationHeadSha,
    attemptedMainlineSha: input.targetMainlineSha,
    diagnostics: sanitizeRefreshDiagnostics(input.diagnostics),
  };
}

export function sanitizeRefreshDiagnostics(diagnostics: readonly string[]): string[] {
  return diagnostics
    .map((diagnostic) => sanitizeGitStderr(diagnostic).trim())
    .filter(Boolean)
    .slice(0, 20);
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
