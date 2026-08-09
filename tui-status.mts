import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The status snapshot is the single contract between the loop-side emitter and
 * the read-only Companion TUI (ADR 0002). It is written atomically at every step
 * transition to `.sandcastle/tui/status.json`. Keep this shape in exact sync
 * with the PRD; both writer and reader import it so they cannot drift.
 */
export const TUI_STATUS_SCHEMA_VERSION = 1 as const;

export type TuiLoopType = "prd" | "backlog" | "pr-review";

/** `escalation` is reserved for future runners; neither v4 nor backlog emit it.
    `pr_review` is for run-pr-review-v1. */
export type TuiPhase = "normal_issue" | "extra_review" | "escalation" | "pr_review";

export type TuiLoopState = "running" | "stopped";

export type TuiStepKind = "agent" | "host";

export interface TuiCounter {
  current: number;
  max: number;
}

export interface TuiTicket {
  number: number;
  title: string;
  branch: string;
  labels?: string[];
}

export interface TuiStep {
  kind: TuiStepKind;
  /**
   * agent: coder | rework | reviewer | initial_issue_decomposer
   *        | subtask_readiness | code_quality | two_axis
   *        | issue_decomposer | escalation_review
   * host:  startup | sandbox_setup | validation | branch_prep | merge
   *        | parent_claim | child_publication | readiness_apply
   *        | child_integration | pre_review_refresh
   *        | aggregate_validation | full_parent_review
   *        | deliver_review_ready | base_validation
   */
  name: string;
  /** ISO timestamp; elapsed is derived as now - startedAt. */
  startedAt: string;
  /** agent: the model; validation: the command. */
  detail?: string;
  /** agent steps only: the loop-owned working log for this step. */
  activeLogPath?: string;
}

export interface TuiStatus {
  schemaVersion: typeof TUI_STATUS_SCHEMA_VERSION;
  loopType: TuiLoopType;
  loopId: string;
  pid: number;
  loopStartedAt: string;
  updatedAt: string;
  loopState: TuiLoopState;
  stopReason?: string;
  phase: TuiPhase;
  iteration?: TuiCounter;
  extraReviewRound?: TuiCounter;
  round?: TuiCounter;
  ticket?: TuiTicket;
  step: TuiStep;
}

/**
 * The loop-level context the emitter accumulates from coarse setters. Combined
 * with the current `TuiStep` and a `now` timestamp it yields a full `TuiStatus`.
 */
export interface TuiStatusContext {
  loopType: TuiLoopType;
  loopId: string;
  pid: number;
  loopStartedAt: string;
  loopState: TuiLoopState;
  stopReason?: string;
  phase: TuiPhase;
  iteration?: TuiCounter;
  extraReviewRound?: TuiCounter;
  round?: TuiCounter;
  ticket?: TuiTicket;
}

/**
 * Pure builder mirroring `buildMeasuredAgentRunRecord`: it copies the context and
 * step, stamps `updatedAt` from `now`, and omits optional fields that are absent
 * so the emitted JSON stays minimal.
 */
export function buildTuiStatus(
  context: TuiStatusContext,
  step: TuiStep,
  now: Date,
): TuiStatus {
  const status: TuiStatus = {
    schemaVersion: TUI_STATUS_SCHEMA_VERSION,
    loopType: context.loopType,
    loopId: context.loopId,
    pid: context.pid,
    loopStartedAt: context.loopStartedAt,
    updatedAt: now.toISOString(),
    loopState: context.loopState,
    phase: context.phase,
    step: normalizeStep(step),
  };
  if (context.stopReason !== undefined) status.stopReason = context.stopReason;
  if (context.iteration !== undefined) status.iteration = context.iteration;
  if (context.extraReviewRound !== undefined) {
    status.extraReviewRound = context.extraReviewRound;
  }
  if (context.round !== undefined) status.round = context.round;
  if (context.ticket !== undefined) status.ticket = context.ticket;
  return status;
}

function normalizeStep(step: TuiStep): TuiStep {
  const normalized: TuiStep = {
    kind: step.kind,
    name: step.name,
    startedAt: step.startedAt,
  };
  if (step.detail !== undefined) normalized.detail = step.detail;
  if (step.activeLogPath !== undefined) {
    normalized.activeLogPath = step.activeLogPath;
  }
  return normalized;
}

export const TUI_DIR_SEGMENTS = [".sandcastle", "tui"] as const;

/** Absolute path to the TUI artifact directory for a repo root. */
export function tuiDir(cwd: string = process.cwd()): string {
  return join(cwd, ...TUI_DIR_SEGMENTS);
}

/** Absolute path to the single status snapshot. */
export function tuiStatusPath(cwd: string = process.cwd()): string {
  return join(tuiDir(cwd), "status.json");
}

/** Absolute path to the per-agent-step working log for a given run name. */
export function tuiWorkingLogPath(
  runName: string,
  cwd: string = process.cwd(),
): string {
  return join(tuiDir(cwd), "logs", `${sanitizeRunName(runName)}.log`);
}

function sanitizeRunName(runName: string): string {
  const cleaned = runName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

/**
 * Write `status.json` atomically: serialize to a unique temp file in the same
 * directory, then `renameSync` over the target. A concurrent reader therefore
 * observes either the old file or the complete new file, never a partial write.
 */
export function writeStatusSnapshotAtomic(dir: string, status: TuiStatus): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "status.json");
  const tmp = join(
    dir,
    `.status.json.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}
