import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordFailureDiagnostic } from "./failure-diagnostics.mts";

function makeRepoRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("recordFailureDiagnostic writes a self-contained bundle and metrics index", () => {
  const repoRoot = makeRepoRoot("fail-diag-");
  const logsDir = join(repoRoot, ".sandcastle", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, "issue-42-coder--42-r1.log"),
    "coder log line\n".repeat(10),
    "utf8",
  );
  writeFileSync(
    join(logsDir, "issue-42-reviewer--42-r1-a1.log"),
    "reviewer log\n",
    "utf8",
  );
  writeFileSync(join(logsDir, "issue-99-coder--99-r1.log"), "other issue\n", "utf8");

  const metricsDir = join(repoRoot, ".sandcastle", "metrics");
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(
    join(metricsDir, "runs.jsonl"),
    `${[
      JSON.stringify({ kind: "sandcastle_agent_run", issue: 42, stage: "coder" }),
      JSON.stringify({ kind: "sandcastle_agent_run", issue: 99, stage: "coder" }),
      JSON.stringify({ kind: "sandcastle_issue_outcome", issue: 42 }),
    ].join("\n")}\n`,
    "utf8",
  );

  const bundleDir = recordFailureDiagnostic(
    {
      scope: "issue",
      outcome: "stuck_no_progress",
      prd: "agent-queue",
      issue: 42,
      branch: "issue-42",
      roundsUsed: 3,
      error: "boom",
      lastFeedback: "## Reviewer requested changes\nfinding text",
      detail: { note: "unit-test" },
    },
    {
      repoRoot,
      now: () => new Date("2026-07-08T12:00:00Z"),
      warn: () => {},
      log: () => {},
    },
  );

  assert.ok(bundleDir, "expected a bundle directory path");
  const diagnostic = JSON.parse(
    readFileSync(join(bundleDir, "diagnostic.json"), "utf8"),
  );
  assert.equal(diagnostic.kind, "sandcastle_failure_diagnostic");
  assert.equal(diagnostic.scope, "issue");
  assert.equal(diagnostic.outcome, "stuck_no_progress");
  assert.equal(diagnostic.issue, 42);
  assert.equal(diagnostic.rounds_used, 3);
  assert.equal(diagnostic.detail.note, "unit-test");
  assert.equal(diagnostic.error, "boom");

  assert.match(
    readFileSync(join(bundleDir, "last-feedback.md"), "utf8"),
    /Reviewer requested changes/,
  );
  assert.equal(readFileSync(join(bundleDir, "error.txt"), "utf8"), "boom");

  const entries = readdirSync(bundleDir);
  assert.ok(entries.some((name) => name.includes("issue-42-coder")));
  assert.ok(entries.some((name) => name.includes("issue-42-reviewer")));
  assert.ok(!entries.some((name) => name.includes("issue-99")));

  const excerpt = readFileSync(join(bundleDir, "metrics-excerpt.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(excerpt.length, 2);
  assert.ok(excerpt.every((record) => record.issue === 42));

  const runs = readFileSync(join(metricsDir, "runs.jsonl"), "utf8")
    .trim()
    .split("\n");
  const index = JSON.parse(runs.at(-1) ?? "{}");
  assert.equal(index.kind, "sandcastle_failure_diagnostic");
  assert.equal(index.bundle_dir, bundleDir);
  assert.equal(index.issue, 42);
});

test("recordFailureDiagnostic matches parent_issue records for child-scope failures", () => {
  const repoRoot = makeRepoRoot("fail-diag-child-");
  const metricsDir = join(repoRoot, ".sandcastle", "metrics");
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(
    join(metricsDir, "runs.jsonl"),
    `${[
      JSON.stringify({ kind: "sandcastle_agent_run", issue: 1104 }),
      JSON.stringify({ kind: "sandcastle_failure_diagnostic", parent_issue: 1002 }),
      JSON.stringify({ kind: "sandcastle_agent_run", issue: 7 }),
    ].join("\n")}\n`,
    "utf8",
  );

  const bundleDir = recordFailureDiagnostic(
    {
      scope: "child",
      outcome: "child_stuck",
      prd: "agent-queue",
      issue: 1104,
      parentIssue: 1002,
      lastFeedback: "reason text",
    },
    { repoRoot, warn: () => {}, log: () => {} },
  );

  assert.ok(bundleDir);
  const excerpt = readFileSync(join(bundleDir, "metrics-excerpt.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(excerpt.length, 2);
});

test("recordFailureDiagnostic still writes a bundle when nothing else exists", () => {
  const repoRoot = makeRepoRoot("fail-diag-empty-");
  const warnings: string[] = [];

  const bundleDir = recordFailureDiagnostic(
    {
      scope: "loop",
      outcome: "acquisition_failed",
      prd: "agent-queue",
      error: "gh exploded",
    },
    { repoRoot, warn: (message) => warnings.push(message), log: () => {} },
  );

  assert.ok(bundleDir, "bundle should be written even with no logs/metrics/git");
  const diagnostic = JSON.parse(
    readFileSync(join(bundleDir, "diagnostic.json"), "utf8"),
  );
  assert.equal(diagnostic.scope, "loop");
  assert.equal(diagnostic.outcome, "acquisition_failed");
  assert.equal(diagnostic.metrics_excerpt, null);
  assert.deepEqual(diagnostic.agent_log_tails, []);
  assert.equal(warnings.length, 0);
  assert.equal(readFileSync(join(bundleDir, "error.txt"), "utf8"), "gh exploded");
});

test("recordFailureDiagnostic sanitizes the outcome in the bundle directory name", () => {
  const repoRoot = makeRepoRoot("fail-diag-slug-");
  const bundleDir = recordFailureDiagnostic(
    {
      scope: "loop",
      outcome: "Weird Outcome / With:Chars",
      prd: "agent-queue",
    },
    { repoRoot, warn: () => {}, log: () => {} },
  );
  assert.ok(bundleDir);
  assert.match(bundleDir, /weird-outcome-with-chars$/);
});
