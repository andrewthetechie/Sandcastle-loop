import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import {
  ISSUE_AS_PRD_CHILD_MARKER,
  buildIssueAsPrdChildMarker,
  fingerprintIssueAsPrdChild,
  publishIssueAsPrdChildren,
  renderIssueAsPrdChildBody,
  type PublishChildDraft,
} from "./issue-as-prd-children.mts";

test("one draft creates one durable child", async () => {
  const client = createMockGitHubIssuesClient();
  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0]!.number, 17);
});

test("zero drafts emits no child and is distinguishable for direct-parent routing", async () => {
  const client = createMockGitHubIssuesClient();
  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [],
    queueLabel: "parent-4",
    client,
  });

  assert.deepEqual(result, { ok: true, children: [], duplicateNumbers: [] });
  assert.deepEqual(client.calls.ensureLabel.length, 1);
  assert.equal(client.calls.createIssue.length, 0);
});

test("queue-label setup failure becomes a publication diagnostic instead of throwing", async () => {
  const client = createMockGitHubIssuesClient({ failOnEnsureLabel: true });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.diagnostics.join("\n"), /queue label setup failed.*simulated ensureLabel failure/i);
  assert.deepEqual(result.orphanNumbers, []);
  assert.equal(client.calls.listIssues.length, 0);
  assert.equal(client.calls.createIssue.length, 0);
});

test("duplicate-search failure becomes a publication diagnostic instead of throwing", async () => {
  const client = createMockGitHubIssuesClient({ failOnListIssues: true });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.diagnostics.join("\n"), /duplicate search failed.*simulated listIssues failure/i);
  assert.deepEqual(result.orphanNumbers, []);
  assert.equal(client.calls.createIssue.length, 0);
});

test("new child creation ensures queue label, creates the child, and verifies the sub-issue relationship in order", async () => {
  const client = createMockGitHubIssuesClient();
  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(client.calls.listIssues, [
    { state: "all", labels: ["parent-4"], limit: 1000 },
  ]);
  assert.deepEqual(client.events, [
    "ensureLabel:parent-4",
    "listIssues:all",
    "createIssue:Extract parser contract",
    "viewIssue:17",
    "addLabel:17:parent-4",
    "viewIssue:17",
    "addSubIssue:4:9001",
    "listSubIssues:4",
  ]);
});

test("open duplicate is reused without creating a second issue", async () => {
  const existing = childIssue({
    id: 7001,
    number: 21,
    title: "Existing open child",
    state: "OPEN",
    body: renderIssueAsPrdChildBody({
      parentNumber: 4,
      queueLabel: "parent-4",
      draft: draft(),
      marker: buildIssueAsPrdChildMarker({
        parentNumber: 4,
        source: "initial",
        title: draft().title,
        body: draft().body,
        dedupeKey: draft().dedupeKey,
      }),
    }),
    labels: [{ name: "parent-4" }],
  });
  const client = createMockGitHubIssuesClient({
    existingIssues: [existing],
    subIssues: [existing],
  });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.duplicateNumbers, [21]);
  assert.equal(client.calls.createIssue.length, 0);
});

test("closed duplicate is reused without creating a second issue", async () => {
  const existing = childIssue({
    id: 7002,
    number: 22,
    title: "Existing closed child",
    state: "CLOSED",
    body: renderIssueAsPrdChildBody({
      parentNumber: 4,
      queueLabel: "parent-4",
      draft: draft(),
      marker: buildIssueAsPrdChildMarker({
        parentNumber: 4,
        source: "initial",
        title: draft().title,
        body: draft().body,
        dedupeKey: draft().dedupeKey,
      }),
    }),
  });
  const client = createMockGitHubIssuesClient({
    existingIssues: [existing],
    subIssues: [existing],
  });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  assert.equal(client.calls.createIssue.length, 0);
  if (result.ok) assert.deepEqual(result.duplicateNumbers, [22]);
});

test("mixed batch creates only non-duplicates", async () => {
  const firstDraft = draft();
  const secondDraft = draft({
    title: "Write child publication tests",
    body: "## Context\nNeed tests.\n\n## Acceptance Criteria\n- Tests exist.",
    dedupeKey: "write-child-publication-tests",
  });
  const existing = childIssue({
    id: 7001,
    number: 21,
    title: "Existing child",
    body: renderIssueAsPrdChildBody({
      parentNumber: 4,
      queueLabel: "parent-4",
      draft: firstDraft,
      marker: buildIssueAsPrdChildMarker({
        parentNumber: 4,
        source: firstDraft.source,
        title: firstDraft.title,
        body: firstDraft.body,
        dedupeKey: firstDraft.dedupeKey,
      }),
    }),
    labels: [{ name: "parent-4" }],
  });
  const client = createMockGitHubIssuesClient({
    existingIssues: [existing],
    subIssues: [existing],
  });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [firstDraft, secondDraft],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.duplicateNumbers, [21]);
  assert.equal(result.children.length, 2);
  assert.equal(client.calls.createIssue.length, 1);
});

test("duplicate drafts in one batch create once and reuse the created child", async () => {
  const client = createMockGitHubIssuesClient();
  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft(), draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(client.calls.createIssue.length, 1);
  assert.deepEqual(result.duplicateNumbers, [17]);
});

test("created-but-unlinked recovery retries the link and does not create a second issue", async () => {
  const client = createMockGitHubIssuesClient({ failFirstLinkVerification: true });
  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(client.calls.createIssue.length, 1);
  assert.equal(client.calls.addSubIssue.length, 2);
});

test("already-linked recovery does not re-add the sub-issue relationship", async () => {
  const existing = childIssue({
    id: 7001,
    number: 21,
    title: "Existing child",
    body: renderIssueAsPrdChildBody({
      parentNumber: 4,
      queueLabel: "parent-4",
      draft: draft(),
      marker: buildIssueAsPrdChildMarker({
        parentNumber: 4,
        source: "initial",
        title: draft().title,
        body: draft().body,
        dedupeKey: draft().dedupeKey,
      }),
    }),
    labels: [{ name: "parent-4" }],
  });
  const client = createMockGitHubIssuesClient({
    existingIssues: [existing],
    subIssues: [existing],
    failOnAddSubIssue: true,
  });

  const result = await publishIssueAsPrdChildren({
    parent: parent(),
    drafts: [draft()],
    queueLabel: "parent-4",
    client,
  });

  assert.equal(result.ok, true);
  assert.equal(client.calls.addSubIssue.length, 1);
  if (result.ok) assert.deepEqual(result.duplicateNumbers, [21]);
});

test("marker and fingerprint follow the required format and stay stable", () => {
  const base = {
    parentNumber: 4,
    source: "initial" as const,
    title: "Extract parser contract",
    body: "## Context\nNeed strict parsing.\n\n## Acceptance Criteria\n- Parse tagged JSON.",
    dedupeKey: "extract-parser-contract",
  };
  const marker = buildIssueAsPrdChildMarker(base);
  const same = buildIssueAsPrdChildMarker({
    ...base,
    body: "## Context\r\nNeed strict parsing.\r\n\r\n## Acceptance Criteria\r\n- Parse tagged JSON.",
  });

  assert.match(
    marker,
    new RegExp(`<!-- ${ISSUE_AS_PRD_CHILD_MARKER} parent_number=4 source=initial source_fingerprint=sha256:[a-f0-9]{32} -->`),
  );
  assert.equal(marker, same);
  assert.equal(fingerprintIssueAsPrdChild(base).length, 32);
});

class MockGitHubIssuesClient {
  readonly calls = {
    ensureLabel: [] as Array<{ name: string; description: string; color: string }>,
    listIssues: [] as Array<{ state: string; labels?: readonly string[]; limit: number }>,
    viewIssue: [] as number[],
    createIssue: [] as Array<{ title: string; body: string; labels: readonly string[] }>,
    addLabel: [] as Array<{ issueNumber: number; label: string }>,
    listSubIssues: [] as number[],
    addSubIssue: [] as Array<{ parentNumber: number; subIssueDatabaseId: number }>,
  };
  readonly events: string[] = [];
  private readonly issues = new Map<number, GitHubIssueRecord>();
  private readonly markerIndex = new Map<string, GitHubIssueRecord>();
  private readonly subIssues = new Map<number, GitHubIssueRecord[]>();
  private nextNumber = 17;
  private nextId = 9001;
  private failFirstLinkVerification: boolean;
  private failOnAddSubIssue: boolean;
  private failOnEnsureLabel: boolean;
  private failOnListIssues: boolean;
  private firstLinkAttemptDone = false;

  constructor(input: {
    existingIssues?: GitHubIssueRecord[];
    subIssues?: GitHubIssueRecord[];
    failFirstLinkVerification?: boolean;
    failOnAddSubIssue?: boolean;
    failOnEnsureLabel?: boolean;
    failOnListIssues?: boolean;
  } = {}) {
    for (const issue of input.existingIssues ?? []) {
      this.issues.set(issue.number, cloneIssue(issue));
      const marker = extractMarker(issue.body);
      if (marker) this.markerIndex.set(marker, cloneIssue(issue));
    }
    this.subIssues.set(4, (input.subIssues ?? []).map(cloneIssue));
    this.failFirstLinkVerification = input.failFirstLinkVerification ?? false;
    this.failOnAddSubIssue = input.failOnAddSubIssue ?? false;
    this.failOnEnsureLabel = input.failOnEnsureLabel ?? false;
    this.failOnListIssues = input.failOnListIssues ?? false;
  }

  ensureLabel(name: string, description: string, color: string): void {
    this.calls.ensureLabel.push({ name, description, color });
    this.events.push(`ensureLabel:${name}`);
    if (this.failOnEnsureLabel) throw new Error("simulated ensureLabel failure");
  }

  listIssues(input: { state: "open" | "closed" | "all"; labels?: readonly string[]; limit: number }): GitHubIssueRecord[] {
    this.calls.listIssues.push({
      state: input.state,
      labels: input.labels,
      limit: input.limit,
    });
    this.events.push(`listIssues:${input.state}`);
    if (this.failOnListIssues) throw new Error("simulated listIssues failure");
    return [...this.issues.values()].map(cloneIssue);
  }

  viewIssue(issueNumber: number): GitHubIssueRecord {
    this.calls.viewIssue.push(issueNumber);
    this.events.push(`viewIssue:${issueNumber}`);
    const issue = this.issues.get(issueNumber);
    assert.ok(issue, `missing issue #${issueNumber}`);
    return cloneIssue(issue);
  }

  createIssue(input: { title: string; body: string; labels: readonly string[] }): { id: number; number: number; url?: string } {
    this.calls.createIssue.push(input);
    this.events.push(`createIssue:${input.title}`);
    const issue = childIssue({
      id: this.nextId++,
      number: this.nextNumber++,
      title: input.title,
      body: input.body,
      labels: input.labels.map((name) => ({ name })),
    });
    this.issues.set(issue.number, cloneIssue(issue));
    const marker = extractMarker(issue.body);
    if (marker) this.markerIndex.set(marker, cloneIssue(issue));
    return { id: issue.id, number: issue.number, url: issue.url };
  }

  addLabel(issueNumber: number, label: string): void {
    this.calls.addLabel.push({ issueNumber, label });
    this.events.push(`addLabel:${issueNumber}:${label}`);
    const issue = this.issues.get(issueNumber)!;
    if (!issue.labels.some((item) => item.name === label)) {
      issue.labels.push({ name: label });
    }
  }

  listSubIssues(parentNumber: number): GitHubIssueRecord[] {
    this.calls.listSubIssues.push(parentNumber);
    this.events.push(`listSubIssues:${parentNumber}`);
    return (this.subIssues.get(parentNumber) ?? []).map(cloneIssue);
  }

  addSubIssue(parentNumber: number, subIssueDatabaseId: number): void {
    this.calls.addSubIssue.push({ parentNumber, subIssueDatabaseId });
    this.events.push(`addSubIssue:${parentNumber}:${subIssueDatabaseId}`);
    if (this.failOnAddSubIssue) return;
    const issue = [...this.issues.values()].find((item) => item.id === subIssueDatabaseId);
    assert.ok(issue, `missing sub-issue with id ${subIssueDatabaseId}`);
    if (this.failFirstLinkVerification && !this.firstLinkAttemptDone) {
      this.firstLinkAttemptDone = true;
      return;
    }
    const current = this.subIssues.get(parentNumber) ?? [];
    if (!current.some((item) => item.id === issue.id)) {
      current.push(cloneIssue(issue));
      this.subIssues.set(parentNumber, current);
    }
  }
}

function createMockGitHubIssuesClient(
  input?: ConstructorParameters<typeof MockGitHubIssuesClient>[0],
): MockGitHubIssuesClient & GitHubIssuesClient {
  return new MockGitHubIssuesClient(input) as MockGitHubIssuesClient & GitHubIssuesClient;
}

function parent(): GitHubIssueRecord {
  return {
    id: 4000,
    number: 4,
    title: "Parent",
    body: "Parent body",
    state: "OPEN",
    url: "https://github.com/acme/widgets/issues/4",
    labels: [{ name: "backlog" }],
    comments: [],
  };
}

function draft(overrides: Partial<PublishChildDraft> = {}): PublishChildDraft {
  return {
    title: "Extract parser contract",
    body: "## Context\nNeed strict parsing.\n\n## Acceptance Criteria\n- Parse tagged JSON.",
    priority: "high",
    files: ["issue-as-prd-parsers.mts"],
    dedupeKey: "extract-parser-contract",
    source: "initial",
    ...overrides,
  };
}

function childIssue(input: {
  id: number;
  number: number;
  title: string;
  body: string;
  state?: "OPEN" | "CLOSED";
  labels?: { name: string }[];
}): GitHubIssueRecord {
  return {
    id: input.id,
    number: input.number,
    title: input.title,
    body: input.body,
    state: input.state ?? "OPEN",
    url: `https://github.com/acme/widgets/issues/${input.number}`,
    labels: input.labels ?? [],
    comments: [],
  };
}

function cloneIssue(issue: GitHubIssueRecord): GitHubIssueRecord {
  return {
    ...issue,
    labels: issue.labels.map((label) => ({ ...label })),
    comments: issue.comments.map((comment) => ({
      ...comment,
      author: { ...comment.author },
    })),
  };
}

function extractMarker(body: string): string | null {
  const match = body.match(
    new RegExp(`<!-- ${ISSUE_AS_PRD_CHILD_MARKER}[^>]* -->`, "u"),
  );
  return match?.[0] ?? null;
}
