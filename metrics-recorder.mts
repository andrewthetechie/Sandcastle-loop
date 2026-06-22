import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
): Promise<T> {
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
    | "already_satisfied"
    | "stuck_rounds_exhausted"
    | "stuck_no_progress"
    | "stuck_livelock"
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
