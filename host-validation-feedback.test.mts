import assert from "node:assert/strict";
import test from "node:test";
import { formatHostValidationFailureFeedback } from "./host-validation-feedback.mts";

test("marks database gate feedback as host-only and redacts runnable host commands", () => {
  const feedback = formatHostValidationFailureFeedback({
    output: [
      "bash .sandcastle/pg-ensure.sh && uv run alembic upgrade head",
      "asyncpg.exceptions.DataError: invalid input for query argument $6",
      "pg_ctl: could not start server",
    ].join("\n"),
  });

  assert.match(feedback, /host validation runner, not from your sandbox/i);
  assert.match(feedback, /Do not run .*pg-ensure.*pg_ctl.*alembic upgrade/i);
  assert.match(feedback, /asyncpg\.exceptions\.DataError/);
  assert.doesNotMatch(feedback, /bash \.sandcastle\/pg-ensure\.sh/);
  assert.doesNotMatch(feedback, /pg_ctl: could not start server/);
});

test("surfaces the pytest failure even when alembic migration logs would fill the truncation window", () => {
  // Reproduces issues #1210/#1212/#1214: the gate concatenates stdout+stderr,
  // so pytest's failure report (stdout) precedes alembic's ~35 successful
  // per-migration log lines (stderr). The old `.slice(-4000)` kept only the
  // migration noise; the coder never saw why validation failed and got stuck.
  const pytestStdout = [
    "=================================== FAILURES ===================================",
    "____________ TestPublicInvoiceView.test_valid_token_returns_invoice ____________",
    "    raise HTTPException(status_code=404, detail='Invoice not found')",
    "E   fastapi.exceptions.HTTPException: 404: Invoice not found",
    "=========================== short test summary info ============================",
    "FAILED tests/test_invoice_lifecycle.py::TestPublicInvoiceView::test_valid_token_returns_invoice_with_visits - fastapi.exceptions.HTTPException: 404: Invoice not found",
    "================= 2 failed, 324 passed, 102 warnings in 11.27s ==================",
  ].join("\n");
  const alembicStderr = Array.from({ length: 35 }, (_, i) =>
    `INFO  [alembic.runtime.migration] Running upgrade ${String(i).padStart(
      3,
      "0",
    )} -> ${String(i + 1).padStart(3, "0")}, Some descriptive migration name that pads the line out to a realistic width.`,
  ).join("\n");

  const feedback = formatHostValidationFailureFeedback({
    output: `${pytestStdout}\n${alembicStderr}`,
  });

  assert.match(feedback, /404: Invoice not found/);
  assert.match(feedback, /FAILED tests\/test_invoice_lifecycle\.py/);
  assert.match(feedback, /2 failed, 324 passed/);
  // The migration success noise must not be what the coder sees.
  assert.doesNotMatch(feedback, /Running upgrade 03[0-4] -> 03[1-5]/);
});

test("adds Postgres role dependency guidance for failed DROP ROLE", () => {
  const feedback = formatHostValidationFailureFeedback({
    output: [
      "sqlalchemy.exc.DBAPIError: (sqlalchemy.dialects.postgresql.asyncpg.Error)",
      '<class "asyncpg.exceptions.DependentObjectsStillExistError">: role "lawncare_admin" cannot be dropped because some objects depend on it',
      "DETAIL:  privileges for database test",
      "[SQL: DROP ROLE lawncare_admin]",
    ].join("\n"),
    roleDependencySummary: [
      "<shared> | pg_database | 2",
      "lawncare_migration_test | pg_class | 18",
      "test | pg_class | 18",
    ].join("\n"),
  });

  assert.match(feedback, /Postgres role dependency hint/);
  assert.match(feedback, /roles are cluster-global/);
  assert.match(feedback, /lawncare_migration_test \| pg_class \| 18/);
  assert.match(feedback, /skip `DROP ROLE` when cross-database dependencies remain/);
});
