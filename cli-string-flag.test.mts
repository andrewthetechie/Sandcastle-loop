import assert from "node:assert/strict";
import test from "node:test";
import { readCliStringFlag } from "./cli-string-flag.mts";

test("reads model overrides in both equals and space-separated forms", () => {
  assert.equal(
    readCliStringFlag(["node", "runner", "--model-coder=spark/coder"], "--model-coder"),
    "spark/coder",
  );
  assert.equal(
    readCliStringFlag(["node", "runner", "--model-rework", "spark/rework"], "--model-rework"),
    "spark/rework",
  );
});

test("returns undefined when an optional model override is absent", () => {
  assert.equal(readCliStringFlag(["node", "runner"], "--model-coder"), undefined);
});

test("rejects missing, blank, and duplicate model overrides", () => {
  assert.throws(
    () => readCliStringFlag(["node", "runner", "--model-coder"], "--model-coder"),
    /Missing value/,
  );
  assert.throws(
    () => readCliStringFlag(["node", "runner", "--model-coder="], "--model-coder"),
    /Missing value/,
  );
  assert.throws(
    () => readCliStringFlag(
      ["node", "runner", "--model-coder=a", "--model-coder", "b"],
      "--model-coder",
    ),
    /specified more than once/,
  );
});
