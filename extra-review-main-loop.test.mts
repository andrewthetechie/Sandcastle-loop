import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runBoundedExtraReviewMainLoop,
  type ExtraReviewMainLoopResult,
  type ExtraReviewRoundResult,
  type NormalIssueIterationResult,
} from "./extra-review-main-loop.mts";
import type {
  ExtraReviewBaseValidationState,
  ExtraReviewQueueDecision,
  ExtraReviewQueueIssue,
} from "./extra-review-queue-state.mts";

test("clean drain runs round 1 and stops cleanly on no work", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    roundResults: [round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "no_work");
  assert.equal(result.completedExtraReviewRounds, 1);
  assert.deepEqual(fixture.roundsStarted, [1]);
  assert.equal(fixture.queueSkipWrites.length, 0);
});

test("new follow-up work resumes the normal issue loop before round 2", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue(), processed(101), noIssue()],
    roundResults: [round("success", 1), round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "no_work");
  assert.equal(result.completedIterations, 1);
  assert.equal(result.completedExtraReviewRounds, 2);
  assert.equal(result.createdIssueCount, 1);
  assert.deepEqual(fixture.roundsStarted, [1, 2]);
  assert.deepEqual(fixture.processedIssueNumbers, [101]);
});

test("follow-up issue visibility lag does not start round 2 early", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue(), noIssue(), processed(101), noIssue()],
    openIssues: [[], [], [], [issue(101, "Delayed follow-up")], []],
    roundResults: [round("success", 1), round("no_work")],
    followUpVisibilityRetries: 2,
  });

  const result = await fixture.run();

  assert.equal(result.reason, "no_work");
  assert.equal(result.completedIterations, 1);
  assert.equal(result.completedExtraReviewRounds, 2);
  assert.deepEqual(fixture.roundsStarted, [1, 2]);
  assert.deepEqual(fixture.processedIssueNumbers, [101]);
  assert.equal(fixture.queueSkipWrites.length, 0);
});

test("duplicate-only round stops cleanly with publication artifacts", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    roundResults: [round("duplicate_only", 0, 2)],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "duplicate_only");
  assert.equal(result.skippedDuplicateIssueCount, 2);
  assert.equal(result.artifactWrite?.paths.roundDirName, "round-artifact");
});

test("parser failure stops for human review after round artifacts are written", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    roundResults: [round("parse_failure")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "parse_failure");
  assert.equal(result.completedExtraReviewRounds, 1);
  assert.equal(result.artifactWrite?.handoff, "round handoff");
});

test("needs-human-review round stops for human review", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    roundResults: [round("needs_human_review")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "needs_human_review");
  assert.equal(result.completedExtraReviewRounds, 1);
  assert.deepEqual(fixture.roundsStarted, [1]);
});

test("stuck issues skip extra review and write queue handoff", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    openIssues: [[issue(17, "Blocked by credentials", ["agent-stuck"])]],
    roundResults: [round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "stuck_issues");
  assert.equal(result.completedExtraReviewRounds, 0);
  assert.deepEqual(fixture.roundsStarted, []);
  assert.equal(fixture.queueSkipWrites.length, 1);
  assert.equal(fixture.queueSkipWrites[0]!.decision.reason, "stuck_issues");
});

test("open work at drain skips extra review and writes queue handoff", async () => {
  const fixture = loopFixture({
    issueResults: [noIssue()],
    openIssues: [[issue(18, "Unprocessed follow-up")]],
    roundResults: [round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "open_non_stuck_issues");
  assert.equal(result.completedExtraReviewRounds, 0);
  assert.deepEqual(fixture.roundsStarted, []);
  assert.equal(fixture.queueSkipWrites[0]!.decision.reason, "open_non_stuck_issues");
});

test("iteration cap exhaustion skips extra review after normal processing", async () => {
  const fixture = loopFixture({
    maxIterations: 1,
    issueResults: [processed(201)],
    openIssues: [[], [issue(202, "Still open")]],
    roundResults: [round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "iteration_cap_exhausted");
  assert.equal(result.completedIterations, 1);
  assert.equal(result.completedExtraReviewRounds, 0);
  assert.deepEqual(fixture.roundsStarted, []);
  assert.equal(fixture.queueSkipWrites[0]!.decision.reason, "iteration_cap_exhausted");
});

test("max extra review rounds stop after final generated work drains", async () => {
  const fixture = loopFixture({
    maxExtraReviewRounds: 2,
    issueResults: [
      noIssue(),
      processed(301),
      noIssue(),
      processed(302),
      noIssue(),
    ],
    roundResults: [round("success", 1), round("success", 1), round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "max_extra_review_rounds");
  assert.equal(result.completedIterations, 2);
  assert.equal(result.completedExtraReviewRounds, 2);
  assert.equal(result.createdIssueCount, 2);
  assert.deepEqual(fixture.roundsStarted, [1, 2]);
  assert.equal(fixture.maxRoundWrites.length, 1);
  assert.equal(fixture.maxRoundWrites[0]!.completedExtraReviewRounds, 2);
});

test("base validation failure writes skip handoff and does not process issues", async () => {
  const fixture = loopFixture({
    baseValidation: [{ ok: false, summary: "typecheck failed" }],
    issueResults: [processed(401)],
    roundResults: [round("no_work")],
  });

  const result = await fixture.run();

  assert.equal(result.reason, "base_validation_failed");
  assert.equal(result.completedIterations, 0);
  assert.equal(fixture.processedIssueNumbers.length, 0);
  assert.equal(fixture.queueSkipWrites[0]!.decision.reason, "base_validation_failed");
});

function loopFixture(input: {
  maxIterations?: number;
  maxExtraReviewRounds?: number;
  followUpVisibilityRetries?: number;
  issueResults: NormalIssueIterationResult[];
  roundResults: ExtraReviewRoundResult[];
  openIssues?: ExtraReviewQueueIssue[][];
  baseValidation?: ExtraReviewBaseValidationState[];
}) {
  const issueResults = [...input.issueResults];
  const roundResults = [...input.roundResults];
  const openIssues = [...(input.openIssues ?? [[]])];
  const baseValidation = [...(input.baseValidation ?? [{ ok: true }])];
  let lastOpenIssues = openIssues[0] ?? [];
  let lastBaseValidation = baseValidation[0] ?? { ok: true };
  const roundsStarted: number[] = [];
  const processedIssueNumbers: number[] = [];
  const queueSkipWrites: { decision: ExtraReviewQueueDecision; head: string }[] =
    [];
  const maxRoundWrites: {
    completedExtraReviewRounds: number;
    head: string;
  }[] = [];

  return {
    roundsStarted,
    processedIssueNumbers,
    queueSkipWrites,
    maxRoundWrites,
    run: (): Promise<ExtraReviewMainLoopResult> =>
      runBoundedExtraReviewMainLoop({
        prd: { number: 1, label: "prd-001" },
        reviewBase: "base-sha",
        maxIterations: input.maxIterations ?? 50,
        maxExtraReviewRounds: input.maxExtraReviewRounds ?? 2,
        followUpVisibilityRetries: input.followUpVisibilityRetries ?? 0,
        sleep: () => {},
        listOpenIssues: () => {
          lastOpenIssues = openIssues.shift() ?? lastOpenIssues;
          return lastOpenIssues;
        },
        validateBase: () => {
          lastBaseValidation = baseValidation.shift() ?? lastBaseValidation;
          return lastBaseValidation;
        },
        getReviewedHead: () => "head-sha",
        runNormalIssueIteration: () => {
          const result = issueResults.shift();
          assert.ok(result, "expected queued issue-loop result");
          if (result.kind === "processed_issue" && result.issueNumber) {
            processedIssueNumbers.push(result.issueNumber);
          }
          return result;
        },
        runExtraReviewRound: ({ round: roundIdentity }) => {
          roundsStarted.push(roundIdentity.number);
          const result = roundResults.shift();
          assert.ok(result, "expected queued extra-review round result");
          return result;
        },
        writeQueueSkipHandoff: (decision, head) => {
          queueSkipWrites.push({ decision, head });
          return artifactWrite("queue-skip");
        },
        writeMaxRoundsHandoff: (completedExtraReviewRounds, head) => {
          maxRoundWrites.push({ completedExtraReviewRounds, head });
          return artifactWrite("max-rounds");
        },
        logger: { log() {}, warn() {} },
      }),
  };
}

function processed(issueNumber: number): NormalIssueIterationResult {
  return { kind: "processed_issue", issueNumber };
}

function noIssue(): NormalIssueIterationResult {
  return { kind: "no_eligible_issue" };
}

function round(
  stopReason: ExtraReviewRoundResult["stopReason"],
  createdIssueCount = 0,
  skippedDuplicateIssueCount = 0,
): ExtraReviewRoundResult {
  return {
    stopReason,
    createdIssueCount,
    skippedDuplicateIssueCount,
    artifactWrite: artifactWrite("round"),
  };
}

function issue(
  number: number,
  title: string,
  labels: ExtraReviewQueueIssue["labels"] = [],
): ExtraReviewQueueIssue {
  return { number, title, labels };
}

function artifactWrite(kind: string) {
  return {
    paths: {
      runsRootDir: "runs",
      prdDirName: "prd-001",
      prdDir: "runs/prd-001",
      roundDirName: `${kind}-artifact`,
      roundDir: `runs/prd-001/${kind}-artifact`,
      files: {
        inputDiff: "review-input.diff",
        inputDiffStat: "review-input.diff-stat.txt",
        inputChangedFiles: "review-input.changed-files.txt",
        inputPrdBody: "review-input.prd.md",
        inputMetadata: "review-input.metadata.json",
        codeReviewRaw: "code-review.raw.txt",
        codeReviewParsed: "code-review.parsed.json",
        twoAxisReviewRaw: "two-axis-review.raw.txt",
        twoAxisReviewParsed: "two-axis-review.parsed.json",
        issueDecomposerRaw: "issue-decomposer.raw.txt",
        issueDecomposerParsed: "issue-decomposer.parsed.json",
        createdIssues: "created-issues.json",
        skippedDuplicateIssues: "skipped-duplicate-issues.json",
        handoff: "HANDOFF.md",
      },
    },
    writtenFiles: [],
    handoff: `${kind} handoff`,
  };
}
