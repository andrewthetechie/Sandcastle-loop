import { createHash } from "node:crypto";

export interface NoProgressState {
  lastDiffHash: string | null;
  diffStreak: number;
  lastValidationSignature: string | null;
  validationStreak: number;
}

export function initialNoProgressState(): NoProgressState {
  return {
    lastDiffHash: null,
    diffStreak: 0,
    lastValidationSignature: null,
    validationStreak: 0,
  };
}

export interface ToolCallIdentity {
  tool: string;
  args: string;
}

/** Normalize a tool name for case-insensitive comparison. */
export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

/** Trim and collapse internal whitespace in formatted tool arguments. */
export function normalizeToolArguments(formattedArgs: string): string {
  return formattedArgs.trim().replace(/\s+/g, " ");
}

/** Build a stable identity for comparing tool calls across formatting noise. */
export function toolCallIdentity(
  toolName: string,
  formattedArgs: string,
): ToolCallIdentity {
  return {
    tool: normalizeToolName(toolName),
    args: normalizeToolArguments(formattedArgs),
  };
}

/** Serialize a normalized tool-call identity for streak comparison. */
export function toolCallIdentityKey(identity: ToolCallIdentity): string {
  return `${identity.tool}\0${identity.args}`;
}

export interface WorktreeProgressSnapshot {
  head: string;
  porcelainStatus: string;
}

export interface LivelockDetectorState {
  lastToolCallKey: string | null;
  toolCallStreak: number;
  streakStartSnapshot: WorktreeProgressSnapshot | null;
}

/** Initial pure state for consecutive repeated tool-call detection. */
export function initialLivelockDetectorState(): LivelockDetectorState {
  return {
    lastToolCallKey: null,
    toolCallStreak: 0,
    streakStartSnapshot: null,
  };
}

function worktreeSnapshotsEqual(
  a: WorktreeProgressSnapshot,
  b: WorktreeProgressSnapshot,
): boolean {
  return a.head === b.head && a.porcelainStatus === b.porcelainStatus;
}

/**
 * Observe a normalized tool-call identity. Reports a livelock candidate when
 * the same call repeats `threshold` times in a row and the worktree snapshot
 * (`head` + porcelain status) is unchanged since the streak started. A
 * different tool call resets the streak. Text-only events are not observed here.
 */
export function observeNormalizedToolCall(
  state: LivelockDetectorState,
  identity: ToolCallIdentity,
  snapshot: WorktreeProgressSnapshot,
  threshold: number,
): { state: LivelockDetectorState; livelockCandidate: boolean } {
  const key = toolCallIdentityKey(identity);
  if (state.lastToolCallKey === key) {
    const toolCallStreak = state.toolCallStreak + 1;
    const streakStartSnapshot = state.streakStartSnapshot;
    const livelockCandidate =
      toolCallStreak >= threshold &&
      streakStartSnapshot !== null &&
      worktreeSnapshotsEqual(snapshot, streakStartSnapshot);
    return {
      state: { ...state, toolCallStreak },
      livelockCandidate,
    };
  }
  return {
    state: {
      ...state,
      lastToolCallKey: key,
      toolCallStreak: 1,
      streakStartSnapshot: snapshot,
    },
    livelockCandidate: 1 >= threshold,
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Observe the review diff for a round. Stalls when the coder reproduces an
 * identical net diff `stallLimit` times in a row (i.e. it is not responding to
 * feedback). Returns the next state and whether to bail.
 */
export function observeReviewDiff(
  state: NoProgressState,
  diff: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  const diffHash = sha1(diff);
  if (state.lastDiffHash === diffHash) {
    const diffStreak = state.diffStreak + 1;
    return { state: { ...state, diffStreak }, stalled: diffStreak >= stallLimit };
  }
  return {
    state: { ...state, lastDiffHash: diffHash, diffStreak: 0 },
    stalled: false,
  };
}

/**
 * Observe a validation failure signature for a round. Stalls when the same
 * failure recurs `stallLimit` times in a row.
 */
export function observeValidationFailure(
  state: NoProgressState,
  signature: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  if (state.lastValidationSignature === signature) {
    const validationStreak = state.validationStreak + 1;
    return {
      state: { ...state, validationStreak },
      stalled: validationStreak >= stallLimit,
    };
  }
  return {
    state: { ...state, lastValidationSignature: signature, validationStreak: 0 },
    stalled: false,
  };
}
