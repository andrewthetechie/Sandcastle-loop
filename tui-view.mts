import { basename } from "node:path";
import type {
  TuiCounter,
  TuiLoopType,
  TuiPhase,
  TuiStatus,
  TuiStepKind,
  TuiTicket,
} from "./tui-status.mts";

/**
 * Liveness combines the loop's own `loopState` with freshness of its `updatedAt`
 * heartbeat and an optional `pid` probe the TUI performs:
 * - `stopped`  — clean shutdown (`loopState: "stopped"`).
 * - `running`  — heartbeat is fresh and the pid (if probed) is alive.
 * - `stale`    — heartbeat older than the stale threshold but not yet dead.
 * - `dead`     — pid probe failed, or heartbeat older than the dead threshold.
 * Elapsed freezes for every non-`running` state so a clock never runs for a loop
 * that has stopped or died.
 */
export type TuiLiveness = "running" | "stale" | "dead" | "stopped";

export const DEFAULT_STALE_THRESHOLD_MS = 8_000;
export const DEFAULT_DEAD_THRESHOLD_MS = 30_000;

/** Companion TUI keeps only a sliding window of working-log lines in memory. */
export const TUI_WORKING_LOG_MAX_LINES = 500;
/** Cap bytes read from a working log so giant agent logs cannot OOM the TUI. */
export const TUI_WORKING_LOG_MAX_READ_BYTES = 256_000;

/**
 * Keep the trailing `maxLines` of a working-log body. Empty input yields [].
 * A trailing newline is ignored so a final empty segment is not retained.
 */
export function tailTextLines(raw: string, maxLines: number): string[] {
  if (raw === "" || maxLines <= 0) return [];
  const trimmed = raw.replace(/\n$/u, "");
  if (trimmed === "") return [];
  const lines = trimmed.split("\n");
  return lines.length <= maxLines ? lines : lines.slice(-maxLines);
}

export interface DeriveStatusViewOptions {
  /** Result of a `process.kill(pid, 0)` probe. `undefined` means not probed. */
  pidAlive?: boolean;
  staleThresholdMs?: number;
  deadThresholdMs?: number;
}

export interface StatusView {
  loopType: TuiLoopType;
  loopId: string;
  phaseLabel: string;
  liveness: TuiLiveness;
  stopReason: string | null;
  stepKind: TuiStepKind;
  stepName: string;
  stepLabel: string;
  stepDetail: string | null;
  elapsedMs: number;
  elapsedFrozen: boolean;
  elapsedLabel: string;
  iterationLabel: string | null;
  roundLabel: string | null;
  extraReviewRoundLabel: string | null;
  ticket: TuiTicket | null;
  ticketLabel: string | null;
}

/**
 * Pure mapping from a snapshot + `now` to the render model for the status pane.
 * All liveness, elapsed-freeze, and label formatting lives here so it is tested
 * without Ink.
 */
export function deriveStatusView(
  status: TuiStatus,
  now: Date,
  options: DeriveStatusViewOptions = {},
): StatusView {
  const staleThreshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const deadThreshold = options.deadThresholdMs ?? DEFAULT_DEAD_THRESHOLD_MS;

  const nowMs = now.getTime();
  const startedMs = safeParse(status.step.startedAt);
  const updatedMs = safeParse(status.updatedAt);

  const liveness = deriveLiveness(status, nowMs, updatedMs, options.pidAlive, {
    staleThreshold,
    deadThreshold,
  });
  const elapsedFrozen = liveness !== "running";
  const elapsedEndMs = elapsedFrozen ? updatedMs : nowMs;
  const elapsedMs = clampNonNegative(elapsedEndMs - startedMs);

  return {
    loopType: status.loopType,
    loopId: status.loopId,
    phaseLabel: formatPhase(status.phase),
    liveness,
    stopReason: status.stopReason ?? null,
    stepKind: status.step.kind,
    stepName: status.step.name,
    stepLabel: formatStepName(status.step.name),
    stepDetail: status.step.detail ?? null,
    elapsedMs,
    elapsedFrozen,
    elapsedLabel: formatElapsed(elapsedMs),
    iterationLabel: formatCounter(status.iteration),
    roundLabel: formatCounter(status.round),
    extraReviewRoundLabel: formatCounter(status.extraReviewRound),
    ticket: status.ticket ?? null,
    ticketLabel: formatTicket(status.ticket),
  };
}

function deriveLiveness(
  status: TuiStatus,
  nowMs: number,
  updatedMs: number,
  pidAlive: boolean | undefined,
  thresholds: { staleThreshold: number; deadThreshold: number },
): TuiLiveness {
  if (status.loopState === "stopped") return "stopped";
  if (pidAlive === false) return "dead";
  const age = nowMs - updatedMs;
  if (!Number.isFinite(age)) return "running";
  if (age >= thresholds.deadThreshold) return "dead";
  if (age >= thresholds.staleThreshold) return "stale";
  return "running";
}

export type WorkingLogAction = "clear" | "continue" | "freeze";

export interface WorkingLogTarget {
  action: WorkingLogAction;
  /**
   * The file to tail for `clear`/`continue`. `null` for `freeze` (host step):
  * the TUI keeps whatever it was already tailing.
   */
  activeLogPath: string | null;
}

/**
 * Pure decision for the working-log pane given the previous and next snapshots:
 * - host step  → `freeze` (keep the last agent log, do not retarget).
 * - new agent step (first snapshot, after a host step, or a different log path)
 *   → `clear` and retarget.
 * - same agent step (heartbeat rewrite with the same log path) → `continue`.
 */
export function deriveWorkingLogTarget(
  prev: TuiStatus | null,
  next: TuiStatus,
): WorkingLogTarget {
  if (next.step.kind !== "agent") {
    return { action: "freeze", activeLogPath: null };
  }
  const nextPath = next.step.activeLogPath ?? null;
  const sameStep =
    prev !== null &&
    prev.step.kind === "agent" &&
    (prev.step.activeLogPath ?? null) === nextPath;
  return { action: sameStep ? "continue" : "clear", activeLogPath: nextPath };
}

function formatPhase(phase: TuiPhase): string {
  switch (phase) {
    case "normal_issue":
      return "normal issue";
    case "extra_review":
      return "extra review";
    case "escalation":
      return "escalation";
    default:
      return phase;
  }
}

function formatStepName(name: string): string {
  return name.replace(/_/gu, " ");
}

function formatCounter(counter: TuiCounter | undefined): string | null {
  if (counter === undefined) return null;
  return `${counter.current}/${counter.max}`;
}

function formatTicket(ticket: TuiTicket | undefined): string | null {
  if (ticket === undefined) return null;
  return `#${ticket.number} ${ticket.title}`.trim();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(clampNonNegative(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

// ---------------------------------------------------------------------------
// Multi-snapshot discovery / selection (TUI can observe several loops at once)
// ---------------------------------------------------------------------------

/** Stable order for cycling through loop snapshots: by filename. */
export function orderSnapshotPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => basename(a).localeCompare(basename(b)));
}

/** Pick the snapshot with the most recent `updatedAt`. Ties fall back to filename order. */
export function pickFreshestSnapshot(
  paths: string[],
  statuses: ReadonlyMap<string, TuiStatus>,
): string | null {
  let best: string | null = null;
  let bestUpdated = -Infinity;
  for (const path of paths) {
    const status = statuses.get(path);
    if (!status) continue;
    const updated = safeParse(status.updatedAt);
    if (updated === 0) continue;
    if (updated > bestUpdated) {
      bestUpdated = updated;
      best = path;
    } else if (updated === bestUpdated && best !== null && path < best) {
      best = path;
    }
  }
  return best;
}

/** Cycle to the next/previous snapshot in stable filename order. */
export function selectAdjacentSnapshot(
  current: string | null,
  paths: string[],
  direction: 1 | -1,
): string | null {
  if (paths.length === 0) return null;
  const ordered = orderSnapshotPaths(paths);
  if (current === null) return ordered[0];
  const idx = ordered.indexOf(current);
  if (idx === -1) return ordered[0];
  const nextIdx = (idx + direction + ordered.length) % ordered.length;
  return ordered[nextIdx];
}

/** Human-readable loop switcher label, e.g. "loop 2/3 · backlog · tab switch". */
export function formatLoopSwitcherLabel(
  selectedPath: string | null,
  paths: string[],
  statuses: ReadonlyMap<string, TuiStatus>,
): string | null {
  if (paths.length <= 1) return null;
  const ordered = orderSnapshotPaths(paths);
  const selected = selectedPath ?? ordered[0];
  const index = ordered.indexOf(selected);
  const status = statuses.get(selected);
  const loopType = status?.loopType ?? "loop";
  return `loop ${index + 1}/${ordered.length} · ${loopType} · tab switch`;
}

function safeParse(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
