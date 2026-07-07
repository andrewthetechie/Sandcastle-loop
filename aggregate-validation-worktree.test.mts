import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDependencySetupCommands } from "./aggregate-validation-worktree.mts";

test("prepares JavaScript and Python dependencies when both lockfiles are present", () => {
  assert.deepEqual(
    aggregateDependencySetupCommands({ hasPackageLock: true, hasUvLock: true }),
    ["npm ci", "uv sync --frozen"],
  );
});

test("does not run unrelated dependency setup", () => {
  assert.deepEqual(
    aggregateDependencySetupCommands({ hasPackageLock: true, hasUvLock: false }),
    ["npm ci"],
  );
  assert.deepEqual(
    aggregateDependencySetupCommands({ hasPackageLock: false, hasUvLock: false }),
    [],
  );
});
