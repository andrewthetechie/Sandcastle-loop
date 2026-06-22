import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INVOCATION_LIVELOCK_KIND,
  agentInvocationStageForRound,
  createLivelockWatchdogStreamCallback,
  formatAgentInvocationLivelockFeedback,
  isAgentInvocationLivelockReason,
  resolveRound1CoderLivelockControlFlow,
  resolveRound1CoderLivelockEscalation,
  resolveReworkLivelockControlFlow,
  toolCallObservationFromStreamEvent,
  type AgentInvocationLivelockReason,
} from "./agent-invocation-livelock.mts";
import type { WorktreeProgressSnapshot } from "./loop-progress.mts";
import { buildIssueOutcomeRecord } from "./metrics-recorder.mts";

function snapshot(
  head: string,
  porcelainStatus: string,
): WorktreeProgressSnapshot {
  return { head, porcelainStatus };
}

function toolCallEvent(name: string, formattedArgs: string) {
  return {
    type: "toolCall" as const,
    name,
    formattedArgs,
    iteration: 1,
    timestamp: new Date("2026-06-22T12:00:00Z"),
  };
}

function textEvent(message: string) {
  return {
    type: "text" as const,
    message,
    iteration: 1,
    timestamp: new Date("2026-06-22T12:00:00Z"),
  };
}

/** Simulate a rework agent invocation aborting after repeated identical tool calls. */
function simulateReworkWatchdogLivelockAbort(
  toolName: string,
  formattedArgs: string,
): unknown {
  const abortController = new AbortController();
  const snap = snapshot("deadbeef", " M rework-user-prompt-prd.md");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
  });
  const event = toolCallEvent(toolName, formattedArgs);
  for (let i = 0; i < 5; i++) {
    onEvent(event);
  }
  assert.equal(abortController.signal.aborted, true);
  return abortController.signal.reason;
}

test("parsed tool-call stream event yields tool name and formatted args", () => {
  const observation = toolCallObservationFromStreamEvent({
    type: "toolCall",
    name: "Bash",
    formattedArgs: "git status -s",
    iteration: 2,
    timestamp: new Date("2026-06-22T12:00:00Z"),
  });
  assert.deepEqual(observation, {
    toolName: "Bash",
    formattedArgs: "git status -s",
  });
});

test("text stream event yields no observation", () => {
  const observation = toolCallObservationFromStreamEvent({
    type: "text",
    message: "Checking repository status…",
    iteration: 1,
    timestamp: new Date("2026-06-22T12:00:00Z"),
  });
  assert.equal(observation, null);
});

test("raw stream event yields no observation", () => {
  const observation = toolCallObservationFromStreamEvent({
    type: "raw",
    line: '{"type":"tool_call","name":"Bash"}',
    iteration: 1,
    timestamp: new Date("2026-06-22T12:00:00Z"),
  });
  assert.equal(observation, null);
});

test("malformed events yield no observation without throwing", () => {
  const cases: unknown[] = [
    null,
    undefined,
    "toolCall",
    42,
    { type: "toolCall" },
    { type: "toolCall", name: "Bash" },
    { type: "toolCall", formattedArgs: "git status -s" },
    { type: "toolCall", name: 1, formattedArgs: "git status -s" },
    { type: "toolCall", name: "Bash", formattedArgs: null },
    { type: "tool_call", name: "Bash", args: "git status -s" },
  ];
  for (const event of cases) {
    assert.equal(toolCallObservationFromStreamEvent(event), null);
  }
});

test("watchdog forwards every stream event to the original callback", () => {
  const received: unknown[] = [];
  const abortController = new AbortController();
  const snap = snapshot("abc123", " M loop-progress.mts");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
    onStreamEvent: (event) => received.push(event),
  });

  const text = textEvent("Checking status…");
  const tool = toolCallEvent("Bash", "git status -s");
  onEvent(text);
  onEvent(tool);

  assert.deepEqual(received, [text, tool]);
  assert.equal(abortController.signal.aborted, false);
});

test("watchdog aborts only after fifth identical tool call with unchanged progress", () => {
  const abortController = new AbortController();
  const snap = snapshot("deadbeef", " M agent-invocation-livelock.mts");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
  });

  const event = toolCallEvent("Bash", "git status -s");
  for (let i = 0; i < 4; i++) {
    onEvent(event);
    assert.equal(
      abortController.signal.aborted,
      false,
      `call ${i + 1} should not abort`,
    );
  }

  onEvent(event);
  assert.equal(abortController.signal.aborted, true);
});

test("watchdog abort reason is structured and names the repeated call", () => {
  const abortController = new AbortController();
  const snap = snapshot("cafebabe", "");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
    threshold: 5,
  });

  const event = toolCallEvent("Bash", "  git   status -s  ");
  for (let i = 0; i < 5; i++) {
    onEvent(event);
  }

  const reason = abortController.signal.reason as AgentInvocationLivelockReason;
  assert.equal(reason.kind, AGENT_INVOCATION_LIVELOCK_KIND);
  assert.deepEqual(reason.toolCall, {
    tool: "bash",
    args: "git status -s",
  });
  assert.equal(reason.threshold, 5);
  assert.deepEqual(reason.noProgressSnapshot, snap);
});

test("text-only stream events do not abort", () => {
  const abortController = new AbortController();
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snapshot("abc123", ""),
  });

  for (let i = 0; i < 10; i++) {
    onEvent(textEvent(`still working ${i}`));
  }

  assert.equal(abortController.signal.aborted, false);
});

test("livelock feedback names repeated call, threshold, and no progress", () => {
  const reason: AgentInvocationLivelockReason = {
    kind: AGENT_INVOCATION_LIVELOCK_KIND,
    toolCall: { tool: "bash", args: "git status -s" },
    threshold: 5,
    noProgressSnapshot: snapshot("cafebabe", " M agent-invocation-livelock.mts"),
  };

  const feedback = formatAgentInvocationLivelockFeedback(reason);

  assert.match(feedback, /^## Agent invocation livelock/m);
  assert.match(feedback, /`bash`/);
  assert.match(feedback, /`git status -s`/);
  assert.match(feedback, /5 consecutive identical tool calls/);
  assert.match(feedback, /No `HEAD` or porcelain-status progress was observed/);
  assert.match(feedback, /`cafebabe`/);
  assert.match(feedback, /` M agent-invocation-livelock\.mts`/);
});

test("changed worktree snapshot on fifth matching call does not abort", () => {
  const abortController = new AbortController();
  let snap = snapshot("aaaa1111", "");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
  });

  const event = toolCallEvent("Bash", "npm test");
  for (let i = 0; i < 4; i++) {
    onEvent(event);
  }
  snap = snapshot("bbbb2222", "");
  onEvent(event);

  assert.equal(abortController.signal.aborted, false);
});

test("type guard accepts structured livelock reasons", () => {
  const reason: AgentInvocationLivelockReason = {
    kind: AGENT_INVOCATION_LIVELOCK_KIND,
    toolCall: { tool: "bash", args: "git status -s" },
    threshold: 5,
    noProgressSnapshot: snapshot("cafebabe", ""),
  };
  assert.equal(isAgentInvocationLivelockReason(reason), true);
});

test("type guard rejects ordinary Error objects", () => {
  assert.equal(isAgentInvocationLivelockReason(new Error("boom")), false);
  assert.equal(
    isAgentInvocationLivelockReason(new Error(AGENT_INVOCATION_LIVELOCK_KIND)),
    false,
  );
});

test("type guard rejects objects with missing or wrong kind", () => {
  const fields = {
    toolCall: { tool: "bash", args: "git status -s" },
    threshold: 5,
    noProgressSnapshot: snapshot("cafebabe", ""),
  };
  assert.equal(isAgentInvocationLivelockReason(fields), false);
  assert.equal(isAgentInvocationLivelockReason("agent_invocation_livelock"), false);
  assert.equal(
    isAgentInvocationLivelockReason({
      ...fields,
      kind: "idle_timeout",
    }),
    false,
  );
});

test("type guard rejects malformed reason-like objects", () => {
  const base = {
    kind: AGENT_INVOCATION_LIVELOCK_KIND,
    toolCall: { tool: "bash", args: "git status -s" },
    threshold: 5,
    noProgressSnapshot: snapshot("abc", ""),
  };
  assert.equal(
    isAgentInvocationLivelockReason({
      ...base,
      toolCall: { tool: "bash" },
    }),
    false,
  );
  assert.equal(
    isAgentInvocationLivelockReason({
      ...base,
      threshold: Number.NaN,
    }),
    false,
  );
  assert.equal(
    isAgentInvocationLivelockReason({
      ...base,
      noProgressSnapshot: { head: 1, porcelainStatus: "" },
    }),
    false,
  );
});

test("round-1 coder livelock maps to continue_with_feedback", () => {
  const reason: AgentInvocationLivelockReason = {
    kind: AGENT_INVOCATION_LIVELOCK_KIND,
    toolCall: { tool: "bash", args: "git status -s" },
    threshold: 5,
    noProgressSnapshot: snapshot("cafebabe", ""),
  };

  const control = resolveRound1CoderLivelockControlFlow(reason);
  assert.equal(control.action, "continue_with_feedback");
  if (control.action !== "continue_with_feedback") return;
  assert.match(control.feedback, /^## Agent invocation livelock/m);
  assert.match(control.feedback, /`git status -s`/);
});

test("non-livelock errors map to rethrow", () => {
  const err = new Error("idle timeout");
  const control = resolveRound1CoderLivelockControlFlow(err);
  assert.equal(control.action, "rethrow");
  if (control.action !== "rethrow") return;
  assert.equal(control.error, err);
});

test("rework runner control flow: watchdog livelock terminates stuck without retry", () => {
  const reworkErr = simulateReworkWatchdogLivelockAbort(
    "Read",
    "  loop-progress.mts  ",
  );
  assert.equal(isAgentInvocationLivelockReason(reworkErr), true);

  const control = resolveReworkLivelockControlFlow(reworkErr);
  assert.equal(control.action, "break_to_stuck");
  assert.notEqual(control.action, "continue_with_feedback");
  if (control.action !== "break_to_stuck") return;

  assert.equal(control.terminalReason, "stuck_livelock");
  assert.match(control.feedback, /^## Agent invocation livelock/m);
  assert.match(control.feedback, /Repeated tool call: `read`/);
  assert.match(control.feedback, /`loop-progress\.mts`/);

  const coderControl = resolveRound1CoderLivelockControlFlow(reworkErr);
  assert.equal(coderControl.action, "continue_with_feedback");
  assert.notEqual(control.action, coderControl.action);

  const outcome = buildIssueOutcomeRecord({
    prd: 3,
    issue: 21,
    outcome: control.terminalReason,
    roundsUsed: 2,
  });
  assert.equal(outcome.outcome, "stuck_livelock");
  assert.equal(outcome.rounds_used, 2);
});

test("rework non-livelock errors map to rethrow", () => {
  const err = new Error("idle timeout");
  const control = resolveReworkLivelockControlFlow(err);
  assert.equal(control.action, "rethrow");
  if (control.action !== "rethrow") return;
  assert.equal(control.error, err);
});

test("agent stage for round 1 is coder and round 2+ is rework", () => {
  assert.equal(agentInvocationStageForRound(1), "coder");
  assert.equal(agentInvocationStageForRound(2), "rework");
  assert.equal(agentInvocationStageForRound(5), "rework");
});

test("simulated round-1 coder livelock escalates to rework with synthetic feedback", () => {
  const abortController = new AbortController();
  const snap = snapshot("deadbeef", " M loop-progress.mts");
  const onEvent = createLivelockWatchdogStreamCallback({
    abortController,
    getWorktreeSnapshot: () => snap,
    threshold: 5,
  });

  const repeatedCall = toolCallEvent("Bash", "git status -s");
  for (let i = 0; i < 5; i++) {
    onEvent(repeatedCall);
  }

  assert.equal(abortController.signal.aborted, true);
  const livelockReason = abortController.signal.reason;
  assert.equal(isAgentInvocationLivelockReason(livelockReason), true);

  const escalation = resolveRound1CoderLivelockEscalation(livelockReason, 1);
  assert.equal(escalation.action, "escalate_to_rework");
  if (escalation.action !== "escalate_to_rework") return;

  assert.equal(escalation.nextRound, 2);
  assert.equal(escalation.nextStage, "rework");
  assert.match(escalation.feedback, /^## Agent invocation livelock/m);
  assert.match(escalation.feedback, /Repeated tool call: `bash`/);
  assert.match(escalation.feedback, /`git status -s`/);
});

test("round-1 coder non-livelock errors escalate helper rethrows", () => {
  const err = new Error("sandcastle idle timeout");
  const escalation = resolveRound1CoderLivelockEscalation(err, 1);
  assert.equal(escalation.action, "rethrow");
  if (escalation.action !== "rethrow") return;
  assert.equal(escalation.error, err);
});
