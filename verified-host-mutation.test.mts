import assert from "node:assert/strict";
import { test } from "node:test";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

test("runVerifiedHostMutation succeeds on attempt 1", async () => {
  const events: string[] = [];
  const result = await runVerifiedHostMutation({
    mutate() {
      events.push("mutate-1");
    },
    readBack() {
      events.push("read-1");
      return { state: "ok" };
    },
    verify(value) {
      events.push(`verify-${value.state}`);
      return true;
    },
    describe(value) {
      return `state=${value.state}`;
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attemptsUsed, 1);
  assert.deepEqual(events, ["mutate-1", "read-1", "verify-ok"]);
  assert.deepEqual(result.diagnostics, ["attempt 1: verified state=ok"]);
});

test("runVerifiedHostMutation succeeds on attempts 2 and 3 after read-back mismatches", async () => {
  const values = [{ ok: false }, { ok: true }];
  const attempt2 = await runVerifiedHostMutation({
    mutate() {},
    readBack() {
      return values.shift()!;
    },
    verify(value) {
      return value.ok;
    },
    describe(value) {
      return `ok=${value.ok}`;
    },
  });
  assert.equal(attempt2.ok, true);
  if (attempt2.ok) assert.equal(attempt2.attemptsUsed, 2);

  let reads = 0;
  const attempt3 = await runVerifiedHostMutation({
    mutate() {},
    readBack() {
      reads += 1;
      return { ok: reads === 3 };
    },
    verify(value) {
      return value.ok;
    },
    describe(value) {
      return `ok=${value.ok}`;
    },
  });
  assert.equal(attempt3.ok, true);
  if (attempt3.ok) assert.equal(attempt3.attemptsUsed, 3);
});

test("runVerifiedHostMutation exhausts on persistent mutate failure", async () => {
  const result = await runVerifiedHostMutation({
    mutate() {
      throw new Error("boom");
    },
    readBack() {
      throw new Error("should not run");
    },
    verify() {
      return false;
    },
    describe() {
      return "never";
    },
  });

  assert.deepEqual(result, {
    ok: false,
    attemptsUsed: 3,
    diagnostics: [
      "attempt 1: mutate failed: boom",
      "attempt 2: mutate failed: boom",
      "attempt 3: mutate failed: boom",
    ],
  });
});

test("runVerifiedHostMutation exhausts on persistent verification mismatch", async () => {
  const result = await runVerifiedHostMutation({
    mutate() {},
    readBack() {
      return { version: "stale" };
    },
    verify() {
      return false;
    },
    describe(value) {
      return `version=${value.version}`;
    },
  });

  assert.deepEqual(result, {
    ok: false,
    attemptsUsed: 3,
    diagnostics: [
      "attempt 1: verification mismatch: version=stale",
      "attempt 2: verification mismatch: version=stale",
      "attempt 3: verification mismatch: version=stale",
    ],
  });
});

test("runVerifiedHostMutation preserves diagnostic order across mutate, read-back, and verify failures", async () => {
  let attempt = 0;
  const result = await runVerifiedHostMutation({
    mutate() {
      attempt += 1;
      if (attempt === 1) throw new Error("mutate one");
    },
    readBack() {
      if (attempt === 2) throw new Error("read two");
      return { ok: false };
    },
    verify() {
      return false;
    },
    describe() {
      return "ok=false";
    },
  });

  assert.deepEqual(result, {
    ok: false,
    attemptsUsed: 3,
    diagnostics: [
      "attempt 1: mutate failed: mutate one",
      "attempt 2: read-back failed: read two",
      "attempt 3: verification mismatch: ok=false",
    ],
  });
});
