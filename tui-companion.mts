import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import React from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  tuiDir,
  tuiStatusPath,
  type TuiStatus,
} from "./tui-status.mts";
import {
  deriveStatusView,
  deriveWorkingLogTarget,
  type StatusView,
  type TuiLiveness,
} from "./tui-view.mts";

// ---------------------------------------------------------------------------
// Read-only I/O helpers (never write to or signal the loop; ADR 0002/0003).
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000;
const TICK_INTERVAL_MS = 1_000;

/** Parse the atomic status snapshot. Returns null when absent or unreadable. */
function readStatusSnapshot(cwd: string): TuiStatus | null {
  try {
    const raw = readFileSync(tuiStatusPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as TuiStatus;
    if (parsed && typeof parsed === "object" && parsed.step) return parsed;
    return null;
  } catch {
    // Absent file or a torn read between rename cycles — the next poll recovers.
    return null;
  }
}

/** Read a working-log file into lines. Missing file → empty. Never throws. */
function readLogLines(path: string | null): string[] {
  if (path === null) return [];
  try {
    const raw = readFileSync(path, "utf8");
    if (raw === "") return [];
    return raw.replace(/\n$/u, "").split("\n");
  } catch {
    return [];
  }
}

/**
 * Best-effort liveness probe with signal 0. `EPERM` means the process exists but
 * is owned by another user, which still counts as alive.
 */
function probePidAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

const h = React.createElement;

const LIVENESS_COLOR: Record<TuiLiveness, string> = {
  running: "green",
  stale: "yellow",
  dead: "red",
  stopped: "cyan",
};

const LIVENESS_LABEL: Record<TuiLiveness, string> = {
  running: "● running",
  stale: "◐ stale",
  dead: "✗ dead",
  stopped: "■ stopped",
};

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function labelledLine(label: string, value: string): React.ReactNode {
  return h(
    Box,
    { key: label },
    h(Text, { dimColor: true }, `${label.padEnd(9)} `),
    h(Text, null, value),
  );
}

function StatusPane(props: {
  view: StatusView;
  width: number;
}): React.ReactElement {
  const { view, width } = props;
  const rows: React.ReactNode[] = [];

  rows.push(
    h(
      Box,
      { key: "title" },
      h(
        Text,
        { bold: true },
        `${view.loopType.toUpperCase()} loop `,
      ),
      h(Text, { color: LIVENESS_COLOR[view.liveness] }, LIVENESS_LABEL[view.liveness]),
    ),
  );
  rows.push(h(Text, { key: "loopId", dimColor: true }, view.loopId));
  rows.push(h(Box, { key: "spacer-1" }));

  rows.push(labelledLine("phase", view.phaseLabel));

  const stepValue = view.stepDetail
    ? `${view.stepLabel} — ${view.stepDetail}`
    : view.stepLabel;
  rows.push(
    h(
      Box,
      { key: "step" },
      h(Text, { dimColor: true }, "step      "),
      h(
        Text,
        { color: view.stepKind === "agent" ? "magenta" : "blue" },
        `${view.stepKind === "agent" ? "▸" : "▪"} ${stepValue}`,
      ),
    ),
  );
  rows.push(
    labelledLine(
      "elapsed",
      view.elapsedFrozen ? `${view.elapsedLabel} (frozen)` : view.elapsedLabel,
    ),
  );

  if (view.iterationLabel) rows.push(labelledLine("iter", view.iterationLabel));
  if (view.roundLabel) rows.push(labelledLine("round", view.roundLabel));
  if (view.extraReviewRoundLabel) {
    rows.push(labelledLine("xreview", view.extraReviewRoundLabel));
  }

  if (view.ticket) {
    rows.push(h(Box, { key: "spacer-2" }));
    rows.push(h(Text, { key: "ticket", bold: true }, view.ticketLabel ?? ""));
    rows.push(h(Text, { key: "branch", dimColor: true }, view.ticket.branch));
  }

  if (view.stopReason) {
    rows.push(h(Box, { key: "spacer-3" }));
    rows.push(
      h(Text, { key: "stop", color: "cyan" }, `stopped: ${view.stopReason}`),
    );
  }

  return h(
    Box,
    {
      flexDirection: "column",
      width,
      paddingX: 1,
      borderStyle: "round",
      borderColor: LIVENESS_COLOR[view.liveness],
    },
    ...rows,
  );
}

function WorkingLogPane(props: {
  lines: string[];
  logPath: string | null;
  frozenLabel: string | null;
  width: number;
  height: number;
  scrollOffset: number;
}): React.ReactElement {
  const { lines, logPath, frozenLabel, width, height, scrollOffset } = props;
  const bodyHeight = Math.max(1, height - 2);
  const end = Math.max(0, lines.length - scrollOffset);
  const start = Math.max(0, end - bodyHeight);
  const visible = lines.slice(start, end);

  const header = frozenLabel
    ? `working log — host step: ${frozenLabel} (frozen)`
    : `working log${logPath ? ` — ${basename(logPath)}` : ""}`;

  const body: React.ReactNode[] =
    visible.length === 0
      ? [h(Text, { key: "empty", dimColor: true }, "(waiting for agent output…)")]
      : visible.map((line, index) =>
          h(Text, { key: `${start + index}`, wrap: "truncate-end" }, line),
        );

  return h(
    Box,
    {
      flexDirection: "column",
      width,
      paddingX: 1,
      borderStyle: "round",
      borderColor: frozenLabel ? "gray" : "white",
    },
    h(Text, { color: frozenLabel ? "gray" : "white", bold: true }, header),
    h(Box, { flexDirection: "column", height: bodyHeight }, ...body),
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

interface LogState {
  path: string | null;
  lines: string[];
}

function TuiApp(props: { cwd: string }): React.ReactElement {
  const { cwd } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [status, setStatus] = React.useState<TuiStatus | null>(() =>
    readStatusSnapshot(cwd),
  );
  const [now, setNow] = React.useState<Date>(() => new Date());
  const [log, setLog] = React.useState<LogState>({ path: null, lines: [] });
  const [scrollOffset, setScrollOffset] = React.useState(0);

  const prevStatusRef = React.useRef<TuiStatus | null>(null);
  const logRef = React.useRef<LogState>(log);
  logRef.current = log;

  const refresh = React.useCallback(() => {
    const next = readStatusSnapshot(cwd);
    setNow(new Date());
    if (next === null) {
      setStatus(null);
      prevStatusRef.current = null;
      return;
    }

    const target = deriveWorkingLogTarget(prevStatusRef.current, next);
    if (target.action === "clear") {
      setLog({ path: target.activeLogPath, lines: readLogLines(target.activeLogPath) });
      setScrollOffset(0);
    } else if (target.action === "continue") {
      setLog({
        path: target.activeLogPath,
        lines: readLogLines(target.activeLogPath),
      });
    }
    // "freeze" (host step) keeps whatever the log pane was already showing.

    prevStatusRef.current = next;
    setStatus(next);
  }, [cwd]);

  React.useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_INTERVAL_MS);
    const tick = setInterval(() => setNow(new Date()), TICK_INTERVAL_MS);

    let watcher: FSWatcher | null = null;
    try {
      // Recursive watch covers both status.json (rename) and logs/*.log appends.
      watcher = watch(tuiDir(cwd), { recursive: true }, () => refresh());
    } catch {
      // Some platforms lack recursive watch; the 1s poll is the safety net.
      watcher = null;
    }

    return () => {
      clearInterval(poll);
      clearInterval(tick);
      if (watcher) watcher.close();
    };
  }, [cwd, refresh]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow) {
      setScrollOffset((offset) => offset + 1);
    } else if (key.downArrow) {
      setScrollOffset((offset) => Math.max(0, offset - 1));
    } else if (input === "g") {
      setScrollOffset(logRef.current.lines.length);
    } else if (input === "G") {
      setScrollOffset(0);
    }
  });

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const statusWidth = Math.max(30, Math.floor(columns * 0.4));
  const logWidth = Math.max(24, columns - statusWidth - 1);
  const paneHeight = Math.max(6, rows - 2);

  if (status === null) {
    return h(
      Box,
      { flexDirection: "column", padding: 1 },
      h(Text, { bold: true }, "Sandcastle Companion TUI"),
      h(
        Text,
        { dimColor: true },
        "Waiting for a loop… (no .sandcastle/tui/status.json yet)",
      ),
      h(Text, { dimColor: true }, "Press q to quit."),
    );
  }

  const view = deriveStatusView(status, now, {
    pidAlive: probePidAlive(status.pid),
  });
  const target = deriveWorkingLogTarget(prevStatusRef.current, status);
  const frozenLabel = target.action === "freeze" ? view.stepLabel : null;

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { flexDirection: "row" },
      h(StatusPane, { view, width: statusWidth }),
      h(WorkingLogPane, {
        lines: log.lines,
        logPath: log.path,
        frozenLabel,
        width: logWidth,
        height: paneHeight,
        scrollOffset,
      }),
    ),
    h(
      Box,
      { paddingX: 1 },
      h(
        Text,
        { dimColor: true },
        "q quit · ↑/↓ scroll · g top · G bottom",
      ),
    ),
  );
}

const instance = render(h(TuiApp, { cwd: process.cwd() }));
await instance.waitUntilExit();
