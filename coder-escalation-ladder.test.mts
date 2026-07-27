import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coderEscalationLadderWarnings,
  coderTierModelIdentity,
  describeCoderEscalationLadder,
  resolveCoderTier,
  validateCoderEscalationLadder,
  type CoderEscalationLadder,
} from "./coder-escalation-ladder.mts";

const LADDER: CoderEscalationLadder = {
  tier1Model: "local/small",
  tier2Model: "vendor/medium",
  tier3Model: "vendor/large",
  tier2FromRound: 3,
  tier3FromRound: 5,
};

test("default ladder maps rounds 1-6 to tiers 1,1,2,2,3,3", () => {
  const tiers = [1, 2, 3, 4, 5, 6].map(
    (round) => resolveCoderTier(LADDER, round).tier,
  );
  assert.deepEqual(tiers, [1, 1, 2, 2, 3, 3]);
});

test("each round resolves to its tier's model", () => {
  assert.equal(resolveCoderTier(LADDER, 1).model, "local/small");
  assert.equal(resolveCoderTier(LADDER, 2).model, "local/small");
  assert.equal(resolveCoderTier(LADDER, 3).model, "vendor/medium");
  assert.equal(resolveCoderTier(LADDER, 4).model, "vendor/medium");
  assert.equal(resolveCoderTier(LADDER, 5).model, "vendor/large");
  assert.equal(resolveCoderTier(LADDER, 6).model, "vendor/large");
});

test("rounds past the last threshold stay on tier 3", () => {
  assert.equal(resolveCoderTier(LADDER, 50).tier, 3);
});

test("model identity changes exactly at the two escalation boundaries", () => {
  const identities = [1, 2, 3, 4, 5, 6].map((round) =>
    coderTierModelIdentity(LADDER, round),
  );
  const changeRounds = identities
    .map((identity, index) => ({ identity, round: index + 1 }))
    .filter((entry, index) => index > 0 && identities[index - 1] !== entry.identity)
    .map((entry) => entry.round);
  assert.deepEqual(changeRounds, [3, 5]);
});

// The fingerprint reset keys on the model string, not the tier number. A ladder
// that repeats a model across tiers is really one model, and must not earn a
// free no-progress reset just for crossing a configured threshold.
test("identity does not change when adjacent tiers share a model", () => {
  const flat: CoderEscalationLadder = {
    ...LADDER,
    tier2Model: "local/small",
  };
  assert.equal(coderTierModelIdentity(flat, 2), coderTierModelIdentity(flat, 3));
  assert.notEqual(
    coderTierModelIdentity(flat, 4),
    coderTierModelIdentity(flat, 5),
  );
});

test("custom thresholds are honoured", () => {
  const eager: CoderEscalationLadder = {
    ...LADDER,
    tier2FromRound: 2,
    tier3FromRound: 3,
  };
  assert.deepEqual(
    [1, 2, 3].map((round) => resolveCoderTier(eager, round).tier),
    [1, 2, 3],
  );
});

test("validate rejects tier2FromRound below 2 so tier 1 always owns round 1", () => {
  assert.throws(
    () => validateCoderEscalationLadder({ ...LADDER, tier2FromRound: 1 }),
    /tier2FromRound must be an integer >= 2/,
  );
});

test("validate rejects tier3FromRound at or below tier2FromRound", () => {
  assert.throws(
    () => validateCoderEscalationLadder({ ...LADDER, tier3FromRound: 3 }),
    /tier3FromRound must be an integer greater than tier2FromRound/,
  );
});

test("validate rejects non-integer thresholds and empty models", () => {
  assert.throws(
    () => validateCoderEscalationLadder({ ...LADDER, tier2FromRound: 2.5 }),
    /tier2FromRound/,
  );
  assert.throws(
    () => validateCoderEscalationLadder({ ...LADDER, tier3Model: "  " }),
    /tier3Model must be a non-empty string/,
  );
});

test("validate accepts the shipped defaults", () => {
  assert.doesNotThrow(() => validateCoderEscalationLadder(LADDER));
});

test("warns when a tier reuses the model below it", () => {
  const warnings = coderEscalationLadderWarnings(
    { ...LADDER, tier2Model: "local/small" },
    6,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /tier 2 uses the same model as tier 1/);
});

test("warns when a tier can never run under the round cap", () => {
  const warnings = coderEscalationLadderWarnings(LADDER, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /tier 3 starts at round 5 but maxReviewRounds is 4/);
});

test("no warnings for a coherent ladder at the v4 round cap", () => {
  assert.deepEqual(coderEscalationLadderWarnings(LADDER, 6), []);
});

test("describe renders one span per reachable tier", () => {
  const described = describeCoderEscalationLadder(LADDER, 6);
  assert.match(described, /tier1 rounds 1-2: local\/small/);
  assert.match(described, /tier2 rounds 3-4: vendor\/medium/);
  assert.match(described, /tier3 rounds 5-6: vendor\/large/);
});

test("describe omits tiers the round cap makes unreachable", () => {
  const described = describeCoderEscalationLadder(LADDER, 3);
  assert.match(described, /tier2 rounds 3: vendor\/medium/);
  assert.ok(!described.includes("tier3"));
});
