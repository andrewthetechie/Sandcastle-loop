const HOST_ONLY_DATABASE_COMMAND =
  /\.sandcastle\/pg-ensure\.sh|\bpg_ctl\b|\bdocker\b|\bsudo\b|\bsu\b|\balembic\s+upgrade\b/i;

function redactHostOnlyDatabaseCommands(output: string): string {
  return output
    .split("\n")
    .map((line) =>
      HOST_ONLY_DATABASE_COMMAND.test(line)
        ? "[host-only database command omitted]"
        : line,
    )
    .join("\n");
}

/**
 * Reworkers run in an unprivileged sandbox. The host owns PostgreSQL reset,
 * migrations, and the full test gate, so feedback must be diagnostic rather
 * than an executable recipe for the sandbox.
 */
export function formatHostValidationFailureFeedback(input: {
  output: string;
}): string {
  return [
    "## Host validation failed",
    "",
    "This failure came from the host validation runner, not from your sandbox.",
    "Do not run or repair PostgreSQL in the sandbox: never invoke `pg-ensure`, `pg_ctl`, `postgres`, `docker`, `sudo`, `su`, or `alembic upgrade`.",
    "Make only the source or test change indicated by the diagnostics. Run only targeted non-database validation; the host will rerun the full gate after your commit.",
    "",
    "Host diagnostics (truncated to last 4000 chars):",
    "```",
    redactHostOnlyDatabaseCommands(input.output).slice(-4000),
    "```",
    "",
    "Fix the failures and commit again.",
  ].join("\n");
}
