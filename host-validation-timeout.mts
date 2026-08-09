/**
 * Host validation runs agent-authored code, which can hang: a non-terminating
 * loop, a test waiting on stdin, or a build blocked on a lock. `spawnSync`
 * without a deadline turns that into a stalled loop with no output and no
 * feedback for the coder, so every validation command runs under a deadline.
 */

const DEFAULT_KILL_GRACE_SECONDS = 10;

/** Exit status GNU `timeout` reports when it killed the command. */
export const TIMEOUT_EXIT_CODE = 124;

/** Exit status a shell reports when the command was SIGKILLed (128 + 9). */
export const SIGKILL_EXIT_CODE = 137;

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap `command` so it is killed after `timeoutSeconds`.
 *
 * GNU `timeout` runs the command in its own process group and signals the
 * whole group, so a killed `cargo test` takes its test binaries with it.
 * Node's own `spawnSync({ timeout })` only signals the direct child and is
 * used as the backstop where the binary is unavailable (notably macOS).
 *
 * The command is passed through `sh -c` because callers may hand us shell
 * syntax (`a && b`, pipes), which `timeout` would otherwise split.
 */
export function wrapHostCommandWithTimeout(input: {
  command: string;
  timeoutSeconds: number;
  hasTimeoutBinary: boolean;
  killGraceSeconds?: number;
}): string {
  if (!input.hasTimeoutBinary) return input.command;
  const killGrace = input.killGraceSeconds ?? DEFAULT_KILL_GRACE_SECONDS;
  return [
    "timeout",
    `--kill-after=${killGrace}s`,
    `${input.timeoutSeconds}s`,
    "sh",
    "-c",
    quotePosixShellArgument(input.command),
  ].join(" ");
}

/**
 * Whether a finished `spawnSync` result represents a deadline kill rather than
 * an ordinary non-zero exit.
 *
 * Covers both enforcement paths: GNU `timeout` (124, or 137 after `--kill-after`
 * escalates to SIGKILL) and Node's `spawnSync({ timeout })`, which reports
 * `ETIMEDOUT` with a null status and the kill signal.
 */
export function isHostCommandTimeout(input: {
  status: number | null;
  errorCode?: string | null;
  signal?: string | null;
}): boolean {
  if (input.errorCode === "ETIMEDOUT") return true;
  if (input.status === null && (input.signal === "SIGKILL" || input.signal === "SIGTERM")) {
    return true;
  }
  return input.status === TIMEOUT_EXIT_CODE || input.status === SIGKILL_EXIT_CODE;
}

/**
 * Feedback for a timed-out command. A hang produces no failing assertion to
 * quote, so the guidance names the likely causes instead; the partial output
 * is still included because it shows how far the command got.
 */
export function formatHostValidationTimeoutFeedback(input: {
  command: string;
  timeoutSeconds: number;
  output: string;
}): string {
  const partial = input.output.trim();
  return [
    "## Host validation timed out",
    "",
    `\`${input.command}\` did not finish within ${input.timeoutSeconds}s and was killed by the host.`,
    "This is a hang, not a normal test failure: the command never produced an exit status.",
    "",
    "Likely causes, in order:",
    "- A loop that never terminates (a `loop`/`while` whose exit condition is unreachable for some input).",
    "- A test waiting on input, a channel, or a lock that is never released.",
    "- An unbounded retry or backoff with no deadline.",
    "",
    "Find the non-terminating path and fix it, then rerun the command locally and confirm it exits.",
    "Do not raise the timeout to work around this.",
    "",
    partial
      ? ["Partial output before the kill:", "```", partial.slice(-4000), "```"].join("\n")
      : "The command produced no output before it was killed.",
  ].join("\n");
}
