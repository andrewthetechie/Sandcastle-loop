import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubIssueRecord } from "./github-issues.mts";
import { runIssueAsPrdParent, type IssueAsPrdOrchestratorDeps } from "./issue-as-prd-orchestrator.mts";
import type { InitialDecompositionAcquisition } from "./issue-as-prd-contracts.mts";
import type { IssueAsPrdParentState } from "./issue-as-prd-state.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";

test("ownership disagreement returns ownership_ambiguous", async () => {
  const deps = createDeps({
    verifyOwnership: { ok: false, diagnostics: ["queue label mismatch"] },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "ownership_ambiguous",
    reason: "Recorded phase 'claimed' disagrees with observed parent state.",
    diagnostics: ["queue label mismatch"],
  });
});

test("zero-draft direct parent approval still gets one full review and clean delivery", async () => {
  const deps = createDeps({
    initialDecomposition: successNoWork(),
    directParentOutcome: approved(sha("1"), sha("2")),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
    terminal: { observedMainlineSha: sha("f"), rebaseNeeded: false },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "clean_delivery",
    accumulationHeadSha: sha("2"),
    observedMainlineSha: sha("f"),
    rebaseNeeded: false,
  });
  assert.deepEqual(deps.events, [
    "verify-ownership",
    "read-accumulation-head",
    "list-children",
    "acquire-initial",
    `direct-parent:${sha("1")}`,
    "persist:initial_drained",
    "refresh",
    "persist:initial_drained",
    `aggregate:pre_review:${sha("2")}:0`,
    "persist:pre_review_ready",
    `full-review:${sha("2")}:${sha("1")}`,
    "persist:full_parent_reviewed",
    "persist:followups_drained",
    `aggregate:pre_delivery:${sha("2")}:0`,
    "persist:pre_delivery_ready",
    "observe-terminal",
    "persist:pre_delivery_ready",
  ]);
});

test("two approved initial children drain sequentially and second base equals first integration head", async () => {
  const deps = createDeps({
    initialDecomposition: successIssues([
      initialDraft("Child A"),
      initialDraft("Child B"),
    ]),
    children: [child(101, "Child A"), child(102, "Child B")],
    childOutcomes: new Map([
      [101, approved(sha("1"), sha("2"))],
      [102, approved(sha("2"), sha("3"))],
    ]),
    integratedHeads: new Map([
      [101, sha("2")],
      [102, sha("3")],
    ]),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.equal(result.kind, "clean_delivery");
  assert.deepEqual(deps.childEngineBases, [
    { childNumber: 101, accumulationSha: sha("1"), source: "initial" },
    { childNumber: 102, accumulationSha: sha("2"), source: "initial" },
  ]);
});

test("resuming after child publication applies readiness before draining children", async () => {
  const deps = createDeps({
    state: state({ phase: "decomposed" }),
    children: [child(101, "Child A")],
    childOutcomes: new Map([[101, stuck("blocked")]]),
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.equal(result.kind, "parent_stuck");
  assert.deepEqual(deps.events, [
    "verify-ownership",
    "read-accumulation-head",
    "list-children",
    "readiness",
    "persist:initial_ready",
    "list-children",
    `child-engine:101:initial:${sha("1")}`,
    "mark-child-stuck:101",
  ]);
});

test("first initial child stuck with no integrated work returns parent_stuck", async () => {
  const deps = createDeps({
    initialDecomposition: successIssues([initialDraft("Child A")]),
    children: [child(101, "Child A")],
    childOutcomes: new Map([[101, stuck("blocked")]]),
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "parent_stuck",
    accumulationHeadSha: sha("1"),
    reason: "initial_child_failed_no_integrated_work",
    diagnostics: ["blocked"],
  });
});

test("already-stuck initial child with no integrated work uses failed-child parent reason", async () => {
  const stuckChild = child(101, "Child A");
  stuckChild.labels.push({ name: "agent-stuck" });
  const deps = createDeps({
    state: state({ phase: "initial_ready" }),
    children: [stuckChild],
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.deepEqual(result, {
    kind: "parent_stuck",
    accumulationHeadSha: sha("1"),
    reason: "initial_child_failed_no_integrated_work",
    diagnostics: ["Initial drain produced no integrated reviewable work; stuck children: #101."],
  });
});

test("later initial child stuck yields partial delivery after one full review", async () => {
  const deps = createDeps({
    initialDecomposition: successIssues([
      initialDraft("Child A"),
      initialDraft("Child B"),
    ]),
    children: [child(101, "Child A"), child(102, "Child B")],
    childOutcomes: new Map<
      number,
      ReturnType<typeof approved> | ReturnType<typeof alreadySatisfied> | ReturnType<typeof stuck> | ReturnType<typeof crashed>
    >([
      [101, approved(sha("1"), sha("2"))],
      [102, stuck("needs human")],
    ]),
    integratedHeads: new Map([[101, sha("2")]]),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
    terminal: { observedMainlineSha: sha("f"), rebaseNeeded: true },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "partial_delivery",
    accumulationHeadSha: sha("2"),
    observedMainlineSha: sha("f"),
    rebaseNeeded: true,
    stuckChildNumber: 102,
  });
  assert.equal(deps.fullReviewCalls, 1);
});

test("full-parent review acquisition failure becomes parent_stuck even after integrated work", async () => {
  const deps = createDeps({
    initialDecomposition: successIssues([initialDraft("Child A")]),
    children: [child(101, "Child A")],
    childOutcomes: new Map([[101, approved(sha("1"), sha("2"))]]),
    integratedHeads: new Map([[101, sha("2")]]),
    fullReview: {
      kind: "acquisition_failed",
      diagnostics: ["review parser failed twice"],
      artifactPaths: ["/tmp/a", "/tmp/b"],
    },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "parent_stuck",
    accumulationHeadSha: sha("2"),
    reason: "full_parent_review_acquisition_failed",
    diagnostics: ["review parser failed twice"],
  });
});

test("aggregate repair child stuck yields partial delivery instead of parent_stuck", async () => {
  const deps = createDeps({
    state: state({ phase: "initial_drained" }),
    aggregation: new Map([
      [
        "pre_review",
        {
          kind: "repair_child_stuck" as const,
          childNumber: 850,
          failure: {
            gate: "pre_review" as const,
            command: "npm test",
            exitCode: 1,
            output: "still red",
            accumulationSha: sha("1"),
          },
          diagnostics: ["repair child could not make the aggregate gate green"],
        },
      ],
    ]),
    terminal: { observedMainlineSha: sha("f"), rebaseNeeded: false },
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.deepEqual(result, {
    kind: "partial_delivery",
    accumulationHeadSha: sha("1"),
    observedMainlineSha: sha("f"),
    rebaseNeeded: false,
    stuckChildNumber: 850,
  });
  assert.equal(deps.fullReviewCalls, 0);
});

test("initial already_satisfied closes only after empty-diff verification", async () => {
  const deps = createDeps({
    initialDecomposition: successIssues([initialDraft("Child A")]),
    children: [child(101, "Child A")],
    childOutcomes: new Map([[101, alreadySatisfied(sha("1"), sha("2"), "done")]]),
    initialAlreadySatisfied: { ok: true, empty: true, evidence: "empty diff" },
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.equal(result.kind, "parent_stuck");
  assert.ok(deps.events.includes("close-already-satisfied:101"));
  // The children were pre-published, so the only decomposition run is the
  // one recovery attempt the starved queue earned before sticking.
  assert.equal(
    deps.events.filter((event) => event === "acquire-initial").length,
    1,
  );
});

test("starved child queue re-decomposes once and drains the fresh children", async () => {
  const deps = createDeps({
    state: state({ phase: "initial_ready" }),
    initialDecomposition: successIssues([initialDraft("Child A")]),
    childOutcomes: new Map([[101, approved(sha("1"), sha("2"))]]),
    integratedHeads: new Map([[101, sha("2")]]),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.equal(result.kind, "clean_delivery");
  assert.equal(
    deps.events.filter((event) => event === "acquire-initial").length,
    1,
  );
  assert.deepEqual(deps.childEngineBases, [
    { childNumber: 101, accumulationSha: sha("1"), source: "initial" },
  ]);
});

test("direct parent already_satisfied with verified empty diff completes the parent", async () => {
  const deps = createDeps({
    initialDecomposition: successNoWork(),
    directParentOutcome: alreadySatisfied(sha("1"), sha("1"), "feature already on base"),
    initialAlreadySatisfied: { ok: true, empty: true, evidence: "trees match" },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.deepEqual(result, {
    kind: "parent_already_complete",
    accumulationHeadSha: sha("1"),
    evidence: "feature already on base\n\ntrees match",
  });
});

test("terminal recorded phase refuses to run instead of falling through to delivery", async () => {
  const deps = createDeps({ state: state({ phase: "failed" }) });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.equal(result.kind, "ownership_ambiguous");
  if (result.kind !== "ownership_ambiguous") return;
  assert.match(result.reason, /terminal phase 'failed'/);
  assert.deepEqual(deps.events, []);
});

test("direct parent already_satisfied with a non-empty diff stays parent_stuck", async () => {
  const deps = createDeps({
    initialDecomposition: successNoWork(),
    directParentOutcome: alreadySatisfied(sha("1"), sha("2"), "claimed done"),
    initialAlreadySatisfied: { ok: true, empty: false, evidence: "" },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.equal(result.kind, "parent_stuck");
  if (result.kind !== "parent_stuck") return;
  assert.equal(result.reason, "direct_parent_already_satisfied");
});

test("follow-up already_satisfied becomes partial delivery and never runs a second full review", async () => {
  const deps = createDeps({
    state: state({ phase: "followups_ready", completedExtraReviewRounds: 1 }),
    accumulationHeadSha: sha("2"),
    children: [child(201, "Follow-up")],
    childOutcomes: new Map([[201, alreadySatisfied(sha("2"), sha("2"), "done")]]),
    terminal: { observedMainlineSha: sha("f"), rebaseNeeded: false },
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.deepEqual(result, {
    kind: "partial_delivery",
    accumulationHeadSha: sha("2"),
    observedMainlineSha: sha("f"),
    rebaseNeeded: false,
    stuckChildNumber: 201,
  });
  assert.equal(deps.fullReviewCalls, 0);
});

test("pre-review and pre-delivery repair budgets are routed independently", async () => {
  const deps = createDeps({
    state: state({ phase: "initial_drained" }),
    aggregation: new Map([
      ["pre_review", { kind: "repaired", childNumber: 301, accumulationSha: sha("4") }],
      ["pre_delivery", { kind: "repaired", childNumber: 302, accumulationSha: sha("5") }],
    ]),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.equal(result.kind, "clean_delivery");
  const budgetChanges = deps.persistedRepairBudgets.filter((value, index, all) =>
    (index === 0 ||
      value.pre_review !== all[index - 1]!.pre_review ||
      value.pre_delivery !== all[index - 1]!.pre_delivery) &&
    !(value.pre_review === 0 && value.pre_delivery === 0)
  );
  assert.deepEqual(budgetChanges, [
    { pre_review: 1, pre_delivery: 0 },
    { pre_review: 1, pre_delivery: 1 },
  ]);
});

test("resume from pre_delivery_ready skips earlier phases and returns rebase-needed clean delivery", async () => {
  const deps = createDeps({
    state: state({
      phase: "pre_delivery_ready",
      fullParentReviewBaseSha: sha("6"),
      rebaseConflictDiagnostics: ["conflict"],
    }),
    accumulationHeadSha: sha("7"),
    terminal: { observedMainlineSha: sha("6"), rebaseNeeded: true },
  });

  const result = await runIssueAsPrdParent(input({ state: deps.state }), deps);

  assert.deepEqual(result, {
    kind: "clean_delivery",
    accumulationHeadSha: sha("7"),
    observedMainlineSha: sha("6"),
    rebaseNeeded: true,
  });
  assert.deepEqual(deps.events, [
    "verify-ownership",
    "read-accumulation-head",
    "observe-terminal",
    "persist:pre_delivery_ready",
  ]);
});

function input(overrides: { state?: IssueAsPrdParentState } = {}) {
  return {
    parent: parent(),
    state: overrides.state ?? state(),
    normalizedContext: context(),
  };
}

function createDeps(options: {
  state?: IssueAsPrdParentState;
  accumulationHeadSha?: string;
  verifyOwnership?: { ok: true } | { ok: false; diagnostics: string[] };
  initialDecomposition?: InitialDecompositionAcquisition;
  children?: GitHubIssueRecord[];
  childOutcomes?: Map<number, ReturnType<typeof approved> | ReturnType<typeof alreadySatisfied> | ReturnType<typeof stuck> | ReturnType<typeof crashed>>;
  integratedHeads?: Map<number, string>;
  initialAlreadySatisfied?: { ok: true; empty: boolean; evidence: string } | { ok: false; diagnostics: string[] };
  directParentOutcome?: ReturnType<typeof approved> | ReturnType<typeof alreadySatisfied> | ReturnType<typeof stuck> | ReturnType<typeof crashed>;
  refresh?: {
    kind: "unchanged";
    accumulationHeadSha: string;
    reviewBaseSha: string;
    fetchedMainlineSha: string;
  } | {
    kind: "rebased";
    accumulationHeadSha: string;
    reviewBaseSha: string;
    fetchedMainlineSha: string;
    diagnosticCheckpoint: string;
  } | {
    kind: "conflict";
    accumulationHeadSha: string;
    reviewBaseSha: string;
    attemptedMainlineSha: string;
    diagnosticCheckpoint: string;
    diagnostics: string[];
  };
  aggregation?: Map<string, { kind: "green" } | { kind: "repaired"; childNumber: number; accumulationSha: string } | { kind: "repair_child_stuck"; childNumber: number; failure: { gate: "pre_review" | "pre_delivery"; command: string; exitCode: number; output: string; accumulationSha: string }; diagnostics: string[] } | { kind: "parent_failure"; failure: { gate: "pre_review" | "pre_delivery"; command: string; exitCode: number; output: string; accumulationSha: string }; diagnostics: string[] }>;
  fullReview?: { kind: "reviewed"; followupDrafts: any[]; artifactPaths: string[] } | { kind: "acquisition_failed"; diagnostics: string[]; artifactPaths: string[] };
  terminal?: { observedMainlineSha: string; rebaseNeeded: boolean };
} = {}): IssueAsPrdOrchestratorDeps & {
  state: IssueAsPrdParentState;
  events: string[];
  childEngineBases: Array<{ childNumber: number; accumulationSha: string; source: "initial" | "review_followup" }>;
  fullReviewCalls: number;
  persistedRepairBudgets: Array<{ pre_review: 0 | 1; pre_delivery: 0 | 1 }>;
} {
  const currentState = options.state ?? state();
  const events: string[] = [];
  const childEngineBases: Array<{ childNumber: number; accumulationSha: string; source: "initial" | "review_followup" }> = [];
  const children = options.children ? [...options.children] : [];
  const childOutcomes = options.childOutcomes ?? new Map();
  const integratedHeads = options.integratedHeads ?? new Map<number, string>();
  let accumulationHeadSha = options.accumulationHeadSha ?? sha("1");
  let fullReviewCalls = 0;
  const persistedRepairBudgets: Array<{ pre_review: 0 | 1; pre_delivery: 0 | 1 }> = [];

  return {
    state: currentState,
    events,
    childEngineBases,
    get fullReviewCalls() {
      return fullReviewCalls;
    },
    persistedRepairBudgets,
    mainlineRef: "origin/main",
    preReviewValidationCommands: ["test"],
    preDeliveryValidationCommands: ["test"],
    now() {
      return "2026-07-02T12:00:00.000Z";
    },
    async verifyOwnership() {
      events.push("verify-ownership");
      return options.verifyOwnership ?? { ok: true as const };
    },
    async readAccumulationHead() {
      events.push("read-accumulation-head");
      return accumulationHeadSha;
    },
    async acquireInitialDecomposition() {
      events.push("acquire-initial");
      return options.initialDecomposition ?? successNoWork();
    },
    async persistState(next) {
      events.push(`persist:${next.phase}`);
      currentState.phase = next.phase;
      currentState.completedExtraReviewRounds = next.completedExtraReviewRounds;
      currentState.aggregateValidationRepairs = next.aggregateValidationRepairs;
      currentState.partialCauseChildNumber = next.partialCauseChildNumber;
      currentState.fullParentReviewBaseSha = next.fullParentReviewBaseSha;
      currentState.attemptedMainlineSha = next.attemptedMainlineSha;
      currentState.rebaseConflictDiagnostics = next.rebaseConflictDiagnostics;
      currentState.latestMainlineShaAtDelivery = next.latestMainlineShaAtDelivery;
      persistedRepairBudgets.push({ ...next.aggregateValidationRepairs });
    },
    async publishChildren({ drafts }) {
      events.push("publish-children");
      if (children.length === 0) {
        for (const [index, draft] of drafts.entries()) {
          children.push(child(100 + index + 1, draft.title));
        }
      }
      return { ok: true as const, children, duplicateNumbers: [] };
    },
    async listChildren() {
      events.push("list-children");
      return children.filter((child) => child.state !== "CLOSED");
    },
    async readiness({ children }) {
      events.push("readiness");
      return { kind: "ready" as const, ready: [...children], dropped: [] };
    },
    async runChildEngine({ child, accumulationSha, source }) {
      events.push(`child-engine:${child.number}:${source}:${accumulationSha}`);
      childEngineBases.push({ childNumber: child.number, accumulationSha, source });
      return childOutcomes.get(child.number) ?? approved(accumulationSha, sha(String(child.number).slice(-1) || "9"));
    },
    async runDirectParentEngine({ accumulationSha }) {
      events.push(`direct-parent:${accumulationSha}`);
      const outcome = options.directParentOutcome ?? approved(accumulationSha, sha("2"));
      if (outcome.kind === "approved") accumulationHeadSha = outcome.approvedHeadSha;
      return outcome;
    },
    async verifyInitialAlreadySatisfied() {
      events.push("verify-initial-already-satisfied");
      return options.initialAlreadySatisfied ?? { ok: true as const, empty: false, evidence: "" };
    },
    async closeAlreadySatisfiedChild({ child }) {
      events.push(`close-already-satisfied:${child.number}`);
      child.state = "CLOSED";
    },
    async markChildStuck({ child }) {
      events.push(`mark-child-stuck:${child.number}`);
      child.labels.push({ name: "agent-stuck" });
    },
    async integrateChild({ childNumber }) {
      events.push(`integrate:${childNumber}`);
      const next = integratedHeads.get(childNumber) ?? sha(String(childNumber).slice(-1) || "9");
      accumulationHeadSha = next;
      const issue = children.find((child) => child.number === childNumber);
      if (issue) issue.state = "CLOSED";
      return { ok: true as const, accumulationHeadSha: next, recoveredFrom: null };
    },
    async refreshBeforeReview() {
      events.push("refresh");
      return options.refresh ?? {
        kind: "unchanged" as const,
        accumulationHeadSha,
        reviewBaseSha: currentState.fullParentReviewBaseSha,
        fetchedMainlineSha: currentState.fullParentReviewBaseSha,
      };
    },
    async runAggregateValidation({ gate, accumulationSha, repairAlreadyUsed }) {
      events.push(`aggregate:${gate}:${accumulationSha}:${repairAlreadyUsed ? 1 : 0}`);
      return options.aggregation?.get(gate) ?? { kind: "green" as const };
    },
    async runFullParentExtraReview({ accumulationHeadSha, reviewBaseSha }) {
      fullReviewCalls += 1;
      events.push(`full-review:${accumulationHeadSha}:${reviewBaseSha}`);
      return options.fullReview ?? { kind: "reviewed" as const, followupDrafts: [], artifactPaths: [] };
    },
    async observeTerminalMainline() {
      events.push("observe-terminal");
      return options.terminal ?? { observedMainlineSha: sha("f"), rebaseNeeded: false };
    },
  };
}

function parent(): GitHubIssueRecord {
  return {
    id: 4,
    number: 4,
    title: "Parent",
    body: "Parent body",
    state: "OPEN",
    labels: [{ name: "agent-in-progress" }, { name: "parent-4" }],
    comments: [],
  };
}

function context(): NormalizedParentContext {
  return {
    body: "Parent body",
    comments: "",
    rendered: "Parent body",
    omittedCommentCount: 0,
  };
}

function state(
  overrides: Partial<IssueAsPrdParentState> = {},
): IssueAsPrdParentState {
  return {
    schemaVersion: 1,
    parentNumber: 4,
    accumulationBranch: "issue-4-accumulation",
    originalForkSha: sha("a"),
    fullParentReviewBaseSha: sha("1"),
    attemptedMainlineSha: null,
    latestMainlineShaAtDelivery: null,
    phase: "claimed",
    queueLabel: "parent-4",
    completedExtraReviewRounds: 0,
    aggregateValidationRepairs: { pre_review: 0, pre_delivery: 0 },
    rebaseConflictDiagnostics: [],
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

function child(number: number, title: string): GitHubIssueRecord {
  return {
    id: number + 1000,
    number,
    title,
    body: `${title} body`,
    state: "OPEN",
    labels: [{ name: "parent-4" }],
    comments: [],
  };
}

function initialDraft(title: string) {
  return {
    title,
    body: `${title} body`,
    priority: "high" as const,
    files: [],
    dedupe_key: title.toLowerCase().replace(/\s+/g, "-"),
  };
}

function successIssues(issues: ReturnType<typeof initialDraft>[]): InitialDecompositionAcquisition {
  return {
    ok: true,
    result: {
      kind: "initial_issue_decomposition",
      status: "issues",
      summary: "summary",
      issues,
      needs_human_review_reason: "",
    },
    attemptsUsed: 1,
    artifacts: [{ attempt: 1, stdout: "", diagnostics: [] }],
    diagnostics: [],
  };
}

function successNoWork(): InitialDecompositionAcquisition {
  return {
    ok: true,
    result: {
      kind: "initial_issue_decomposition",
      status: "no_work",
      summary: "none",
      issues: [],
      needs_human_review_reason: "",
    },
    attemptsUsed: 1,
    artifacts: [{ attempt: 1, stdout: "", diagnostics: [] }],
    diagnostics: [],
  };
}

function approved(reviewedBaseSha: string, approvedHeadSha: string) {
  return {
    kind: "approved" as const,
    reviewedBaseSha,
    approvedHeadSha,
    roundsUsed: 1,
  };
}

function alreadySatisfied(reviewedBaseSha: string, headSha: string, evidence: string) {
  return {
    kind: "already_satisfied" as const,
    reviewedBaseSha,
    headSha,
    evidence,
    roundsUsed: 1,
  };
}

function stuck(lastFeedback: string) {
  return {
    kind: "stuck" as const,
    reason: "blocked" as const,
    headSha: sha("b"),
    lastFeedback,
    roundsUsed: 1,
  };
}

function crashed(error: string) {
  return {
    kind: "crashed" as const,
    headSha: sha("c"),
    error,
    roundsUsed: 1,
  };
}

function sha(hex: string): string {
  return hex.repeat(40).slice(0, 40);
}

test("claimed parent with already-published children resumes from decomposed without re-running decomposition", async () => {
  const deps = createDeps({
    children: [child(101, "Child A")],
    childOutcomes: new Map([[101, approved(sha("1"), sha("2"))]]),
    integratedHeads: new Map([[101, sha("2")]]),
    fullReview: { kind: "reviewed", followupDrafts: [], artifactPaths: [] },
  });

  const result = await runIssueAsPrdParent(input(), deps);

  assert.equal(result.kind, "clean_delivery");
  assert.ok(!deps.events.includes("acquire-initial"));
  assert.ok(!deps.events.includes("publish-children"));
  assert.equal(
    deps.events.filter((event) => event === "persist:decomposed").length,
    1,
  );
  assert.equal(
    deps.events.filter((event) => event === "readiness").length,
    1,
  );
});
