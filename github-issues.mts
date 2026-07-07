import { execFileSync } from "node:child_process";

export interface GitHubCommandRunner {
  run(args: readonly string[], options?: { cwd?: string }): string;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  hostname?: string;
}

export interface GitHubIssueComment {
  id: number;
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface GitHubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url?: string;
  labels: { name: string }[];
  comments: GitHubIssueComment[];
}

export interface GitHubIssueListQuery {
  state: "open" | "closed" | "all";
  labels?: readonly string[];
  limit: number;
}

export interface GitHubIssueCreateInput {
  title: string;
  body: string;
  labels: readonly string[];
}

export interface GitHubIssueCreateResult {
  id: number;
  number: number;
  url?: string;
}

export const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export class GitHubIssuesClient {
  constructor(
    private readonly repo: GitHubRepoRef,
    private readonly runner: GitHubCommandRunner = defaultGhRunner,
  ) {}

  listIssues(input: GitHubIssueListQuery): GitHubIssueRecord[] {
    if (input.limit <= 0) return [];

    const issues: GitHubIssueRecord[] = [];
    const perPage = Math.min(input.limit, 100);
    for (let page = 1; issues.length < input.limit; page += 1) {
      const response = this.apiJson<unknown>([
        "api",
        ...this.apiHostnameArgs(),
        `repos/${this.repo.owner}/${this.repo.repo}/issues`,
        "--method",
        "GET",
        "-H",
        `Accept: ${GITHUB_JSON_ACCEPT}`,
        "-H",
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
        "-f",
        `state=${input.state}`,
        "-f",
        `per_page=${perPage}`,
        "-f",
        `page=${page}`,
        ...(input.labels?.length ? ["-f", `labels=${input.labels.join(",")}`] : []),
      ]);
      const listed = normalizeGitHubIssueRestList(
        response,
      );
      issues.push(...listed);
      if (!Array.isArray(response) || response.length < perPage) break;
    }

    return issues.slice(0, input.limit);
  }

  viewIssue(issueNumber: number): GitHubIssueRecord {
    const issue = record(
      this.apiJson<unknown>([
        "api",
        ...this.apiHostnameArgs(),
        `repos/${this.repo.owner}/${this.repo.repo}/issues/${issueNumber}`,
        "--method",
        "GET",
        "-H",
        `Accept: ${GITHUB_JSON_ACCEPT}`,
        "-H",
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      ]),
    );
    const comments = this.apiJson<unknown>([
      "api",
      ...this.apiHostnameArgs(),
      `repos/${this.repo.owner}/${this.repo.repo}/issues/${issueNumber}/comments`,
      "--method",
      "GET",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ]);

    return normalizeGitHubIssueDetail({
      ...issue,
      comments,
    });
  }

  createIssue(input: GitHubIssueCreateInput): GitHubIssueCreateResult {
    const output = this.runner
      .run([
        "issue",
        "create",
        "--repo",
        this.repoSelector(),
        "--title",
        input.title,
        "--body",
        input.body,
        ...input.labels.flatMap((label) => ["--label", label]),
      ])
      .trim();

    const issueNumber = issueNumberFromText(output);
    if (!issueNumber) {
      throw new Error(`gh issue create did not report an issue number.\n${output}`);
    }
    const detail = this.viewIssue(issueNumber);
    return { id: detail.id, number: detail.number, url: detail.url };
  }

  ensureLabel(name: string, description: string, color: string): void {
    this.runner.run([
      "label",
      "create",
      name,
      "--repo",
      this.repoSelector(),
      "--description",
      description,
      "--color",
      color,
      "--force",
    ]);
  }

  deleteLabel(name: string): void {
    this.runner.run([
      "label",
      "delete",
      name,
      "--repo",
      this.repoSelector(),
      "--yes",
    ]);
  }

  addLabel(issueNumber: number, label: string): void {
    this.runner.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.repoSelector(),
      "--add-label",
      label,
    ]);
  }

  removeLabel(issueNumber: number, label: string): void {
    this.runner.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.repoSelector(),
      "--remove-label",
      label,
    ]);
  }

  editIssueBody(issueNumber: number, body: string): void {
    this.runner.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.repoSelector(),
      "--body",
      body,
    ]);
  }

  createComment(issueNumber: number, body: string): { id: number } {
    const response = this.apiJson<{ id: unknown }>([
      "api",
      ...this.apiHostnameArgs(),
      `repos/${this.repo.owner}/${this.repo.repo}/issues/${issueNumber}/comments`,
      "--method",
      "POST",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      "-F",
      `body=${body}`,
    ]);
    const id = integerField(response, "id");
    if (id === undefined) {
      throw new Error("GitHub comment creation response did not include an integer id.");
    }
    return { id };
  }

  updateComment(commentId: number, body: string): void {
    this.runner.run([
      "api",
      ...this.apiHostnameArgs(),
      `repos/${this.repo.owner}/${this.repo.repo}/issues/comments/${commentId}`,
      "--method",
      "PATCH",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      "-F",
      `body=${body}`,
    ]);
  }

  closeIssue(issueNumber: number, comment: string): void {
    this.runner.run([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      this.repoSelector(),
      "--comment",
      comment,
    ]);
  }

  listSubIssues(parentNumber: number): GitHubIssueRecord[] {
    return normalizeGitHubIssueList(
      this.apiJson<unknown>([
        "api",
        ...this.apiHostnameArgs(),
        `repos/${this.repo.owner}/${this.repo.repo}/issues/${parentNumber}/sub_issues`,
        "--method",
        "GET",
        "-H",
        `Accept: ${GITHUB_JSON_ACCEPT}`,
        "-H",
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      ]),
    );
  }

  addSubIssue(
    parentNumber: number,
    subIssueDatabaseId: number,
    options: { replaceParent?: boolean } = {},
  ): void {
    this.runner.run([
      "api",
      ...this.apiHostnameArgs(),
      `repos/${this.repo.owner}/${this.repo.repo}/issues/${parentNumber}/sub_issues`,
      "--method",
      "POST",
      "--include",
      "-H",
      `Accept: ${GITHUB_JSON_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      "-F",
      `sub_issue_id=${subIssueDatabaseId}`,
      ...(options.replaceParent ? ["-F", "replace_parent=true"] : []),
    ]);
  }

  private ghJson<T>(args: readonly string[]): T {
    const output = this.runner.run(args);
    try {
      return JSON.parse(output) as T;
    } catch (err) {
      throw new Error(
        [
          `gh ${args.join(" ")} did not return valid JSON.`,
          err instanceof Error ? err.message : String(err),
          output.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  private apiJson<T>(args: readonly string[]): T {
    return this.ghJson<T>(args);
  }

  private repoSelector(): string {
    return this.repo.hostname
      ? `${this.repo.hostname}/${this.repo.owner}/${this.repo.repo}`
      : `${this.repo.owner}/${this.repo.repo}`;
  }

  private apiHostnameArgs(): string[] {
    return this.repo.hostname ? ["--hostname", this.repo.hostname] : [];
  }
}

export function normalizeGitHubIssueList(value: unknown): GitHubIssueRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub issue list response was not an array.");
  }
  return value.map((item) => normalizeGitHubIssueDetail(item));
}

function normalizeGitHubIssueRestList(value: unknown): GitHubIssueRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub REST issue list response was not an array.");
  }
  return value
    .filter((item) => !isPullRequest(item))
    .map((item) => normalizeGitHubIssueDetail(item));
}

export function normalizeGitHubIssueDetail(value: unknown): GitHubIssueRecord {
  const issue = record(value);
  const id = requiredIntegerField(issue, "id", "GitHub issue");
  const number = requiredIntegerField(issue, "number", "GitHub issue");
  const title = requiredStringField(issue, "title", "GitHub issue");
  const body = optionalStringField(issue, "body") ?? "";
  const state = normalizeIssueState(requiredStringField(issue, "state", "GitHub issue"));
  const url = optionalStringField(issue, "url") ?? optionalStringField(issue, "html_url");
  const labels = normalizeGitHubLabels(issue.labels);
  const comments = normalizeGitHubComments(issue.comments);

  return {
    id,
    number,
    title,
    body,
    state,
    url,
    labels,
    comments,
  };
}

export function normalizeGitHubLabels(value: unknown): { name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return { name: label };
      const item = record(label);
      const name = optionalStringField(item, "name");
      return name ? { name } : null;
    })
    .filter((label): label is { name: string } => Boolean(label));
}

export function normalizeGitHubComments(value: unknown): GitHubIssueComment[] {
  if (!Array.isArray(value)) return [];
  return value.map((comment) => {
    const item = record(comment);
    const author = record(item.author ?? item.user ?? {});
    return {
      id: requiredIntegerField(item, "id", "GitHub issue comment"),
      author: { login: optionalStringField(author, "login") ?? "" },
      body: optionalStringField(item, "body") ?? "",
      createdAt:
        optionalStringField(item, "createdAt") ??
        optionalStringField(item, "created_at") ??
        "",
    };
  });
}

function normalizeIssueState(value: string): "OPEN" | "CLOSED" {
  const normalized = value.toUpperCase();
  if (normalized === "OPEN" || normalized === "CLOSED") return normalized;
  throw new Error(`GitHub issue state must be OPEN/CLOSED/open/closed; got '${value}'.`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function isPullRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "pull_request" in value;
}

function requiredIntegerField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const parsed = integerField(value, key);
  if (parsed === undefined) {
    throw new Error(`${context} missing integer field '${key}'.`);
  }
  return parsed;
}

function integerField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  if (typeof value[key] !== "number" || !Number.isInteger(value[key])) return undefined;
  return value[key] as number;
}

function requiredStringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const parsed = optionalStringField(value, key);
  if (parsed === undefined) {
    throw new Error(`${context} missing string field '${key}'.`);
  }
  return parsed;
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function issueNumberFromText(output: string): number | undefined {
  const parsedJson = tryParseJson(output);
  if (parsedJson) {
    if (typeof parsedJson.number === "number" && Number.isInteger(parsedJson.number)) {
      return parsedJson.number;
    }
    if (typeof parsedJson.url === "string") return issueNumberFromUrl(parsedJson.url);
  }
  return issueNumberFromUrl(output) ?? trailingIssueNumber(output);
}

function issueNumberFromUrl(value: string): number | undefined {
  const raw = value.match(/\/issues\/(\d+)(?:$|[/?#\s])/u)?.[1];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function trailingIssueNumber(value: string): number | undefined {
  const raw = value.trim().match(/#(\d+)\s*$/u)?.[1];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const defaultGhRunner: GitHubCommandRunner = {
  run(args, options) {
    return execFileSync("gh", args, {
      cwd: options?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GITHUB_COMMAND_MAX_BUFFER_BYTES,
    });
  },
};
