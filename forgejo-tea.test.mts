import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExtraReviewDuplicateMarker,
  publishExtraReviewIssues,
} from "./extra-review-issues.mts";
import {
  ForgejoTeaClient,
  normalizeForgejoIssueDetail,
  normalizeForgejoIssueList,
} from "./forgejo-tea.mts";
import type { FollowupIssueDraft } from "./extra-review-contracts.mts";

test("open issue list with labels filters out agent-stuck after normalization", () => {
  const list = normalizeForgejoIssueList([
    {
      number: 12,
      title: "Open work",
      state: "open",
      html_url: "https://forgejo.test/org/repo/issues/12",
      labels: [{ name: "prd-001" }],
    },
    {
      number: 13,
      title: "Stuck work",
      state: "open",
      labels: [{ name: "prd-001" }, { name: "agent-stuck" }],
    },
  ]);

  const eligible = list.filter(
    (issue) =>
      !issueLabels(issue).some((label) => label.name === "agent-stuck"),
  );

  assert.deepEqual(
    eligible.map((issue) => issue.number),
    [12],
  );
});

test("issue detail normalizes comments into tracker-neutral shape", () => {
  const detail = normalizeForgejoIssueDetail({
    Index: 44,
    Title: "Implement the thing",
    Body: "Issue body",
    State: "open",
    URL: "https://forgejo.test/org/repo/issues/44",
    Labels: ["prd-001"],
    Comments: [
      {
        Poster: { UserName: "andrew" },
        Body: "Looks good",
        Created: "2026-06-11T12:00:00Z",
      },
    ],
  });

  assert.equal(detail.number, 44);
  assert.equal(detail.title, "Implement the thing");
  assert.deepEqual(detail.labels, [{ name: "prd-001" }]);
  assert.deepEqual(detail.comments, [
    {
      author: { login: "andrew" },
      body: "Looks good",
      createdAt: "2026-06-11T12:00:00Z",
    },
  ]);
});

test("follow-up label creation is idempotent", () => {
  const runner = new RecordingTeaRunner({
    "label list --output json": JSON.stringify([{ name: "ai-review-followup" }]),
  });
  const client = new ForgejoTeaClient(runner);

  client.ensureLabel("ai-review-followup", "description", "5319e7");

  assert.deepEqual(runner.commands, [["label", "list", "--output", "json"]]);
});

test("follow-up duplicate detection searches all PRD issues and reads bodies", () => {
  const runner = new RecordingTeaRunner({
    "label list --output json": JSON.stringify([{ name: "ai-review-followup" }]),
    "issue list --state all --limit 1000 --output json --labels prd-001":
      JSON.stringify([
        {
          number: 7,
          title: "Existing follow-up",
          state: "open",
          html_url: "https://forgejo.test/org/repo/issues/7",
        },
      ]),
  });
  const marker = buildExtraReviewDuplicateMarker(draft(), context());
  runner.responses.set(
    "issue 7 --comments --output json",
    JSON.stringify({
      number: 7,
      title: "Existing follow-up",
      state: "open",
      body: marker,
      html_url: "https://forgejo.test/org/repo/issues/7",
    }),
  );

  const result = publishExtraReviewIssues({
    decomposition: {
      kind: "followup_issues",
      status: "issues",
      summary: "One follow-up",
      issues: [draft()],
      needs_human_review_reason: "",
    },
    context: context(),
    client: new ForgejoTeaClient(runner),
    logger: { warn() {} },
  });

  assert.equal(result.stopReason, "duplicate_only");
  assert.deepEqual(runner.commands.slice(1), [
    [
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "1000",
      "--output",
      "json",
      "--labels",
      "prd-001",
    ],
    ["issue", "7", "--comments", "--output", "json"],
  ]);
});

test("missing tea preflight fails before other runner work can start", () => {
  const runner = new RecordingTeaRunner({});
  runner.fail.set("--version", new Error("spawn tea ENOENT"));
  const client = new ForgejoTeaClient(runner);

  assert.throws(() => client.preflight(), /requires the tea CLI/);
  assert.deepEqual(runner.commands, [["--version"]]);
});

class RecordingTeaRunner {
  readonly commands: string[][] = [];
  readonly responses = new Map<string, string>();
  readonly fail = new Map<string, Error>();

  constructor(responses: Record<string, string>) {
    for (const [command, response] of Object.entries(responses)) {
      this.responses.set(command, response);
    }
  }

  run(args: readonly string[]): string {
    this.commands.push([...args]);
    const key = args.join(" ");
    const failure = this.fail.get(key);
    if (failure) throw failure;
    const response = this.responses.get(key);
    assert.notEqual(response, undefined, `unexpected tea command: ${key}`);
    return response;
  }
}

function issueLabels(issue: unknown): { name: string }[] {
  const labels = (issue as { labels?: { name: string }[] }).labels;
  return labels ?? [];
}

function draft(): FollowupIssueDraft {
  return {
    title: "Extract review orchestration helper",
    body: "## Context\nMove helper.\n\n## Acceptance Criteria\n- Helper exists.\n\n## Provenance\n- code_quality CQ-001",
    priority: "high",
    source_findings: [
      {
        reviewer: "code_quality",
        finding_id: "CQ-001",
        axis: "code_quality",
        title: "Extract review orchestration helper",
      },
    ],
    files: ["extra-review-sessions.mts"],
    dedupe_key: "extract-review-orchestration-helper-cq-001",
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
  };
}
