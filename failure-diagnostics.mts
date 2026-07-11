// failure-diagnostics.mts
//
// Post-mortem capture for agent-stuck terminals and loop failures. Every
// terminal failure writes one self-contained bundle directory under
// `.sandcastle/diagnostics/` so the failure can be debugged after the loop,
// its sandboxes, and its worktrees are gone: structured context
// (`diagnostic.json`), the final feedback the agent saw, git state for the
// failing branch, tails of the branch's agent run logs, an excerpt of the
// matching metrics records, and the Companion TUI snapshot at failure time.
// An index record is appended to `.sandcastle/metrics/runs.jsonl` so metrics
// remain the single searchable index.
//
// Capture is strictly best-effort: `recordFailureDiagnostic` never throws,
// and each section is guarded independently so one failing probe cannot lose
// the rest of the bundle. A diagnostics failure must never affect loop
// control flow.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_FILES = 12;
const MAX_METRICS_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_METRICS_EXCERPT_RECORDS = 300;
const MAX_LOOP_SCOPE_EXCERPT_RECORDS = 50;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024;
const MAX_INLINE_ERROR_BYTES = 8 * 1024;

export type FailureDiagnosticScope = "issue" | "child" | "parent" | "loop";

export interface FailureDiagnosticInput {
  scope: FailureDiagnosticScope;
  /** Terminal classification, e.g. `stuck_no_progress`, `crashed`, `parent_stuck`. */
  outcome: string;
  /** Backlog label(s) identifying the loop, mirroring metrics records. */
  prd: string;
  issue?: number;
  parentIssue?: number;
  branch?: string;
  /** Ref the branch forked from (e.g. `origin/main`); enables merge-base/diff probes. */
  baseRef?: string;
  worktreePath?: string;
  roundsUsed?: number;
  /** Error message or stack for crash-shaped failures. */
  error?: string;
  /** The final reviewer/validation feedback the agent saw before the terminal. */
  lastFeedback?: string;
  /** Free-form extra context (terminal diagnostics, reasons, counters). */
  detail?: Record<string, unknown>;
}

export interface FailureDiagnosticDeps {
  repoRoot: string;
  now?: () => Date;
  warn?: (message: string) => void;
  log?: (message: string) => void;
}

export interface AgentLogTailRecord {
  source_path: string;
  tail_file: string;
  source_bytes: number;
  tail_bytes: number;
}

export function recordFailureDiagnostic(
  input: FailureDiagnosticInput,
  deps: FailureDiagnosticDeps,
): string | null {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const log = deps.log ?? ((message: string) => console.log(message));
  try {
    const now = (deps.now ?? (() => new Date()))();
    const recordedAt = now.toISOString();
    const stamp = recordedAt.replace(/[:.]/g, "-");
    const subject = input.issue ?? input.parentIssue;
    const bundleDir = join(
      deps.repoRoot,
      ".sandcastle",
      "diagnostics",
      [
        stamp,
        input.scope,
        subject !== undefined ? String(subject) : "loop",
        sanitizeSlug(input.outcome),
      ].join("-"),
    );
    mkdirSync(bundleDir, { recursive: true });

    const captureErrors: string[] = [];
    const capture = <T,>(name: string, fn: () => T): T | null => {
      try {
        return fn();
      } catch (error) {
        captureErrors.push(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    };

    const gitState = capture("git_state", () =>
      captureGitState({
        repoRoot: deps.repoRoot,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: input.worktreePath,
      }),
    );

    const logTails =
      capture("agent_log_tails", () =>
        collectBranchLogTails({
          repoRoot: deps.repoRoot,
          branch: input.branch,
          bundleDir,
        }),
      ) ?? [];

    const metricsExcerpt = capture("metrics_excerpt", () =>
      writeMetricsExcerpt({
        repoRoot: deps.repoRoot,
        bundleDir,
        issue: input.issue,
        parentIssue: input.parentIssue,
      }),
    );

    capture("tui_snapshot", () => {
      const snapshotPath = join(
        deps.repoRoot,
        ".sandcastle",
        "tui",
        "status.json",
      );
      if (existsSync(snapshotPath)) {
        copyFileSync(snapshotPath, join(bundleDir, "tui-status.json"));
      }
    });

    if (input.lastFeedback) {
      capture("last_feedback", () => {
        writeFileSync(
          join(bundleDir, "last-feedback.md"),
          truncateText(input.lastFeedback ?? "", MAX_TEXT_BYTES),
          "utf8",
        );
      });
    }
    if (input.error) {
      capture("error_text", () => {
        writeFileSync(
          join(bundleDir, "error.txt"),
          truncateText(input.error ?? "", MAX_TEXT_BYTES),
          "utf8",
        );
      });
    }

    const diagnostic: Record<string, unknown> = {
      kind: "sandcastle_failure_diagnostic",
      schema_version: 1,
      recorded_at: recordedAt,
      scope: input.scope,
      outcome: input.outcome,
      prd: input.prd,
      issue: input.issue,
      parent_issue: input.parentIssue,
      branch: input.branch,
      base_ref: input.baseRef,
      worktree_path: input.worktreePath,
      rounds_used: input.roundsUsed,
      error: input.error
        ? truncateText(input.error, MAX_INLINE_ERROR_BYTES)
        : undefined,
      detail: input.detail,
      host: {
        hostname: hostname(),
        pid: process.pid,
        node: process.version,
        argv: process.argv.slice(1),
        cwd: process.cwd(),
      },
      git_state: gitState,
      agent_log_tails: logTails,
      metrics_excerpt: metricsExcerpt,
      capture_errors: captureErrors,
    };
    writeFileSync(
      join(bundleDir, "diagnostic.json"),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
      "utf8",
    );

    capture("metrics_index", () => {
      const metricsDir = join(deps.repoRoot, ".sandcastle", "metrics");
      mkdirSync(metricsDir, { recursive: true });
      appendFileSync(
        join(metricsDir, "runs.jsonl"),
        `${JSON.stringify({
          kind: "sandcastle_failure_diagnostic",
          schema_version: 1,
          scope: input.scope,
          outcome: input.outcome,
          prd: input.prd,
          issue: input.issue,
          parent_issue: input.parentIssue,
          branch: input.branch,
          bundle_dir: bundleDir,
          recorded_at: recordedAt,
        })}\n`,
        "utf8",
      );
    });

    log(`Failure diagnostic written: ${bundleDir}`);
    return bundleDir;
  } catch (error) {
    warn(
      `Failure diagnostic capture failed (${input.scope}/${input.outcome}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export interface LoopCrashHandlerInput {
  prd: string;
  repoRoot: string;
  baseRef?: string;
}

let crashHandlersInstalled = false;

/**
 * Capture a loop-scope diagnostics bundle before the process dies on an
 * otherwise-unhandled crash. Preserves the default fatal behavior: the error
 * still reaches stderr and the process still exits 1.
 */
export function installLoopCrashHandlers(input: LoopCrashHandlerInput): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  const record = (
    outcome: "uncaught_exception" | "unhandled_rejection",
    error: unknown,
  ) => {
    recordFailureDiagnostic(
      {
        scope: "loop",
        outcome,
        prd: input.prd,
        baseRef: input.baseRef,
        error:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
      { repoRoot: input.repoRoot },
    );
  };
  process.on("uncaughtException", (error) => {
    console.error(error);
    record("uncaught_exception", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(reason);
    record("unhandled_rejection", reason);
    process.exit(1);
  });
}

function sanitizeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  return `${buffer.toString("utf8")}\n[truncated at ${maxBytes} bytes]`;
}

function gitProbe(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return truncateText((result.stdout ?? "").trimEnd(), MAX_GIT_OUTPUT_BYTES);
}

function captureGitState(input: {
  repoRoot: string;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
}): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (input.branch) {
    state.branch = input.branch;
    state.branch_head_sha = gitProbe(
      ["rev-parse", input.branch],
      input.repoRoot,
    );
    state.branch_recent_commits = gitProbe(
      ["log", "--oneline", "-12", input.branch, "--"],
      input.repoRoot,
    );
    if (input.baseRef) {
      state.base_ref = input.baseRef;
      state.base_ref_sha = gitProbe(["rev-parse", input.baseRef], input.repoRoot);
      state.merge_base = gitProbe(
        ["merge-base", input.baseRef, input.branch],
        input.repoRoot,
      );
      state.diff_stat_vs_base = gitProbe(
        ["diff", "--stat", `${input.baseRef}...${input.branch}`],
        input.repoRoot,
      );
    }
  }
  if (input.worktreePath && existsSync(input.worktreePath)) {
    state.worktree_path = input.worktreePath;
    state.worktree_head_sha = gitProbe(["rev-parse", "HEAD"], input.worktreePath);
    state.worktree_status = gitProbe(
      ["status", "--porcelain"],
      input.worktreePath,
    );
  }
  return state;
}

function readFileTail(
  path: string,
  maxBytes: number,
): { text: string; sourceBytes: number; startedMidFile: boolean } {
  const size = statSync(path).size;
  const offset = Math.max(0, size - maxBytes);
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return {
    text: buffer.toString("utf8"),
    sourceBytes: size,
    startedMidFile: offset > 0,
  };
}

// Agent run logs are named `<sanitizedBranch>-<runName>.log` (see
// agentRunLogPath in the loop scripts); the same sanitization here keeps the
// prefix match aligned with how the logs were written.
function collectBranchLogTails(input: {
  repoRoot: string;
  branch?: string;
  bundleDir: string;
}): AgentLogTailRecord[] {
  if (!input.branch) return [];
  const logsDir = join(input.repoRoot, ".sandcastle", "logs");
  if (!existsSync(logsDir)) return [];
  const prefix = `${input.branch.replace(/[^a-zA-Z0-9_.-]/g, "-")}-`;
  const candidates = readdirSync(logsDir)
    .filter((name) => name.endsWith(".log") && name.startsWith(prefix))
    .map((name) => {
      const path = join(logsDir, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_LOG_FILES);

  const records: AgentLogTailRecord[] = [];
  for (const candidate of candidates) {
    const tail = readFileTail(candidate.path, MAX_LOG_TAIL_BYTES);
    const tailFile = `logtail-${candidate.name}`;
    writeFileSync(
      join(input.bundleDir, tailFile),
      tail.startedMidFile
        ? `[tail: last ${MAX_LOG_TAIL_BYTES} bytes of ${tail.sourceBytes}]\n${tail.text}`
        : tail.text,
      "utf8",
    );
    records.push({
      source_path: candidate.path,
      tail_file: tailFile,
      source_bytes: tail.sourceBytes,
      tail_bytes: Buffer.byteLength(tail.text, "utf8"),
    });
  }
  return records;
}

function writeMetricsExcerpt(input: {
  repoRoot: string;
  bundleDir: string;
  issue?: number;
  parentIssue?: number;
}): { records: number; source_path: string } | null {
  const runsPath = join(input.repoRoot, ".sandcastle", "metrics", "runs.jsonl");
  if (!existsSync(runsPath)) return null;
  const tail = readFileTail(runsPath, MAX_METRICS_SCAN_BYTES);
  const lines = tail.text.split("\n").filter((line) => line.trim().length > 0);
  // A tail that starts mid-file may begin with a partial JSON line; drop it.
  if (tail.startedMidFile) lines.shift();

  const wanted = new Set(
    [input.issue, input.parentIssue].filter(
      (value): value is number => typeof value === "number",
    ),
  );
  const matched: string[] = [];
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    if (wanted.size === 0) {
      matched.push(line);
      continue;
    }
    const issueValue = (record as { issue?: unknown }).issue;
    const parentValue = (record as { parent_issue?: unknown }).parent_issue;
    if (
      (typeof issueValue === "number" && wanted.has(issueValue)) ||
      (typeof parentValue === "number" && wanted.has(parentValue))
    ) {
      matched.push(line);
    }
  }
  const cap =
    wanted.size === 0
      ? MAX_LOOP_SCOPE_EXCERPT_RECORDS
      : MAX_METRICS_EXCERPT_RECORDS;
  const kept = matched.slice(-cap);
  writeFileSync(
    join(input.bundleDir, "metrics-excerpt.jsonl"),
    kept.length > 0 ? `${kept.join("\n")}\n` : "",
    "utf8",
  );
  return { records: kept.length, source_path: runsPath };
}
