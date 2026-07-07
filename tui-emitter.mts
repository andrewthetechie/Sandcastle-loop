import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatWorkingLogLines } from "./tui-working-log.mts";
import {
  buildTuiStatus,
  tuiDir,
  writeStatusSnapshotAtomic,
  type TuiCounter,
  type TuiLoopType,
  type TuiPhase,
  type TuiStatus,
  type TuiStatusContext,
  type TuiStep,
  type TuiTicket,
} from "./tui-status.mts";

/** How often the emitter refreshes `updatedAt` so a long step still looks alive. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;

export interface StartLoopInput {
  loopType: TuiLoopType;
  loopId: string;
  pid?: number;
  loopStartedAt?: string;
  phase?: TuiPhase;
}

export interface BeginAgentStepInput {
  stage: string;
  agent?: string;
  model?: string;
  worktreePath?: string;
  activeLogPath?: string;
}

export interface TuiEmitterOptions {
  cwd?: string;
  writeSnapshot?: (dir: string, status: TuiStatus) => void;
  truncateLog?: (path: string) => void;
  appendLog?: (path: string, text: string) => void;
  now?: () => Date;
  heartbeatIntervalMs?: number;
}

type IntervalHandle = ReturnType<typeof setInterval>;

/**
 * Side-effect-only emitter that owns the TUI status snapshot and per-agent-step
 * working logs. It is the single loop-side seam for the Companion TUI.
 *
 * Contract guarantees:
 * - Nothing is written until `startLoop()` runs, so other runners that merely
 *   import the shared chokepoint (`recordMeasuredAgentRun`) never emit.
 * - Every filesystem write is wrapped so a failure is swallowed and can never
 *   propagate into loop control flow (PRD user stories 33/34, ADR 0002/0003).
 */
export class TuiEmitter {
  private readonly cwd: string;
  private readonly writeSnapshot: (dir: string, status: TuiStatus) => void;
  private readonly truncateLog: (path: string) => void;
  private readonly appendLog: (path: string, text: string) => void;
  private readonly now: () => Date;
  private readonly heartbeatIntervalMs: number;

  private started = false;
  private context: TuiStatusContext | null = null;
  private currentStep: TuiStep | null = null;
  private heartbeatTimer: IntervalHandle | null = null;

  constructor(options: TuiEmitterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.writeSnapshot = options.writeSnapshot ?? defaultWriteSnapshot;
    this.truncateLog = options.truncateLog ?? defaultTruncateLog;
    this.appendLog = options.appendLog ?? defaultAppendLog;
    this.now = options.now ?? (() => new Date());
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /** Begin emitting for a loop. Idempotent-safe: a second call re-seeds context. */
  startLoop(input: StartLoopInput): void {
    this.clearHeartbeat();
    this.context = {
      loopType: input.loopType,
      loopId: input.loopId,
      pid: input.pid ?? process.pid,
      loopStartedAt: input.loopStartedAt ?? this.now().toISOString(),
      loopState: "running",
      phase: input.phase ?? "normal_issue",
    };
    this.currentStep = {
      kind: "host",
      name: "startup",
      startedAt: this.now().toISOString(),
    };
    this.started = true;
    this.write();
    this.startHeartbeat();
  }

  setPhase(phase: TuiPhase): void {
    this.mutate((context) => {
      context.phase = phase;
    });
  }

  setIteration(iteration: TuiCounter | undefined): void {
    this.mutate((context) => {
      context.iteration = iteration;
    });
  }

  setRound(round: TuiCounter | undefined): void {
    this.mutate((context) => {
      context.round = round;
    });
  }

  setExtraReviewRound(round: TuiCounter | undefined): void {
    this.mutate((context) => {
      context.extraReviewRound = round;
    });
  }

  setTicket(ticket: TuiTicket | undefined): void {
    this.mutate((context) => {
      context.ticket = ticket;
    });
  }

  clearTicket(): void {
    this.mutate((context) => {
      context.ticket = undefined;
      context.round = undefined;
    });
  }

  /** Mark a host step (no agent, no working log). */
  beginHostStep(name: string, detail?: string): void {
    if (!this.started) return;
    const step: TuiStep = {
      kind: "host",
      name,
      startedAt: this.now().toISOString(),
    };
    if (detail !== undefined) step.detail = detail;
    this.currentStep = step;
    this.write();
  }

  /**
   * Mark an agent step and open a fresh working log for it. Returns the resolved
   * working-log path (or undefined when not started) so callers can pair it with
   * `workingLogSink`.
   */
  beginAgentStep(input: BeginAgentStepInput): string | undefined {
    if (!this.started) return undefined;
    const step: TuiStep = {
      kind: "agent",
      name: input.stage,
      startedAt: this.now().toISOString(),
    };
    if (input.model !== undefined) step.detail = input.model;
    if (input.activeLogPath !== undefined) {
      step.activeLogPath = input.activeLogPath;
      this.safe(() => this.truncateLog(input.activeLogPath as string));
    }
    this.currentStep = step;
    this.write();
    return input.activeLogPath;
  }

  /**
   * Build an `onAgentStreamEvent`-shaped sink that appends formatted working-log
   * lines for the given path. Returns a no-op when not started or when no path is
   * supplied. Never throws.
   */
  workingLogSink(activeLogPath: string | undefined): (event: unknown) => void {
    if (!this.started || activeLogPath === undefined) {
      return () => {};
    }
    return (event: unknown) => {
      const lines = formatWorkingLogLines(event);
      if (lines.length === 0) return;
      this.safe(() => this.appendLog(activeLogPath, `${lines.join("\n")}\n`));
    };
  }

  /** Write a terminal snapshot with the clean stop reason and stop the heartbeat. */
  stop(reason?: string): void {
    if (!this.started || this.context === null) return;
    this.context.loopState = "stopped";
    if (reason !== undefined) this.context.stopReason = reason;
    this.write();
    this.clearHeartbeat();
  }

  private mutate(apply: (context: TuiStatusContext) => void): void {
    if (!this.started || this.context === null) return;
    apply(this.context);
    this.write();
  }

  private write(): void {
    if (this.context === null || this.currentStep === null) return;
    const context = this.context;
    const step = this.currentStep;
    this.safe(() => {
      const status = buildTuiStatus(context, step, this.now());
      this.writeSnapshot(tuiDir(this.cwd), status);
    });
  }

  private startHeartbeat(): void {
    const timer = setInterval(() => this.write(), this.heartbeatIntervalMs);
    // Never keep the loop process alive on the emitter's account.
    if (typeof timer.unref === "function") timer.unref();
    this.heartbeatTimer = timer;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Observability must never fail the loop.
    }
  }
}

function defaultWriteSnapshot(dir: string, status: TuiStatus): void {
  writeStatusSnapshotAtomic(dir, status);
}

function defaultTruncateLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
}

function defaultAppendLog(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text, "utf8");
}

/** Process-wide singleton the loops and the agent-run chokepoint share. */
export const tuiEmitter = new TuiEmitter();
