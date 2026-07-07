import assert from "node:assert/strict";
import test from "node:test";
import { claimFreshIssueAsPrdParent } from "./backlog-v3-issue-as-prd-claim.mts";

function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

test("fresh claim performs the required verified ordering and records claimed state", async () => {
  const calls: string[] = [];
  const mainlineSha = sha("a");

  const result = await claimFreshIssueAsPrdParent(
    {
      parent: { number: 42 },
      now: "2026-07-02T12:00:00Z",
    },
    {
      addInProgressLabel(parentNumber) {
        calls.push(`addInProgressLabel:${parentNumber}`);
      },
      ensureQueueLabel(parentNumber) {
        calls.push(`ensureQueueLabel:${parentNumber}`);
      },
      fetchMainline() {
        calls.push("fetchMainline");
        return mainlineSha;
      },
      createAccumulationBranch({ branchName, baseSha }) {
        calls.push(`createAccumulationBranch:${branchName}:${baseSha}`);
      },
      pushInitialCheckpoint({ branchName, expectedHeadSha }) {
        calls.push(`pushInitialCheckpoint:${branchName}:${expectedHeadSha}`);
        return expectedHeadSha;
      },
      createStateComment({ parentNumber, body }) {
        calls.push(`createStateComment:${parentNumber}:${body.includes("sandcastle-issue-as-prd-state")}`);
        return 91;
      },
    },
  );

  assert.deepEqual(calls, [
    "addInProgressLabel:42",
    "ensureQueueLabel:42",
    "fetchMainline",
    `createAccumulationBranch:issue-42-accumulation:${mainlineSha}`,
    `pushInitialCheckpoint:issue-42-accumulation:${mainlineSha}`,
    "createStateComment:42:true",
  ]);

  assert.equal(result.commentId, 91);
  assert.equal(result.state.parentNumber, 42);
  assert.equal(result.state.phase, "claimed");
  assert.equal(result.state.accumulationBranch, "issue-42-accumulation");
  assert.equal(result.state.queueLabel, "parent-42");
  assert.equal(result.state.originalForkSha, mainlineSha);
  assert.equal(result.state.fullParentReviewBaseSha, mainlineSha);
  assert.match(result.commentBody, /<sandcastle_issue_as_prd_state>/);
});

test("fresh claim adopts the SHA returned by pushInitialCheckpoint when it recovers from a non-fast-forward rejection", async () => {
  // Simulates the recovery path in run-backlog-v3.mts::pushInitialCheckpoint:
  // a prior interrupted claim left the remote accumulation branch at a
  // different SHA, the fresh-claim push is rejected as non-fast-forward, and
  // the implementation adopts the remote tip as the parent's original fork
  // instead of clobbering it. The durable state must record the adopted SHA so
  // subsequent full-parent review base comparison is correct.
  const calls: string[] = [];
  const mainlineSha = sha("a");
  const adoptedRemoteTip = sha("f");

  const result = await claimFreshIssueAsPrdParent(
    {
      parent: { number: 42 },
      now: "2026-07-02T12:00:00Z",
    },
    {
      addInProgressLabel(parentNumber) {
        calls.push(`addInProgressLabel:${parentNumber}`);
      },
      ensureQueueLabel(parentNumber) {
        calls.push(`ensureQueueLabel:${parentNumber}`);
      },
      fetchMainline() {
        calls.push("fetchMainline");
        return mainlineSha;
      },
      createAccumulationBranch({ branchName, baseSha }) {
        calls.push(`createAccumulationBranch:${branchName}:${baseSha}`);
      },
      pushInitialCheckpoint({ branchName, expectedHeadSha }) {
        calls.push(
          `pushInitialCheckpoint:${branchName}:${expectedHeadSha}->${adoptedRemoteTip}`,
        );
        return adoptedRemoteTip;
      },
      createStateComment({ parentNumber, body }) {
        calls.push(`createStateComment:${parentNumber}:${body.includes("sandcastle-issue-as-prd-state")}`);
        return 91;
      },
    },
  );

  assert.deepEqual(calls, [
    "addInProgressLabel:42",
    "ensureQueueLabel:42",
    "fetchMainline",
    `createAccumulationBranch:issue-42-accumulation:${mainlineSha}`,
    `pushInitialCheckpoint:issue-42-accumulation:${mainlineSha}->${adoptedRemoteTip}`,
    "createStateComment:42:true",
  ]);

  assert.equal(result.state.originalForkSha, adoptedRemoteTip);
  assert.equal(result.state.fullParentReviewBaseSha, adoptedRemoteTip);
});
