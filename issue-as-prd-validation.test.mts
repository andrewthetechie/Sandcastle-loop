import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubIssueRecord } from "./github-issues.mts";
import { runAggregateValidation, type AggregateValidationDeps } from "./issue-as-prd-validation.mts";

test("green and empty-command gates return green", async () => {
  const empty = createDeps();
  const emptyResult = await runAggregateValidation(
    { gate: "pre_review", commands: [], accumulationSha: "acc-1", repairAlreadyUsed: false },
    empty,
  );
  assert.deepEqual(emptyResult, { kind: "green" });

  const green = createDeps({ commandResults: [{ ok: true }, { ok: true }] });
  const greenResult = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["typecheck", "test"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: false,
    },
    green,
  );
  assert.deepEqual(greenResult, { kind: "green" });
  assert.deepEqual(green.events, ["command:typecheck:acc-1", "command:test:acc-1"]);
});

test("used repair budget returns parent_failure without publishing a child", async () => {
  const deps = createDeps({
    commandResults: [{ ok: true }, { ok: false, exitCode: 2, output: "boom" }],
  });

  const result = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["typecheck", "test"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: true,
    },
    deps,
  );

  assert.equal(result.kind, "parent_failure");
  assert.deepEqual(deps.events, ["command:typecheck:acc-1", "command:test:acc-1"]);
});

test("approved repair child reruns the full gate from the beginning", async () => {
  const deps = createDeps({
    commandResults: [
      { ok: true },
      { ok: false, exitCode: 1, output: "TOKEN=abc\nfail" },
      { ok: true },
      { ok: true },
      { ok: true },
    ],
    engineOutcome: {
      kind: "approved",
      reviewedBaseSha: "base-1",
      approvedHeadSha: "head-2",
      roundsUsed: 1,
    },
    integratedHeadSha: "acc-2",
  });

  const result = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["typecheck", "test", "build"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: false,
    },
    deps,
  );

  assert.deepEqual(result, {
    kind: "repaired",
    childNumber: 71,
    accumulationSha: "acc-2",
  });
  assert.deepEqual(deps.events, [
    "command:typecheck:acc-1",
    "command:test:acc-1",
    "publish",
    "mark-budget:pre_review:71",
    "readiness",
    "engine:71:pre_review",
    "integrate:71",
    "command:typecheck:acc-2",
    "command:test:acc-2",
    "command:build:acc-2",
  ]);
  assert.match(deps.publishedDrafts[0]!.body, /Repair pre-review aggregate validation/);
  assert.match(deps.publishedDrafts[0]!.body, /TOKEN[:=] \[REDACTED\]|TOKEN=\[REDACTED\]/);
});

test("repair child is improved just in time with freshly listed siblings before coding", async () => {
  const deps = createDeps({
    commandResults: [
      { ok: false, exitCode: 1, output: "fail" },
      { ok: true },
    ],
    integratedHeadSha: "acc-2",
  });
  deps.readiness = undefined;
  deps.listSiblingSummaries = ({ childNumber }) => {
    deps.events.push(`list-siblings:${childNumber}`);
    return [{ number: 72, title: "Sibling", body: "Current sibling body" }];
  };
  deps.improveChild = async ({ child, siblingSummaries, accumulationSha }) => {
    deps.events.push(
      `improve:${child.number}:${siblingSummaries.map((sibling) => sibling.number).join(",")}:${accumulationSha}`,
    );
    return { kind: "actionable" as const, child, reused: false };
  };

  const result = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["test"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: false,
    },
    deps,
  );

  assert.deepEqual(result, {
    kind: "repaired",
    childNumber: 71,
    accumulationSha: "acc-2",
  });
  assert.deepEqual(deps.events, [
    "command:test:acc-1",
    "publish",
    "mark-budget:pre_review:71",
    "list-siblings:71",
    "improve:71:72:acc-1",
    "engine:71:pre_review",
    "integrate:71",
    "command:test:acc-2",
  ]);
});

test("readiness drop or failure becomes parent_failure", async () => {
  const dropped = createDeps({
    commandResults: [{ ok: false, exitCode: 1, output: "fail" }],
    readinessResult: { kind: "ready", ready: [], dropped: [71] },
  });
  const droppedResult = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["test"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: false,
    },
    dropped,
  );
  assert.equal(droppedResult.kind, "parent_failure");

  const failed = createDeps({
    commandResults: [{ ok: false, exitCode: 1, output: "fail" }],
    readinessResult: {
      kind: "parent_failure",
      ready: [],
      dropped: [],
      diagnostics: ["readiness failed"],
    },
  });
  const failedResult = await runAggregateValidation(
    {
      gate: "pre_review",
      commands: ["test"],
      accumulationSha: "acc-1",
      repairAlreadyUsed: false,
    },
    failed,
  );
  assert.equal(failedResult.kind, "parent_failure");
});

test("engine stuck and crashed mark the repair child stuck", async () => {
  const stuck = createDeps({
    commandResults: [{ ok: false, exitCode: 1, output: "fail" }],
    engineOutcome: {
      kind: "stuck",
      reason: "blocked",
      headSha: "head",
      lastFeedback: "blocked here",
      roundsUsed: 1,
    },
  });
  const stuckResult = await runAggregateValidation(
    { gate: "pre_review", commands: ["test"], accumulationSha: "acc-1", repairAlreadyUsed: false },
    stuck,
  );
  assert.equal(stuckResult.kind, "repair_child_stuck");
  assert.deepEqual(stuck.events.slice(-1), ["mark-child-stuck:71"]);

  const crashed = createDeps({
    commandResults: [{ ok: false, exitCode: 1, output: "fail" }],
    engineOutcome: {
      kind: "crashed",
      headSha: "head",
      error: "boom",
      roundsUsed: 1,
    },
  });
  const crashedResult = await runAggregateValidation(
    { gate: "pre_review", commands: ["test"], accumulationSha: "acc-1", repairAlreadyUsed: false },
    crashed,
  );
  assert.equal(crashedResult.kind, "repair_child_stuck");
  assert.deepEqual(crashed.events.slice(-1), ["mark-child-stuck:71"]);
});

test("integration failure marks the repair child stuck", async () => {
  const deps = createDeps({
    commandResults: [{ ok: false, exitCode: 1, output: "fail" }],
    engineOutcome: {
      kind: "approved",
      reviewedBaseSha: "base-1",
      approvedHeadSha: "head-2",
      roundsUsed: 1,
    },
    integrateFailure: { reason: "push_failed", diagnostics: ["push failed"] },
  });

  const result = await runAggregateValidation(
    { gate: "pre_review", commands: ["test"], accumulationSha: "acc-1", repairAlreadyUsed: false },
    deps,
  );
  assert.equal(result.kind, "repair_child_stuck");
  assert.deepEqual(deps.events.slice(-1), ["mark-child-stuck:71"]);
});

test("already satisfied closes the repair child only when rerun is green", async () => {
  const green = createDeps({
    commandResults: [
      { ok: false, exitCode: 1, output: "fail" },
      { ok: true },
    ],
    engineOutcome: {
      kind: "already_satisfied",
      reviewedBaseSha: "base-1",
      headSha: "head-1",
      evidence: "already fixed",
      roundsUsed: 1,
    },
  });

  const greenResult = await runAggregateValidation(
    { gate: "pre_delivery", commands: ["test"], accumulationSha: "acc-1", repairAlreadyUsed: false },
    green,
  );
  assert.deepEqual(greenResult, {
    kind: "repaired",
    childNumber: 71,
    accumulationSha: "acc-1",
  });
  assert.deepEqual(green.events, [
    "command:test:acc-1",
    "publish",
    "mark-budget:pre_delivery:71",
    "readiness",
    "engine:71:pre_delivery",
    "command:test:acc-1",
    "close:71",
    "read-child:71",
  ]);

  const red = createDeps({
    commandResults: [
      { ok: false, exitCode: 1, output: "fail" },
      { ok: false, exitCode: 1, output: "still red" },
    ],
    engineOutcome: {
      kind: "already_satisfied",
      reviewedBaseSha: "base-1",
      headSha: "head-1",
      evidence: "already fixed",
      roundsUsed: 1,
    },
  });
  const redResult = await runAggregateValidation(
    { gate: "pre_delivery", commands: ["test"], accumulationSha: "acc-1", repairAlreadyUsed: false },
    red,
  );
  assert.deepEqual(redResult, {
    kind: "repair_child_stuck",
    childNumber: 71,
    failure: {
      gate: "pre_delivery",
      command: "test",
      exitCode: 1,
      output: "still red",
      accumulationSha: "acc-1",
    },
    diagnostics: ["Aggregate validation remained red after already-satisfied repair child."],
  });
  assert.deepEqual(red.events, [
    "command:test:acc-1",
    "publish",
    "mark-budget:pre_delivery:71",
    "readiness",
    "engine:71:pre_delivery",
    "command:test:acc-1",
    "mark-child-stuck:71",
  ]);
});

function createDeps(options: {
  commandResults?: Array<{ ok: true } | { ok: false; exitCode: number; output: string }>;
  readinessResult?: {
    kind: "ready";
    ready: GitHubIssueRecord[];
    dropped: number[];
  } | {
    kind: "parent_failure";
    ready: GitHubIssueRecord[];
    dropped: number[];
    diagnostics: string[];
  };
  engineOutcome?: AggregateValidationDeps["runEngine"] extends (...args: never[]) => Promise<infer T> ? T : never;
  integratedHeadSha?: string;
  integrateFailure?: { reason: string; diagnostics: string[] };
} = {}): AggregateValidationDeps & {
  events: string[];
  publishedDrafts: Array<{ title: string; body: string }>;
} {
  const events: string[] = [];
  const publishedDrafts: Array<{ title: string; body: string }> = [];
  const child = issue(71, "Repair child");
  let issueState: "OPEN" | "CLOSED" = "OPEN";
  const commandResults = [...(options.commandResults ?? [])];

  return {
    parent: issue(4, "Parent"),
    accumulationBranch: "issue-42",
    queueLabel: "parent-4",
    siblingSummaries: [],
    events,
    publishedDrafts,
    async runValidationCommand({ command, accumulationSha }) {
      events.push(`command:${command}:${accumulationSha}`);
      return commandResults.shift() ?? { ok: true };
    },
    async publishChildren({ drafts }) {
      events.push("publish");
      publishedDrafts.push({ title: drafts[0]!.title, body: drafts[0]!.body });
      return { ok: true, children: [child], duplicateNumbers: [] };
    },
    async markRepairBudgetUsed({ gate, childNumber }) {
      events.push(`mark-budget:${gate}:${childNumber}`);
    },
    async readiness() {
      events.push("readiness");
      return options.readinessResult ?? { kind: "ready", ready: [child], dropped: [] };
    },
    async runEngine({ child, gate }) {
      events.push(`engine:${child.number}:${gate}`);
      return options.engineOutcome ?? {
        kind: "approved",
        reviewedBaseSha: "base-1",
        approvedHeadSha: "head-2",
        roundsUsed: 1,
      };
    },
    async integrate({ childNumber }) {
      events.push(`integrate:${childNumber}`);
      if (options.integrateFailure) {
        return { ok: false as const, ...options.integrateFailure };
      }
      return {
        ok: true as const,
        accumulationHeadSha: options.integratedHeadSha ?? "acc-2",
        recoveredFrom: null,
      };
    },
    async closeChild({ childNumber }) {
      events.push(`close:${childNumber}`);
      issueState = "CLOSED";
    },
    async readChild({ childNumber }) {
      events.push(`read-child:${childNumber}`);
      return { state: issueState };
    },
    async markChildStuck({ childNumber }) {
      events.push(`mark-child-stuck:${childNumber}`);
    },
  };
}

function issue(number: number, title: string): GitHubIssueRecord {
  return {
    id: number + 1000,
    number,
    title,
    body: `${title} body`,
    state: "OPEN",
    labels: [],
    comments: [],
  };
}
