import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPreReviewDiagnosticBranch,
  observeTerminalMainline,
  recoverMainlineRefreshJournal,
  refreshAccumulationContinuously,
  refreshAccumulationBeforeReview,
  type ContinuousMainlineRefreshDeps,
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

test("continuous deterministic refresh journals before verified promotion and skips full validation", async () => {
  const deps = createContinuousDeps({ deterministic: "candidate" });

  const result = await refreshAccumulationContinuously(continuousInput(), deps);

  assert.deepEqual(result, {
    kind: "refreshed",
    accumulationHeadSha: sha40("d"),
    attemptedMainlineSha: sha40("c"),
  });
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "ancestor",
    "deterministic",
    "verify:structural",
    "journal:d",
    "promote",
    "journal:clear",
  ]);
});

test("continuous refresh fetches once and stops when the pinned mainline is already present", async () => {
  const deps = createContinuousDeps({
    deterministic: "candidate",
    alreadyCurrent: true,
  });

  const result = await refreshAccumulationContinuously(continuousInput(), deps);

  assert.deepEqual(result, {
    kind: "unchanged",
    accumulationHeadSha: sha40("b"),
    attemptedMainlineSha: sha40("c"),
  });
  assert.deepEqual(deps.events, ["read-heads", "fetch-mainline", "ancestor"]);
});

test("unsafe deterministic candidate preserves the checkpoint and becomes divergence", async () => {
  const deps = createContinuousDeps({
    deterministic: "candidate",
    candidateVerificationFails: true,
  });

  const result = await refreshAccumulationContinuously(continuousInput(), deps);

  assert.deepEqual(result, {
    kind: "diverged",
    accumulationHeadSha: sha40("b"),
    attemptedMainlineSha: sha40("c"),
    diagnostics: ["unsafe candidate"],
  });
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "ancestor",
    "deterministic",
    "verify:structural",
    "verify-checkpoint",
  ]);
});

test("continuous conflict runs exactly one agent and full host validation before promotion", async () => {
  const deps = createContinuousDeps({ deterministic: "conflict", agent: "resolved" });

  const result = await refreshAccumulationContinuously(continuousInput(), deps);

  assert.equal(result.kind, "refreshed");
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "ancestor",
    "deterministic",
    "agent",
    "verify:full",
    "journal:e",
    "promote",
    "journal:clear",
  ]);
});

test("unresolved refresh verifies the checkpoint, sanitizes diagnostics, and does not promote", async () => {
  const deps = createContinuousDeps({ deterministic: "conflict", agent: "unresolved" });

  const result = await refreshAccumulationContinuously(continuousInput(), deps);

  assert.deepEqual(result, {
    kind: "diverged",
    accumulationHeadSha: sha40("b"),
    attemptedMainlineSha: sha40("c"),
    diagnostics: [
      "conflict on https://user:[REDACTED]@example.test/repo.git",
      "Bearer [REDACTED]",
    ],
  });
  assert.deepEqual(deps.events, [
    "read-heads",
    "fetch-mainline",
    "ancestor",
    "deterministic",
    "agent",
    "verify-checkpoint",
  ]);
});

test("promotion failure leaves the durable journal for restart recovery", async () => {
  const deps = createContinuousDeps({ deterministic: "candidate", promotionFails: true });

  await assert.rejects(
    refreshAccumulationContinuously(continuousInput(), deps),
    /promotion failed/,
  );
  assert.equal(deps.events.at(-1), "promote");
  assert.equal(deps.events.includes("journal:clear"), false);
});

test("journal recovery completes or abandons only the two journal-owned SHAs", async () => {
  const journal = {
    preRebaseAccumulationSha: sha40("b"),
    targetMainlineSha: sha40("c"),
    candidateSha: sha40("d"),
  };
  const completedEvents: string[] = [];
  const completed = await recoverMainlineRefreshJournal(
    { accumulationBranch: "issue-42", journal },
    {
      readAccumulationHeads: () => ({
        localHeadSha: sha40("b"),
        remoteHeadSha: sha40("d"),
      }),
      updateLocalAccumulation: ({ expectedCurrentSha, targetSha }) => {
        completedEvents.push(`update:${expectedCurrentSha[0]}:${targetSha[0]}`);
      },
      persistJournal: async () => {
        completedEvents.push("clear");
      },
    },
  );
  assert.deepEqual(completed, { kind: "completed", accumulationHeadSha: sha40("d") });
  assert.deepEqual(completedEvents, ["update:b:d", "clear"]);

  const abandonedEvents: string[] = [];
  const abandoned = await recoverMainlineRefreshJournal(
    { accumulationBranch: "issue-42", journal },
    {
      readAccumulationHeads: () => ({
        localHeadSha: sha40("d"),
        remoteHeadSha: sha40("b"),
      }),
      updateLocalAccumulation: ({ expectedCurrentSha, targetSha }) => {
        abandonedEvents.push(`update:${expectedCurrentSha[0]}:${targetSha[0]}`);
      },
      persistJournal: async () => {
        abandonedEvents.push("clear");
      },
    },
  );
  assert.deepEqual(abandoned, { kind: "abandoned", accumulationHeadSha: sha40("b") });
  assert.deepEqual(abandonedEvents, ["update:d:b", "clear"]);

  await assert.rejects(
    recoverMainlineRefreshJournal(
      { accumulationBranch: "issue-42", journal },
      {
        readAccumulationHeads: () => ({
          localHeadSha: sha40("b"),
          remoteHeadSha: sha40("f"),
        }),
        updateLocalAccumulation() {},
        async persistJournal() {},
      },
    ),
    /cannot own/,
  );
});

function continuousInput() {
  return {
    accumulationBranch: "issue-42",
    mainlineRef: "origin/main",
    accumulationHeadSha: sha40("b"),
  };
}

function sha40(seed: string): string {
  return seed.repeat(40);
}

function createContinuousDeps(options: {
  deterministic: "candidate" | "conflict";
  agent?: "resolved" | "unresolved";
  promotionFails?: boolean;
  alreadyCurrent?: boolean;
  candidateVerificationFails?: boolean;
}): ContinuousMainlineRefreshDeps & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    readAccumulationHeads() {
      events.push("read-heads");
      return { localHeadSha: sha40("b"), remoteHeadSha: sha40("b") };
    },
    fetchMainline() {
      events.push("fetch-mainline");
      return sha40("c");
    },
    isAncestor() {
      events.push("ancestor");
      return options.alreadyCurrent ?? false;
    },
    async buildDeterministicCandidate() {
      events.push("deterministic");
      return options.deterministic === "candidate"
        ? { kind: "candidate" as const, candidateSha: sha40("d") }
        : {
            kind: "conflict" as const,
            diagnostics: ["conflict on https://user:secret@example.test/repo.git"],
          };
    },
    async runRebaseAgent() {
      events.push("agent");
      return options.agent === "unresolved"
        ? { kind: "unresolved" as const, diagnostics: ["Bearer abc"] }
        : {
            kind: "resolved" as const,
            preRebaseAccumulationSha: sha40("b"),
            targetMainlineSha: sha40("c"),
            candidateSha: sha40("e"),
          };
    },
    async verifyCandidate({ validation }) {
      events.push(`verify:${validation}`);
      if (options.candidateVerificationFails) {
        return { ok: false as const, diagnostics: ["unsafe candidate"] };
      }
      return { ok: true as const };
    },
    async verifyPreservedCheckpoint() {
      events.push("verify-checkpoint");
      return { ok: true as const };
    },
    async persistJournal(journal) {
      events.push(journal ? `journal:${journal.candidateSha[0]}` : "journal:clear");
    },
    async promoteCandidate() {
      events.push("promote");
      if (options.promotionFails) throw new Error("promotion failed");
    },
  };
}

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
