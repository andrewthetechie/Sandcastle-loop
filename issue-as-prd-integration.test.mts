import assert from "node:assert/strict";
import { test } from "node:test";
import { integrateApprovedChild, type ChildIntegrationDeps } from "./issue-as-prd-integration.mts";

test("rejects reviewed base mismatch before mutation", async () => {
  const deps = createDeps({
    localHeadSha: "local-sha",
    remoteHeadSha: "remote-sha",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "reviewed_base_mismatch",
    diagnostics: [
      "Accumulation branch 'issue-42' heads do not match reviewed base reviewed-base: local=local-sha remote=remote-sha.",
    ],
  });
  assert.deepEqual(deps.events, ["read"]);
});

test("recovers when the remote accumulation branch is strictly behind the reviewed base", async () => {
  // Local is at the reviewed base (the clean state the loop owns); the remote
  // lagged behind it (a lost push / interrupted rebase). The remote is a clean
  // ancestor, so the integration fast-forwards it to the approved head instead
  // of stranding the parent as a reviewed_base_mismatch.
  const deps = createDeps({
    localHeadSha: "reviewed-base",
    remoteHeadSha: "behind-sha",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.accumulationHeadSha, "approved-head");
  assert.deepEqual(deps.events, [
    "read",
    "ancestry", // guard: remote behind is an ancestor of the reviewed base
    "ancestry", // push path: reviewed base is an ancestor of the approved head
    "fast-forward",
    "push",
    "remote-read",
    "close",
    "issue-read",
  ]);
  assert.deepEqual(deps.pushExpectedRemoteShas, ["behind-sha"]);
});

test("still rejects when the remote has genuinely diverged from the reviewed base", async () => {
  const deps = createDeps({
    localHeadSha: "reviewed-base",
    remoteHeadSha: "diverged-sha",
    isAncestor: false,
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "reviewed_base_mismatch");
  assert.deepEqual(deps.events, ["read", "ancestry"]);
});

test("rejects non-descendant before fast-forward", async () => {
  const deps = createDeps({ isAncestor: false });

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "non_descendant");
  assert.match(result.diagnostics.join("\n"), /not a descendant/);
  assert.deepEqual(deps.events, ["read", "ancestry"]);
});

test("successful integration uses the exact required operation order", async () => {
  const deps = createDeps();

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: true,
    accumulationHeadSha: "approved-head",
    recoveredFrom: null,
  });
  assert.deepEqual(deps.events, [
    "read",
    "ancestry",
    "fast-forward",
    "push",
    "remote-read",
    "close",
    "issue-read",
  ]);
  assert.deepEqual(deps.pushExpectedRemoteShas, ["reviewed-base"]);
});

test("recovery before local update behaves like a fresh success", async () => {
  const deps = createDeps();

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, true);
  assert.deepEqual(deps.events, [
    "read",
    "ancestry",
    "fast-forward",
    "push",
    "remote-read",
    "close",
    "issue-read",
  ]);
});

test("recovery after local update resumes at push", async () => {
  const deps = createDeps({
    localHeadSha: "approved-head",
    remoteHeadSha: "reviewed-base",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: true,
    accumulationHeadSha: "approved-head",
    recoveredFrom: "after_local_fast_forward",
  });
  assert.deepEqual(deps.events, ["read", "push", "remote-read", "close", "issue-read"]);
});

test("recovery after push resumes at close without another commit", async () => {
  const deps = createDeps({
    localHeadSha: "approved-head",
    remoteHeadSha: "approved-head",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: true,
    accumulationHeadSha: "approved-head",
    recoveredFrom: "after_remote_push",
  });
  assert.deepEqual(deps.events, ["read", "close", "issue-read"]);
});

test("recovery after close returns idempotent success", async () => {
  const deps = createDeps({
    localHeadSha: "approved-head",
    remoteHeadSha: "approved-head",
    issueState: "CLOSED",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: true,
    accumulationHeadSha: "approved-head",
    recoveredFrom: "after_child_close",
  });
  assert.deepEqual(deps.events, ["read", "close", "issue-read"]);
});

test("push failure returns sanitized diagnostics", async () => {
  const deps = createDeps({
    pushError: new Error(
      "fatal: could not push to https://user:secret@example.test/repo.git\nBearer abc123",
    ),
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "push_failed");
  assert.match(result.diagnostics.join("\n"), /\[REDACTED\]/);
  assert.doesNotMatch(result.diagnostics.join("\n"), /secret@example/);
});

test("remote mismatch after push returns remote_verification_failed", async () => {
  const deps = createDeps({
    afterPushRemoteHeadSha: "unexpected-remote",
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "remote_verification_failed",
    diagnostics: [
      "Remote accumulation head mismatch after push: expected approved-head, observed unexpected-remote.",
    ],
  });
});

test("close failure returns close_failed", async () => {
  const deps = createDeps({
    closeError: new Error("issue close denied"),
  });

  const result = await integrateApprovedChild(input(), deps);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "close_failed");
  assert.match(result.diagnostics.join("\n"), /issue close denied/);
});

test("repeated success is idempotent", async () => {
  const deps = createDeps({
    localHeadSha: "approved-head",
    remoteHeadSha: "approved-head",
    issueState: "CLOSED",
  });

  const first = await integrateApprovedChild(input(), deps);
  const second = await integrateApprovedChild(input(), deps);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(deps.events, ["read", "close", "issue-read", "read", "close", "issue-read"]);
});

function input() {
  return {
    childNumber: 42,
    accumulationBranch: "issue-42",
    reviewedBaseSha: "reviewed-base",
    approvedHeadSha: "approved-head",
  };
}

function createDeps(options: {
  localHeadSha?: string;
  remoteHeadSha?: string;
  afterPushRemoteHeadSha?: string;
  isAncestor?: boolean;
  pushError?: Error;
  closeError?: Error;
  issueState?: "OPEN" | "CLOSED";
} = {}): ChildIntegrationDeps & { events: string[]; pushExpectedRemoteShas: string[] } {
  const events: string[] = [];
  const pushExpectedRemoteShas: string[] = [];
  let localHeadSha = options.localHeadSha ?? "reviewed-base";
  let remoteHeadSha = options.remoteHeadSha ?? "reviewed-base";
  let remoteReadCount = 0;
  let issueState = options.issueState ?? "OPEN";

  return {
    events,
    pushExpectedRemoteShas,
    readAccumulationHeads() {
      if (events.length > 0 && events.includes("push")) {
        events.push("remote-read");
      } else {
        events.push("read");
      }
      remoteReadCount += 1;
      if (remoteReadCount >= 2 && options.afterPushRemoteHeadSha) {
        remoteHeadSha = options.afterPushRemoteHeadSha;
      }
      return { localHeadSha, remoteHeadSha };
    },
    isAncestor() {
      events.push("ancestry");
      return options.isAncestor ?? true;
    },
    fastForwardLocalAccumulation({ targetSha }) {
      events.push("fast-forward");
      localHeadSha = targetSha;
    },
    pushAccumulationBranch({ expectedHeadSha, expectedRemoteSha }) {
      events.push("push");
      pushExpectedRemoteShas.push(expectedRemoteSha);
      if (options.pushError) throw options.pushError;
      remoteHeadSha = expectedHeadSha;
    },
    closeChildIssue() {
      events.push("close");
      if (options.closeError) throw options.closeError;
      if (issueState === "CLOSED") return "already_closed";
      issueState = "CLOSED";
      return "closed";
    },
    readChildIssue() {
      events.push("issue-read");
      return { state: issueState };
    },
  };
}
