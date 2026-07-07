import { join } from "node:path";

const WORKTREE_PG_ENSURE_COMMAND =
  /(^|\s)bash\s+(?:\.\/)?\.sandcastle\/pg-ensure\.sh(?=$|\s|[;&|])/g;

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Validation runs in a task worktree, which may have been created from an
 * older task base.  Infrastructure reset scripts instead come from the host
 * runner, so their policy is consistent across resumed worktrees without
 * modifying tracked files in the issue branch.
 */
export function resolveHostValidationCommand(
  command: string,
  repoRoot: string,
): string {
  const canonicalPgEnsure = `bash ${quotePosixShellArgument(
    join(repoRoot, ".sandcastle", "pg-ensure.sh"),
  )}`;
  let usesHostPostgres = false;
  const resolved = command.replace(
    WORKTREE_PG_ENSURE_COMMAND,
    (_match, leadingWhitespace: string) => {
      usesHostPostgres = true;
      return `${leadingWhitespace}${canonicalPgEnsure}`;
    },
  );
  if (!usesHostPostgres) return resolved;

  // All loops share one host PostgreSQL service. Hold the lock through reset,
  // migration, and pytest so another loop cannot reset the database mid-gate.
  return [
    "flock",
    quotePosixShellArgument(join(repoRoot, ".sandcastle", "pg-validation.lock")),
    "bash",
    "-c",
    quotePosixShellArgument(resolved),
  ].join(" ");
}
