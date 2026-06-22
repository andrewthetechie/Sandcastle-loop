import type { LoggingOption } from "@ai-hero/sandcastle";
import {
  initialLivelockDetectorState,
  observeNormalizedToolCall,
  toolCallIdentity,
  type LivelockDetectorState,
  type ToolCallIdentity,
  type WorktreeProgressSnapshot,
} from "./loop-progress.mts";

/** Stable kind for watchdog abort reasons distinguishable from idle timeout or user abort. */
export const AGENT_INVOCATION_LIVELOCK_KIND = "agent_invocation_livelock" as const;

/** Structured abort reason produced when the watchdog resolves a livelock. */
export interface AgentInvocationLivelockReason {
  kind: typeof AGENT_INVOCATION_LIVELOCK_KIND;
  toolCall: ToolCallIdentity;
  threshold: number;
  noProgressSnapshot: WorktreeProgressSnapshot;
}

/** Default consecutive identical tool-call threshold before aborting. */
export const DEFAULT_LIVELOCK_TOOL_CALL_THRESHOLD = 5;

/** Normalized tool-call observation extracted from a Sandcastle stream event. */
export interface ToolCallStreamObservation {
  toolName: string;
  formattedArgs: string;
}

export interface LivelockWatchdogOptions {
  abortController: AbortController;
  getWorktreeSnapshot: () => WorktreeProgressSnapshot;
  threshold?: number;
  onStreamEvent?: (event: unknown) => void;
}

/**
 * Adapt a Sandcastle `onAgentStreamEvent` callback event into a tool-call
 * observation for the livelock detector. Text, raw, and malformed events
 * return `null` without throwing.
 */
export function toolCallObservationFromStreamEvent(
  event: unknown,
): ToolCallStreamObservation | null {
  if (!isRecord(event) || event.type !== "toolCall") {
    return null;
  }
  const { name, formattedArgs } = event;
  if (typeof name !== "string" || typeof formattedArgs !== "string") {
    return null;
  }
  return { toolName: name, formattedArgs };
}

function buildLivelockAbortReason(
  identity: ToolCallIdentity,
  threshold: number,
  noProgressSnapshot: WorktreeProgressSnapshot,
): AgentInvocationLivelockReason {
  return {
    kind: AGENT_INVOCATION_LIVELOCK_KIND,
    toolCall: identity,
    threshold,
    noProgressSnapshot,
  };
}

/**
 * Build an `onAgentStreamEvent` callback that observes tool calls for livelock,
 * forwards every event to an optional original callback (e.g. Sandcastle file
 * logging), and aborts the supplied controller when the pure detector reports
 * a resolved livelock condition.
 */
export function createLivelockWatchdogStreamCallback(
  options: LivelockWatchdogOptions,
): (event: unknown) => void {
  const threshold = options.threshold ?? DEFAULT_LIVELOCK_TOOL_CALL_THRESHOLD;
  let detectorState: LivelockDetectorState = initialLivelockDetectorState();

  return (event: unknown) => {
    const observation = toolCallObservationFromStreamEvent(event);
    if (observation !== null) {
      const identity = toolCallIdentity(
        observation.toolName,
        observation.formattedArgs,
      );
      const snapshot = options.getWorktreeSnapshot();
      const result = observeNormalizedToolCall(
        detectorState,
        identity,
        snapshot,
        threshold,
      );
      detectorState = result.state;
      if (
        result.livelockCandidate &&
        detectorState.streakStartSnapshot !== null
      ) {
        options.abortController.abort(
          buildLivelockAbortReason(
            identity,
            threshold,
            detectorState.streakStartSnapshot,
          ),
        );
      }
    }

    options.onStreamEvent?.(event);
  };
}

/**
 * Convert a structured livelock abort reason into synthetic feedback for
 * the next rework round after a round-1 coder livelock.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Type guard for structured watchdog abort reasons surfaced by Sandcastle. */
export function isAgentInvocationLivelockReason(
  value: unknown,
): value is AgentInvocationLivelockReason {
  if (!isRecord(value) || value.kind !== AGENT_INVOCATION_LIVELOCK_KIND) {
    return false;
  }
  const { toolCall, threshold, noProgressSnapshot } = value;
  if (!isRecord(toolCall)) return false;
  if (typeof toolCall.tool !== "string" || typeof toolCall.args !== "string") {
    return false;
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return false;
  }
  if (!isRecord(noProgressSnapshot)) return false;
  if (
    typeof noProgressSnapshot.head !== "string" ||
    typeof noProgressSnapshot.porcelainStatus !== "string"
  ) {
    return false;
  }
  return true;
}

export type Round1CoderLivelockControlFlow =
  | { action: "continue_with_feedback"; feedback: string }
  | { action: "rethrow"; error: unknown };

export type ReworkLivelockControlFlow =
  | {
      action: "break_to_stuck";
      terminalReason: "stuck_livelock";
      feedback: string;
    }
  | { action: "rethrow"; error: unknown };

/**
 * Map a round-1 coder invocation failure to loop control flow. Structured
 * livelock abort reasons become synthetic rework feedback; everything else
 * should propagate to existing crash handling.
 */
export function resolveRound1CoderLivelockControlFlow(
  error: unknown,
): Round1CoderLivelockControlFlow {
  if (isAgentInvocationLivelockReason(error)) {
    return {
      action: "continue_with_feedback",
      feedback: formatAgentInvocationLivelockFeedback(error),
    };
  }
  return { action: "rethrow", error };
}

export type AgentInvocationStage = "coder" | "rework";

/** Agent stage for a review round: round 1 runs coder, later rounds run rework. */
export function agentInvocationStageForRound(round: number): AgentInvocationStage {
  return round > 1 ? "rework" : "coder";
}

export type Round1CoderLivelockEscalation =
  | {
      action: "escalate_to_rework";
      feedback: string;
      nextRound: number;
      nextStage: "rework";
    }
  | { action: "rethrow"; error: unknown };

/**
 * Map a round-1 coder invocation failure to loop escalation. Structured livelock
 * abort reasons become synthetic rework feedback and select rework on the next
 * round; everything else propagates to existing crash handling.
 */
export function resolveRound1CoderLivelockEscalation(
  error: unknown,
  round: number,
): Round1CoderLivelockEscalation {
  const control = resolveRound1CoderLivelockControlFlow(error);
  if (control.action === "rethrow") {
    return control;
  }
  const nextRound = round + 1;
  return {
    action: "escalate_to_rework",
    feedback: control.feedback,
    nextRound,
    nextStage: agentInvocationStageForRound(nextRound),
  };
}

/**
 * Map a rework invocation failure to loop control flow. Structured livelock
 * abort reasons terminate the issue on the stuck path; everything else should
 * propagate to existing crash handling.
 */
export function resolveReworkLivelockControlFlow(
  error: unknown,
): ReworkLivelockControlFlow {
  if (isAgentInvocationLivelockReason(error)) {
    return {
      action: "break_to_stuck",
      terminalReason: "stuck_livelock",
      feedback: formatAgentInvocationLivelockFeedback(error),
    };
  }
  return { action: "rethrow", error };
}

export interface LivelockWatchdogSandcastleRunOptions {
  abortController: AbortController;
  signal: AbortSignal;
  logging: Extract<LoggingOption, { type: "file" }>;
}

/** Sandcastle `run()` options for an agent invocation protected by the watchdog. */
export function createLivelockWatchdogSandcastleRunOptions(input: {
  logPath: string;
  getWorktreeSnapshot: () => WorktreeProgressSnapshot;
  threshold?: number;
}): LivelockWatchdogSandcastleRunOptions {
  const abortController = new AbortController();
  return {
    abortController,
    signal: abortController.signal,
    logging: {
      type: "file",
      path: input.logPath,
      onAgentStreamEvent: createLivelockWatchdogStreamCallback({
        abortController,
        getWorktreeSnapshot: input.getWorktreeSnapshot,
        threshold: input.threshold,
      }),
    },
  };
}

export function formatAgentInvocationLivelockFeedback(
  reason: AgentInvocationLivelockReason,
): string {
  const { tool, args } = reason.toolCall;
  const { head, porcelainStatus } = reason.noProgressSnapshot;
  const porcelainDisplay =
    porcelainStatus === "" ? "(clean)" : porcelainStatus;

  return [
    "## Agent invocation livelock",
    "",
    `The agent was stopped after ${reason.threshold} consecutive identical tool calls without worktree progress.`,
    "",
    `Repeated tool call: \`${tool}\` with normalized arguments \`${args}\`.`,
    "",
    `No \`HEAD\` or porcelain-status progress was observed during this streak (HEAD: \`${head}\`, porcelain status: \`${porcelainDisplay}\`).`,
    "",
    "Do not repeat this tool call. Change approach so the worktree can move forward.",
  ].join("\n");
}
