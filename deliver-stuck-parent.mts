// deliver-stuck-parent.mts
//
// Manually delivers a stuck Issue-as-PRD parent by:
//   1. Ensuring the accumulation branch exists locally.
//   2. Discovering all child issues (via the parent-N queue label).
//   3. For each child whose branch has commits not yet in the accumulation
//      branch, merging that child branch in (fast-forward preferred, merge
//      commit on conflicts).
//   4. Pushing the accumulation branch.
//   5. Opening a PR to the base branch (unless --no-pr is passed).
//
// Usage:
//   tsx .sandcastle/deliver-stuck-parent.mts --issue <N>
//     [--base-branch main] [--dry-run] [--no-pr]

import { execFileSync, spawnSync } from "node:child_process";
import { hasFlag, readCliStringFlag } from "./cli-string-flag.mts";
import {
  accumulationBranchName,
  childBranchName,
  queueLabelName,
} from "./backlog-v3-issue-as-prd-adapter.mts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: tsx .sandcastle/deliver-stuck-parent.mts --issue <N> [--base-branch main] [--dry-run] [--no-pr]";

function readFlag(flag: string): string | undefined {
  try {
    return readCliStringFlag(process.argv, flag);
  } catch (e) {
    throw new Error(`${USAGE}\n\n${e instanceof Error ? e.message : String(e)}`);
  }
}

const issueRaw = readFlag("--issue");
if (!issueRaw) throw new Error(`${USAGE}\n\nMissing required argument: --issue <N>`);
const parentNumber = Number.parseInt(issueRaw, 10);
if (!Number.isInteger(parentNumber) || parentNumber < 1) {
  throw new Error(`--issue must be a positive integer, got: ${issueRaw}`);
}

const baseBranch = readFlag("--base-branch") ?? "main";
const DRY_RUN = hasFlag(process.argv, "--dry-run");
const NO_PR = hasFlag(process.argv, "--no-pr");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const git = (args: string[], opts?: { cwd?: string; input?: string }): string =>
  execFileSync("git", args, {
    encoding: "utf8",
    cwd: opts?.cwd,
    input: opts?.input,
  });

const gitTry = (args: string[], cwd?: string) =>
  spawnSync("git", args, { encoding: "utf8", cwd });

const ghJson = <T>(args: string[]): T =>
  JSON.parse(execFileSync("gh", args, { encoding: "utf8" })) as T;

function say(msg: string) {
  console.log(msg);
}

function dryRun(description: string, fn: () => void) {
  if (DRY_RUN) {
    say(`  [dry-run] would: ${description}`);
  } else {
    fn();
  }
}

function branchExistsLocally(branch: string): boolean {
  return gitTry(["rev-parse", "--verify", branch]).status === 0;
}

function branchExistsOnOrigin(branch: string): boolean {
  const result = spawnSync("git", ["ls-remote", "--heads", "origin", branch], {
    encoding: "utf8",
  });
  return result.status === 0 && Boolean((result.stdout ?? "").trim());
}

function ensureLocalBranch(branch: string): boolean {
  if (branchExistsLocally(branch)) return true;
  if (branchExistsOnOrigin(branch)) {
    say(`  fetching ${branch} from origin`);
    dryRun(`git branch ${branch} origin/${branch}`, () => {
      execFileSync("git", ["fetch", "origin", `${branch}:${branch}`], {
        stdio: "inherit",
      });
    });
    return !DRY_RUN;
  }
  return false;
}

function commitsAhead(from: string, to: string): number {
  const raw = gitTry(["rev-list", "--count", `${from}..${to}`]);
  if (raw.status !== 0) return 0;
  return Number.parseInt((raw.stdout ?? "0").trim(), 10) || 0;
}

function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const accumulation = accumulationBranchName(parentNumber);
const queueLabel = queueLabelName(parentNumber);
const originBase = `origin/${baseBranch}`;

say(`\nDeliver stuck parent #${parentNumber}`);
say(`  accumulation branch : ${accumulation}`);
say(`  queue label         : ${queueLabel}`);
say(`  base branch         : ${baseBranch}`);
say(`  dry-run             : ${DRY_RUN}`);
say("");

// 1. Fetch origin so all remote refs are current.
say("Step 1: fetching origin");
dryRun("git fetch origin", () => {
  execFileSync("git", ["fetch", "origin"], { stdio: "inherit" });
});

// 2. Ensure the accumulation branch exists locally.
say(`Step 2: ensuring ${accumulation} exists locally`);
if (!ensureLocalBranch(accumulation)) {
  throw new Error(
    `Accumulation branch ${accumulation} does not exist locally or on origin. ` +
      `Run the backlog loop at least once to claim the parent, then retry.`,
  );
}

// 3. Fetch the parent issue title for the PR.
say("Step 3: reading parent issue from GitHub");
const parentIssue = ghJson<{ title: string; body: string }>([
  "issue",
  "view",
  String(parentNumber),
  "--json",
  "title,body",
]);
say(`  title: ${parentIssue.title}`);

// 4. Discover children via queue label.
say(`Step 4: listing children via label ${queueLabel}`);
const childIssues = ghJson<Array<{ number: number; state: string; title: string }>>([
  "issue",
  "list",
  "--state",
  "all",
  "--label",
  queueLabel,
  "--json",
  "number,state,title",
  "--limit",
  "1000",
]);
say(`  found ${childIssues.length} child issue(s)`);

// 5. Check out the accumulation branch (if not already on it).
say(`Step 5: switching to ${accumulation}`);
const before = currentBranch();
if (before !== accumulation) {
  dryRun(`git checkout ${accumulation}`, () => {
    execFileSync("git", ["checkout", accumulation], { stdio: "inherit" });
  });
}

// 6. For each child, check for an unintegrated branch and merge it.
say("Step 6: merging child branches");
let mergedCount = 0;
const missing: number[] = [];
const alreadyIntegrated: number[] = [];
const merged: number[] = [];
const conflicted: number[] = [];

for (const child of childIssues) {
  const branch = childBranchName(parentNumber, child.number);
  say(`\n  child #${child.number} (${child.state}): ${child.title}`);
  say(`    branch: ${branch}`);

  // Fetch child branch from origin if needed.
  if (!branchExistsLocally(branch)) {
    if (branchExistsOnOrigin(branch)) {
      say(`    fetching from origin`);
      dryRun(`git fetch origin ${branch}:${branch}`, () => {
        spawnSync("git", ["fetch", "origin", `${branch}:${branch}`], {
          stdio: "inherit",
        });
      });
    } else {
      say(`    branch not found locally or on origin — skipping`);
      missing.push(child.number);
      continue;
    }
  }

  // Skip if already integrated.
  const ahead = commitsAhead(accumulation, branch);
  if (ahead === 0) {
    say(`    already integrated (0 commits ahead of ${accumulation})`);
    alreadyIntegrated.push(child.number);
    continue;
  }

  say(`    ${ahead} commit(s) ahead of ${accumulation} — merging`);

  if (DRY_RUN) {
    say(`    [dry-run] would: git merge --ff-only ${branch}`);
    merged.push(child.number);
    mergedCount++;
    continue;
  }

  // Try fast-forward first, fall back to a merge commit.
  const ff = gitTry(["merge", "--ff-only", branch]);
  if (ff.status === 0) {
    say(`    fast-forward merged`);
    merged.push(child.number);
    mergedCount++;
    continue;
  }

  // Fast-forward failed — try a regular merge.
  say(`    fast-forward not possible; attempting merge commit`);
  const mc = gitTry([
    "merge",
    "--no-ff",
    "-m",
    `Merge ${branch} into ${accumulation} (child #${child.number})`,
    branch,
  ]);
  if (mc.status === 0) {
    say(`    merge commit created`);
    merged.push(child.number);
    mergedCount++;
  } else {
    say(`    CONFLICT merging ${branch}:`);
    say(`    ${(mc.stdout ?? "") + (mc.stderr ?? "")}`);
    say(`    aborting this merge; you will need to resolve manually`);
    gitTry(["merge", "--abort"]);
    conflicted.push(child.number);
  }
}

// 7. Summary so far.
say("\nStep 6 summary:");
say(`  merged          : ${merged.length > 0 ? merged.map((n) => `#${n}`).join(", ") : "(none)"}`);
say(`  already in      : ${alreadyIntegrated.length > 0 ? alreadyIntegrated.map((n) => `#${n}`).join(", ") : "(none)"}`);
say(`  branch missing  : ${missing.length > 0 ? missing.map((n) => `#${n}`).join(", ") : "(none)"}`);
say(`  conflict (skip) : ${conflicted.length > 0 ? conflicted.map((n) => `#${n}`).join(", ") : "(none)"}`);

if (conflicted.length > 0) {
  say(
    `\nWARNING: ${conflicted.length} child branch(es) could not be merged automatically.` +
      ` Resolve conflicts manually, then re-run without those children already integrated.`,
  );
}

// 8. Verify the accumulation branch has at least one commit ahead of base.
const accumulationAhead = commitsAhead(originBase, DRY_RUN ? accumulation : "HEAD");
if (accumulationAhead === 0) {
  say(
    `\nAccumulation branch has no commits ahead of ${originBase}. Nothing to push or PR.`,
  );
  process.exit(0);
}
say(`\nStep 7: ${accumulationAhead} commit(s) ahead of ${originBase}`);

// 9. Push accumulation branch.
say(`Step 8: pushing ${accumulation} to origin`);
dryRun(`git push -u origin ${accumulation}`, () => {
  execFileSync("git", ["push", "-u", "origin", accumulation], { stdio: "inherit" });
});

// 10. Open PR (unless --no-pr).
if (NO_PR) {
  say("\nStep 9: skipped (--no-pr)");
  say(`\nDone. Branch ${accumulation} is ready. Open a PR manually when ready.`);
  process.exit(0);
}

say(`Step 9: opening PR to ${baseBranch}`);

// Check if a PR already exists for this branch.
const existingPrs = ghJson<Array<{ number: number; url: string }>>([
  "pr",
  "list",
  "--head",
  accumulation,
  "--state",
  "open",
  "--json",
  "number,url",
]);

if (existingPrs.length > 0) {
  const pr = existingPrs[0]!;
  say(`  PR already exists: #${pr.number} ${pr.url}`);
  say(`\nDone. Pushed ${mergedCount} new child branch(es) into ${accumulation}.`);
  process.exit(0);
}

// Build the PR body.
const childSummary =
  childIssues.length > 0
    ? childIssues
        .map((c) => `- Closes #${c.number} — ${c.title}`)
        .join("\n")
    : "(no children recorded)";

const prBody = [
  `## Summary`,
  ``,
  `Delivers parent issue #${parentNumber}: ${parentIssue.title}`,
  ``,
  childIssues.length > 0 ? `### Child issues integrated\n` : null,
  childIssues.length > 0 ? childSummary : null,
  ``,
  `## Test plan`,
  ``,
  `- [ ] CI passes`,
  `- [ ] Acceptance criteria in #${parentNumber} satisfied`,
  ``,
  `🤖 Assembled by \`deliver-stuck-parent.mts\``,
]
  .filter((l) => l !== null)
  .join("\n");

dryRun(`gh pr create --title "${parentIssue.title}" --base ${baseBranch}`, () => {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "create",
      "--title",
      parentIssue.title,
      "--base",
      baseBranch,
      "--head",
      accumulation,
      "--body",
      prBody,
    ],
    { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `gh pr create failed: ${(result.stderr ?? "") + (result.stdout ?? "")}`,
    );
  }
  const url = (result.stdout ?? "").trim();
  say(`  PR created: ${url}`);
});

say(`\nDone.`);
if (mergedCount > 0) say(`  Merged ${mergedCount} child branch(es) into ${accumulation}.`);
if (conflicted.length > 0) {
  say(`  ${conflicted.length} child(ren) had conflicts and were skipped.`);
}
