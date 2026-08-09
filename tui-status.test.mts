import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTuiStatus,
  listTuiStatusSnapshotPaths,
  parseTuiStatusFileName,
  tuiLegacyStatusPath,
  tuiStatusFileName,
  tuiStatusPath,
  tuiWorkingLogPath,
  writeStatusSnapshotAtomic,
  type TuiStatus,
  type TuiStatusContext,
  type TuiStep,
} from "./tui-status.mts";

const baseContext: TuiStatusContext = {
  loopType: "prd",
  loopId: "prd-004",
  pid: 4242,
  loopStartedAt: "2026-07-02T10:00:00.000Z",
  loopState: "running",
  phase: "normal_issue",
};

const agentStep: TuiStep = {
  kind: "agent",
  name: "coder",
  startedAt: "2026-07-02T10:05:00.000Z",
  detail: "anthropic/claude-sonnet-4-5",
  activeLogPath: "/repo/.sandcastle/tui/logs/coder.log",
};

test("buildTuiStatus copies context and step and stamps updatedAt from now", () => {
  const now = new Date("2026-07-02T10:05:30.000Z");
  const status = buildTuiStatus(
    {
      ...baseContext,
      iteration: { current: 2, max: 40 },
      round: { current: 1, max: 5 },
      ticket: { number: 7, title: "Add widget", branch: "prd-004-issue-7" },
    },
    agentStep,
    now,
  );

  assert.equal(status.schemaVersion, 1);
  assert.equal(status.loopType, "prd");
  assert.equal(status.loopId, "prd-004");
  assert.equal(status.pid, 4242);
  assert.equal(status.loopStartedAt, "2026-07-02T10:00:00.000Z");
  assert.equal(status.updatedAt, "2026-07-02T10:05:30.000Z");
  assert.equal(status.loopState, "running");
  assert.equal(status.phase, "normal_issue");
  assert.deepEqual(status.iteration, { current: 2, max: 40 });
  assert.deepEqual(status.round, { current: 1, max: 5 });
  assert.deepEqual(status.ticket, {
    number: 7,
    title: "Add widget",
    branch: "prd-004-issue-7",
  });
  assert.deepEqual(status.step, agentStep);
});

test("buildTuiStatus omits optional fields that are absent", () => {
  const status = buildTuiStatus(
    baseContext,
    { kind: "host", name: "validation", startedAt: "2026-07-02T10:06:00.000Z" },
    new Date("2026-07-02T10:06:01.000Z"),
  );

  assert.equal("iteration" in status, false);
  assert.equal("round" in status, false);
  assert.equal("extraReviewRound" in status, false);
  assert.equal("ticket" in status, false);
  assert.equal("stopReason" in status, false);
  assert.equal("detail" in status.step, false);
  assert.equal("activeLogPath" in status.step, false);
});

test("buildTuiStatus carries stopReason and extraReviewRound when present", () => {
  const status = buildTuiStatus(
    {
      ...baseContext,
      loopState: "stopped",
      stopReason: "queue clean",
      phase: "extra_review",
      extraReviewRound: { current: 1, max: 3 },
    },
    { kind: "host", name: "merge", startedAt: "2026-07-02T11:00:00.000Z" },
    new Date("2026-07-02T11:00:05.000Z"),
  );

  assert.equal(status.loopState, "stopped");
  assert.equal(status.stopReason, "queue clean");
  assert.equal(status.phase, "extra_review");
  assert.deepEqual(status.extraReviewRound, { current: 1, max: 3 });
});

test("writeStatusSnapshotAtomic yields a complete, parseable status-<loopType>.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-status-"));
  try {
    const status = buildTuiStatus(
      baseContext,
      agentStep,
      new Date("2026-07-02T10:05:30.000Z"),
    );
    writeStatusSnapshotAtomic(dir, status);

    const raw = readFileSync(join(dir, "status-prd.json"), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    const parsed = JSON.parse(raw) as TuiStatus;
    assert.deepEqual(parsed, status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusSnapshotAtomic overwrites the previous snapshot in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-status-"));
  try {
    const first = buildTuiStatus(
      baseContext,
      { kind: "host", name: "sandbox_setup", startedAt: "2026-07-02T10:01:00.000Z" },
      new Date("2026-07-02T10:01:01.000Z"),
    );
    const second = buildTuiStatus(
      baseContext,
      agentStep,
      new Date("2026-07-02T10:05:30.000Z"),
    );
    writeStatusSnapshotAtomic(dir, first);
    writeStatusSnapshotAtomic(dir, second);

    const parsed = JSON.parse(
      readFileSync(join(dir, "status-prd.json"), "utf8"),
    ) as TuiStatus;
    assert.deepEqual(parsed, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path helpers resolve under .sandcastle/tui and sanitize run names", () => {
  assert.equal(
    tuiStatusFileName("backlog"),
    "status-backlog.json",
  );
  assert.equal(
    tuiStatusPath("pr-review", "/repo"),
    "/repo/.sandcastle/tui/status-pr-review.json",
  );
  assert.equal(
    tuiLegacyStatusPath("/repo"),
    "/repo/.sandcastle/tui/status.json",
  );
  assert.equal(
    tuiWorkingLogPath("reviewer #7 r1 a1", "/repo"),
    "/repo/.sandcastle/tui/logs/reviewer-7-r1-a1.log",
  );
  assert.equal(
    tuiWorkingLogPath("", "/repo"),
    "/repo/.sandcastle/tui/logs/agent.log",
  );
});

test("parseTuiStatusFileName accepts namespaced and legacy snapshots", () => {
  assert.deepEqual(parseTuiStatusFileName("status.json"), {
    fileName: "status.json",
    legacy: true,
  });
  assert.deepEqual(parseTuiStatusFileName("status-prd.json"), {
    fileName: "status-prd.json",
    loopType: "prd",
    legacy: false,
  });
  assert.deepEqual(parseTuiStatusFileName("status-backlog.json"), {
    fileName: "status-backlog.json",
    loopType: "backlog",
    legacy: false,
  });
  assert.deepEqual(parseTuiStatusFileName("status-pr-review.json"), {
    fileName: "status-pr-review.json",
    loopType: "pr-review",
    legacy: false,
  });
  assert.equal(parseTuiStatusFileName("status-unknown.json"), null);
  assert.equal(parseTuiStatusFileName(".status-prd.json.tmp-123"), null);
  assert.equal(parseTuiStatusFileName("coder.log"), null);
});

test("listTuiStatusSnapshotPaths returns only status snapshot files, sorted", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-status-"));
  try {
    writeFileSync(join(dir, "status-prd.json"), "{}", "utf8");
    writeFileSync(join(dir, "status-backlog.json"), "{}", "utf8");
    writeFileSync(join(dir, "status.json"), "{}", "utf8");
    writeFileSync(join(dir, ".status-prd.json.tmp-abc"), "", "utf8");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "agent.log"), "", "utf8");

    const paths = listTuiStatusSnapshotPaths(dir);
    assert.deepEqual(paths, [
      join(dir, "status-backlog.json"),
      join(dir, "status-prd.json"),
      join(dir, "status.json"),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two loop types can write snapshots to the same directory without clobbering", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-status-"));
  try {
    const backlog = buildTuiStatus(
      { ...baseContext, loopType: "backlog", loopId: "bugs" },
      { kind: "host", name: "startup", startedAt: "2026-07-02T10:00:00.000Z" },
      new Date("2026-07-02T10:00:01.000Z"),
    );
    const prReview = buildTuiStatus(
      { ...baseContext, loopType: "pr-review", loopId: "all" },
      { kind: "host", name: "startup", startedAt: "2026-07-02T10:00:00.000Z" },
      new Date("2026-07-02T10:00:02.000Z"),
    );
    writeStatusSnapshotAtomic(dir, backlog);
    writeStatusSnapshotAtomic(dir, prReview);

    assert.ok(existsSync(join(dir, "status-backlog.json")));
    assert.ok(existsSync(join(dir, "status-pr-review.json")));

    const parsedBacklog = JSON.parse(
      readFileSync(join(dir, "status-backlog.json"), "utf8"),
    ) as TuiStatus;
    const parsedPrReview = JSON.parse(
      readFileSync(join(dir, "status-pr-review.json"), "utf8"),
    ) as TuiStatus;

    assert.equal(parsedBacklog.loopType, "backlog");
    assert.equal(parsedBacklog.loopId, "bugs");
    assert.equal(parsedPrReview.loopType, "pr-review");
    assert.equal(parsedPrReview.loopId, "all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
