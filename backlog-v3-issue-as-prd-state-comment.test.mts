import assert from "node:assert/strict";
import test from "node:test";
import { persistIssueAsPrdParentStateComment } from "./backlog-v3-issue-as-prd-state-comment.mts";
import {
  ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";

function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

function state(overrides: Partial<IssueAsPrdParentState> = {}): IssueAsPrdParentState {
  return {
    schemaVersion: ISSUE_AS_PRD_STATE_SCHEMA_VERSION,
    parentNumber: 42,
    accumulationBranch: "issue-42-accumulation",
    originalForkSha: sha("a"),
    fullParentReviewBaseSha: sha("b"),
    attemptedMainlineSha: null,
    latestMainlineShaAtDelivery: null,
    phase: "claimed",
    queueLabel: "parent-42",
    completedExtraReviewRounds: 0,
    aggregateValidationRepairs: { pre_review: 0, pre_delivery: 0 },
    rebaseConflictDiagnostics: [],
    accumulationDiverged: false,
    mainlineRefresh: null,
    partialCauseChildNumber: null,
    lastTransitionAt: "2026-07-02T12:00:00Z",
    ...overrides,
  };
}

test("creates the state comment when no comment id exists yet", async () => {
  const calls: string[] = [];
  const result = await persistIssueAsPrdParentStateComment(
    {
      parentNumber: 42,
      commentId: null,
      state: state(),
    },
    {
      createComment({ parentNumber, body }) {
        calls.push(`create:${parentNumber}:${body.includes("sandcastle-issue-as-prd-state")}`);
        return 91;
      },
      updateComment() {
        throw new Error("should not update");
      },
    },
  );

  assert.deepEqual(calls, ["create:42:true"]);
  assert.equal(result.commentId, 91);
  assert.match(result.body, /<sandcastle_issue_as_prd_state>/);
});

test("updates the existing state comment when comment id is known", async () => {
  const calls: string[] = [];
  const result = await persistIssueAsPrdParentStateComment(
    {
      parentNumber: 42,
      commentId: 17,
      state: state({ phase: "decomposed" }),
    },
    {
      createComment() {
        throw new Error("should not create");
      },
      updateComment({ commentId, body }) {
        calls.push(`update:${commentId}:${body.includes('"phase": "decomposed"')}`);
      },
    },
  );

  assert.deepEqual(calls, ["update:17:true"]);
  assert.equal(result.commentId, 17);
});

test("read-back verifies a newly created comment and retries without creating a duplicate", async () => {
  const calls: string[] = [];
  let persistedBody = "stale";
  const result = await persistIssueAsPrdParentStateComment(
    {
      parentNumber: 42,
      commentId: null,
      state: state({ phase: "initial_drained" }),
    },
    {
      createComment({ body }) {
        calls.push("create");
        persistedBody = "eventually-consistent";
        assert.match(body, /"phase": "initial_drained"/);
        return 91;
      },
      updateComment({ commentId, body }) {
        calls.push(`update:${commentId}`);
        persistedBody = body;
      },
      readComments() {
        calls.push("read");
        return [{ id: 91, body: persistedBody }];
      },
    },
  );

  assert.equal(result.commentId, 91);
  assert.deepEqual(calls, ["create", "read", "update:91", "read"]);
});

test("read-back failure is terminal after the bounded retry budget", async () => {
  let updates = 0;
  await assert.rejects(
    persistIssueAsPrdParentStateComment(
      {
        parentNumber: 42,
        commentId: 17,
        state: state({ phase: "decomposed" }),
      },
      {
        createComment() {
          throw new Error("should not create");
        },
        updateComment() {
          updates += 1;
        },
        readComments() {
          return [{ id: 17, body: "stale" }];
        },
      },
    ),
    /Parent state comment persistence failed:.*verification mismatch/s,
  );
  assert.equal(updates, 3);
});
