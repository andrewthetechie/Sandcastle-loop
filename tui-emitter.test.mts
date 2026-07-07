import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiEmitter } from "./tui-emitter.mts";
import type { TuiStatus } from "./tui-status.mts";

interface Harness {
  emitter: TuiEmitter;
  snapshots: TuiStatus[];
  truncated: string[];
  appended: Array<{ path: string; text: string }>;
}

function makeHarness(
  overrides: Partial<{
    throwOnWrite: boolean;
  }> = {},
): Harness {
  const snapshots: TuiStatus[] = [];
  const truncated: string[] = [];
  const appended: Array<{ path: string; text: string }> = [];
  const emitter = new TuiEmitter({
    cwd: "/repo",
    heartbeatIntervalMs: 1_000_000,
    now: () => new Date("2026-07-02T10:00:00.000Z"),
    writeSnapshot: (_dir, status) => {
      if (overrides.throwOnWrite) throw new Error("disk full");
      snapshots.push(structuredClone(status));
    },
    truncateLog: (path) => {
      truncated.push(path);
    },
    appendLog: (path, text) => {
      appended.push({ path, text });
    },
  });
  return { emitter, snapshots, truncated, appended };
}

function last(snapshots: TuiStatus[]): TuiStatus {
  const value = snapshots.at(-1);
  assert.ok(value, "expected at least one snapshot");
  return value;
}

test("no emission happens before startLoop is called", () => {
  const h = makeHarness();
  h.emitter.setPhase("extra_review");
  h.emitter.beginHostStep("validation");
  const path = h.emitter.beginAgentStep({ stage: "coder", model: "m" });
  h.emitter.workingLogSink("/repo/.sandcastle/tui/logs/coder.log")({
    type: "toolCall",
    name: "Bash",
    formattedArgs: "ls",
  });
  h.emitter.stop("done");

  assert.equal(path, undefined);
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.truncated.length, 0);
  assert.equal(h.appended.length, 0);
});

test("startLoop emits an initial running snapshot", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "prd", loopId: "prd-004", pid: 99 });

  const snapshot = last(h.snapshots);
  assert.equal(snapshot.loopState, "running");
  assert.equal(snapshot.loopType, "prd");
  assert.equal(snapshot.loopId, "prd-004");
  assert.equal(snapshot.pid, 99);
  assert.equal(snapshot.step.kind, "host");
  assert.equal(snapshot.step.name, "startup");
});

test("beginAgentStep opens a fresh working log and writes an agent snapshot", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "prd", loopId: "prd-004" });
  const logPath = "/repo/.sandcastle/tui/logs/coder.log";
  const returned = h.emitter.beginAgentStep({
    stage: "coder",
    agent: "coder",
    model: "anthropic/claude-sonnet-4-5",
    activeLogPath: logPath,
  });

  assert.equal(returned, logPath);
  assert.deepEqual(h.truncated, [logPath]);
  const snapshot = last(h.snapshots);
  assert.equal(snapshot.step.kind, "agent");
  assert.equal(snapshot.step.name, "coder");
  assert.equal(snapshot.step.detail, "anthropic/claude-sonnet-4-5");
  assert.equal(snapshot.step.activeLogPath, logPath);
});

test("workingLogSink appends formatted lines and ignores empty events", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "backlog", loopId: "bug" });
  const logPath = "/repo/.sandcastle/tui/logs/coder.log";
  const sink = h.emitter.workingLogSink(logPath);

  sink({ type: "toolCall", name: "Bash", formattedArgs: "git status -s" });
  sink({ type: "toolResult", output: "ignored" });
  sink({ type: "text", message: "thinking" });

  assert.deepEqual(h.appended, [
    { path: logPath, text: "→ Bash(git status -s)\n" },
    { path: logPath, text: "thinking\n" },
  ]);
});

test("context setters are reflected in the next snapshot", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "prd", loopId: "prd-004" });
  h.emitter.setIteration({ current: 3, max: 40 });
  h.emitter.setTicket({ number: 7, title: "Add widget", branch: "prd-004-issue-7" });
  h.emitter.setRound({ current: 2, max: 5 });

  const snapshot = last(h.snapshots);
  assert.deepEqual(snapshot.iteration, { current: 3, max: 40 });
  assert.deepEqual(snapshot.round, { current: 2, max: 5 });
  assert.deepEqual(snapshot.ticket, {
    number: 7,
    title: "Add widget",
    branch: "prd-004-issue-7",
  });

  h.emitter.clearTicket();
  const cleared = last(h.snapshots);
  assert.equal("ticket" in cleared, false);
  assert.equal("round" in cleared, false);
});

test("ticket switching is reflected across child and parent steps with distinct working logs", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "backlog", loopId: "bug" });

  h.emitter.setTicket({ number: 12, title: "Child issue", branch: "issue-9-child-12" });
  const childLogPath = "/repo/.sandcastle/tui/logs/subtask-readiness.log";
  h.emitter.beginAgentStep({
    stage: "subtask_readiness",
    model: "reviewer-model",
    activeLogPath: childLogPath,
  });
  h.emitter.workingLogSink(childLogPath)({ type: "text", message: "child log line" });

  h.emitter.setTicket({ number: 9, title: "Parent issue", branch: "issue-9-accumulation" });
  h.emitter.beginHostStep("full_parent_review", "abc1234");
  const parentSnapshot = last(h.snapshots);
  assert.deepEqual(parentSnapshot.ticket, {
    number: 9,
    title: "Parent issue",
    branch: "issue-9-accumulation",
  });
  assert.equal(parentSnapshot.step.kind, "host");
  assert.equal(parentSnapshot.step.name, "full_parent_review");
  assert.equal("activeLogPath" in parentSnapshot.step, false);

  const parentLogPath = "/repo/.sandcastle/tui/logs/code-quality.log";
  h.emitter.beginAgentStep({
    stage: "code_quality",
    model: "review-model",
    activeLogPath: parentLogPath,
  });
  h.emitter.workingLogSink(parentLogPath)({ type: "text", message: "parent log line" });

  const agentSnapshot = last(h.snapshots);
  assert.deepEqual(agentSnapshot.ticket, {
    number: 9,
    title: "Parent issue",
    branch: "issue-9-accumulation",
  });
  assert.equal(agentSnapshot.step.kind, "agent");
  assert.equal(agentSnapshot.step.name, "code_quality");
  assert.equal(agentSnapshot.step.activeLogPath, parentLogPath);
  assert.deepEqual(h.truncated, [childLogPath, parentLogPath]);
  assert.deepEqual(h.appended, [
    { path: childLogPath, text: "child log line\n" },
    { path: parentLogPath, text: "parent log line\n" },
  ]);
});

test("stop writes a terminal stopped snapshot with the reason", () => {
  const h = makeHarness();
  h.emitter.startLoop({ loopType: "prd", loopId: "prd-004" });
  h.emitter.stop("queue clean");

  const snapshot = last(h.snapshots);
  assert.equal(snapshot.loopState, "stopped");
  assert.equal(snapshot.stopReason, "queue clean");
});

test("a throwing writer is swallowed and never propagates", () => {
  const h = makeHarness({ throwOnWrite: true });
  assert.doesNotThrow(() => {
    h.emitter.startLoop({ loopType: "prd", loopId: "prd-004" });
    const path = h.emitter.beginAgentStep({
      stage: "reviewer",
      activeLogPath: "/repo/.sandcastle/tui/logs/reviewer.log",
    });
    assert.equal(path, "/repo/.sandcastle/tui/logs/reviewer.log");
    h.emitter.setIteration({ current: 1, max: 5 });
    h.emitter.stop("done");
  });
  assert.equal(h.snapshots.length, 0);
});
