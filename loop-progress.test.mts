import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialLivelockDetectorState,
  initialNoProgressState,
  observeFailedRoundFingerprint,
  observeNormalizedToolCall,
  toolCallIdentity,
  toolCallIdentityKey,
  type WorktreeProgressSnapshot,
} from "./loop-progress.mts";

function snapshot(
  head: string,
  porcelainStatus: string,
): WorktreeProgressSnapshot {
  return { head, porcelainStatus };
}

test("first failed-round fingerprint seeds state without stalling", () => {
  const r = observeFailedRoundFingerprint(
    initialNoProgressState(),
    {
      diffHash: "diff-a",
      source: "validation",
      signatureHash: "sig-a",
      signatureSummary: "npm run test :: boom",
    },
    3,
  );
  assert.equal(r.stalled, false);
  assert.equal(r.state.repeatCount, 0);
});

test("three identical repeats after the seed stall at the limit", () => {
  let state = initialNoProgressState();
  for (let i = 0; i < 3; i++) {
    const seeded = observeFailedRoundFingerprint(
      state,
      {
        diffHash: "diff-a",
        source: "validation",
        signatureHash: "sig-a",
        signatureSummary: "npm run test :: boom",
      },
      3,
    );
    state = seeded.state;
    assert.equal(seeded.stalled, false);
  }
  const r = observeFailedRoundFingerprint(
    state,
    {
      diffHash: "diff-a",
      source: "validation",
      signatureHash: "sig-a",
      signatureSummary: "npm run test :: boom",
    },
    3,
  );
  assert.equal(r.stalled, true);
  assert.equal(r.state.repeatCount, 3);
});

test("a changed diff, source, or signature resets the failed-round streak", () => {
  let state = initialNoProgressState();
  ({ state } = observeFailedRoundFingerprint(
    state,
    {
      diffHash: "diff-a",
      source: "validation",
      signatureHash: "sig-a",
      signatureSummary: "first",
    },
    3,
  ));
  ({ state } = observeFailedRoundFingerprint(
    state,
    {
      diffHash: "diff-a",
      source: "validation",
      signatureHash: "sig-a",
      signatureSummary: "first",
    },
    3,
  ));
  const r = observeFailedRoundFingerprint(
    state,
    {
      diffHash: "diff-b",
      source: "reviewer_changes_requested",
      signatureHash: "sig-b",
      signatureSummary: "second",
    },
    3,
  );
  assert.equal(r.stalled, false);
  assert.equal(r.state.repeatCount, 0);
});

test("tool call identity normalizes tool name case and argument whitespace", () => {
  const a = toolCallIdentity("Bash", "git   status   -s");
  const b = toolCallIdentity("bash", "git status -s");
  assert.deepEqual(a, b);
  assert.equal(a.tool, "bash");
  assert.equal(a.args, "git status -s");
});

test("tool call identity trims leading and trailing argument whitespace", () => {
  const id = toolCallIdentity("Shell", "  git status  ");
  assert.equal(id.args, "git status");
});

test("different tool call arguments do not match", () => {
  const a = toolCallIdentity("bash", "git status -s");
  const b = toolCallIdentity("bash", "git status");
  assert.notDeepEqual(a, b);
});

test("five consecutive identical tool calls report livelock at threshold 5", () => {
  let state = initialLivelockDetectorState();
  const id = toolCallIdentity("bash", "git status -s");
  const snap = snapshot("abc123", " M loop-progress.mts");
  for (let i = 1; i < 5; i++) {
    const r = observeNormalizedToolCall(state, id, snap, 5);
    state = r.state;
    assert.equal(r.livelockCandidate, false, `call ${i} should not report`);
  }
  const r = observeNormalizedToolCall(state, id, snap, 5);
  assert.equal(r.livelockCandidate, true);
  assert.equal(r.state.toolCallStreak, 5);
});

test("five consecutive identical tool calls with unchanged snapshot report livelock", () => {
  let state = initialLivelockDetectorState();
  const id = toolCallIdentity("bash", "npm test");
  const snap = snapshot("deadbeef", "");
  for (let i = 1; i < 5; i++) {
    ({ state } = observeNormalizedToolCall(state, id, snap, 5));
  }
  const r = observeNormalizedToolCall(state, id, snap, 5);
  assert.equal(r.livelockCandidate, true);
  assert.equal(r.state.streakStartSnapshot, snap);
});

test("changed HEAD on fifth matching call prevents livelock report", () => {
  let state = initialLivelockDetectorState();
  const id = toolCallIdentity("bash", "npm test");
  const start = snapshot("aaaa1111", " M foo.mts");
  for (let i = 1; i < 5; i++) {
    ({ state } = observeNormalizedToolCall(state, id, start, 5));
  }
  const progressed = snapshot("bbbb2222", " M foo.mts");
  const r = observeNormalizedToolCall(state, id, progressed, 5);
  assert.equal(r.livelockCandidate, false);
  assert.equal(r.state.toolCallStreak, 5);
  assert.equal(r.state.streakStartSnapshot?.head, "aaaa1111");
});

test("changed porcelain status on fifth matching call prevents livelock report", () => {
  let state = initialLivelockDetectorState();
  const id = toolCallIdentity("bash", "npm test");
  const start = snapshot("aaaa1111", "");
  for (let i = 1; i < 5; i++) {
    ({ state } = observeNormalizedToolCall(state, id, start, 5));
  }
  const progressed = snapshot("aaaa1111", " M bar.mts");
  const r = observeNormalizedToolCall(state, id, progressed, 5);
  assert.equal(r.livelockCandidate, false);
  assert.equal(r.state.toolCallStreak, 5);
});

test("first call in a streak stores the streak-start snapshot", () => {
  const snap = snapshot("cafebabe", "?? new.mts");
  const id = toolCallIdentity("read", "loop-progress.mts");
  const r = observeNormalizedToolCall(initialLivelockDetectorState(), id, snap, 5);
  assert.deepEqual(r.state.streakStartSnapshot, snap);
  assert.equal(r.state.toolCallStreak, 1);
});

test("five total matching calls do not report when interrupted by a different tool", () => {
  let state = initialLivelockDetectorState();
  const a = toolCallIdentity("bash", "git status -s");
  const b = toolCallIdentity("read", "loop-progress.mts");
  const snap = snapshot("abc123", "");
  const sequence = [a, a, b, a, a] as const;
  for (const id of sequence) {
    const r = observeNormalizedToolCall(state, id, snap, 5);
    state = r.state;
    assert.equal(r.livelockCandidate, false);
  }
  assert.equal(state.toolCallStreak, 2);
});

test("a different tool call resets the repeated-call streak", () => {
  let state = initialLivelockDetectorState();
  const a = toolCallIdentity("bash", "git status -s");
  const b = toolCallIdentity("read", "loop-progress.mts");
  const snap = snapshot("abc123", "");
  ({ state } = observeNormalizedToolCall(state, a, snap, 5));
  ({ state } = observeNormalizedToolCall(state, a, snap, 5));
  assert.equal(state.toolCallStreak, 2);
  const r = observeNormalizedToolCall(state, b, snap, 5);
  state = r.state;
  assert.equal(r.livelockCandidate, false);
  assert.equal(state.toolCallStreak, 1);
  assert.notEqual(state.lastToolCallKey, toolCallIdentityKey(a));
  assert.deepEqual(state.streakStartSnapshot, snap);
});
