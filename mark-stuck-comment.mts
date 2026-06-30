export type StuckTerminalReason =
  | "stuck_rounds_exhausted"
  | "stuck_no_progress"
  | "stuck_reviewer_parse_failure"
  | "stuck_reviewer_incomplete"
  | "stuck_needs_human_review"
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
  } else if (
    terminalReason === "stuck_reviewer_parse_failure" &&
    roundsUsed != null
  ) {
    intro = `Reviewer parse failed after round ${roundsUsed}; manual review required.`;
  } else if (
    terminalReason === "stuck_reviewer_incomplete" &&
    roundsUsed != null
  ) {
    intro = `Reviewer did not return a complete verdict after round ${roundsUsed}; manual review required.`;
  } else if (
    terminalReason === "stuck_needs_human_review" &&
    roundsUsed != null
  ) {
    intro = `Reviewer requested human review on round ${roundsUsed}.`;
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
