import type { GitHubIssueRecord } from "./github-issues.mts";
import type {
  InitialDecompositionAcquisition,
  InitialIssueDecomposition,
} from "./issue-as-prd-contracts.mts";
import {
  decideDrainState,
  selectNextChild,
} from "./issue-as-prd-queue-state.mts";
import type { ChildPublicationResult, PublishChildDraft } from "./issue-as-prd-children.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";
import {
  nextParentState,
  type IssueAsPrdParentState,
  type ParentPhase,
} from "./issue-as-prd-state.mts";
import type { ChildIntegrationInput } from "./issue-as-prd-integration.mts";
import type { PerBranchEngineOutcome } from "./per-branch-engine.mts";
import type { ReadinessBatchResult } from "./subtask-readiness.mts";
import type {
  AggregateGate,
  AggregateValidationFailure,
} from "./issue-as-prd-validation.mts";

export type ParentRunResult =
  | {
      kind: "clean_delivery";
      accumulationHeadSha: string;
      observedMainlineSha: string;
      rebaseNeeded: boolean;
    }
  | {
      kind: "partial_delivery";
      accumulationHeadSha: string;
      observedMainlineSha: string;
      rebaseNeeded: boolean;
      stuckChildNumber: number;
    }
  | {
      // The parent's deliverable already exists on the accumulation base with
      // a host-verified empty diff: there is nothing to implement or review.
      // The caller should close the parent with the evidence instead of
      // marking it stuck.
      kind: "parent_already_complete";
      accumulationHeadSha: string;
      evidence: string;
    }
  | {
      kind: "parent_stuck";
      accumulationHeadSha: string;
      reason: string;
      diagnostics: string[];
    }
  | { kind: "ownership_ambiguous"; reason: string; diagnostics: string[] };

export interface IssueAsPrdOrchestratorDeps {
  now(): string;
  verifyOwnership(input: {
    parent: GitHubIssueRecord;
    state: IssueAsPrdParentState;
  }): Promise<{ ok: true } | { ok: false; diagnostics: string[] }>;
  readAccumulationHead(input: {
    accumulationBranch: string;
  }): Promise<string>;
  acquireInitialDecomposition(input: {
    parent: GitHubIssueRecord;
    context: NormalizedParentContext;
  }): Promise<InitialDecompositionAcquisition>;
  persistState(state: IssueAsPrdParentState): Promise<void>;
  publishChildren(input: {
    parent: GitHubIssueRecord;
    drafts: readonly PublishChildDraft[];
    queueLabel: string;
  }): Promise<ChildPublicationResult>;
  listChildren(input: {
    parent: GitHubIssueRecord;
    queueLabel: string;
  }): Promise<GitHubIssueRecord[]>;
  readiness(input: {
    parentContext: NormalizedParentContext;
    children: readonly GitHubIssueRecord[];
    siblingSummaries: readonly { number: number; title: string; body: string }[];
    accumulationSha: string;
  }): Promise<ReadinessBatchResult>;
  runChildEngine(input: {
    child: GitHubIssueRecord;
    accumulationSha: string;
    source: "initial" | "review_followup";
  }): Promise<PerBranchEngineOutcome>;
  runDirectParentEngine(input: {
    parent: GitHubIssueRecord;
    context: NormalizedParentContext;
    accumulationBranch: string;
    accumulationSha: string;
  }): Promise<PerBranchEngineOutcome>;
  verifyInitialAlreadySatisfied(input: {
    child: GitHubIssueRecord;
    reviewedBaseSha: string;
    headSha: string;
  }): Promise<{ ok: true; empty: boolean; evidence: string } | { ok: false; diagnostics: string[] }>;
  closeAlreadySatisfiedChild(input: {
    child: GitHubIssueRecord;
    evidence: string;
  }): Promise<void>;
  markChildStuck(input: {
    child: GitHubIssueRecord;
    reason: string;
  }): Promise<void>;
  integrateChild(input: ChildIntegrationInput): Promise<
    | { ok: true; accumulationHeadSha: string; recoveredFrom: string | null }
    | { ok: false; reason: string; diagnostics: string[] }
  >;
  refreshBeforeReview(input: {
    accumulationBranch: string;
    mainlineRef: string;
    originalForkSha: string;
    currentReviewBaseSha: string;
  }): Promise<
    | {
        kind: "unchanged";
        accumulationHeadSha: string;
        reviewBaseSha: string;
        fetchedMainlineSha: string;
      }
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
  >;
  runAggregateValidation(input: {
    gate: AggregateGate;
    commands: readonly string[];
    accumulationSha: string;
    repairAlreadyUsed: boolean;
  }): Promise<
    | { kind: "green" }
    | { kind: "repaired"; childNumber: number; accumulationSha: string }
    | {
        kind: "repair_child_stuck";
        childNumber: number;
        failure: AggregateValidationFailure;
        diagnostics: string[];
      }
    | { kind: "parent_failure"; failure: AggregateValidationFailure; diagnostics: string[] }
  >;
  runFullParentExtraReview(input: {
    parent: GitHubIssueRecord;
    parentContext: NormalizedParentContext;
    queueLabel: string;
    originalForkSha: string;
    reviewBaseSha: string;
    accumulationHeadSha: string;
    roundNumber: 1;
  }): Promise<
    | { kind: "reviewed"; followupDrafts: PublishChildDraft[]; artifactPaths: string[] }
    | { kind: "acquisition_failed"; diagnostics: string[]; artifactPaths: string[] }
  >;
  observeTerminalMainline(input: {
    mainlineRef: string;
    fullParentReviewBaseSha: string;
    preReviewConflict: boolean;
  }): Promise<{ observedMainlineSha: string; rebaseNeeded: boolean }>;
  mainlineRef: string;
  preReviewValidationCommands: readonly string[];
  preDeliveryValidationCommands: readonly string[];
}

export async function runIssueAsPrdParent(input: {
  parent: GitHubIssueRecord;
  state: IssueAsPrdParentState;
  normalizedContext: NormalizedParentContext;
}, deps: IssueAsPrdOrchestratorDeps): Promise<ParentRunResult> {
  if (input.state.phase === "failed" || input.state.phase === "delivered") {
    // A terminal phase matches no phase block below; without this guard it
    // would fall through to the delivery tail and mislabel a finished (or
    // failed) parent as a fresh clean delivery.
    return {
      kind: "ownership_ambiguous",
      reason: `Parent #${input.parent.number} arrived with terminal phase '${input.state.phase}'; the loop cannot resume a terminal parent.`,
      diagnostics: [
        "Requeue the parent (remove its agent-stuck label) or run recover-backlog-v3-issues.mts before retrying.",
      ],
    };
  }

  const ownership = await deps.verifyOwnership({
    parent: input.parent,
    state: input.state,
  });
  if (!ownership.ok) {
    return {
      kind: "ownership_ambiguous",
      reason: `Recorded phase '${input.state.phase}' disagrees with observed parent state.`,
      diagnostics: ownership.diagnostics,
    };
  }

  let state = input.state;
  let accumulationHeadSha = await deps.readAccumulationHead({
    accumulationBranch: state.accumulationBranch,
  });
  let partialCauseChildNumber = state.partialCauseChildNumber;

  if (state.phase === "claimed") {
    // Children are published to GitHub before the 'decomposed' transition is
    // persisted, so a claimed parent that already has queue-labelled children
    // is an interrupted run, not a fresh one. Resume from 'decomposed' rather
    // than re-running decomposition (which would spend a decomposer session
    // and could draft a divergent second set of children).
    const existingChildren = await deps.listChildren({
      parent: input.parent,
      queueLabel: state.queueLabel,
    });
    if (existingChildren.length > 0) {
      state = await transition(state, deps, { phase: "decomposed" });
    }
  }

  if (state.phase === "claimed") {
    const prepared = await prepareInitialWorkFromDecomposition({
      parent: input.parent,
      context: input.normalizedContext,
      state,
      accumulationHeadSha,
      deps,
    });
    if (prepared.kind === "terminal") return prepared.result;
    state = prepared.state;
    accumulationHeadSha = prepared.accumulationHeadSha;
  }

  if (state.phase === "decomposed") {
    const children = await deps.listChildren({
      parent: input.parent,
      queueLabel: state.queueLabel,
    });
    const readiness = await deps.readiness({
      parentContext: input.normalizedContext,
      children,
      siblingSummaries: siblingSummaries(children),
      accumulationSha: accumulationHeadSha,
    });
    if (readiness.kind === "parent_failure") {
      return parentStuck(
        accumulationHeadSha,
        "initial_child_readiness_failed",
        readiness.diagnostics,
      );
    }
    state = await transition(state, deps, { phase: "initial_ready" });
  }

  let redecompositionAttempted = false;
  while (state.phase === "initial_ready") {
    const drained = await drainInitialChildren({
      parent: input.parent,
      context: input.normalizedContext,
      state,
      accumulationHeadSha,
      partialCauseChildNumber,
      deps,
    });
    if (drained.kind === "parent_stuck") return drained.result;
    if (drained.kind === "queue_starved") {
      // Every child was closed (duplicate, already satisfied, or left over
      // from an earlier incarnation) without any work landing. That is a
      // recoverable planning failure, not an implementation failure: retry
      // decomposition once before giving up on the parent.
      if (redecompositionAttempted) {
        return parentStuck(
          accumulationHeadSha,
          "initial_child_stuck_empty",
          [
            "Initial child queue drained to empty with no integrated work even after a recovery decomposition.",
          ],
        );
      }
      redecompositionAttempted = true;
      const prepared = await prepareInitialWorkFromDecomposition({
        parent: input.parent,
        context: input.normalizedContext,
        state,
        accumulationHeadSha,
        deps,
      });
      if (prepared.kind === "terminal") return prepared.result;
      state = prepared.state;
      accumulationHeadSha = prepared.accumulationHeadSha;
      continue;
    }
    accumulationHeadSha = drained.accumulationHeadSha;
    partialCauseChildNumber = drained.partialCauseChildNumber;
    state = drained.state;
  }

  if (state.phase === "initial_drained") {
    const refreshed = await deps.refreshBeforeReview({
      accumulationBranch: state.accumulationBranch,
      mainlineRef: deps.mainlineRef,
      originalForkSha: state.originalForkSha,
      currentReviewBaseSha: state.fullParentReviewBaseSha,
    });
    accumulationHeadSha = refreshed.accumulationHeadSha;
    state = await transition(state, deps, {
      fullParentReviewBaseSha: refreshed.reviewBaseSha,
      attemptedMainlineSha:
        refreshed.kind === "conflict" ? refreshed.attemptedMainlineSha : refreshed.fetchedMainlineSha,
      rebaseConflictDiagnostics:
        refreshed.kind === "conflict" ? refreshed.diagnostics : [],
      phase: "initial_drained",
    });

    const preReview = await deps.runAggregateValidation({
      gate: "pre_review",
      commands: deps.preReviewValidationCommands,
      accumulationSha: accumulationHeadSha,
      repairAlreadyUsed: state.aggregateValidationRepairs.pre_review === 1,
    });
    if (preReview.kind === "parent_failure") {
      return parentStuck(
        accumulationHeadSha,
        `aggregate_validation_${preReview.failure.gate}`,
        preReview.diagnostics,
      );
    }
    if (preReview.kind === "repair_child_stuck") {
      return finalizePartial(
        accumulationHeadSha,
        preReview.childNumber,
        state,
        deps,
      );
    }
    if (preReview.kind === "repaired") {
      accumulationHeadSha = preReview.accumulationSha;
      state = await transition(state, deps, {
        aggregateValidationRepairs: {
          ...state.aggregateValidationRepairs,
          pre_review: 1,
        },
      });
    }
    state = await transition(state, deps, { phase: "pre_review_ready" });
  }

  if (state.phase === "pre_review_ready") {
    const review = await deps.runFullParentExtraReview({
      parent: input.parent,
      parentContext: input.normalizedContext,
      queueLabel: state.queueLabel,
      originalForkSha: state.originalForkSha,
      reviewBaseSha: state.fullParentReviewBaseSha,
      accumulationHeadSha,
      roundNumber: 1,
    });
    if (review.kind === "acquisition_failed") {
      return parentStuck(
        accumulationHeadSha,
        "full_parent_review_acquisition_failed",
        review.diagnostics,
      );
    }

    state = await transition(state, deps, {
      completedExtraReviewRounds: 1,
      phase: "full_parent_reviewed",
    });

    if (review.followupDrafts.length > 0) {
      const publication = await deps.publishChildren({
        parent: input.parent,
        drafts: review.followupDrafts,
        queueLabel: state.queueLabel,
      });
      if (!publication.ok) {
        return parentStuck(
          accumulationHeadSha,
          "review_followup_publication_failed",
          publication.diagnostics,
        );
      }
      const readiness = await deps.readiness({
        parentContext: input.normalizedContext,
        children: publication.children,
        siblingSummaries: siblingSummaries(publication.children),
        accumulationSha: accumulationHeadSha,
      });
      if (readiness.kind === "parent_failure") {
        return parentStuck(
          accumulationHeadSha,
          "review_followup_readiness_failed",
          readiness.diagnostics,
        );
      }
      state = await transition(state, deps, {
        phase: "followups_ready",
      });
    } else {
      state = await transition(state, deps, {
        phase: "followups_drained",
      });
    }
  }

  if (state.phase === "followups_ready") {
    const drained = await drainFollowupChildren({
      parent: input.parent,
      context: input.normalizedContext,
      state,
      accumulationHeadSha,
      partialCauseChildNumber,
      deps,
    });
    if (drained.kind === "partial_delivery") {
      return await finalizePartial(
        drained.accumulationHeadSha,
        drained.stuckChildNumber,
        state,
        deps,
      );
    }
    if (drained.kind === "parent_stuck") return drained.result;
    accumulationHeadSha = drained.accumulationHeadSha;
    partialCauseChildNumber = drained.partialCauseChildNumber;
    state = drained.state;
  }

  if (state.phase === "followups_drained") {
    const preDelivery = await deps.runAggregateValidation({
      gate: "pre_delivery",
      commands: deps.preDeliveryValidationCommands,
      accumulationSha: accumulationHeadSha,
      repairAlreadyUsed: state.aggregateValidationRepairs.pre_delivery === 1,
    });
    if (preDelivery.kind === "parent_failure") {
      return parentStuck(
        accumulationHeadSha,
        `aggregate_validation_${preDelivery.failure.gate}`,
        preDelivery.diagnostics,
      );
    }
    if (preDelivery.kind === "repair_child_stuck") {
      return finalizePartial(
        accumulationHeadSha,
        preDelivery.childNumber,
        state,
        deps,
      );
    }
    if (preDelivery.kind === "repaired") {
      accumulationHeadSha = preDelivery.accumulationSha;
      state = await transition(state, deps, {
        aggregateValidationRepairs: {
          ...state.aggregateValidationRepairs,
          pre_delivery: 1,
        },
      });
    }
    state = await transition(state, deps, { phase: "pre_delivery_ready" });
  }

  const terminal = await deps.observeTerminalMainline({
    mainlineRef: deps.mainlineRef,
    fullParentReviewBaseSha: state.fullParentReviewBaseSha,
    preReviewConflict: state.rebaseConflictDiagnostics.length > 0,
  });
  state = await transition(state, deps, {
    latestMainlineShaAtDelivery: terminal.observedMainlineSha,
  });

  if (partialCauseChildNumber !== null) {
    return {
      kind: "partial_delivery",
      accumulationHeadSha,
      observedMainlineSha: terminal.observedMainlineSha,
      rebaseNeeded: terminal.rebaseNeeded,
      stuckChildNumber: partialCauseChildNumber,
    };
  }

  return {
    kind: "clean_delivery",
    accumulationHeadSha,
    observedMainlineSha: terminal.observedMainlineSha,
    rebaseNeeded: terminal.rebaseNeeded,
  };
}

type InitialWorkPreparation =
  | {
      kind: "prepared";
      state: IssueAsPrdParentState;
      accumulationHeadSha: string;
    }
  | { kind: "terminal"; result: ParentRunResult };

// Run one decomposition cycle for the parent: acquire the decomposition,
// publish + readiness-check children (phase -> initial_ready), or — when the
// decomposer reports no decomposable work — run the direct parent engine
// (phase -> initial_drained). Used from the fresh 'claimed' phase and again
// as recovery when the child queue starves without integrating any work.
async function prepareInitialWorkFromDecomposition(input: {
  parent: GitHubIssueRecord;
  context: NormalizedParentContext;
  state: IssueAsPrdParentState;
  accumulationHeadSha: string;
  deps: IssueAsPrdOrchestratorDeps;
}): Promise<InitialWorkPreparation> {
  const { deps } = input;
  let state = input.state;
  let accumulationHeadSha = input.accumulationHeadSha;

  const acquisition = await deps.acquireInitialDecomposition({
    parent: input.parent,
    context: input.context,
  });
  if (!acquisition.ok) {
    return terminal(
      parentStuck(
        accumulationHeadSha,
        "initial_decomposition_failed",
        acquisition.diagnostics,
      ),
    );
  }

  const result = acquisition.result;
  if (result.status === "issues") {
    const drafts = result.issues.map(initialDraftToPublishDraft);
    const publication = await deps.publishChildren({
      parent: input.parent,
      drafts,
      queueLabel: state.queueLabel,
    });
    if (!publication.ok) {
      return terminal(
        parentStuck(
          accumulationHeadSha,
          "initial_child_publication_failed",
          publication.diagnostics,
        ),
      );
    }
    state = await transition(state, deps, {
      phase: "decomposed",
    });
    const readiness = await deps.readiness({
      parentContext: input.context,
      children: publication.children,
      siblingSummaries: siblingSummaries(publication.children),
      accumulationSha: accumulationHeadSha,
    });
    if (readiness.kind === "parent_failure") {
      return terminal(
        parentStuck(
          accumulationHeadSha,
          "initial_child_readiness_failed",
          readiness.diagnostics,
        ),
      );
    }
    state = await transition(state, deps, { phase: "initial_ready" });
    return { kind: "prepared", state, accumulationHeadSha };
  }

  const direct = await deps.runDirectParentEngine({
    parent: input.parent,
    context: input.context,
    accumulationBranch: state.accumulationBranch,
    accumulationSha: accumulationHeadSha,
  });
  if (direct.kind === "approved") {
    accumulationHeadSha = direct.approvedHeadSha;
    state = await transition(state, deps, {
      phase: "initial_drained",
    });
    return { kind: "prepared", state, accumulationHeadSha };
  }
  if (direct.kind === "already_satisfied") {
    // Decomposer said there is no decomposable work AND the direct engine
    // found nothing to implement. If the host verifies the branch tree is
    // unchanged, the parent's deliverable already exists — complete, not
    // stuck.
    const verification = await deps.verifyInitialAlreadySatisfied({
      child: input.parent,
      reviewedBaseSha: direct.reviewedBaseSha || accumulationHeadSha,
      headSha: direct.headSha,
    });
    if (verification.ok && verification.empty) {
      return terminal({
        kind: "parent_already_complete",
        accumulationHeadSha,
        evidence: [direct.evidence, verification.evidence]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
    return terminal(
      parentStuck(
        accumulationHeadSha,
        "direct_parent_already_satisfied",
        verification.ok
          ? [
              "Direct parent run claimed already_satisfied but the branch tree is not empty.",
              direct.evidence,
            ]
          : verification.diagnostics,
      ),
    );
  }
  return terminal(
    parentStuck(
      accumulationHeadSha,
      `direct_parent_${direct.kind}`,
      direct.kind === "crashed" ? [direct.error] : [direct.lastFeedback],
    ),
  );
}

function terminal(result: ParentRunResult): InitialWorkPreparation {
  return { kind: "terminal", result };
}

async function drainInitialChildren(input: {
  parent: GitHubIssueRecord;
  context: NormalizedParentContext;
  state: IssueAsPrdParentState;
  accumulationHeadSha: string;
  partialCauseChildNumber: number | null;
  deps: IssueAsPrdOrchestratorDeps;
}): Promise<
  | { kind: "done"; accumulationHeadSha: string; partialCauseChildNumber: number | null; state: IssueAsPrdParentState }
  | { kind: "queue_starved" }
  | { kind: "parent_stuck"; result: ParentRunResult }
> {
  let state = input.state;
  let accumulationHeadSha = input.accumulationHeadSha;
  let partialCauseChildNumber = input.partialCauseChildNumber;
  while (true) {
    const children = await input.deps.listChildren({
      parent: input.parent,
      queueLabel: state.queueLabel,
    });
    const selection = selectNextChild({
      openIssues: children,
      queueLabel: state.queueLabel,
    });
    if (selection.kind === "none") {
      const drain = decideDrainState({
        openIssues: children,
        queueLabel: state.queueLabel,
        fullParentReviewBaseSha: state.fullParentReviewBaseSha,
        accumulationHeadSha,
      });
      if (drain.kind === "queue_starved_empty") {
        return { kind: "queue_starved" };
      }
      if (drain.kind === "parent_stuck_empty") {
        return {
          kind: "parent_stuck",
          result: parentStuck(
            accumulationHeadSha,
            "initial_child_stuck_empty",
            [
              `Initial drain produced no integrated reviewable work; stuck children: ${drain.openStuckNumbers
                .map((number) => `#${number}`)
                .join(", ")}.`,
            ],
          ),
        };
      }
      state = await transition(state, input.deps, { phase: "initial_drained", partialCauseChildNumber });
      return { kind: "done", accumulationHeadSha, partialCauseChildNumber, state };
    }

    const child = children.find((candidate) => candidate.number === selection.issue.number)!;
    const outcome = await input.deps.runChildEngine({
      child,
      accumulationSha: accumulationHeadSha,
      source: "initial",
    });
    if (outcome.kind === "approved") {
      const integrated = await input.deps.integrateChild({
        childNumber: child.number,
        accumulationBranch: state.accumulationBranch,
        reviewedBaseSha: outcome.reviewedBaseSha,
        approvedHeadSha: outcome.approvedHeadSha,
      });
      if (!integrated.ok) {
        return {
          kind: "parent_stuck",
          result: parentStuck(accumulationHeadSha, "initial_child_integration_failed", integrated.diagnostics),
        };
      }
      accumulationHeadSha = integrated.accumulationHeadSha;
      continue;
    }

    if (outcome.kind === "already_satisfied") {
      // already_satisfied engine outcomes carry an empty reviewedBaseSha
      // (the coder never reached review); verify against the accumulation
      // base the child was launched from instead.
      const verification = await input.deps.verifyInitialAlreadySatisfied({
        child,
        reviewedBaseSha: outcome.reviewedBaseSha || accumulationHeadSha,
        headSha: outcome.headSha,
      });
      if (verification.ok && verification.empty) {
        await input.deps.closeAlreadySatisfiedChild({
          child,
          evidence: verification.evidence,
        });
        continue;
      }

      const diagnostics = verification.ok
        ? [`Initial child #${child.number} claimed already_satisfied with non-empty diff.`]
        : verification.diagnostics;
      await input.deps.markChildStuck({
        child,
        reason: diagnostics.join("; "),
      });
      if (accumulationHeadSha === state.fullParentReviewBaseSha) {
        return {
          kind: "parent_stuck",
          result: parentStuck(accumulationHeadSha, "initial_child_stuck_empty", diagnostics),
        };
      }
      partialCauseChildNumber = child.number;
      state = await transition(state, input.deps, {
        phase: "initial_drained",
        partialCauseChildNumber,
      });
      return { kind: "done", accumulationHeadSha, partialCauseChildNumber, state };
    }

    const diagnostics =
      outcome.kind === "stuck" ? [outcome.lastFeedback] : [outcome.error];
    await input.deps.markChildStuck({
      child,
      reason: diagnostics.join("; "),
    });
    if (accumulationHeadSha === state.fullParentReviewBaseSha) {
      return {
        kind: "parent_stuck",
        result: parentStuck(accumulationHeadSha, "initial_child_stuck_empty", diagnostics),
      };
    }
    partialCauseChildNumber = child.number;
    state = await transition(state, input.deps, {
      phase: "initial_drained",
      partialCauseChildNumber,
    });
    return { kind: "done", accumulationHeadSha, partialCauseChildNumber, state };
  }
}

async function drainFollowupChildren(input: {
  parent: GitHubIssueRecord;
  context: NormalizedParentContext;
  state: IssueAsPrdParentState;
  accumulationHeadSha: string;
  partialCauseChildNumber: number | null;
  deps: IssueAsPrdOrchestratorDeps;
}): Promise<
  | { kind: "done"; accumulationHeadSha: string; partialCauseChildNumber: number | null; state: IssueAsPrdParentState }
  | { kind: "partial_delivery"; accumulationHeadSha: string; stuckChildNumber: number }
  | { kind: "parent_stuck"; result: ParentRunResult }
> {
  let state = input.state;
  let accumulationHeadSha = input.accumulationHeadSha;
  let partialCauseChildNumber = input.partialCauseChildNumber;

  while (true) {
    const children = await input.deps.listChildren({
      parent: input.parent,
      queueLabel: state.queueLabel,
    });
    const selection = selectNextChild({
      openIssues: children,
      queueLabel: state.queueLabel,
    });
    if (selection.kind === "none") {
      state = await transition(state, input.deps, { phase: "followups_drained", partialCauseChildNumber });
      return { kind: "done", accumulationHeadSha, partialCauseChildNumber, state };
    }

    const child = children.find((candidate) => candidate.number === selection.issue.number)!;
    const outcome = await input.deps.runChildEngine({
      child,
      accumulationSha: accumulationHeadSha,
      source: "review_followup",
    });
    if (outcome.kind === "approved") {
      const integrated = await input.deps.integrateChild({
        childNumber: child.number,
        accumulationBranch: state.accumulationBranch,
        reviewedBaseSha: outcome.reviewedBaseSha,
        approvedHeadSha: outcome.approvedHeadSha,
      });
      if (!integrated.ok) {
        return {
          kind: "parent_stuck",
          result: parentStuck(accumulationHeadSha, "review_followup_integration_failed", integrated.diagnostics),
        };
      }
      accumulationHeadSha = integrated.accumulationHeadSha;
      continue;
    }

    const diagnostics =
      outcome.kind === "already_satisfied"
        ? [`Review follow-up #${child.number} cannot route already_satisfied to completion.`]
        : outcome.kind === "stuck"
          ? [outcome.lastFeedback]
          : [outcome.error];
    await input.deps.markChildStuck({
      child,
      reason: diagnostics.join("; "),
    });
    partialCauseChildNumber = child.number;
    await transition(state, input.deps, { partialCauseChildNumber });
    return {
      kind: "partial_delivery",
      accumulationHeadSha,
      stuckChildNumber: child.number,
    };
  }
}

function siblingSummaries(children: readonly GitHubIssueRecord[]) {
  return children.map((child) => ({
    number: child.number,
    title: child.title,
    body: child.body,
  }));
}

async function transition(
  state: IssueAsPrdParentState,
  deps: IssueAsPrdOrchestratorDeps,
  patch: Partial<Omit<IssueAsPrdParentState, "schemaVersion" | "parentNumber" | "accumulationBranch" | "queueLabel" | "originalForkSha" | "lastTransitionAt">> & {
    phase?: ParentPhase;
  },
): Promise<IssueAsPrdParentState> {
  const next = nextParentState({
    previous: state,
    now: deps.now(),
    next: {
      ...state,
      ...patch,
      schemaVersion: state.schemaVersion,
      parentNumber: state.parentNumber,
      accumulationBranch: state.accumulationBranch,
      queueLabel: state.queueLabel,
      originalForkSha: state.originalForkSha,
    },
  });
  await deps.persistState(next);
  return next;
}

function parentStuck(
  accumulationHeadSha: string,
  reason: string,
  diagnostics: string[],
): ParentRunResult {
  return {
    kind: "parent_stuck",
    accumulationHeadSha,
    reason,
    diagnostics,
  };
}

async function finalizePartial(
  accumulationHeadSha: string,
  stuckChildNumber: number,
  state: IssueAsPrdParentState,
  deps: IssueAsPrdOrchestratorDeps,
): Promise<ParentRunResult> {
  const terminal = await deps.observeTerminalMainline({
    mainlineRef: deps.mainlineRef,
    fullParentReviewBaseSha: state.fullParentReviewBaseSha,
    preReviewConflict: state.rebaseConflictDiagnostics.length > 0,
  });
  return {
    kind: "partial_delivery",
    accumulationHeadSha,
    observedMainlineSha: terminal.observedMainlineSha,
    rebaseNeeded: terminal.rebaseNeeded,
    stuckChildNumber,
  };
}

function initialDraftToPublishDraft(
  draft: {
    title: string;
    body: string;
    priority: "high" | "medium" | "low";
    files: string[];
    dedupe_key: string;
  },
): PublishChildDraft {
  return {
    title: draft.title,
    body: draft.body,
    priority: draft.priority,
    files: draft.files,
    dedupeKey: draft.dedupe_key,
    source: "initial",
  };
}
