import { MAX_EXTRA_REVIEW_ROUNDS } from "./extra-review-config.mts";
import {
  type ExtraReviewPrdArtifactIdentity,
  type ExtraReviewRoundArtifactIdentity,
  type ExtraReviewRoundStopReason,
  type ExtraReviewRoundWriteResult,
  writeExtraReviewRoundArtifacts,
} from "./extra-review-artifacts.mts";
import {
  decideExtraReviewQueueAction,
  type ExtraReviewBaseValidationState,
  type ExtraReviewQueueDecision,
  type ExtraReviewQueueIssue,
  writeExtraReviewQueueSkipHandoff,
} from "./extra-review-queue-state.mts";

export type NormalIssueIterationResult =
  | { kind: "processed_issue"; issueNumber?: number }
  | { kind: "no_eligible_issue" };

export interface NormalIssueIterationContext {
  completedIterations: number;
  maxIterations: number;
  completedExtraReviewRounds: number;
}

export interface ExtraReviewRoundContext {
  round: ExtraReviewRoundArtifactIdentity & { number: number };
  completedIterations: number;
  maxIterations: number;
}

export interface ExtraReviewRoundResult {
  stopReason: ExtraReviewRoundStopReason;
  createdIssueCount: number;
  skippedDuplicateIssueCount?: number;
  artifactWrite?: ExtraReviewRoundWriteResult;
}

export type ExtraReviewMainLoopStopReason =
  | ExtraReviewRoundStopReason
  | "clean_drain"
  | "max_extra_review_rounds"
  | "iteration_cap_exhausted"
  | "stuck_issues"
  | "open_non_stuck_issues"
  | "base_validation_failed";

export interface ExtraReviewMainLoopResult {
  reason: ExtraReviewMainLoopStopReason;
  completedIterations: number;
  completedExtraReviewRounds: number;
  createdIssueCount: number;
  skippedDuplicateIssueCount: number;
  queueDecision?: ExtraReviewQueueDecision;
  artifactWrite?: ExtraReviewRoundWriteResult;
}

export interface ExtraReviewMainLoopLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ExtraReviewMainLoopInput {
  prd: ExtraReviewPrdArtifactIdentity;
  reviewBase: string;
  maxIterations: number;
  maxExtraReviewRounds?: number;
  followUpVisibilityRetries?: number;
  followUpVisibilityDelayMs?: number;
  runsRootDir?: string;
  listOpenIssues(): Promise<readonly ExtraReviewQueueIssue[]> | readonly ExtraReviewQueueIssue[];
  validateBase(): Promise<ExtraReviewBaseValidationState> | ExtraReviewBaseValidationState;
  getReviewedHead(): Promise<string> | string;
  runNormalIssueIteration(
    context: NormalIssueIterationContext,
  ): Promise<NormalIssueIterationResult> | NormalIssueIterationResult;
  runExtraReviewRound(
    context: ExtraReviewRoundContext,
  ): Promise<ExtraReviewRoundResult> | ExtraReviewRoundResult;
  writeQueueSkipHandoff?(
    decision: ExtraReviewQueueDecision,
    reviewedHead: string,
  ): Promise<ExtraReviewRoundWriteResult> | ExtraReviewRoundWriteResult;
  writeMaxRoundsHandoff?(
    completedExtraReviewRounds: number,
    reviewedHead: string,
  ): Promise<ExtraReviewRoundWriteResult> | ExtraReviewRoundWriteResult;
  sleep?(ms: number): Promise<void> | void;
  logger?: ExtraReviewMainLoopLogger;
}

export async function runBoundedExtraReviewMainLoop(
  input: ExtraReviewMainLoopInput,
): Promise<ExtraReviewMainLoopResult> {
  const logger = input.logger ?? console;
  const maxExtraReviewRounds =
    input.maxExtraReviewRounds ?? MAX_EXTRA_REVIEW_ROUNDS;
  let completedIterations = 0;
  let completedExtraReviewRounds = 0;
  let createdIssueCount = 0;
  let skippedDuplicateIssueCount = 0;
  let lastBaseValidation: ExtraReviewBaseValidationState = { ok: true };
  let awaitingFollowUpVisibility = false;

  while (true) {
    if (completedIterations >= input.maxIterations) {
      const decision = decideExtraReviewQueueAction({
        openIssues: await input.listOpenIssues(),
        outerLoop: {
          capExhausted: true,
          completedIterations,
          maxIterations: input.maxIterations,
        },
        baseValidation: lastBaseValidation,
      });
      const artifactWrite = await writeQueueSkip(input, decision);
      return {
        reason: "iteration_cap_exhausted",
        completedIterations,
        completedExtraReviewRounds,
        createdIssueCount,
        skippedDuplicateIssueCount,
        queueDecision: decision,
        artifactWrite,
      };
    }

    const baseValidation = await input.validateBase();
    lastBaseValidation = baseValidation;
    if (!baseValidation.ok) {
      const decision = forceQueueStop(
        decideExtraReviewQueueAction({
          openIssues: await input.listOpenIssues(),
          outerLoop: {
            capExhausted: false,
            completedIterations,
            maxIterations: input.maxIterations,
          },
          baseValidation,
        }),
        "base_validation_failed",
      );
      const artifactWrite = await writeQueueSkip(input, decision);
      return {
        reason: "base_validation_failed",
        completedIterations,
        completedExtraReviewRounds,
        createdIssueCount,
        skippedDuplicateIssueCount,
        queueDecision: decision,
        artifactWrite,
      };
    }

    const issueResult = await input.runNormalIssueIteration({
      completedIterations,
      maxIterations: input.maxIterations,
      completedExtraReviewRounds,
    });

    if (issueResult.kind === "processed_issue") {
      completedIterations++;
      awaitingFollowUpVisibility = false;
      continue;
    }

    let decision = decideExtraReviewQueueAction({
      openIssues: await input.listOpenIssues(),
      outerLoop: {
        capExhausted: false,
        completedIterations,
        maxIterations: input.maxIterations,
      },
      baseValidation,
    });

    if (
      awaitingFollowUpVisibility &&
      decision.action === "start_extra_review"
    ) {
      decision = await waitForFollowUpIssueVisibility(input, {
        completedIterations,
        maxIterations: input.maxIterations,
        baseValidation,
        logger,
      });
    }

    if (decision.action === "continue_issue_loop") {
      if (awaitingFollowUpVisibility) {
        logger.log(
          "New follow-up PRD issues became visible after extra-review publication; resuming normal issue loop.",
        );
        continue;
      }
      const stopDecision = forceQueueStop(decision, "open_non_stuck_issues");
      const artifactWrite = await writeQueueSkip(input, stopDecision);
      return {
        reason: "open_non_stuck_issues",
        completedIterations,
        completedExtraReviewRounds,
        createdIssueCount,
        skippedDuplicateIssueCount,
        queueDecision: stopDecision,
        artifactWrite,
      };
    }

    if (decision.action === "stop_with_handoff") {
      const artifactWrite = await writeQueueSkip(input, decision);
      return {
        reason: decision.reason,
        completedIterations,
        completedExtraReviewRounds,
        createdIssueCount,
        skippedDuplicateIssueCount,
        queueDecision: decision,
        artifactWrite,
      };
    }

    if (completedExtraReviewRounds >= maxExtraReviewRounds) {
      logger.log(
        `Configured extra-review round budget reached (${completedExtraReviewRounds}/${maxExtraReviewRounds}); stopping.`,
      );
      const artifactWrite = await writeMaxRoundsHandoff(
        input,
        completedExtraReviewRounds,
      );
      return {
        reason: "max_extra_review_rounds",
        completedIterations,
        completedExtraReviewRounds,
        createdIssueCount,
        skippedDuplicateIssueCount,
        queueDecision: decision,
        artifactWrite,
      };
    }

    const roundNumber = completedExtraReviewRounds + 1;
    logger.log(
      `Starting extra review round ${roundNumber}/${maxExtraReviewRounds}.`,
    );
    const roundResult = await input.runExtraReviewRound({
      round: { number: roundNumber },
      completedIterations,
      maxIterations: input.maxIterations,
    });
    completedExtraReviewRounds++;
    createdIssueCount += roundResult.createdIssueCount;
    skippedDuplicateIssueCount += roundResult.skippedDuplicateIssueCount ?? 0;

    if (
      roundResult.stopReason === "success" &&
      roundResult.createdIssueCount > 0
    ) {
      awaitingFollowUpVisibility = true;
      logger.log(
        `Extra review round ${roundNumber} created ${roundResult.createdIssueCount} follow-up issue(s); resuming normal issue loop.`,
      );
      continue;
    }

    return {
      reason: roundResult.stopReason,
      completedIterations,
      completedExtraReviewRounds,
      createdIssueCount,
      skippedDuplicateIssueCount,
      artifactWrite: roundResult.artifactWrite,
    };
  }
}

function forceQueueStop(
  decision: ExtraReviewQueueDecision,
  reason: ExtraReviewQueueDecision["reason"],
): ExtraReviewQueueDecision {
  return {
    ...decision,
    action: "stop_with_handoff",
    reason,
    shouldStartExtraReview: false,
  };
}

async function writeQueueSkip(
  input: ExtraReviewMainLoopInput,
  decision: ExtraReviewQueueDecision,
): Promise<ExtraReviewRoundWriteResult> {
  const reviewedHead = await input.getReviewedHead();
  if (input.writeQueueSkipHandoff) {
    return input.writeQueueSkipHandoff(decision, reviewedHead);
  }
  return writeExtraReviewQueueSkipHandoff({
    runsRootDir: input.runsRootDir,
    prd: input.prd,
    decision,
    reviewBase: input.reviewBase,
    reviewedHead,
  });
}

async function waitForFollowUpIssueVisibility(
  input: ExtraReviewMainLoopInput,
  context: {
    completedIterations: number;
    maxIterations: number;
    baseValidation: ExtraReviewBaseValidationState;
    logger: ExtraReviewMainLoopLogger;
  },
): Promise<ExtraReviewQueueDecision> {
  const retries = Math.max(0, input.followUpVisibilityRetries ?? 5);
  const delayMs = Math.max(0, input.followUpVisibilityDelayMs ?? 2_000);
  let decision = decideExtraReviewQueueAction({
    openIssues: await input.listOpenIssues(),
    outerLoop: {
      capExhausted: false,
      completedIterations: context.completedIterations,
      maxIterations: context.maxIterations,
    },
    baseValidation: context.baseValidation,
  });

  for (let attempt = 0; attempt < retries; attempt++) {
    if (decision.action !== "start_extra_review") {
      return decision;
    }
    if (delayMs > 0) {
      await (input.sleep ?? defaultSleep)(delayMs);
    }
    decision = decideExtraReviewQueueAction({
      openIssues: await input.listOpenIssues(),
      outerLoop: {
        capExhausted: false,
        completedIterations: context.completedIterations,
        maxIterations: context.maxIterations,
      },
      baseValidation: context.baseValidation,
    });
  }

  if (decision.action === "start_extra_review") {
    context.logger.warn(
      "Extra-review follow-up issues were created but did not become visible before the visibility wait expired; continuing with the observed queue state.",
    );
  }
  return decision;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeMaxRoundsHandoff(
  input: ExtraReviewMainLoopInput,
  completedExtraReviewRounds: number,
): Promise<ExtraReviewRoundWriteResult> {
  const reviewedHead = await input.getReviewedHead();
  if (input.writeMaxRoundsHandoff) {
    return input.writeMaxRoundsHandoff(completedExtraReviewRounds, reviewedHead);
  }
  return writeExtraReviewRoundArtifacts({
    runsRootDir: input.runsRootDir,
    prd: input.prd,
    round: { id: "max-extra-review-rounds-reached" },
    reviewBase: input.reviewBase,
    reviewedHead,
    stopReason: "skipped",
    stopDetails: [
      `Configured extra-review round budget reached: ${completedExtraReviewRounds}/${input.maxExtraReviewRounds ?? MAX_EXTRA_REVIEW_ROUNDS}.`,
      "No additional PRD-level quality gate was started.",
    ],
  });
}
