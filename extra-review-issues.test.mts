import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTRA_REVIEW_FOLLOWUP_LABEL_COLOR,
  EXTRA_REVIEW_FOLLOWUP_LABEL_DESCRIPTION,
  buildExtraReviewDuplicateMarker,
  buildExtraReviewIssueCreateCommand,
  publishExtraReviewIssues,
  type ExtraReviewIssueDetail,
  type ExtraReviewIssueClient,
  type ExtraReviewIssueListItem,
} from "./extra-review-support.mts";
import type {
  FollowupIssueDraft,
  FollowupIssuesParseResult,
} from "./extra-review-support.mts";

test("new decomposed issue creates a Forgejo/tracker issue command and record", () => {
  const client = mockIssueClient({
    existingIssues: [],
    createdIssues: [{ number: 101, url: "https://forgejo.test/repo/issues/101" }],
  });

  const result = publishExtraReviewIssues({
    decomposition: followupIssues([draft()]),
    context: context(),
    client,
  });

  assert.equal(result.stopReason, "success");
  assert.equal(result.createdIssues.length, 1);
  assert.equal(result.skippedDuplicateIssues.length, 0);
  assert.equal(result.createdIssues[0]!.issue_number, 101);
  assert.equal(result.createdIssues[0]!.issue_url, "https://forgejo.test/repo/issues/101");
  assert.equal(result.createdIssues[0]!.dedupe_key, "extract-review-orchestration-helper-cq-001");
  assert.equal(result.createdIssues[0]!.duplicate_marker, result.createCommands[0]!.duplicateMarker);
  assert.deepEqual(client.calls.ensureLabel[0], {
    name: "ai-review-followup",
    description: EXTRA_REVIEW_FOLLOWUP_LABEL_DESCRIPTION,
    color: EXTRA_REVIEW_FOLLOWUP_LABEL_COLOR,
  });
  assert.deepEqual(client.calls.list[0], duplicateListArgs());
  assert.equal(client.calls.view.length, 0);
  assert.deepEqual(client.calls.create[0], result.createCommands[0]);
});

test("open duplicate issue is detected, warned, and skipped", () => {
  const existingMarker = buildExtraReviewDuplicateMarker(draft(), context());
  const warnings: string[] = [];
  const client = mockIssueClient({
    existingIssues: [
      {
        number: 88,
        title: "Existing open follow-up",
        state: "OPEN",
        url: "https://forgejo.test/repo/issues/88",
        body: `Already filed.\n\n${existingMarker}`,
      },
    ],
  });

  const result = publishExtraReviewIssues({
    decomposition: followupIssues([draft()]),
    context: context(),
    client,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result.stopReason, "duplicate_only");
  assert.equal(result.createdIssues.length, 0);
  assert.equal(result.skippedDuplicateIssues.length, 1);
  assert.equal(result.skippedDuplicateIssues[0]!.existing_issue_number, 88);
  assert.equal(result.skippedDuplicateIssues[0]!.existing_issue_url, "https://forgejo.test/repo/issues/88");
  assert.match(result.skippedDuplicateIssues[0]!.reason, /open PRD issue #88/i);
  assert.match(warnings[0]!, /Skipping duplicate extra-review follow-up issue/);
  assert.match(warnings[0]!, /#88/);
  assert.deepEqual(client.calls.view[0], duplicateViewArgs(88));
  assert.equal(client.calls.create.length, 0);
});

test("closed duplicate issue is detected and skipped", () => {
  const existingMarker = buildExtraReviewDuplicateMarker(draft(), context());
  const warnings: string[] = [];
  const client = mockIssueClient({
    existingIssues: [
      {
        number: 77,
        title: "Existing closed follow-up",
        state: "CLOSED",
        url: "https://forgejo.test/repo/issues/77",
        body: existingMarker,
      },
    ],
  });

  const result = publishExtraReviewIssues({
    decomposition: followupIssues([draft()]),
    context: context(),
    client,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result.stopReason, "duplicate_only");
  assert.equal(result.createdIssues.length, 0);
  assert.equal(result.skippedDuplicateIssues[0]!.existing_issue_number, 77);
  assert.match(result.skippedDuplicateIssues[0]!.reason, /closed PRD issue #77/i);
  assert.match(warnings[0]!, /State: CLOSED/);
  assert.equal(client.calls.create.length, 0);
});

test("duplicate-only decomposer output records every skipped duplicate", () => {
  const firstDraft = draft();
  const secondDraft = draft({
    title: "Persist round handoff",
    body: "## Context\nPersist handoff files.\n\n## Acceptance Criteria\n- Handoff is written.\n\n## Provenance\n- two_axis STD-002",
    dedupe_key: "persist-round-handoff-std-002",
    source_findings: [
      {
        reviewer: "two_axis",
        finding_id: "STD-002",
        axis: "standards",
        title: "Missing round handoff",
      },
    ],
  });
  const client = mockIssueClient({
    existingIssues: [
      {
        number: 21,
        state: "OPEN",
        body: buildExtraReviewDuplicateMarker(firstDraft, context()),
      },
      {
        number: 22,
        state: "CLOSED",
        body: buildExtraReviewDuplicateMarker(secondDraft, context()),
      },
    ],
  });
  const warnings: string[] = [];

  const result = publishExtraReviewIssues({
    decomposition: followupIssues([firstDraft, secondDraft]),
    context: context(),
    client,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result.stopReason, "duplicate_only");
  assert.equal(result.createdIssues.length, 0);
  assert.deepEqual(
    result.skippedDuplicateIssues.map((issue) => issue.existing_issue_number),
    [21, 22],
  );
  assert.equal(warnings.length, 2);
  assert.equal(client.calls.create.length, 0);
});

test("mixed new and duplicate output creates only non-duplicates", () => {
  const duplicateDraft = draft();
  const newDraft = draft({
    title: "Write duplicate publication tests",
    body: "## Context\nAdd fixture coverage.\n\n## Acceptance Criteria\n- New and duplicate issues are both covered.\n\n## Provenance\n- code_quality CQ-002",
    dedupe_key: "write-duplicate-publication-tests-cq-002",
    source_findings: [
      {
        reviewer: "code_quality",
        finding_id: "CQ-002",
        axis: "code_quality",
        title: "Missing duplicate publication coverage",
      },
    ],
  });
  const client = mockIssueClient({
    existingIssues: [
      {
        number: 88,
        state: "OPEN",
        body: buildExtraReviewDuplicateMarker(duplicateDraft, context()),
      },
    ],
    createdIssues: [{ url: "https://forgejo.test/repo/issues/102" }],
  });

  const result = publishExtraReviewIssues({
    decomposition: followupIssues([duplicateDraft, newDraft]),
    context: context(),
    client,
    logger: { warn() {} },
  });

  assert.equal(result.stopReason, "success");
  assert.equal(result.createdIssues.length, 1);
  assert.equal(result.createdIssues[0]!.issue_number, 102);
  assert.equal(result.createdIssues[0]!.title, "Write duplicate publication tests");
  assert.equal(result.skippedDuplicateIssues.length, 1);
  assert.equal(result.skippedDuplicateIssues[0]!.existing_issue_number, 88);
  assert.equal(client.calls.create.length, 1);
});

test("issue create command args and body include labels, provenance, artifacts, and marker", () => {
  const command = buildExtraReviewIssueCreateCommand(draft(), context());

  assert.deepEqual(command.labels, ["prd-001", "ai-review-followup"]);
  assert.equal(command.title, "Extract review orchestration helper");
  assert.equal(command.body.includes("Move sequential extra review"), true);

  assert.match(command.body, /## Extra Review Provenance/);
  assert.match(command.body, /PRD: #1 \(prd-001\)/);
  assert.match(command.body, /PRD file: docs\/prd\/001-extra-review\.md/);
  assert.match(command.body, /Extra review round: #1 \/ round-01-head-abc123/);
  assert.match(command.body, /Source reviewers: code_quality/);
  assert.match(command.body, /Original review base: main/);
  assert.match(command.body, /Resolved review base SHA: base-sha/);
  assert.match(command.body, /Reviewed branch head SHA: head-sha/);
  assert.match(command.body, /Source finding refs\/excerpts:/);
  assert.match(command.body, /code_quality\/code_quality CQ-001: Extract review orchestration helper/);
  assert.match(command.body, /Issue decomposer parsed output: mock-runs\/issue-decomposer\.parsed\.json/);
  assert.match(command.body, /<!-- sandcastle-extra-review-followup .*source_fingerprint=sha256:[a-f0-9]{32} -->/);
});

test("duplicate marker is stable for the same issue and source finding text", () => {
  const first = buildExtraReviewDuplicateMarker(draft(), context());
  const second = buildExtraReviewDuplicateMarker(draft(), {
    ...context(),
    round: { number: 2, id: "round-02-head-def456" },
    reviewedHeadSha: "different-head-sha",
    artifactRefs: { handoff: "another/handoff.md" },
  });
  const third = buildExtraReviewDuplicateMarker(
    draft({ dedupe_key: "different-human-readable-key" }),
    context(),
  );

  assert.equal(first, second);
  assert.equal(first, third);
});

test("no-work and needs-human-review decompositions do not call client", () => {
  for (const decomposition of [noWorkIssues(), needsHumanReviewIssues()]) {
    const client = throwingIssueClient();
    const result = publishExtraReviewIssues({
      decomposition,
      context: context(),
      client,
    });

    assert.equal(result.createdIssues.length, 0);
    assert.equal(result.skippedDuplicateIssues.length, 0);
    assert.equal(result.createCommands.length, 0);
  }
});

test("missing follow-up label is created before issue publication", () => {
  const client = mockIssueClient({
    existingIssues: [],
    createdIssues: [{ number: 103, url: "https://forgejo.test/repo/issues/103" }],
  });

  publishExtraReviewIssues({
    decomposition: followupIssues([draft()]),
    context: context(),
    client,
  });

  assert.deepEqual(client.calls.ensureLabel, [
    {
      name: "ai-review-followup",
      description: EXTRA_REVIEW_FOLLOWUP_LABEL_DESCRIPTION,
      color: EXTRA_REVIEW_FOLLOWUP_LABEL_COLOR,
    },
  ]);
});

function mockIssueClient(input: {
  existingIssues?: ExtraReviewIssueDetail[];
  createdIssues?: { number?: number; url?: string }[];
}) {
  const existingIssues = input.existingIssues ?? [];
  const createdIssues = [...(input.createdIssues ?? [])];
  const calls = {
    list: [] as unknown[],
    view: [] as number[],
    create: [] as unknown[],
    ensureLabel: [] as { name: string; description?: string; color?: string }[],
  };

  const client: ExtraReviewIssueClient & { calls: typeof calls } = {
    calls,
    listIssues(query) {
      calls.list.push({ ...query });
      return existingIssues.map(
        ({ number, title, state, url }): ExtraReviewIssueListItem => ({
          number,
          title,
          state,
          url,
        }),
      );
    },
    viewIssue(issueNumber) {
      calls.view.push(issueNumber);
      const issue = existingIssues.find(
        (candidate) => candidate.number === issueNumber,
      );
      assert.ok(issue, `expected mock issue #${issueNumber}`);
      return issue;
    },
    createIssue(input) {
      calls.create.push({ ...input, labels: [...input.labels] });
      return createdIssues.shift() ?? {};
    },
    ensureLabel(name, description, color) {
      calls.ensureLabel.push({ name, description, color });
    },
  };

  return client;
}

function throwingIssueClient(): ExtraReviewIssueClient {
  return {
    listIssues() {
      throw new Error("listIssues should not be called");
    },
    viewIssue() {
      throw new Error("viewIssue should not be called");
    },
    createIssue() {
      throw new Error("createIssue should not be called");
    },
    ensureLabel() {
      throw new Error("ensureLabel should not be called");
    },
  };
}

function context() {
  return {
    prd: {
      number: 1,
      label: "prd-001",
      path: "docs/prd/001-extra-review.md",
      title: "Extra review",
    },
    round: { number: 1, id: "round-01-head-abc123" },
    originalReviewBaseArg: "main",
    resolvedReviewBaseSha: "base-sha",
    reviewedHeadSha: "head-sha",
    artifactRefs: {
      roundDir: "mock-runs/round-01-head-abc123",
      codeReviewParsed: "mock-runs/code-review.parsed.json",
      twoAxisReviewParsed: "mock-runs/two-axis-review.parsed.json",
      issueDecomposerParsed: "mock-runs/issue-decomposer.parsed.json",
      handoff: "mock-runs/HANDOFF.md",
    },
  };
}

function followupIssues(
  issues: FollowupIssueDraft[],
): FollowupIssuesParseResult {
  return {
    kind: "followup_issues",
    status: "issues",
    summary: "Converted findings into follow-up issues.",
    issues,
    needs_human_review_reason: "",
  };
}

function noWorkIssues(): FollowupIssuesParseResult {
  return {
    kind: "followup_issues",
    status: "no_work",
    summary: "No follow-up issue needed.",
    issues: [],
    needs_human_review_reason: "",
  };
}

function needsHumanReviewIssues(): FollowupIssuesParseResult {
  return {
    kind: "followup_issues",
    status: "needs_human_review",
    summary: "The findings conflict.",
    issues: [],
    needs_human_review_reason: "Reviewer outputs disagree about scope.",
  };
}

function draft(
  overrides: Partial<FollowupIssueDraft> = {},
): FollowupIssueDraft {
  return {
    title: "Extract review orchestration helper",
    body: [
      "## Context",
      "Move sequential extra review orchestration into a focused helper.",
      "",
      "## Acceptance Criteria",
      "- The runner delegates session sequencing to the helper.",
      "",
      "## Provenance",
      "- code_quality CQ-001",
    ].join("\n"),
    priority: "high",
    source_findings: [
      {
        reviewer: "code_quality",
        finding_id: "CQ-001",
        axis: "code_quality",
        title: "Extract review orchestration helper",
      },
    ],
    files: ["extra-review-sessions.mts", "run-prd-extra-reviews.mts"],
    dedupe_key: "extract-review-orchestration-helper-cq-001",
    ...overrides,
  };
}

function duplicateListArgs() {
  return {
    label: "prd-001",
    state: "all",
    limit: 1000,
  };
}

function duplicateViewArgs(issueNumber: number): number {
  return issueNumber;
}
