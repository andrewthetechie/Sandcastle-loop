import type {
  ObservedParentRecoveryState,
  ParentStateReconciliation,
} from "./issue-as-prd-state-contracts.mts";
import { ISSUE_AS_PRD_STATE_MARKER } from "./issue-parent-context.mts";

export const ISSUE_AS_PRD_STATE_SCHEMA_VERSION = 2 as const;

export type ParentPhase =
  | "claimed"
  | "decomposed"
  | "initial_ready"
  | "initial_queue"
  | "initial_drained"
  | "pre_review_ready"
  | "full_parent_reviewed"
  | "followups_ready"
  | "followup_queue"
  | "followups_drained"
  | "pre_delivery_ready"
  | "delivered"
  | "failed";

export const PARENT_PHASES: readonly ParentPhase[] = [
  "claimed",
  "decomposed",
  "initial_ready",
  "initial_queue",
  "initial_drained",
  "pre_review_ready",
  "full_parent_reviewed",
  "followups_ready",
  "followup_queue",
  "followups_drained",
  "pre_delivery_ready",
  "delivered",
  "failed",
];

export interface MainlineRefreshJournal {
  preRebaseAccumulationSha: string;
  targetMainlineSha: string;
  candidateSha: string;
}

export interface IssueAsPrdParentState {
  schemaVersion: 1 | typeof ISSUE_AS_PRD_STATE_SCHEMA_VERSION;
  parentNumber: number;
  accumulationBranch: string;
  originalForkSha: string;
  fullParentReviewBaseSha: string;
  attemptedMainlineSha: string | null;
  latestMainlineShaAtDelivery: string | null;
  phase: ParentPhase;
  queueLabel: string;
  completedExtraReviewRounds: number;
  aggregateValidationRepairs: { pre_review: 0 | 1; pre_delivery: 0 | 1 };
  rebaseConflictDiagnostics: string[];
  // Optional only at the TypeScript boundary so persisted v1 fixture shapes
  // remain constructible; parser/claim/transition always materialize them.
  accumulationDiverged?: boolean;
  mainlineRefresh?: MainlineRefreshJournal | null;
  partialCauseChildNumber: number | null;
  lastTransitionAt: string;
}

export function parseParentStateComment(
  body: string,
):
  | { ok: true; state: IssueAsPrdParentState }
  | { ok: false; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const markerMatches = body.match(markerRegex()) ?? [];
  if (markerMatches.length === 0) {
    return { ok: false, diagnostics: ["Missing state marker comment."] };
  }
  if (markerMatches.length > 1) {
    return {
      ok: false,
      diagnostics: [`Expected exactly one state marker comment, found ${markerMatches.length}.`],
    };
  }

  const tagMatches = [...body.matchAll(tagRegex())];
  if (tagMatches.length === 0) {
    return {
      ok: false,
      diagnostics: ["Missing <sandcastle_issue_as_prd_state>...</sandcastle_issue_as_prd_state> block."],
    };
  }
  if (tagMatches.length > 1) {
    return {
      ok: false,
      diagnostics: [`Expected exactly one state tag block, found ${tagMatches.length}.`],
    };
  }

  const match = tagMatches[0]!;
  const wrapped = renderEnvelope(match[1]!.trim());
  if (body.trim() !== wrapped.trim()) {
    diagnostics.push("Unexpected text outside the state comment wrapper.");
  }

  const rawJson = match[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    diagnostics.push(
      `State JSON could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, diagnostics };
  }

  if (!isRecord(parsed)) {
    diagnostics.push("State JSON must be an object.");
    return { ok: false, diagnostics };
  }

  const state = parseStateObject(migrateSchemaOneState(parsed), diagnostics);
  if (!state || diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, state };
}

export function renderParentStateComment(state: IssueAsPrdParentState): string {
  const validated = parseStateObject(state as unknown as Record<string, unknown>, []);
  if (!validated) {
    throw new Error("Cannot render invalid IssueAsPrdParentState.");
  }
  return renderEnvelope(JSON.stringify(state, null, 2));
}

export function reconcileParentState(input: {
  parentNumber: number;
  comments: readonly { id: number; body: string }[];
  observed: ObservedParentRecoveryState;
}): ParentStateReconciliation<IssueAsPrdParentState> {
  const markedComments = input.comments.filter((comment) =>
    comment.body.includes(ISSUE_AS_PRD_STATE_MARKER),
  );
  if (markedComments.length === 0) return { kind: "create" };
  if (markedComments.length > 1) {
    return {
      kind: "disagreement",
      diagnostics: [`Expected exactly one marked state comment, found ${markedComments.length}.`],
    };
  }

  const comment = markedComments[0]!;
  const parsed = parseParentStateComment(comment.body);
  if (!parsed.ok) {
    return { kind: "disagreement", diagnostics: parsed.diagnostics };
  }

  const diagnostics = reconcileObservedState(
    input.parentNumber,
    parsed.state,
    input.observed,
  );
  if (diagnostics.length > 0) {
    return { kind: "disagreement", diagnostics };
  }

  return { kind: "resume", commentId: comment.id, state: parsed.state };
}

export function nextParentState(input: {
  previous: IssueAsPrdParentState | null;
  next: Omit<IssueAsPrdParentState, "lastTransitionAt" | "accumulationDiverged" | "mainlineRefresh"> &
    Partial<Pick<IssueAsPrdParentState, "accumulationDiverged" | "mainlineRefresh">>;
  now: string;
}): IssueAsPrdParentState {
  const durableNext = {
    ...input.next,
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    accumulationDiverged: input.next.accumulationDiverged ?? false,
    mainlineRefresh: input.next.mainlineRefresh ?? null,
  };
  const nextState: IssueAsPrdParentState = {
    ...durableNext,
    lastTransitionAt:
      input.previous && durableFieldsEqual(input.previous, durableNext)
        ? input.previous.lastTransitionAt
        : input.now,
  };
  const diagnostics: string[] = [];
  const parsed = parseStateObject(
    nextState as unknown as Record<string, unknown>,
    diagnostics,
  );
  if (!parsed || diagnostics.length > 0) {
    throw new Error(`Invalid IssueAsPrdParentState transition: ${diagnostics.join("; ")}`);
  }
  return nextState;
}

function parseStateObject(
  value: Record<string, unknown>,
  diagnostics: string[],
): IssueAsPrdParentState | null {
  const expectedKeys = new Set([
    "schemaVersion",
    "parentNumber",
    "accumulationBranch",
    "originalForkSha",
    "fullParentReviewBaseSha",
    "attemptedMainlineSha",
    "latestMainlineShaAtDelivery",
    "phase",
    "queueLabel",
    "completedExtraReviewRounds",
    "aggregateValidationRepairs",
    "rebaseConflictDiagnostics",
    "accumulationDiverged",
    "mainlineRefresh",
    "partialCauseChildNumber",
    "lastTransitionAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      diagnostics.push(`Unexpected field '${key}'.`);
    }
  }

  const schemaVersion = exactNumberField(value, "schemaVersion", diagnostics);
  const parentNumber = positiveIntegerField(value, "parentNumber", diagnostics);
  const accumulationBranch = nonEmptyStringField(value, "accumulationBranch", diagnostics);
  const originalForkSha = shaField(value, "originalForkSha", diagnostics);
  const fullParentReviewBaseSha = shaField(
    value,
    "fullParentReviewBaseSha",
    diagnostics,
  );
  const attemptedMainlineSha = nullableShaField(
    value,
    "attemptedMainlineSha",
    diagnostics,
  );
  const latestMainlineShaAtDelivery = nullableShaField(
    value,
    "latestMainlineShaAtDelivery",
    diagnostics,
  );
  const phase = phaseField(value, "phase", diagnostics);
  const queueLabel = nonEmptyStringField(value, "queueLabel", diagnostics);
  const completedExtraReviewRounds = nonNegativeIntegerField(
    value,
    "completedExtraReviewRounds",
    diagnostics,
  );
  const aggregateValidationRepairs = aggregateRepairField(
    value,
    "aggregateValidationRepairs",
    diagnostics,
  );
  const rebaseConflictDiagnostics = stringArrayField(
    value,
    "rebaseConflictDiagnostics",
    diagnostics,
  );
  const accumulationDiverged = booleanField(value, "accumulationDiverged", diagnostics);
  const mainlineRefresh = mainlineRefreshField(value, "mainlineRefresh", diagnostics);
  const partialCauseChildNumber = nullablePositiveIntegerField(
    value,
    "partialCauseChildNumber",
    diagnostics,
  );
  const lastTransitionAt = isoTimestampField(value, "lastTransitionAt", diagnostics);

  if (schemaVersion !== ISSUE_AS_PRD_STATE_SCHEMA_VERSION) {
    diagnostics.push(
      `Unsupported schemaVersion '${String(schemaVersion)}'; expected ${ISSUE_AS_PRD_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (
    parentNumber !== undefined &&
    queueLabel !== undefined &&
    queueLabel !== parentQueueLabel(parentNumber)
  ) {
    diagnostics.push(
      `queueLabel must equal ${parentQueueLabel(parentNumber)} for parent #${parentNumber}.`,
    );
  }

  if (
    parentNumber === undefined ||
    accumulationBranch === undefined ||
    originalForkSha === undefined ||
    fullParentReviewBaseSha === undefined ||
    attemptedMainlineSha === undefined ||
    latestMainlineShaAtDelivery === undefined ||
    phase === undefined ||
    queueLabel === undefined ||
    completedExtraReviewRounds === undefined ||
    aggregateValidationRepairs === undefined ||
    rebaseConflictDiagnostics === undefined ||
    accumulationDiverged === undefined ||
    mainlineRefresh === undefined ||
    partialCauseChildNumber === undefined ||
    lastTransitionAt === undefined
  ) {
    return null;
  }

  return {
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    parentNumber,
    accumulationBranch,
    originalForkSha,
    fullParentReviewBaseSha,
    attemptedMainlineSha,
    latestMainlineShaAtDelivery,
    phase,
    queueLabel,
    completedExtraReviewRounds,
    aggregateValidationRepairs,
    rebaseConflictDiagnostics,
    accumulationDiverged,
    mainlineRefresh,
    partialCauseChildNumber,
    lastTransitionAt,
  };
}

function reconcileObservedState(
  parentNumber: number,
  state: IssueAsPrdParentState,
  observed: ObservedParentRecoveryState,
): string[] {
  const diagnostics: string[] = [];
  if (state.parentNumber !== parentNumber) {
    diagnostics.push(
      `State parentNumber ${state.parentNumber} does not match requested parent #${parentNumber}.`,
    );
  }

  if (!observed.accumulationBranchExists) {
    diagnostics.push(`Accumulation branch '${state.accumulationBranch}' is missing.`);
  }
  if (observed.localAccumulationHeadSha === null) {
    diagnostics.push("Local accumulation head SHA is missing.");
  }
  if (observed.remoteAccumulationHeadSha === null) {
    diagnostics.push("Remote accumulation head SHA is missing.");
  }
  const journalOwnedHeads = state.mainlineRefresh
    ? new Set([
        state.mainlineRefresh.preRebaseAccumulationSha,
        state.mainlineRefresh.candidateSha,
      ])
    : null;
  const inFlightPromotion =
    journalOwnedHeads !== null &&
    observed.localAccumulationHeadSha !== null &&
    observed.remoteAccumulationHeadSha !== null &&
    journalOwnedHeads.has(observed.localAccumulationHeadSha) &&
    journalOwnedHeads.has(observed.remoteAccumulationHeadSha);
  if (
    state.mainlineRefresh &&
    observed.localAccumulationHeadSha !== null &&
    !journalOwnedHeads!.has(observed.localAccumulationHeadSha)
  ) {
    diagnostics.push(
      `In-flight refresh journal does not own local accumulation SHA ${observed.localAccumulationHeadSha}.`,
    );
  }
  if (
    state.mainlineRefresh &&
    observed.remoteAccumulationHeadSha !== null &&
    !journalOwnedHeads!.has(observed.remoteAccumulationHeadSha)
  ) {
    diagnostics.push(
      `In-flight refresh journal does not own remote accumulation SHA ${observed.remoteAccumulationHeadSha}.`,
    );
  }
  if (
    observed.localAccumulationHeadSha !== null &&
    observed.remoteAccumulationHeadSha !== null &&
    observed.localAccumulationHeadSha !== observed.remoteAccumulationHeadSha &&
    !inFlightPromotion
  ) {
    diagnostics.push(
      `Accumulation branch head mismatch: local ${observed.localAccumulationHeadSha} != remote ${observed.remoteAccumulationHeadSha}.`,
    );
  }

  const labelSet = new Set(observed.parentLabels);
  const observedQueueLabels = observed.parentLabels.filter((label) =>
    /^parent-\d+$/u.test(label),
  );
  if (observedQueueLabels.length > 1) {
    diagnostics.push(
      `Expected at most one parent-N queue label, found ${observedQueueLabels.join(", ")}.`,
    );
  }
  if (state.phase !== "delivered" && !labelSet.has(state.queueLabel)) {
    diagnostics.push(`Queue label '${state.queueLabel}' is missing from the parent issue.`);
  }
  if (state.phase === "delivered" && labelSet.has("agent-in-progress")) {
    diagnostics.push("Delivered parent still has agent-in-progress.");
  }
  if (state.phase === "failed") {
    if (labelSet.has("agent-in-progress")) {
      diagnostics.push("Failed parent still has agent-in-progress.");
    }
    if (!labelSet.has(state.queueLabel)) {
      diagnostics.push(`Failed parent must retain queue label '${state.queueLabel}'.`);
    }
  }
  if (isInProgressPhase(state.phase) && !labelSet.has("agent-in-progress")) {
    diagnostics.push(`Phase '${state.phase}' requires agent-in-progress.`);
  }

  // A claimed parent MAY already have child issues: publication lands on
  // GitHub before the 'decomposed' transition is persisted, so a crash in
  // that window is a legal recovery state. The orchestrator advances such a
  // parent straight to 'decomposed' instead of re-running decomposition.
  if (state.phase === "decomposed" && totalChildCount(observed) === 0) {
    diagnostics.push("Decomposed parent should have published child issues.");
  }
  if (state.phase === "initial_drained" && observed.openChildNumbers.length > 0) {
    diagnostics.push("Initial drained parent should not have open child issues.");
  }
  if (state.phase === "pre_review_ready" && observed.openChildNumbers.length > 0) {
    diagnostics.push("Pre-review-ready parent should not have open child issues.");
  }
  if (state.phase === "full_parent_reviewed" && observed.openChildNumbers.length > 0) {
    diagnostics.push("Full-parent-reviewed state should not have open child issues yet.");
  }
  if (state.phase === "followups_ready" && totalChildCount(observed) === 0) {
    diagnostics.push("Followups-ready parent should have follow-up child state.");
  }
  if (
    (state.phase === "followups_drained" ||
      state.phase === "pre_delivery_ready" ||
      state.phase === "delivered") &&
    observed.openChildNumbers.length > 0
  ) {
    diagnostics.push(`Phase '${state.phase}' should not have open child issues.`);
  }

  return diagnostics;
}

function durableFieldsEqual(
  previous: IssueAsPrdParentState,
  next: Omit<IssueAsPrdParentState, "lastTransitionAt">,
): boolean {
  const {
    lastTransitionAt: _previousLastTransitionAt,
    ...previousWithoutTimestamp
  } = previous;
  const previousKeys = Object.keys(previousWithoutTimestamp);
  const nextKeys = Object.keys(next);
  return previousKeys.length === nextKeys.length && previousKeys.every(
    (key) =>
      key in next &&
      JSON.stringify(previousWithoutTimestamp[key as keyof typeof previousWithoutTimestamp]) ===
        JSON.stringify(next[key as keyof typeof next]),
  );
}

function withoutTimestamp(
  state: IssueAsPrdParentState,
): Omit<IssueAsPrdParentState, "lastTransitionAt"> {
  const { lastTransitionAt: _lastTransitionAt, ...durable } = state;
  return durable;
}

// Version 1 published readiness-oriented phases. A resume must be able to
// write version 2 before further work, without spending another agent session
// or accepting an old readiness marker as proof of current context.
function migrateSchemaOneState(value: Record<string, unknown>): Record<string, unknown> {
  if (value.schemaVersion !== 1) return value;
  const phase = value.phase === "decomposed" || value.phase === "initial_ready"
    ? "initial_queue"
    : value.phase === "followups_ready"
      ? "followup_queue"
      : value.phase;
  return {
    ...value,
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    phase,
    accumulationDiverged: false,
    mainlineRefresh: null,
  };
}

function renderEnvelope(json: string): string {
  return [
    `<!-- ${ISSUE_AS_PRD_STATE_MARKER} -->`,
    "<sandcastle_issue_as_prd_state>",
    json,
    "</sandcastle_issue_as_prd_state>",
  ].join("\n");
}

function parentQueueLabel(parentNumber: number): string {
  return `parent-${parentNumber}`;
}

function totalChildCount(observed: ObservedParentRecoveryState): number {
  return observed.openChildNumbers.length + observed.closedChildNumbers.length;
}

function isInProgressPhase(phase: ParentPhase): boolean {
  return phase !== "delivered" && phase !== "failed";
}

function markerRegex(): RegExp {
  return new RegExp(`<!--\\s*${ISSUE_AS_PRD_STATE_MARKER}\\s*-->`, "g");
}

function tagRegex(): RegExp {
  return /<sandcastle_issue_as_prd_state>([\s\S]*?)<\/sandcastle_issue_as_prd_state>/g;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactNumberField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): number | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (typeof value[key] !== "number" || !Number.isInteger(value[key])) {
    diagnostics.push(`Field '${key}' must be an integer.`);
    return undefined;
  }
  return value[key] as number;
}

function positiveIntegerField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): number | undefined {
  const parsed = exactNumberField(value, key, diagnostics);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    diagnostics.push(`Field '${key}' must be a positive integer.`);
    return undefined;
  }
  return parsed;
}

function nonNegativeIntegerField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): number | undefined {
  const parsed = exactNumberField(value, key, diagnostics);
  if (parsed === undefined) return undefined;
  if (parsed < 0) {
    diagnostics.push(`Field '${key}' must be a non-negative integer.`);
    return undefined;
  }
  return parsed;
}

function nullablePositiveIntegerField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): number | null | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (value[key] === null) return null;
  if (typeof value[key] !== "number" || !Number.isInteger(value[key]) || (value[key] as number) <= 0) {
    diagnostics.push(`Field '${key}' must be null or a positive integer.`);
    return undefined;
  }
  return value[key] as number;
}

function nonEmptyStringField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): string | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (typeof value[key] !== "string" || value[key].trim() === "") {
    diagnostics.push(`Field '${key}' must be a non-empty string.`);
    return undefined;
  }
  return value[key] as string;
}

function shaField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): string | undefined {
  const parsed = nonEmptyStringField(value, key, diagnostics);
  if (parsed === undefined) return undefined;
  if (!/^[0-9a-f]{40}$/iu.test(parsed)) {
    diagnostics.push(`Field '${key}' must be a 40-character hex SHA.`);
    return undefined;
  }
  return parsed;
}

function nullableShaField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): string | null | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (value[key] === null) return null;
  if (typeof value[key] !== "string" || value[key].trim() === "") {
    diagnostics.push(`Field '${key}' must be null or a non-empty SHA string.`);
    return undefined;
  }
  if (!/^[0-9a-f]{40}$/iu.test(value[key] as string)) {
    diagnostics.push(`Field '${key}' must be null or a 40-character hex SHA.`);
    return undefined;
  }
  return value[key] as string;
}

function phaseField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): ParentPhase | undefined {
  const parsed = nonEmptyStringField(value, key, diagnostics);
  if (parsed === undefined) return undefined;
  if (!PARENT_PHASES.includes(parsed as ParentPhase)) {
    diagnostics.push(
      `Field '${key}' must be one of: ${PARENT_PHASES.join(", ")}.`,
    );
    return undefined;
  }
  return parsed as ParentPhase;
}

function aggregateRepairField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): { pre_review: 0 | 1; pre_delivery: 0 | 1 } | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  const raw = value[key];
  if (!isRecord(raw)) {
    diagnostics.push(`Field '${key}' must be an object.`);
    return undefined;
  }
  const allowed = new Set(["pre_review", "pre_delivery"]);
  for (const childKey of Object.keys(raw)) {
    if (!allowed.has(childKey)) {
      diagnostics.push(`Unexpected field '${key}.${childKey}'.`);
    }
  }
  const preReview = budgetField(raw, "pre_review", diagnostics, key);
  const preDelivery = budgetField(raw, "pre_delivery", diagnostics, key);
  if (preReview === undefined || preDelivery === undefined) return undefined;
  return { pre_review: preReview, pre_delivery: preDelivery };
}

function budgetField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
  parentKey: string,
): 0 | 1 | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${parentKey}.${key}'.`);
    return undefined;
  }
  if (value[key] !== 0 && value[key] !== 1) {
    diagnostics.push(`Field '${parentKey}.${key}' must be 0 or 1.`);
    return undefined;
  }
  return value[key] as 0 | 1;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): string[] | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (!Array.isArray(value[key])) {
    diagnostics.push(`Field '${key}' must be an array of strings.`);
    return undefined;
  }
  const items: string[] = [];
  for (const [index, item] of (value[key] as unknown[]).entries()) {
    if (typeof item !== "string") {
      diagnostics.push(`Field '${key}[${index}]' must be a string.`);
      continue;
    }
    items.push(item);
  }
  return items;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): boolean | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (typeof value[key] !== "boolean") {
    diagnostics.push(`Field '${key}' must be a boolean.`);
    return undefined;
  }
  return value[key] as boolean;
}

function mainlineRefreshField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): MainlineRefreshJournal | null | undefined {
  if (!(key in value)) {
    diagnostics.push(`Missing required field '${key}'.`);
    return undefined;
  }
  if (value[key] === null) return null;
  if (!isRecord(value[key])) {
    diagnostics.push(`Field '${key}' must be null or an object.`);
    return undefined;
  }
  const journal = value[key];
  const expected = new Set([
    "preRebaseAccumulationSha",
    "targetMainlineSha",
    "candidateSha",
  ]);
  for (const journalKey of Object.keys(journal)) {
    if (!expected.has(journalKey)) {
      diagnostics.push(`Unexpected field '${key}.${journalKey}'.`);
    }
  }
  const preRebaseAccumulationSha = shaField(
    journal,
    "preRebaseAccumulationSha",
    diagnostics,
  );
  const targetMainlineSha = shaField(journal, "targetMainlineSha", diagnostics);
  const candidateSha = shaField(journal, "candidateSha", diagnostics);
  if (!preRebaseAccumulationSha || !targetMainlineSha || !candidateSha) return undefined;
  return { preRebaseAccumulationSha, targetMainlineSha, candidateSha };
}

function isoTimestampField(
  value: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): string | undefined {
  const parsed = nonEmptyStringField(value, key, diagnostics);
  if (parsed === undefined) return undefined;
  if (Number.isNaN(Date.parse(parsed))) {
    diagnostics.push(`Field '${key}' must be a valid ISO timestamp.`);
    return undefined;
  }
  return parsed;
}
