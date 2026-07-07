import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tuiEmitter } from "./tui-emitter.mts";

export interface MeasuredAgentRunMetadata {
  prd: number | string;
  issue?: number;
  stage: string;
  agent: string;
  round: number | string;
  model: string;
  runName: string;
  worktreePath?: string;
  promptFile?: string;
  promptArgs?: Record<string, string>;
  /**
   * Loop-owned working-log file for this agent step (Companion TUI). When set,
   * the agent-step snapshot points the TUI at this file. Undefined for callers
   * that do not run the TUI-instrumented loops.
   */
  activeLogPath?: string;
}

/**
 * The agent-step chokepoint reports a single Companion-TUI agent step per run.
 * Injectable so tests can assert it fires exactly once without the singleton or
 * a real sandbox; defaults to the shared emitter (a no-op until `startLoop`).
 */
export interface RecordMeasuredAgentRunDeps {
  beginAgentStep?: (input: {
    stage: string;
    agent?: string;
    model?: string;
    worktreePath?: string;
    activeLogPath?: string;
  }) => void;
}

export interface MeasuredAgentRunResult {
  runId: string;
  startedMs: number;
  endedMs: number;
  status: "success" | "error";
  error?: string;
}

export function buildMeasuredAgentRunRecord(
  metadata: MeasuredAgentRunMetadata,
  result: MeasuredAgentRunResult,
): Record<string, unknown> {
  return {
    kind: "sandcastle_agent_run",
    schema_version: 1,
    run_id: result.runId,
    prd: metadata.prd,
    issue: metadata.issue,
    stage: metadata.stage,
    agent: metadata.agent,
    round: metadata.round,
    model: metadata.model,
    run_name: metadata.runName,
    worktree_path: metadata.worktreePath,
    prompt_file: metadata.promptFile,
    prompt_arg_keys: metadata.promptArgs
      ? Object.keys(metadata.promptArgs).sort()
      : undefined,
    status: result.status,
    error: result.error,
    started_at: new Date(result.startedMs).toISOString(),
    ended_at: new Date(result.endedMs).toISOString(),
    started_ms: result.startedMs,
    ended_ms: result.endedMs,
    elapsed_ms: result.endedMs - result.startedMs,
  };
}

export async function recordMeasuredAgentRun<T>(
  metadata: MeasuredAgentRunMetadata,
  run: () => Promise<T>,
  deps: RecordMeasuredAgentRunDeps = {},
): Promise<T> {
  const beginAgentStep =
    deps.beginAgentStep ?? ((input) => tuiEmitter.beginAgentStep(input));
  // Report the Companion-TUI agent step once, at the single seam both loops route
  // every agent run through. Emission is a no-op until a loop calls startLoop().
  beginAgentStep({
    stage: metadata.stage,
    agent: metadata.agent,
    model: metadata.model,
    worktreePath: metadata.worktreePath,
    activeLogPath: metadata.activeLogPath,
  });

  const startedAt = new Date();
  const startedMs = startedAt.getTime();
  const runId = [
    "run",
    metadata.prd,
    metadata.issue ?? "prd",
    metadata.stage,
    metadata.round,
    startedMs,
    Math.random().toString(36).slice(2, 10),
  ].join("-");

  try {
    const result = await run();
    writeMetricRecord(metadata, {
      runId,
      startedAt,
      startedMs,
      status: "success",
    });
    return result;
  } catch (err) {
    writeMetricRecord(metadata, {
      runId,
      startedAt,
      startedMs,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function writeMetricRecord(
  metadata: MeasuredAgentRunMetadata,
  result: {
    runId: string;
    startedAt: Date;
    startedMs: number;
    status: "success" | "error";
    error?: string;
  },
): void {
  const endedMs = Date.now();
  appendMetricRecord(
    buildMeasuredAgentRunRecord(metadata, {
      runId: result.runId,
      startedMs: result.startedMs,
      endedMs,
      status: result.status,
      error: result.error,
    }),
  );
}

function appendMetricRecord(record: Record<string, unknown>): void {
  const metricsDir = join(process.cwd(), ".sandcastle", "metrics");
  mkdirSync(metricsDir, { recursive: true });
  appendFileSync(
    join(metricsDir, "runs.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

export interface ValidationRunMetadata {
  prd: number | string;
  issue?: number;
  round: number | string;
  gate: "issue" | "base";
  command: string;
  commandIndex: number;
}

export interface ValidationRunResult {
  startedMs: number;
  endedMs: number;
  status: "success" | "failed";
  exitCode: number | null;
}

export function buildValidationRunRecord(
  metadata: ValidationRunMetadata,
  result: ValidationRunResult,
): Record<string, unknown> {
  return {
    kind: "sandcastle_validation_run",
    schema_version: 1,
    prd: metadata.prd,
    issue: metadata.issue,
    round: metadata.round,
    gate: metadata.gate,
    command: metadata.command,
    command_index: metadata.commandIndex,
    status: result.status,
    exit_code: result.exitCode,
    started_ms: result.startedMs,
    ended_ms: result.endedMs,
    elapsed_ms: result.endedMs - result.startedMs,
    started_at: new Date(result.startedMs).toISOString(),
    ended_at: new Date(result.endedMs).toISOString(),
  };
}

export function recordValidationRun(
  metadata: ValidationRunMetadata,
  result: ValidationRunResult,
): void {
  appendMetricRecord(buildValidationRunRecord(metadata, result));
}

export interface IssueOutcomeMetadata {
  prd: number | string;
  issue: number;
  outcome:
    | "merged"
    | "review_ready"
    | "already_satisfied"
    | "stuck_rounds_exhausted"
    | "stuck_no_progress"
    | "stuck_reviewer_parse_failure"
    | "stuck_reviewer_incomplete"
    | "stuck_needs_human_review"
    | "stuck_livelock"
    | "stuck_rebase_conflict"
    | "blocked"
    | "crashed";
  roundsUsed: number;
}

export function buildIssueOutcomeRecord(
  metadata: IssueOutcomeMetadata,
): Record<string, unknown> {
  return {
    kind: "sandcastle_issue_outcome",
    schema_version: 1,
    prd: metadata.prd,
    issue: metadata.issue,
    outcome: metadata.outcome,
    rounds_used: metadata.roundsUsed,
    recorded_at: new Date().toISOString(),
  };
}

export function recordIssueOutcome(metadata: IssueOutcomeMetadata): void {
  appendMetricRecord(buildIssueOutcomeRecord(metadata));
}

export interface ReviewerResultMetadata {
  prd: number | string;
  issue: number;
  round: number;
  attempt: number;
  maxAttempts: number;
  status:
    | "approved"
    | "changes_requested"
    | "needs_human_review"
    | "parse_failed"
    | "incomplete";
  resultSource: "stdout" | "run_log" | "none";
  logFallbackUsed: boolean;
  logFilePath?: string;
  parseFailureCode?: string;
}

export function buildReviewerResultRecord(
  metadata: ReviewerResultMetadata,
): Record<string, unknown> {
  return {
    kind: "sandcastle_reviewer_result",
    schema_version: 1,
    prd: metadata.prd,
    issue: metadata.issue,
    round: metadata.round,
    attempt: metadata.attempt,
    max_attempts: metadata.maxAttempts,
    status: metadata.status,
    result_source: metadata.resultSource,
    log_fallback_used: metadata.logFallbackUsed,
    parse_failure_code: metadata.parseFailureCode,
    log_file_path: metadata.logFilePath,
    recorded_at: new Date().toISOString(),
  };
}

export function recordReviewerResult(metadata: ReviewerResultMetadata): void {
  appendMetricRecord(buildReviewerResultRecord(metadata));
}
