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
