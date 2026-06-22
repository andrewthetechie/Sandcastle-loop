import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideExtraReviewQueueAction,
  renderExtraReviewQueueSkipDetails,
  writeExtraReviewQueueSkipHandoff,
  type ExtraReviewBaseValidationState,
  type ExtraReviewQueueDecision,
  type ExtraReviewQueueIssue,
} from "./extra-review-support.mts";

test("clean PRD queue drain permits extra review setup", () => {
  const decision = decideExtraReviewQueueAction(
    fixtureQueue({ openIssues: [] }),
  );

  assert.equal(decision.action, "start_extra_review");
  assert.equal(decision.reason, "clean_drain");
  assert.equal(decision.shouldStartExtraReview, true);
  assert.deepEqual(decision.openNonStuckIssues, []);
  assert.deepEqual(decision.stuckIssues, []);
});

test("open non-stuck PRD issues continue the normal issue loop", () => {
  const decision = decideExtraReviewQueueAction(
    fixtureQueue({
      openIssues: [
        issue(12, "Finish parser tests"),
        issue(4, "Wire parser fixtures", ["feature"]),
      ],
    }),
  );

  assert.equal(decision.action, "continue_issue_loop");
  assert.equal(decision.reason, "open_non_stuck_issues");
  assert.equal(decision.shouldStartExtraReview, false);
  assert.deepEqual(
    decision.openNonStuckIssues.map((item) => item.number),
    [4, 12],
  );
  assert.deepEqual(decision.stuckIssues, []);
});

test("open stuck PRD issues stop before extra review and request handoff", () => {
  const decision = decideExtraReviewQueueAction(
    fixtureQueue({
      openIssues: [
        issue(8, "Needs unavailable credentials", ["agent-stuck"]),
        issue(3, "Blocked on missing fixture", [{ name: "agent-stuck" }]),
      ],
    }),
  );

  assert.equal(decision.action, "stop_with_handoff");
  assert.equal(decision.reason, "stuck_issues");
  assert.equal(decision.shouldStartExtraReview, false);
  assert.deepEqual(
    decision.stuckIssues.map((item) => item.number),
    [3, 8],
  );

  const details = renderExtraReviewQueueSkipDetails(decision);
  assert.match(details.join("\n"), /open stuck PRD issues remain/);
  assert.match(details.join("\n"), /#3 Blocked on missing fixture/);
  assert.match(details.join("\n"), /#8 Needs unavailable credentials/);
});

test("outer iteration cap exhaustion stops with handoff even when work remains", () => {
  const decision = decideExtraReviewQueueAction(
    fixtureQueue({
      openIssues: [issue(14, "Unprocessed follow-up")],
      outerLoop: {
        capExhausted: true,
        completedIterations: 50,
        maxIterations: 50,
      },
    }),
  );

  assert.equal(decision.action, "stop_with_handoff");
  assert.equal(decision.reason, "iteration_cap_exhausted");
  assert.equal(decision.shouldStartExtraReview, false);

  const details = renderExtraReviewQueueSkipDetails(decision).join("\n");
  assert.match(details, /safety cap was exhausted/);
  assert.match(details, /Iterations: 50\/50/);
  assert.match(details, /#14 Unprocessed follow-up/);
});

test("base validation failure stops before extra review setup", () => {
  const decision = decideExtraReviewQueueAction(
    fixtureQueue({
      openIssues: [],
      baseValidation: {
        ok: false,
        summary: "npm test failed",
        command: "npm run test",
        exitCode: 1,
        feedback: "Fixture failure output",
      },
    }),
  );

  assert.equal(decision.action, "stop_with_handoff");
  assert.equal(decision.reason, "base_validation_failed");
  assert.equal(decision.shouldStartExtraReview, false);

  const details = renderExtraReviewQueueSkipDetails(decision).join("\n");
  assert.match(details, /base validation failed/);
  assert.match(details, /npm test failed/);
  assert.match(details, /npm run test/);
  assert.match(details, /Fixture failure output/);
});

test("skip handoff writer explains stuck, cap-exhausted, and validation-failure states", () => {
  withTempRunsRoot((runsRootDir) => {
    const stuckDecision = decideExtraReviewQueueAction(
      fixtureQueue({
        openIssues: [issue(7, "Reviewer could not finish", ["agent-stuck"])],
      }),
    );
    const capDecision = decideExtraReviewQueueAction(
      fixtureQueue({
        openIssues: [issue(9, "Still open")],
        outerLoop: {
          capExhausted: true,
          completedIterations: 50,
          maxIterations: 50,
        },
      }),
    );
    const validationDecision = decideExtraReviewQueueAction(
      fixtureQueue({
        openIssues: [],
        baseValidation: {
          ok: false,
          summary: "typecheck failed",
          command: "npm run typecheck",
        },
      }),
    );

    assertSkipHandoff({
      runsRootDir,
      decision: stuckDecision,
      roundId: "queue-skip-stuck-fixture",
      expected: [/Stop reason: skipped/, /open stuck PRD issues remain/, /#7/],
    });
    assertSkipHandoff({
      runsRootDir,
      decision: capDecision,
      roundId: "queue-skip-cap-fixture",
      expected: [/Stop reason: skipped/, /safety cap was exhausted/, /50\/50/],
    });
    assertSkipHandoff({
      runsRootDir,
      decision: validationDecision,
      roundId: "queue-skip-validation-fixture",
      expected: [
        /Stop reason: skipped/,
        /base validation failed/,
        /npm run typecheck/,
      ],
    });
  });
});

function fixtureQueue(input: {
  openIssues: ExtraReviewQueueIssue[];
  outerLoop?: {
    capExhausted: boolean;
    completedIterations: number;
    maxIterations: number;
  };
  baseValidation?: ExtraReviewBaseValidationState;
}) {
  return {
    openIssues: input.openIssues,
    outerLoop:
      input.outerLoop ??
      {
        capExhausted: false,
        completedIterations: 8,
        maxIterations: 50,
      },
    baseValidation: input.baseValidation ?? { ok: true },
  };
}

function issue(
  number: number,
  title: string,
  labels: ExtraReviewQueueIssue["labels"] = [],
): ExtraReviewQueueIssue {
  return { number, title, labels };
}

function assertSkipHandoff(input: {
  runsRootDir: string;
  decision: ExtraReviewQueueDecision;
  roundId: string;
  expected: RegExp[];
}): void {
  const result = writeExtraReviewQueueSkipHandoff({
    runsRootDir: input.runsRootDir,
    prd: {
      number: 1,
      label: "prd-001",
      path: "docs/prd/001-extra-review.md",
      title: "Extra review",
    },
    decision: input.decision,
    reviewBase: "base-sha",
    reviewedHead: "head-sha",
    round: { id: input.roundId },
  });

  assert.equal(existsSync(result.paths.files.handoff), true);
  const handoff = read(result.paths.files.handoff);
  assert.match(handoff, /^# Extra Review Round Handoff/m);
  assert.match(handoff, /PRD: prd-001 \/ #1/);
  assert.match(handoff, /Review base: base-sha/);
  assert.match(handoff, /Reviewed head: head-sha/);
  for (const pattern of input.expected) {
    assert.match(handoff, pattern);
  }
}

function withTempRunsRoot(fn: (runsRootDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "extra-review-queue-state-"));
  try {
    fn(join(tempDir, "runs"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}
