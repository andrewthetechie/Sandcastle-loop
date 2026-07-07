import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_API_VERSION,
  GITHUB_JSON_ACCEPT,
  GitHubIssuesClient,
  normalizeGitHubIssueDetail,
  normalizeGitHubIssueList,
} from "./github-issues.mts";

test("listIssues emits exact gh argv with no labels", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -f state=open -f per_page=10 -f page=1`]:
      JSON.stringify([issuePayload({ id: 1, number: 7, title: "One" })]),
  });

  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);
  const issues = client.listIssues({ state: "open", limit: 10 });

  assert.equal(issues[0]?.number, 7);
  assert.deepEqual(runner.commands, [[
    "api",
    "repos/acme/widgets/issues",
    "--method",
    "GET",
    "-H",
    `Accept: ${GITHUB_JSON_ACCEPT}`,
    "-H",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "-f",
    "state=open",
    "-f",
    "per_page=10",
    "-f",
    "page=1",
  ]]);
});

test("listIssues emits exact gh argv with multiple labels", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -f state=all -f per_page=50 -f page=1 -f labels=parent-4,feature`]:
      JSON.stringify([issuePayload({ id: 1, number: 4, title: "Two" })]),
  });

  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);
  client.listIssues({ state: "all", limit: 50, labels: ["parent-4", "feature"] });

  assert.deepEqual(runner.commands[0], [
    "api",
    "repos/acme/widgets/issues",
    "--method",
    "GET",
    "-H",
    `Accept: ${GITHUB_JSON_ACCEPT}`,
    "-H",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "-f",
    "state=all",
    "-f",
    "per_page=50",
    "-f",
    "page=1",
    "-f",
    "labels=parent-4,feature",
  ]);
});

test("listIssues paginates REST results up to the requested limit", () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    issuePayload({ id: index + 1, number: index + 1, title: `Issue ${index + 1}` }),
  );
  const secondPage = [issuePayload({ id: 101, number: 101, title: "Issue 101" })];
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -f state=all -f per_page=100 -f page=1`]: JSON.stringify(firstPage),
    [`api repos/acme/widgets/issues --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -f state=all -f per_page=100 -f page=2`]: JSON.stringify(secondPage),
  });

  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);
  const issues = client.listIssues({ state: "all", limit: 150 });

  assert.equal(issues.length, 101);
  assert.equal(issues.at(-1)?.id, 101);
  assert.equal(runner.commands.length, 2);
});

test("viewIssue emits exact gh api argv and reads comments separately", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues/17 --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION}`]:
      JSON.stringify(issuePayload({ id: 9, number: 17, title: "View me", comments: [] })),
    [`api repos/acme/widgets/issues/17/comments --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION}`]: JSON.stringify([
      {
        id: 91,
        user: { login: "octocat" },
        body: "durable state",
        created_at: "2026-07-03T17:51:17Z",
      },
    ]),
  });

  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);
  const issue = client.viewIssue(17);

  assert.equal(issue.id, 9);
  assert.deepEqual(issue.comments, [{
    id: 91,
    author: { login: "octocat" },
    body: "durable state",
    createdAt: "2026-07-03T17:51:17Z",
  }]);
  assert.deepEqual(runner.commands, [
    [
      "api",
      "repos/acme/widgets/issues/17",
      "--method",
      "GET",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ],
    [
      "api",
      "repos/acme/widgets/issues/17/comments",
      "--method",
      "GET",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ],
  ]);
});

test("createIssue emits exact gh argv and resolves id from read-back", () => {
  const runner = new RecordingGhRunner({
    "issue create --repo acme/widgets --title Child --body Body --label parent-4 --label feature":
      "https://github.com/acme/widgets/issues/17\n",
    [`api repos/acme/widgets/issues/17 --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION}`]:
      JSON.stringify(issuePayload({ id: 9001, number: 17, title: "Child", body: "Body", comments: [] })),
    [`api repos/acme/widgets/issues/17/comments --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION}`]:
      JSON.stringify([]),
  });

  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);
  const created = client.createIssue({
    title: "Child",
    body: "Body",
    labels: ["parent-4", "feature"],
  });

  assert.deepEqual(created, {
    id: 9001,
    number: 17,
    url: "https://github.com/acme/widgets/issues/17",
  });
  assert.deepEqual(runner.commands, [
    [
      "issue",
      "create",
      "--repo",
      "acme/widgets",
      "--title",
      "Child",
      "--body",
      "Body",
      "--label",
      "parent-4",
      "--label",
      "feature",
    ],
    [
      "api",
      "repos/acme/widgets/issues/17",
      "--method",
      "GET",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ],
    [
      "api",
      "repos/acme/widgets/issues/17/comments",
      "--method",
      "GET",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ],
  ]);
});

test("label and issue mutation methods emit exact gh argv", () => {
  const runner = new RecordingGhRunner({
    "label create parent-4 --repo acme/widgets --description Temporary queue --color 1d76db --force": "",
    "label delete parent-4 --repo acme/widgets --yes": "",
    "issue edit 7 --repo acme/widgets --add-label parent-4": "",
    "issue edit 7 --repo acme/widgets --remove-label parent-4": "",
    "issue edit 7 --repo acme/widgets --body New body": "",
    "issue close 7 --repo acme/widgets --comment Closed as not actionable": "",
  });
  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);

  client.ensureLabel("parent-4", "Temporary queue", "1d76db");
  client.deleteLabel("parent-4");
  client.addLabel(7, "parent-4");
  client.removeLabel(7, "parent-4");
  client.editIssueBody(7, "New body");
  client.closeIssue(7, "Closed as not actionable");

  assert.deepEqual(runner.commands, [
    ["label", "create", "parent-4", "--repo", "acme/widgets", "--description", "Temporary queue", "--color", "1d76db", "--force"],
    ["label", "delete", "parent-4", "--repo", "acme/widgets", "--yes"],
    ["issue", "edit", "7", "--repo", "acme/widgets", "--add-label", "parent-4"],
    ["issue", "edit", "7", "--repo", "acme/widgets", "--remove-label", "parent-4"],
    ["issue", "edit", "7", "--repo", "acme/widgets", "--body", "New body"],
    ["issue", "close", "7", "--repo", "acme/widgets", "--comment", "Closed as not actionable"],
  ]);
});

test("createComment and updateComment emit exact gh api argv", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues/4/comments --method POST -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -F body=Hello`]:
      JSON.stringify({ id: 77 }),
    [`api repos/acme/widgets/issues/comments/77 --method PATCH -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -F body=Updated`]:
      "",
  });
  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);

  const created = client.createComment(4, "Hello");
  client.updateComment(created.id, "Updated");

  assert.deepEqual(created, { id: 77 });
  assert.deepEqual(runner.commands, [
    ["api", "repos/acme/widgets/issues/4/comments", "--method", "POST", "-H", `Accept: ${GITHUB_JSON_ACCEPT}`, "-H", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`, "-F", "body=Hello"],
    ["api", "repos/acme/widgets/issues/comments/77", "--method", "PATCH", "-H", `Accept: ${GITHUB_JSON_ACCEPT}`, "-H", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`, "-F", "body=Updated"],
  ]);
});

test("listSubIssues emits exact gh api argv and normalizes results", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues/4/sub_issues --method GET -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION}`]:
      JSON.stringify([issuePayload({ id: 9001, number: 17, title: "Child" })]),
  });
  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);

  const issues = client.listSubIssues(4);

  assert.equal(issues[0]?.id, 9001);
  assert.deepEqual(runner.commands[0], [
    "api",
    "repos/acme/widgets/issues/4/sub_issues",
    "--method",
    "GET",
    "-H",
    `Accept: ${GITHUB_JSON_ACCEPT}`,
    "-H",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
  ]);
});

test("addSubIssue emits exact gh api argv and uses the child database id, never the issue number", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues/4/sub_issues --method POST --include -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -F sub_issue_id=9001`]:
      "HTTP/2 201 Created\n\n{}",
  });
  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);

  client.addSubIssue(4, 9001);

  assert.deepEqual(runner.commands[0], [
    "api",
    "repos/acme/widgets/issues/4/sub_issues",
    "--method",
    "POST",
    "--include",
    "-H",
    `Accept: ${GITHUB_JSON_ACCEPT}`,
    "-H",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "-F",
    "sub_issue_id=9001",
  ]);
  assert.equal(runner.commands[0]?.includes("17"), false);
});

test("addSubIssue can request replace_parent", () => {
  const runner = new RecordingGhRunner({
    [`api repos/acme/widgets/issues/4/sub_issues --method POST --include -H Accept: ${GITHUB_JSON_ACCEPT} -H X-GitHub-Api-Version: ${GITHUB_API_VERSION} -F sub_issue_id=9001 -F replace_parent=true`]:
      "HTTP/2 201 Created\n\n{}",
  });
  const client = new GitHubIssuesClient({ owner: "acme", repo: "widgets" }, runner);

  client.addSubIssue(4, 9001, { replaceParent: true });

  assert.deepEqual(runner.commands[0], [
    "api",
    "repos/acme/widgets/issues/4/sub_issues",
    "--method",
    "POST",
    "--include",
    "-H",
    `Accept: ${GITHUB_JSON_ACCEPT}`,
    "-H",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "-F",
    "sub_issue_id=9001",
    "-F",
    "replace_parent=true",
  ]);
});

test("GitHub normalizers produce tracker-neutral issue records", () => {
  const issue = normalizeGitHubIssueDetail(
    issuePayload({
      id: 5,
      number: 44,
      title: "Implement the thing",
      body: "Issue body",
      labels: [{ name: "prd-001" }],
      comments: [
        {
          id: 88,
          author: { login: "andrew" },
          body: "Looks good",
          createdAt: "2026-06-11T12:00:00Z",
        },
      ],
    }),
  );
  const list = normalizeGitHubIssueList([issuePayload({ id: 12, number: 7, title: "List item" })]);

  assert.equal(issue.number, 44);
  assert.equal(issue.id, 5);
  assert.deepEqual(issue.labels, [{ name: "prd-001" }]);
  assert.deepEqual(issue.comments, [
    {
      id: 8088,
      id: 88,
      author: { login: "andrew" },
      body: "Looks good",
      createdAt: "2026-06-11T12:00:00Z",
    },
  ]);
  assert.equal(list[0]?.number, 7);
});

class RecordingGhRunner {
  readonly commands: string[][] = [];
  private readonly responses = new Map<string, string>();

  constructor(responses: Record<string, string>) {
    for (const [command, response] of Object.entries(responses)) {
      this.responses.set(command, response);
    }
  }

  run(args: readonly string[]): string {
    this.commands.push([...args]);
    const key = args.join(" ");
    const response = this.responses.get(key);
    assert.notEqual(response, undefined, `unexpected gh command: ${key}`);
    return response!;
  }
}

function issuePayload(input: {
  id: number;
  number: number;
  title: string;
  body?: string;
  state?: "OPEN" | "CLOSED" | "open" | "closed";
  labels?: unknown[];
  comments?: unknown[];
}): Record<string, unknown> {
  return {
    id: input.id,
    number: input.number,
    title: input.title,
    body: input.body ?? "",
    state: input.state ?? "OPEN",
    url: `https://github.com/acme/widgets/issues/${input.number}`,
    labels: input.labels ?? [],
    comments: input.comments ?? [],
  };
}
