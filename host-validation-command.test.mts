import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHostValidationCommand } from "./host-validation-command.mts";

test("runs the full PostgreSQL gate under a host-scoped lock", () => {
  const command = resolveHostValidationCommand(
    "bash .sandcastle/pg-ensure.sh && uv run pytest tests/",
    "/srv/yardwhisper",
  );

  assert.match(command, /^flock '\/srv\/yardwhisper\/\.sandcastle\/pg-validation\.lock' bash -c /);
  assert.match(command, /\/srv\/yardwhisper\/\.sandcastle\/pg-ensure\.sh/);
  assert.match(command, /uv run pytest tests/);
});

test("also recognizes a dot-slash worktree helper path and shell-quotes the host path", () => {
  const command = resolveHostValidationCommand(
    "CI=1 bash ./.sandcastle/pg-ensure.sh; npm test",
    "/srv/yard whisper's",
  );

  assert.match(command, /^flock /);
  assert.match(command, /pg-validation\.lock/);
  assert.match(command, /pg-ensure\.sh/);
  assert.match(command, /npm test/);
});

test("leaves unrelated validation commands untouched", () => {
  assert.equal(
    resolveHostValidationCommand("uv run pytest tests/", "/srv/yardwhisper"),
    "uv run pytest tests/",
  );
});
