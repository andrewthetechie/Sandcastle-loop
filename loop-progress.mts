import { createHash } from "node:crypto";

export type FailedRoundSource =
  | "validation"
  | "reviewer_changes_requested"
  | "workflow_pollution"
  | "diff_too_large"
  | "branch_hygiene"
  | "missing_commit"
  | "host_input_limit"
  | "livelock";

export interface FailedRoundFingerprint {
  diffHash: string;
  source: FailedRoundSource;
  signatureHash: string;
  signatureSummary: string;
}

export interface NoProgressState {
  lastFailedFingerprint: FailedRoundFingerprint | null;
  repeatCount: number;
}

export function initialNoProgressState(): NoProgressState {
  return {
    lastFailedFingerprint: null,
    repeatCount: 0,
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

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function observeFailedRoundFingerprint(
  state: NoProgressState,
  fingerprint: FailedRoundFingerprint,
  repeatLimit: number,
): { state: NoProgressState; stalled: boolean } {
  if (
    state.lastFailedFingerprint &&
    state.lastFailedFingerprint.diffHash === fingerprint.diffHash &&
    state.lastFailedFingerprint.source === fingerprint.source &&
    state.lastFailedFingerprint.signatureHash === fingerprint.signatureHash
  ) {
    const repeatCount = state.repeatCount + 1;
    return {
      state: { ...state, repeatCount },
      stalled: repeatCount >= repeatLimit,
    };
  }
  return {
    state: { lastFailedFingerprint: fingerprint, repeatCount: 0 },
    stalled: false,
  };
}

// Backward-compatible wrappers for older runner variants. New code should use
// observeFailedRoundFingerprint with an explicit source and signature.
export function observeReviewDiff(
  state: NoProgressState,
  diff: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  return observeFailedRoundFingerprint(
    state,
    {
      diffHash: sha1(diff),
      source: "reviewer_changes_requested",
      signatureHash: sha1(diff),
      signatureSummary: "legacy review diff repeat",
    },
    stallLimit,
  );
}

export function observeValidationFailure(
  state: NoProgressState,
  signature: string,
  stallLimit: number,
): { state: NoProgressState; stalled: boolean } {
  return observeFailedRoundFingerprint(
    state,
    {
      diffHash: sha1("legacy-validation"),
      source: "validation",
      signatureHash: sha1(signature),
      signatureSummary: signature,
    },
    stallLimit,
  );
}
