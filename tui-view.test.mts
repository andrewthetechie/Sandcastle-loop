import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiStatus, TuiStep } from "./tui-status.mts";
import { deriveStatusView, deriveWorkingLogTarget } from "./tui-view.mts";

function status(overrides: Partial<TuiStatus> = {}): TuiStatus {
  return {
    schemaVersion: 1,
    loopType: "prd",
    loopId: "prd-004",
    pid: 4242,
    loopStartedAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:05:00.000Z",
    loopState: "running",
    phase: "normal_issue",
    step: {
      kind: "agent",
      name: "coder",
      startedAt: "2026-07-02T10:05:00.000Z",
      detail: "anthropic/claude-sonnet-4-5",
      activeLogPath: "/repo/.sandcastle/tui/logs/coder.log",
    },
    ...overrides,
  };
}

test("running loop advances elapsed against now and is not frozen", () => {
  // The heartbeat keeps updatedAt fresh while the step runs, so liveness stays
  // running and elapsed tracks now - step.startedAt.
  const view = deriveStatusView(
    status({ updatedAt: "2026-07-02T10:05:41.000Z" }),
    new Date("2026-07-02T10:05:42.000Z"),
  );
  assert.equal(view.liveness, "running");
  assert.equal(view.elapsedFrozen, false);
  assert.equal(view.elapsedMs, 42_000);
  assert.equal(view.elapsedLabel, "0:42");
});

test("elapsed label switches to h:mm:ss past an hour with a fresh heartbeat", () => {
  const view = deriveStatusView(
    status({ updatedAt: "2026-07-02T11:06:04.000Z" }),
    new Date("2026-07-02T11:06:05.000Z"),
  );
  assert.equal(view.liveness, "running");
  assert.equal(view.elapsedLabel, "1:01:05");
});

test("stale heartbeat freezes elapsed at the last update", () => {
  const view = deriveStatusView(
    status(),
    new Date("2026-07-02T10:05:12.000Z"),
    { staleThresholdMs: 8_000, deadThresholdMs: 30_000 },
  );
  assert.equal(view.liveness, "stale");
  assert.equal(view.elapsedFrozen, true);
  assert.equal(view.elapsedMs, 0);
});

test("heartbeat past the dead threshold marks the loop dead and freezes", () => {
  const view = deriveStatusView(
    status({ updatedAt: "2026-07-02T10:05:00.000Z" }),
    new Date("2026-07-02T10:06:00.000Z"),
  );
  assert.equal(view.liveness, "dead");
  assert.equal(view.elapsedFrozen, true);
});

test("a dead pid marks the loop dead even with a fresh heartbeat", () => {
  const view = deriveStatusView(
    status(),
    new Date("2026-07-02T10:05:01.000Z"),
    { pidAlive: false },
  );
  assert.equal(view.liveness, "dead");
  assert.equal(view.elapsedFrozen, true);
});

test("clean stop is distinct from dead and surfaces the stop reason", () => {
  const view = deriveStatusView(
    status({
      loopState: "stopped",
      stopReason: "queue clean",
      updatedAt: "2026-07-02T10:05:10.000Z",
    }),
    new Date("2026-07-02T10:20:00.000Z"),
  );
  assert.equal(view.liveness, "stopped");
  assert.equal(view.elapsedFrozen, true);
  assert.equal(view.elapsedMs, 10_000);
  assert.equal(view.stopReason, "queue clean");
});

test("labels format phase, counters, ticket, and step name", () => {
  const view = deriveStatusView(
    status({
      phase: "extra_review",
      iteration: { current: 2, max: 40 },
      round: { current: 3, max: 5 },
      extraReviewRound: { current: 1, max: 3 },
      ticket: { number: 7, title: "Add widget", branch: "prd-004-issue-7" },
      step: {
        kind: "host",
        name: "base_validation",
        startedAt: "2026-07-02T10:05:00.000Z",
        detail: "npm run test",
      },
    }),
    new Date("2026-07-02T10:05:01.000Z"),
  );
  assert.equal(view.phaseLabel, "extra review");
  assert.equal(view.iterationLabel, "2/40");
  assert.equal(view.roundLabel, "3/5");
  assert.equal(view.extraReviewRoundLabel, "1/3");
  assert.equal(view.ticketLabel, "#7 Add widget");
  assert.equal(view.stepKind, "host");
  assert.equal(view.stepLabel, "base validation");
  assert.equal(view.stepDetail, "npm run test");
});

test("absent counters and ticket derive to null", () => {
  const view = deriveStatusView(
    status({ step: { kind: "host", name: "merge", startedAt: "2026-07-02T10:05:00.000Z" } }),
    new Date("2026-07-02T10:05:01.000Z"),
  );
  assert.equal(view.iterationLabel, null);
  assert.equal(view.roundLabel, null);
  assert.equal(view.extraReviewRoundLabel, null);
  assert.equal(view.ticket, null);
  assert.equal(view.ticketLabel, null);
  assert.equal(view.stepDetail, null);
});

const agentStep = (path: string): TuiStep => ({
  kind: "agent",
  name: "coder",
  startedAt: "2026-07-02T10:05:00.000Z",
  activeLogPath: path,
});

test("working-log target clears and retargets on the first agent step", () => {
  const target = deriveWorkingLogTarget(
    null,
    status({ step: agentStep("/logs/coder.log") }),
  );
  assert.deepEqual(target, { action: "clear", activeLogPath: "/logs/coder.log" });
});

test("working-log target continues within the same agent step", () => {
  const prev = status({ step: agentStep("/logs/coder.log") });
  const next = status({
    step: agentStep("/logs/coder.log"),
    updatedAt: "2026-07-02T10:05:05.000Z",
  });
  const target = deriveWorkingLogTarget(prev, next);
  assert.deepEqual(target, {
    action: "continue",
    activeLogPath: "/logs/coder.log",
  });
});

test("working-log target clears and retargets on a new agent step", () => {
  const prev = status({ step: agentStep("/logs/coder.log") });
  const next = status({ step: agentStep("/logs/reviewer.log") });
  const target = deriveWorkingLogTarget(prev, next);
  assert.deepEqual(target, {
    action: "clear",
    activeLogPath: "/logs/reviewer.log",
  });
});

test("working-log target freezes during a host step without retargeting", () => {
  const prev = status({ step: agentStep("/logs/coder.log") });
  const next = status({
    step: { kind: "host", name: "validation", startedAt: "2026-07-02T10:06:00.000Z" },
  });
  const target = deriveWorkingLogTarget(prev, next);
  assert.deepEqual(target, { action: "freeze", activeLogPath: null });
});

test("an agent step following a host step clears (host is not the same step)", () => {
  const prev = status({
    step: { kind: "host", name: "validation", startedAt: "2026-07-02T10:06:00.000Z" },
  });
  const next = status({ step: agentStep("/logs/coder.log") });
  const target = deriveWorkingLogTarget(prev, next);
  assert.deepEqual(target, { action: "clear", activeLogPath: "/logs/coder.log" });
});
