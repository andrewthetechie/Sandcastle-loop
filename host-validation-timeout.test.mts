import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatHostValidationTimeoutFeedback,
  isHostCommandTimeout,
  wrapHostCommandWithTimeout,
} from "./host-validation-timeout.mts";

test("wraps a command so GNU timeout kills the whole process group", () => {
  const command = wrapHostCommandWithTimeout({
    command: "cargo test",
    timeoutSeconds: 900,
    hasTimeoutBinary: true,
  });

  assert.equal(command, "timeout --kill-after=10s 900s sh -c 'cargo test'");
});

test("keeps shell operators inside the wrapped command instead of splitting them", () => {
  const command = wrapHostCommandWithTimeout({
    command: "npm run build && npm test",
    timeoutSeconds: 60,
    hasTimeoutBinary: true,
  });

  assert.equal(command, "timeout --kill-after=10s 60s sh -c 'npm run build && npm test'");
});

test("shell-quotes single quotes in the wrapped command", () => {
  const command = wrapHostCommandWithTimeout({
    command: "sh -c 'echo hi'",
    timeoutSeconds: 30,
    hasTimeoutBinary: true,
  });

  assert.equal(command, `timeout --kill-after=10s 30s sh -c 'sh -c '\\''echo hi'\\'''`);
});

test("passes the command through unchanged when timeout is unavailable", () => {
  assert.equal(
    wrapHostCommandWithTimeout({
      command: "cargo test",
      timeoutSeconds: 900,
      hasTimeoutBinary: false,
    }),
    "cargo test",
  );
});

test("recognizes both timeout enforcement paths", () => {
  assert.equal(isHostCommandTimeout({ status: 124 }), true);
  assert.equal(isHostCommandTimeout({ status: 137 }), true);
  assert.equal(
    isHostCommandTimeout({ status: null, errorCode: "ETIMEDOUT", signal: "SIGKILL" }),
    true,
  );
  assert.equal(isHostCommandTimeout({ status: null, signal: "SIGKILL" }), true);
});

test("does not mistake an ordinary failing command for a timeout", () => {
  assert.equal(isHostCommandTimeout({ status: 1 }), false);
  assert.equal(isHostCommandTimeout({ status: 101, errorCode: null }), false);
});

test("timeout feedback names the hang and keeps the tail of partial output", () => {
  const feedback = formatHostValidationTimeoutFeedback({
    command: "cargo test",
    timeoutSeconds: 900,
    output: "running 78 tests\ntest ai::retrieval::tests::respects_k_cap has been running for over 60 seconds",
  });

  assert.match(feedback, /## Host validation timed out/);
  assert.match(feedback, /did not finish within 900s/);
  assert.match(feedback, /never terminates/);
  assert.match(feedback, /respects_k_cap/);
});

test("timeout feedback states plainly when nothing was produced", () => {
  const feedback = formatHostValidationTimeoutFeedback({
    command: "npm run build",
    timeoutSeconds: 300,
    output: "   \n",
  });

  assert.match(feedback, /produced no output before it was killed/);
});
