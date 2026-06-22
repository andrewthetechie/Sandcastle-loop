import { execFileSync } from "node:child_process";
import type {
  ExtraReviewIssueClient,
  ExtraReviewIssueCreateInput,
  ExtraReviewIssueCreateResult,
  ExtraReviewIssueDetail,
  ExtraReviewIssueListItem,
  ExtraReviewIssueListQuery,
} from "./extra-review-issues.mts";

export interface ForgejoIssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface ForgejoIssueDetail extends ExtraReviewIssueDetail {
  title: string;
  body: string;
  comments: ForgejoIssueComment[];
  labels: { name: string }[];
}

export type ForgejoPullMergeStrategy = "merge" | "squash" | "rebase";

export interface ForgejoPullCreateInput {
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface ForgejoPullCreateResult {
  number?: number;
  url?: string;
}

export interface ForgejoTeaCommandRunner {
  run(args: readonly string[], options?: { cwd?: string }): string;
}

export class ForgejoTeaClient implements ExtraReviewIssueClient {
  constructor(
    private readonly runner: ForgejoTeaCommandRunner = defaultTeaRunner,
  ) {}

  preflight(): void {
    try {
      this.runner.run(["--version"]);
    } catch (err) {
      throw new Error(
        [
          "Forgejo runner requires the tea CLI, but `tea --version` failed.",
          err instanceof Error ? err.message : String(err),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    try {
      this.listIssues({ label: "", state: "open", limit: 1 });
    } catch (err) {
      throw new Error(
        [
          "Forgejo runner preflight failed: tea could not return machine-readable issue output.",
          err instanceof Error ? err.message : String(err),
        ].join("\n"),
      );
    }
  }

  listIssues(query: ExtraReviewIssueListQuery): ExtraReviewIssueListItem[] {
    const args = [
      "issue",
      "list",
      "--state",
      query.state,
      "--limit",
      String(query.limit),
      "--output",
      "json",
    ];
    if (query.label) args.push("--labels", query.label);
    return normalizeForgejoIssueList(this.teaJson<unknown>(args));
  }

  viewIssue(issueNumber: number): ForgejoIssueDetail {
    return normalizeForgejoIssueDetail(
      this.teaJson<unknown>([
        "issue",
        String(issueNumber),
        "--comments",
        "--output",
        "json",
      ]),
    );
  }

  createIssue(input: ExtraReviewIssueCreateInput): ExtraReviewIssueCreateResult {
    const output = this.runner
      .run([
        "issue",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--labels",
        input.labels.join(","),
      ])
      .trim();
    const parsed = tryParseJson(output);
    if (parsed) {
      const issue = normalizeForgejoIssueDetail(parsed);
      return { number: issue.number, url: issue.url };
    }
    return { number: issueNumberFromText(output), url: urlFromText(output) };
  }

  ensureLabel(name: string, description?: string, color?: string): void {
    const existing = normalizeForgejoLabels(
      this.teaJson<unknown>(["label", "list", "--output", "json"]),
    );
    if (existing.some((label) => label.name === name)) return;
    this.runner.run([
      "label",
      "create",
      "--name",
      name,
      "--color",
      color ?? "5319e7",
      "--description",
      description ?? "",
    ]);
  }

  commentIssue(issueNumber: number, body: string): void {
    this.runner.run(["issue", "comment", String(issueNumber), "--body", body]);
  }

  closeIssue(issueNumber: number, comment: string): void {
    this.runner.run(["issue", "close", String(issueNumber), "--comment", comment]);
  }

  addLabelToIssue(issueNumber: number, label: string): void {
    this.runner.run([
      "issue",
      "edit",
      String(issueNumber),
      "--add-label",
      label,
    ]);
  }

  createPull(
    input: ForgejoPullCreateInput,
    cwd?: string,
  ): ForgejoPullCreateResult {
    const output = this.runner
      .run(
        [
          "pulls",
          "create",
          "--base",
          input.base,
          "--head",
          input.head,
          "--title",
          input.title,
          "--body",
          input.body,
        ],
        { cwd },
      )
      .trim();
    const parsed = tryParseJson(output);
    if (parsed) {
      const issue = normalizeForgejoIssueDetail(parsed);
      return { number: issue.number, url: issue.url };
    }
    return { number: pullNumberFromText(output), url: urlFromText(output) };
  }

  mergePull(
    pull: ForgejoPullCreateResult,
    strategy: ForgejoPullMergeStrategy,
    cwd?: string,
  ): void {
    const pullRef = pull.number ? String(pull.number) : pull.url;
    if (!pullRef) {
      throw new Error("tea did not report a pull request number or URL to merge");
    }
    this.runner.run(
      ["pulls", "merge", pullRef, "--style", strategy],
      { cwd },
    );
  }

  private teaJson<T>(args: readonly string[]): T {
    const output = this.runner.run(args);
    try {
      return JSON.parse(output) as T;
    } catch (err) {
      throw new Error(
        [
          `tea ${args.join(" ")} did not return valid JSON.`,
          err instanceof Error ? err.message : String(err),
          output.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }
}

export function normalizeForgejoIssueList(
  value: unknown,
): ExtraReviewIssueListItem[] {
  const items = Array.isArray(value) ? value : objectArrayField(value, "issues");
  return items.map((item) => normalizeForgejoIssueSummary(item));
}

export function normalizeForgejoIssueDetail(value: unknown): ForgejoIssueDetail {
  const item = record(value);
  const summary = normalizeForgejoIssueSummary(item);
  return {
    ...summary,
    title: stringField(item, "title", "Title") ?? "",
    body: stringField(item, "body", "Body", "description", "Description") ?? "",
    comments: normalizeForgejoComments(
      field(item, "comments", "Comments", "comment_list"),
    ),
    labels: normalizeForgejoLabels(field(item, "labels", "Labels")),
  };
}

export function normalizeForgejoLabels(value: unknown): { name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return { name: label };
      const labelRecord = record(label);
      const name = stringField(labelRecord, "name", "Name");
      return name ? { name } : null;
    })
    .filter((label): label is { name: string } => Boolean(label));
}

export function normalizeForgejoComments(value: unknown): ForgejoIssueComment[] {
  if (!Array.isArray(value)) return [];
  return value.map((comment) => {
    const commentRecord = record(comment);
    const user = record(
      field(
        commentRecord,
        "author",
        "Author",
        "poster",
        "Poster",
        "user",
        "User",
      ),
    );
    return {
      author: {
        login:
          stringField(user, "login", "username", "name", "Login", "UserName") ??
          "",
      },
      body: stringField(commentRecord, "body", "Body", "content", "Content") ?? "",
      createdAt:
        stringField(
          commentRecord,
          "createdAt",
          "created_at",
          "Created",
          "created",
        ) ?? "",
    };
  });
}

function normalizeForgejoIssueSummary(
  value: unknown,
): ExtraReviewIssueListItem {
  const item = record(value);
  const number =
    numberField(item, "number", "Number", "index", "Index", "id", "ID") ?? 0;
  return {
    number,
    title: stringField(item, "title", "Title"),
    state: stringField(item, "state", "State"),
    url: stringField(item, "url", "URL", "html_url", "HTMLURL", "HTMLUrl"),
    labels: normalizeForgejoLabels(field(item, "labels", "Labels")),
  } as ExtraReviewIssueListItem & { labels: { name: string }[] };
}

function objectArrayField(value: unknown, key: string): unknown[] {
  const obj = record(value);
  const nested = obj[key];
  return Array.isArray(nested) ? nested : [];
}

function field(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown | undefined {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

function stringField(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = field(obj, ...keys);
  return typeof value === "string" ? value : undefined;
}

function numberField(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = field(obj, ...keys);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function tryParseJson(output: string): unknown | null {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function urlFromText(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

function issueNumberFromText(text: string): number | undefined {
  const urlNumber = urlFromText(text)?.match(/\/issues\/(\d+)(?:\b|$)/)?.[1];
  const raw = urlNumber ?? text.match(/#(\d+)\b/)?.[1];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function pullNumberFromText(text: string): number | undefined {
  const urlNumber = urlFromText(text)?.match(/\/pulls\/(\d+)(?:\b|$)/)?.[1];
  const raw = urlNumber ?? text.match(/#(\d+)\b/)?.[1];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

const defaultTeaRunner: ForgejoTeaCommandRunner = {
  run(args, options) {
    return execFileSync("tea", [...args], {
      cwd: options?.cwd,
      encoding: "utf8",
      env: process.env,
    });
  },
};
