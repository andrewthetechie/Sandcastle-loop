import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPreReviewDiagnosticBranch,
  observeTerminalMainline,
  refreshAccumulationBeforeReview,
  type RefreshGitDeps,
} from "./issue-as-prd-refresh.mts";

test("unchanged mainline returns without checkpoint, rebase, or push", async () => {
  const deps = createDeps({
    fetchedMainlineSha: "aaa",
    localHeadSha: "bbb",
    remoteHeadSha: "bbb",
  });

  const result = await refreshAccumulationBeforeReview(input(), deps);

  assert.deepEqual(result, {
    kind: "unchanged",
    accumulationHeadSha: "bbb",
    reviewBaseSha: "aaa",
    fetchedMainlineSha: "aaa",
  });
  assert.deepEqual(deps.events, ["read-heads", "fetch-mainline"]);
});

test("advanced mainline checkpoints then rebases and force-pushes with lease", async () => {
  const deps = createDeps({
    fetchedMainlineSha: "ccc",
    localHeadSha: "bbb",
    remoteHeadSha: "bbb",
    rebasedHeadSha: "ddd",
  });

  const result = await refreshAccumulationBeforeReview(input(), deps);

  assert.deepEqual(result, {
    kind: "rebased",
    accumulationHeadSha: "ddd",
    reviewBaseSha: "ccc",
    fetchedMainlineSha: "ccc",
    diagnosticCheckpoint: "issue-42-pre-review-bbb",
  });
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "checkpoint:issue-42-pre-review-bbb",
    "rebase:ccc",
    "push-with-lease:bbb",
    "rev-parse:issue-42",
  ]);
  assert.deepEqual(deps.pushLeaseArgs, [
    {
      accumulationBranch: "issue-42",
      expectedRemoteSha: "bbb",
    },
  ]);
});

test("conflict aborts, verifies restored head, avoids force push, and returns diagnostics", async () => {
  const deps = createDeps({
    fetchedMainlineSha: "ccc",
    localHeadSha: "bbb",
    remoteHeadSha: "bbb",
    rebaseConflict: "fatal: conflict on https://user:secret@example.test/repo.git\nBearer abc",
  });

  const result = await refreshAccumulationBeforeReview(input(), deps);

  assert.deepEqual(result, {
    kind: "conflict",
    accumulationHeadSha: "bbb",
    reviewBaseSha: "aaa",
    attemptedMainlineSha: "ccc",
    diagnosticCheckpoint: "issue-42-pre-review-bbb",
    diagnostics: ["fatal: conflict on https://user:[REDACTED]@example.test/repo.git\nBearer [REDACTED]"],
  });
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "checkpoint:issue-42-pre-review-bbb",
    "rebase:ccc",
    "abort-rebase",
    "rev-parse:issue-42",
  ]);
  assert.equal(deps.pushLeaseArgs.length, 0);
});

test("conflict restores from diagnostic checkpoint when abort leaves wrong head", async () => {
  const deps = createDeps({
    fetchedMainlineSha: "ccc",
    localHeadSha: "bbb",
    remoteHeadSha: "bbb",
    rebaseConflict: "conflict",
    postAbortHeadSha: "zzz",
  });

  const result = await refreshAccumulationBeforeReview(input(), deps);

  assert.equal(result.kind, "conflict");
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "checkpoint:issue-42-pre-review-bbb",
    "rebase:ccc",
    "abort-rebase",
    "rev-parse:issue-42",
    "reset:issue-42-pre-review-bbb",
    "rev-parse:issue-42",
  ]);
});

test("terminal observe reports no rebase needed when mainline is unchanged", async () => {
  const deps = createDeps({ fetchedMainlineSha: "ccc" });

  const result = await observeTerminalMainline(
    {
      mainlineRef: "origin/main",
      fullParentReviewBaseSha: "ccc",
      preReviewConflict: false,
    },
    deps,
  );

  assert.deepEqual(result, { observedMainlineSha: "ccc", rebaseNeeded: false });
  assert.deepEqual(deps.events, ["fetch-mainline"]);
});

test("terminal observe reports rebase needed when pre-review conflicted or mainline advanced", async () => {
  const deps = createDeps({ fetchedMainlineSha: "ddd" });

  const advanced = await observeTerminalMainline(
    {
      mainlineRef: "origin/main",
      fullParentReviewBaseSha: "ccc",
      preReviewConflict: false,
    },
    deps,
  );
  const conflict = await observeTerminalMainline(
    {
      mainlineRef: "origin/main",
      fullParentReviewBaseSha: "ddd",
      preReviewConflict: true,
    },
    deps,
  );

  assert.deepEqual(advanced, { observedMainlineSha: "ddd", rebaseNeeded: true });
  assert.deepEqual(conflict, { observedMainlineSha: "ddd", rebaseNeeded: true });
});

test("diagnostic branch helper uses the required suffix", () => {
  assert.equal(
    buildPreReviewDiagnosticBranch("issue-42", "bbbbbbbbbbbbcccccccccccc"),
    "issue-42-pre-review-bbbbbbbbbbbb",
  );
});

function input() {
  return {
    accumulationBranch: "issue-42",
    mainlineRef: "origin/main",
    originalForkSha: "aaa",
    currentReviewBaseSha: "aaa",
  };
}

function createDeps(options: {
  fetchedMainlineSha?: string;
  localHeadSha?: string;
  remoteHeadSha?: string;
  rebasedHeadSha?: string;
  rebaseConflict?: string;
  postAbortHeadSha?: string;
} = {}): RefreshGitDeps & {
  events: string[];
  pushLeaseArgs: Array<{ accumulationBranch: string; expectedRemoteSha: string }>;
} {
  const events: string[] = [];
  const pushLeaseArgs: Array<{ accumulationBranch: string; expectedRemoteSha: string }> = [];
  let branchHead = options.localHeadSha ?? "bbb";
  let revParseCount = 0;

  return {
    events,
    pushLeaseArgs,
    readAccumulationHeads() {
      events.push("read-heads");
      return {
        localHeadSha: options.localHeadSha ?? "bbb",
        remoteHeadSha: options.remoteHeadSha ?? "bbb",
      };
    },
    fetchMainline() {
      events.push("fetch-mainline");
      return options.fetchedMainlineSha ?? "ccc";
    },
    createDiagnosticCheckpoint({ branchName }) {
      events.push(`checkpoint:${branchName}`);
    },
    rebaseAccumulationOntoMainline({ ontoSha }) {
      events.push(`rebase:${ontoSha}`);
      if (options.rebaseConflict) return { ok: false, stderr: options.rebaseConflict } as const;
      branchHead = options.rebasedHeadSha ?? "ddd";
      return { ok: true } as const;
    },
    abortRebase() {
      events.push("abort-rebase");
      branchHead = options.postAbortHeadSha ?? (options.localHeadSha ?? "bbb");
    },
    resetAccumulationToRef({ targetRef }) {
      events.push(`reset:${targetRef}`);
      branchHead = options.localHeadSha ?? "bbb";
    },
    pushAccumulationWithLease(args) {
      events.push(`push-with-lease:${args.expectedRemoteSha}`);
      pushLeaseArgs.push(args);
    },
    revParse(ref) {
      events.push(`rev-parse:${ref}`);
      revParseCount += 1;
      void revParseCount;
      return branchHead;
    },
  };
}
