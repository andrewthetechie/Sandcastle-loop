import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import React from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  listTuiStatusSnapshotPaths,
  tuiDir,
  type TuiStatus,
} from "./tui-status.mts";
import {
  deriveStatusView,
  deriveWorkingLogTarget,
  formatLoopSwitcherLabel,
  orderSnapshotPaths,
  pickFreshestSnapshot,
  selectAdjacentSnapshot,
  type StatusView,
  type TuiLiveness,
} from "./tui-view.mts";

// ---------------------------------------------------------------------------
// Read-only I/O helpers (never write to or signal the loop; ADR 0002/0004).
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000;
const TICK_INTERVAL_MS = 1_000;

/** Parse an atomic status snapshot at the given path. Returns null when absent or unreadable. */
function readStatusSnapshot(path: string): TuiStatus | null {
  try {
    const raw = readFileSync(path, "utf8");
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
// Multi-loop state
// ---------------------------------------------------------------------------

interface LogState {
  path: string | null;
  lines: string[];
}

interface LoopPaneState {
  status: TuiStatus | null;
  prevStatus: TuiStatus | null;
  log: LogState;
  scrollOffset: number;
}

/** Build the initial map from whatever snapshots already exist on disk. */
function buildInitialLoops(cwd: string): Map<string, LoopPaneState> {
  const loops = new Map<string, LoopPaneState>();
  for (const path of listTuiStatusSnapshotPaths(tuiDir(cwd))) {
    const status = readStatusSnapshot(path);
    if (status === null) continue;
    loops.set(path, {
      status,
      prevStatus: null,
      log: { path: null, lines: [] },
      scrollOffset: 0,
    });
  }
  return loops;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function TuiApp(props: { cwd: string }): React.ReactElement {
  const { cwd } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  const loopsRef = React.useRef<Map<string, LoopPaneState>>(buildInitialLoops(cwd));
  const [selected, setSelected] = React.useState<string | null>(() => {
    const statusMap = new Map(
      [...loopsRef.current.entries()]
        .filter((entry): entry is [string, LoopPaneState & { status: TuiStatus }] => entry[1].status !== null)
        .map(([path, loop]) => [path, loop.status]),
    );
    return pickFreshestSnapshot([...statusMap.keys()], statusMap);
  });
  const [now, setNow] = React.useState<Date>(() => new Date());
  const [tick, setTick] = React.useState(0);

  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  const updateSelectedScroll = React.useCallback((fn: (offset: number) => number) => {
    const path = selectedRef.current;
    if (path === null) return;
    const loop = loopsRef.current.get(path);
    if (!loop) return;
    const next = new Map(loopsRef.current);
    next.set(path, { ...loop, scrollOffset: fn(loop.scrollOffset) });
    loopsRef.current = next;
    setTick((t) => t + 1);
  }, []);

  const refresh = React.useCallback(() => {
    setNow(new Date());

    const paths = listTuiStatusSnapshotPaths(tuiDir(cwd));
    const next = new Map(loopsRef.current);

    for (const path of paths) {
      const status = readStatusSnapshot(path);
      if (status === null) {
        // Torn read: keep the last known state so the pane doesn't flicker.
        continue;
      }

      const existing = next.get(path) ?? {
        status: null,
        prevStatus: null,
        log: { path: null, lines: [] },
        scrollOffset: 0,
      };

      const prev = existing.status;
      const target = deriveWorkingLogTarget(prev, status);
      let log = existing.log;
      let scrollOffset = existing.scrollOffset;

      if (target.action === "clear") {
        log = { path: target.activeLogPath, lines: readLogLines(target.activeLogPath) };
        scrollOffset = 0;
      } else if (target.action === "continue") {
        log = { path: target.activeLogPath, lines: readLogLines(target.activeLogPath) };
      }
      // "freeze" (host step) keeps whatever the log pane was already showing.

      next.set(path, { status, prevStatus: prev, log, scrollOffset });
    }

    // Drop loops whose snapshot files have disappeared.
    for (const path of next.keys()) {
      if (!paths.includes(path)) next.delete(path);
    }

    loopsRef.current = next;

    setSelected((current) => {
      if (current !== null && next.has(current)) return current;
      const statusMap = new Map(
        [...next.entries()]
          .filter((entry): entry is [string, LoopPaneState & { status: TuiStatus }] => entry[1].status !== null)
          .map(([path, loop]) => [path, loop.status]),
      );
      return pickFreshestSnapshot([...statusMap.keys()], statusMap);
    });

    setTick((t) => t + 1);
  }, [cwd]);

  React.useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_INTERVAL_MS);
    const tickTimer = setInterval(() => setNow(new Date()), TICK_INTERVAL_MS);

    let watcher: FSWatcher | null = null;
    try {
      // Recursive watch covers all status-<loopType>.json renames and logs/*.log appends.
      watcher = watch(tuiDir(cwd), { recursive: true }, () => refresh());
    } catch {
      // Some platforms lack recursive watch; the 1s poll is the safety net.
      watcher = null;
    }

    return () => {
      clearInterval(poll);
      clearInterval(tickTimer);
      if (watcher) watcher.close();
    };
  }, [cwd, refresh]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    const paths = orderSnapshotPaths([...loopsRef.current.keys()]);
    if (paths.length === 0) return;

    if (key.tab && key.shift) {
      const next = selectAdjacentSnapshot(selected, paths, -1);
      if (next !== null) setSelected(next);
      return;
    }
    if (key.tab || input === "n") {
      const next = selectAdjacentSnapshot(selected, paths, 1);
      if (next !== null) setSelected(next);
      return;
    }
    if (input === "p") {
      const next = selectAdjacentSnapshot(selected, paths, -1);
      if (next !== null) setSelected(next);
      return;
    }

    if (key.upArrow) {
      updateSelectedScroll((offset) => offset + 1);
    } else if (key.downArrow) {
      updateSelectedScroll((offset) => Math.max(0, offset - 1));
    } else if (input === "g") {
      updateSelectedScroll(() => {
        const loop = selected ? loopsRef.current.get(selected) : undefined;
        return loop?.log.lines.length ?? 0;
      });
    } else if (input === "G") {
      updateSelectedScroll(() => 0);
    }
  });

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const statusWidth = Math.max(30, Math.floor(columns * 0.4));
  const logWidth = Math.max(24, columns - statusWidth - 1);
  const paneHeight = Math.max(6, rows - 2);

  const loops = loopsRef.current;
  if (loops.size === 0) {
    return h(
      Box,
      { flexDirection: "column", padding: 1 },
      h(Text, { bold: true }, "Sandcastle Companion TUI"),
      h(
        Text,
        { dimColor: true },
        "Waiting for a loop… (no .sandcastle/tui/status*.json yet)",
      ),
      h(Text, { dimColor: true }, "Press q to quit."),
    );
  }

  const selectedPath = selected ?? [...loops.keys()][0];
  const loop = loops.get(selectedPath);
  if (!loop || loop.status === null) {
    return h(
      Box,
      { flexDirection: "column", padding: 1 },
      h(Text, { bold: true }, "Sandcastle Companion TUI"),
      h(Text, { dimColor: true }, "Reading loop snapshot…"),
      h(Text, { dimColor: true }, "Press q to quit."),
    );
  }

  const view = deriveStatusView(loop.status, now, {
    pidAlive: probePidAlive(loop.status.pid),
  });
  const target = deriveWorkingLogTarget(loop.prevStatus, loop.status);
  const frozenLabel = target.action === "freeze" ? view.stepLabel : null;

  const switcherLabel = formatLoopSwitcherLabel(
    selectedPath,
    [...loops.keys()],
    new Map(
      [...loops.entries()]
        .filter((entry): entry is [string, LoopPaneState & { status: TuiStatus }] => entry[1].status !== null)
        .map(([path, l]) => [path, l.status]),
    ),
  );
  const footer = switcherLabel
    ? `q quit · ↑/↓ scroll · g top · G bottom · tab/p/n prev/next · ${switcherLabel}`
    : "q quit · ↑/↓ scroll · g top · G bottom";

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { flexDirection: "row" },
      h(StatusPane, { view, width: statusWidth }),
      h(WorkingLogPane, {
        lines: loop.log.lines,
        logPath: loop.log.path,
        frozenLabel,
        width: logWidth,
        height: paneHeight,
        scrollOffset: loop.scrollOffset,
      }),
    ),
    h(Box, { paddingX: 1 }, h(Text, { dimColor: true }, footer)),
  );
}

const instance = render(h(TuiApp, { cwd: process.cwd() }));
await instance.waitUntilExit();
