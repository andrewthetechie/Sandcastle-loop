import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CUSTOM_AGENT_ARGV_LIMIT_BYTES,
  enforceArgvSizeLimit,
} from "./custom-agent-argv-guard.mts";

test("enforceArgvSizeLimit returns ok with the utf-8 byte count for a small message", () => {
  assert.deepEqual(enforceArgvSizeLimit("small"), { ok: true, bytes: 5 });
});

test("enforceArgvSizeLimit accepts a message exactly at the byte limit", () => {
  const message = "a".repeat(CUSTOM_AGENT_ARGV_LIMIT_BYTES);

  assert.deepEqual(enforceArgvSizeLimit(message), {
    ok: true,
    bytes: CUSTOM_AGENT_ARGV_LIMIT_BYTES,
  });
});

test("enforceArgvSizeLimit rejects a message above the byte limit with an actionable error", () => {
  const bytes = CUSTOM_AGENT_ARGV_LIMIT_BYTES + 1;
  const message = "a".repeat(bytes);
  const result = enforceArgvSizeLimit(message);

  assert.deepEqual(result, {
    ok: false,
    bytes,
    error: `## Rendered agent message too large

The rendered message is ${bytes} bytes, above the ${CUSTOM_AGENT_ARGV_LIMIT_BYTES} byte command-line limit.
These PRD issues are expected to be small. Reduce the issue body / diff scope so the message fits, then retry.`,
  });
});

test("CUSTOM_AGENT_ARGV_LIMIT_BYTES leaves headroom under the argv ceiling", () => {
  assert.equal(CUSTOM_AGENT_ARGV_LIMIT_BYTES, 120_000);
});

test("enforceArgvSizeLimit measures utf-8 bytes rather than character count", () => {
  const message = "€".repeat(2);

  assert.deepEqual(enforceArgvSizeLimit(message, 6), { ok: true, bytes: 6 });

  const result = enforceArgvSizeLimit(message, 5);
  assert.equal(result.ok, false);
  assert.equal(result.bytes, 6);
  assert.match(result.error, /\b6 bytes\b/);
  assert.match(result.error, /\b5 byte command-line limit\b/);
});
