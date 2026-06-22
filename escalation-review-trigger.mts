import type { ExtraReviewMainLoopStopReason } from "./extra-review-main-loop.mts";

/**
 * Terminal reasons that mean the completed PRD branch is green and the issue
 * queue is fully drained — the only states where the escalation tier runs.
 *
 * Note: a round that returns "success" only does so with zero created issues
 * (the loop keeps going when success + created > 0). We deliberately exclude
 * "success" so escalation engages on the explicit clean-exhaustion reasons.
 */
export const ESCALATION_CLEAN_REASONS: ReadonlySet<ExtraReviewMainLoopStopReason> =
  new Set(["max_extra_review_rounds", "no_work", "duplicate_only"]);

export function shouldRunEscalationReview(
  reason: ExtraReviewMainLoopStopReason,
): boolean {
  return ESCALATION_CLEAN_REASONS.has(reason);
}
