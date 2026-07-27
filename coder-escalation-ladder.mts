// coder-escalation-ladder.mts
//
// Pure resolution of the backlog-v4 coder/rework escalation ladder.
//
// The v3 loop ran every review round on one model. Measured over 451 v3 tasks,
// the probability that a task needs *another* round climbs with the round
// number (~44% after round 1, ~65% through rounds 3-6, 85%+ past round 7):
// once a task has failed twice, re-running the same model rarely converges it.
// The ladder answers that by spending a stronger model only on the rounds that
// have already proven the cheap model insufficient.
//
// Rounds are 1-based and map to tiers by threshold:
//
//   round < tier2FromRound                        -> tier 1 (cheap/local)
//   tier2FromRound <= round < tier3FromRound      -> tier 2
//   round >= tier3FromRound                       -> tier 3
//
// Tier 1 always owns round 1: `tier2FromRound` is validated to be >= 2.

export interface CoderEscalationLadder {
  tier1Model: string;
  tier2Model: string;
  tier3Model: string;
  /** First round that runs on tier 2. Must be >= 2. */
  tier2FromRound: number;
  /** First round that runs on tier 3. Must be > tier2FromRound. */
  tier3FromRound: number;
}

export type CoderEscalationTier = 1 | 2 | 3;

export interface ResolvedCoderTier {
  tier: CoderEscalationTier;
  model: string;
}

export function resolveCoderTier(
  ladder: CoderEscalationLadder,
  round: number,
): ResolvedCoderTier {
  if (round >= ladder.tier3FromRound) {
    return { tier: 3, model: ladder.tier3Model };
  }
  if (round >= ladder.tier2FromRound) {
    return { tier: 2, model: ladder.tier2Model };
  }
  return { tier: 1, model: ladder.tier1Model };
}

/**
 * Identity used to decide whether the engine should clear its no-progress
 * fingerprint history between rounds.
 *
 * This is deliberately the *model string*, not the tier number. The repeat
 * limit encodes the inference "same model, same input, same failure, therefore
 * further attempts are pointless". Only a genuine model change invalidates
 * that. A ladder configured with the same model in two tiers (the degenerate
 * case that reproduces v3 behaviour) must not earn a free fingerprint reset
 * just for crossing a threshold.
 */
export function coderTierModelIdentity(
  ladder: CoderEscalationLadder,
  round: number,
): string {
  return resolveCoderTier(ladder, round).model;
}

export function validateCoderEscalationLadder(
  ladder: CoderEscalationLadder,
): void {
  for (const [field, value] of [
    ["tier1Model", ladder.tier1Model],
    ["tier2Model", ladder.tier2Model],
    ["tier3Model", ladder.tier3Model],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`coder escalation ladder: ${field} must be a non-empty string`);
    }
  }
  if (
    !Number.isInteger(ladder.tier2FromRound) ||
    ladder.tier2FromRound < 2
  ) {
    throw new Error(
      `coder escalation ladder: tier2FromRound must be an integer >= 2 (got ${ladder.tier2FromRound}); tier 1 must own round 1`,
    );
  }
  if (
    !Number.isInteger(ladder.tier3FromRound) ||
    ladder.tier3FromRound <= ladder.tier2FromRound
  ) {
    throw new Error(
      `coder escalation ladder: tier3FromRound must be an integer greater than tier2FromRound (got ${ladder.tier3FromRound} vs ${ladder.tier2FromRound})`,
    );
  }
}

/**
 * Warn about ladder configurations that are legal but almost certainly not what
 * the operator intended. Returns one message per problem; empty when the ladder
 * is coherent.
 */
export function coderEscalationLadderWarnings(
  ladder: CoderEscalationLadder,
  maxReviewRounds: number,
): string[] {
  const warnings: string[] = [];
  if (ladder.tier2Model === ladder.tier1Model) {
    warnings.push(
      `Escalation tier 2 uses the same model as tier 1 ("${ladder.tier1Model}"); rounds ${ladder.tier2FromRound}+ gain no additional capability.`,
    );
  }
  if (ladder.tier3Model === ladder.tier2Model) {
    warnings.push(
      `Escalation tier 3 uses the same model as tier 2 ("${ladder.tier2Model}"); rounds ${ladder.tier3FromRound}+ gain no additional capability.`,
    );
  }
  if (ladder.tier2FromRound > maxReviewRounds) {
    warnings.push(
      `Escalation tier 2 starts at round ${ladder.tier2FromRound} but maxReviewRounds is ${maxReviewRounds}; tier 2 and tier 3 will never run.`,
    );
  } else if (ladder.tier3FromRound > maxReviewRounds) {
    warnings.push(
      `Escalation tier 3 starts at round ${ladder.tier3FromRound} but maxReviewRounds is ${maxReviewRounds}; tier 3 will never run.`,
    );
  }
  return warnings;
}

/** Single-line-per-tier summary for the startup banner. */
export function describeCoderEscalationLadder(
  ladder: CoderEscalationLadder,
  maxReviewRounds: number,
): string {
  const spans: string[] = [];
  const tier1End = Math.min(ladder.tier2FromRound - 1, maxReviewRounds);
  spans.push(`  tier1 rounds ${formatSpan(1, tier1End)}: ${ladder.tier1Model}`);
  if (ladder.tier2FromRound <= maxReviewRounds) {
    const tier2End = Math.min(ladder.tier3FromRound - 1, maxReviewRounds);
    spans.push(
      `  tier2 rounds ${formatSpan(ladder.tier2FromRound, tier2End)}: ${ladder.tier2Model}`,
    );
  }
  if (ladder.tier3FromRound <= maxReviewRounds) {
    spans.push(
      `  tier3 rounds ${formatSpan(ladder.tier3FromRound, maxReviewRounds)}: ${ladder.tier3Model}`,
    );
  }
  return [`Coder escalation ladder (max ${maxReviewRounds} rounds):`, ...spans].join(
    "\n",
  );
}

function formatSpan(from: number, to: number): string {
  if (to < from) return `(none)`;
  return from === to ? `${from}` : `${from}-${to}`;
}
