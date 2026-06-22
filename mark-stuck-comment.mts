export type StuckTerminalReason =
  | "stuck_rounds_exhausted"
  | "stuck_no_progress"
  | "stuck_livelock"
  | "blocked";

export interface FormatStuckIssueCommentInput {
  lastFeedback: string;
  roundsUsed?: number;
  maxReviewRounds?: number;
  terminalReason?: StuckTerminalReason;
  /** Host-side failure (merge, close, etc.) — bypasses round-based headline. */
  headline?: string;
}

export function formatStuckIssueComment(
  input: FormatStuckIssueCommentInput,
): string {
  const {
    lastFeedback,
    roundsUsed,
    maxReviewRounds,
    terminalReason,
    headline,
  } = input;

  let intro: string;
  if (headline) {
    intro = headline;
  } else if (terminalReason === "stuck_no_progress" && roundsUsed != null) {
    intro = `Agent stopped early after round ${roundsUsed} (no progress).`;
  } else if (terminalReason === "blocked" && roundsUsed != null) {
    intro = `Coder signaled blocked on round ${roundsUsed}.`;
  } else if (terminalReason === "stuck_livelock" && roundsUsed != null) {
    intro = `Agent stopped after a livelock on round ${roundsUsed}.`;
  } else if (roundsUsed != null && maxReviewRounds != null) {
    intro = `Agent gave up after ${roundsUsed} of ${maxReviewRounds} review round(s).`;
  } else {
    intro = "Agent marked this issue stuck.";
  }

  return `${intro}\n\nLast feedback:\n\n${lastFeedback}`;
}
