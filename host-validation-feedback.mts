const HOST_ONLY_DATABASE_COMMAND =
  /\.sandcastle\/pg-ensure\.sh|\bpg_ctl\b|\bdocker\b|\bsudo\b|\bsu\b|\balembic\s+upgrade\b/i;

// The gate concatenates `stdout + stderr`, so pytest's failure report (stdout)
// lands *before* alembic's successful per-migration log (stderr). Those
// `INFO  [alembic.runtime.migration] Running upgrade N -> M` lines are pure
// success noise — for a 35-migration chain they total ~3.8KB and, when the
// output is later truncated to its tail, they fill the entire window and bury
// the actual test failure. Drop them so the truncation keeps the failure.
// A genuine alembic *failure* traceback (e.g. sqlalchemy.exc.*) does not match
// this pattern and is preserved.
const ALEMBIC_MIGRATION_NOISE =
  /^INFO\s+\[alembic\.runtime\.migration\]\s+(Running upgrade|Context impl|Will assume)/i;

// Anchors that mark the start of pytest's failure report. When present we keep
// the excerpt from the last such anchor to the end, guaranteeing the failing
// test names and assertions survive truncation instead of leading warnings.
const PYTEST_FAILURE_ANCHOR =
  /^(=+\s*(FAILURES|ERRORS|short test summary info)\s*=+)$/m;

const HOST_DIAGNOSTICS_MAX_CHARS = 6000;
const ROLE_DROP_DEPENDENCY_ERROR =
  /role "([^"]+)" cannot be dropped because some objects depend on it/i;

export function extractDroppedRoleNameFromDependentObjectsError(
  output: string,
): string | null {
  if (!/DependentObjectsStillExistError/i.test(output)) return null;
  return ROLE_DROP_DEPENDENCY_ERROR.exec(output)?.[1] ?? null;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildRoleDependencySummaryQuery(input: {
  roleName: string;
  pipeSeparated?: boolean;
}): string {
  const select = input.pipeSeparated
    ? [
        "SELECT COALESCE(db.datname, '<shared>') || ' | ' ||",
        "       d.classid::regclass::text || ' | ' ||",
        "       count(*)::text",
      ]
    : [
        "SELECT COALESCE(db.datname, '<shared>') AS database,",
        "       d.classid::regclass AS dependency_catalog,",
        "       count(*) AS dependency_count",
      ];
  return [
    ...select,
    "FROM pg_shdepend d",
    "LEFT JOIN pg_database db ON d.dbid = db.oid",
    `WHERE d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = ${sqlLiteral(input.roleName)})`,
    "GROUP BY db.datname, d.classid",
    input.pipeSeparated
      ? "ORDER BY db.datname NULLS FIRST, d.classid::regclass::text;"
      : "ORDER BY database NULLS FIRST, dependency_catalog;",
  ].join("\n");
}

function redactHostOnlyDatabaseCommands(output: string): string {
  return output
    .split("\n")
    .filter((line) => !ALEMBIC_MIGRATION_NOISE.test(line))
    .map((line) =>
      HOST_ONLY_DATABASE_COMMAND.test(line)
        ? "[host-only database command omitted]"
        : line,
    )
    .join("\n");
}

// Keep the most diagnostic tail of the output. If pytest emitted a failure
// section, anchor on it so the failing tests survive even when earlier output
// (collection logs, warnings) would otherwise dominate the byte budget.
function extractSalientTail(output: string, maxChars: number): string {
  const anchors = [...output.matchAll(new RegExp(PYTEST_FAILURE_ANCHOR, "gm"))];
  if (anchors.length > 0) {
    const lastAnchor = anchors[anchors.length - 1];
    const fromAnchor = output.slice(lastAnchor.index ?? 0);
    if (fromAnchor.length <= maxChars) return fromAnchor;
    // Failure section itself exceeds the budget: keep its tail (the summary of
    // failed test names lives at the very end of pytest output).
    return fromAnchor.slice(-maxChars);
  }
  return output.slice(-maxChars);
}

/**
 * Reworkers run in an unprivileged sandbox. The host owns PostgreSQL reset,
 * migrations, and the full test gate, so feedback must be diagnostic rather
 * than an executable recipe for the sandbox.
 */
export function formatHostValidationFailureFeedback(input: {
  output: string;
  roleDependencySummary?: string | null;
}): string {
  const droppedRole =
    extractDroppedRoleNameFromDependentObjectsError(input.output);
  const roleDependencyGuidance = droppedRole
    ? [
        "",
        "## Postgres role dependency hint",
        "",
        `The failed SQL tried to drop role \`${droppedRole}\`. PostgreSQL roles are cluster-global, so a migration running in one database cannot drop a role while grants or ownership for that role still exist in another database in the same cluster.`,
        "",
        input.roleDependencySummary
          ? [
              "Read-only dependency summary from `pg_shdepend`:",
              "```",
              input.roleDependencySummary,
              "```",
            ].join("\n")
          : [
              "If this needs deeper inspection, run this read-only host query against the same Postgres cluster:",
              "```sql",
              buildRoleDependencySummaryQuery({ roleName: droppedRole }),
              "```",
            ].join("\n"),
        "",
        "Prefer making the downgrade revoke this database's privileges and skip `DROP ROLE` when cross-database dependencies remain.",
      ]
    : [];
  return [
    "## Host validation failed",
    "",
    "This failure came from the host validation runner, not from your sandbox.",
    "Do not run or repair PostgreSQL in the sandbox: never invoke `pg-ensure`, `pg_ctl`, `postgres`, `docker`, `sudo`, `su`, or `alembic upgrade`.",
    "Make only the source or test change indicated by the diagnostics. Run only targeted non-database validation; the host will rerun the full gate after your commit.",
    "",
    `Host diagnostics (most relevant tail, up to ${HOST_DIAGNOSTICS_MAX_CHARS} chars):`,
    "```",
    extractSalientTail(
      redactHostOnlyDatabaseCommands(input.output),
      HOST_DIAGNOSTICS_MAX_CHARS,
    ),
    "```",
    ...roleDependencyGuidance,
    "",
    "Fix the failures and commit again.",
  ].join("\n");
}
