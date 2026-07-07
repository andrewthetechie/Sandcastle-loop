import assert from "node:assert/strict";
import test from "node:test";
import {
  integrateIssueAsPrdChild,
  observeIssueAsPrdTerminalMainline,
  refreshIssueAsPrdAccumulationBeforeReview,
} from "./backlog-v3-issue-as-prd-git-adapter.mts";

test("integrateIssueAsPrdChild delegates to the shared integration flow", async () => {
  const calls: string[] = [];
  let headReadCount = 0;
  const result = await integrateIssueAsPrdChild(
    {
      childNumber: 42,
      accumulationBranch: "issue-7-accumulation",
      reviewedBaseSha: "a".repeat(40),
      approvedHeadSha: "b".repeat(40),
    },
    {
      readAccumulationHeads() {
        calls.push("readAccumulationHeads");
        headReadCount += 1;
        return {
          localHeadSha: headReadCount === 1 ? "a".repeat(40) : "b".repeat(40),
          remoteHeadSha: headReadCount === 1 ? "a".repeat(40) : "b".repeat(40),
        };
      },
      isAncestor() {
        calls.push("isAncestor");
        return true;
      },
      fastForwardLocalAccumulation() {
        calls.push("fastForwardLocalAccumulation");
      },
      pushAccumulationBranch() {
        calls.push("pushAccumulationBranch");
      },
      closeChildIssue() {
        calls.push("closeChildIssue");
        return "closed" as const;
      },
      readChildIssue() {
        calls.push("readChildIssue");
        return { state: "CLOSED" as const };
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.accumulationHeadSha, "b".repeat(40));
  assert.deepEqual(calls, [
    "readAccumulationHeads",
    "isAncestor",
    "fastForwardLocalAccumulation",
    "pushAccumulationBranch",
    "readAccumulationHeads",
    "closeChildIssue",
    "readChildIssue",
  ]);
});

test("refreshIssueAsPrdAccumulationBeforeReview delegates to the shared refresh flow", async () => {
  const calls: string[] = [];
  const result = await refreshIssueAsPrdAccumulationBeforeReview(
    {
      accumulationBranch: "issue-7-accumulation",
      mainlineRef: "origin/main",
      originalForkSha: "a".repeat(40),
      currentReviewBaseSha: "a".repeat(40),
    },
    {
      readAccumulationHeads() {
        calls.push("readAccumulationHeads");
        return {
          localHeadSha: "b".repeat(40),
          remoteHeadSha: "b".repeat(40),
        };
      },
      fetchMainline() {
        calls.push("fetchMainline");
        return "c".repeat(40);
      },
      createDiagnosticCheckpoint() {
        calls.push("createDiagnosticCheckpoint");
      },
      rebaseAccumulationOntoMainline() {
        calls.push("rebaseAccumulationOntoMainline");
        return { ok: true as const };
      },
      abortRebase() {
        calls.push("abortRebase");
      },
      resetAccumulationToRef() {
        calls.push("resetAccumulationToRef");
      },
      pushAccumulationWithLease() {
        calls.push("pushAccumulationWithLease");
      },
      revParse() {
        calls.push("revParse");
        return "d".repeat(40);
      },
    },
  );

  assert.equal(result.kind, "rebased");
  assert.deepEqual(calls, [
    "readAccumulationHeads",
    "fetchMainline",
    "createDiagnosticCheckpoint",
    "rebaseAccumulationOntoMainline",
    "pushAccumulationWithLease",
    "revParse",
  ]);
});

test("observeIssueAsPrdTerminalMainline delegates to the shared terminal observe flow", async () => {
  const calls: string[] = [];
  const result = await observeIssueAsPrdTerminalMainline(
    {
      mainlineRef: "origin/main",
      fullParentReviewBaseSha: "a".repeat(40),
      preReviewConflict: false,
    },
    {
      fetchMainline() {
        calls.push("fetchMainline");
        return "b".repeat(40);
      },
      revParse() {
        calls.push("revParse");
        return "unused";
      },
    },
  );

  assert.deepEqual(result, {
    observedMainlineSha: "b".repeat(40),
    rebaseNeeded: true,
  });
  assert.deepEqual(calls, ["fetchMainline"]);
});
