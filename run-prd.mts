import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Models. Replace with the exact opencode model strings once known.
const CODER_MODEL = "strix/qwen3.6-35b-a3b-8bit";
const REVIEWER_MODEL = "zai-coding-plan/glm-5.1";

// PRD layout
const PRD_DIR = "docs/prd";
const LABEL_PREFIX = "prd"; // -> label `prd-<N>`, base branch `prd-<N>`
const STUCK_LABEL = "agent-stuck";

// Loop bounds
const MAX_REVIEW_ROUNDS = 5; // coder<->reviewer attempts per issue
const MAX_ITERATIONS = 50; // outer-loop safety cap
const CODER_MAX_ITERATIONS = 30; // per coder invocation

// Idle timeout for the agent (sandcastle fails the run if stdout is silent
// this long). Local LLMs like Qwen 35B on a single GPU often go silent for
// many minutes during a single generation — opencode buffers stdout until
// the next tool call or final response. 1800s = 30 min is a safe default;
// override on the command line with `--idle-timeout <seconds>`.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

// Host-side validation gate. Runs after each coder commit, before the reviewer.
// Empty array disables the gate. Commands run sequentially; first failure stops
// the gate and is fed back to the coder as the next round's REVIEW_FEEDBACK.
const VALIDATION_COMMANDS: string[] = [
  "npm run typecheck",
  "npm run test",
  "npm run build",
];

// Commands to run inside the sandbox once it's ready (e.g. install deps).
const SANDBOX_READY_COMMANDS: string[] = ["npm install"];

// Git pathspec exclusions for the reviewer diff. Lockfiles and other
// auto-generated bulk bloat the prompt fast and have no review value.
const REVIEW_DIFF_EXCLUDES: string[] = [
  ":(exclude)**/package-lock.json",
  ":(exclude)**/yarn.lock",
  ":(exclude)**/pnpm-lock.yaml",
  ":(exclude)**/bun.lockb",
  ":(exclude)**/poetry.lock",
  ":(exclude)**/uv.lock",
  ":(exclude)**/Cargo.lock",
];

// Hard cap on the reviewer diff (bytes). Linux execve argv limit is ~128KB
// system-wide and opencode passes the whole prompt as a single CLI arg, so
// keep this well under that with headroom for the rest of the prompt.
const REVIEW_DIFF_MAX_BYTES = 60_000;

// `gh pr merge` strategy flag. Repos may disable certain strategies in
// branch protection; use whichever your repo allows.
const PR_MERGE_STRATEGY: "--merge" | "--squash" | "--rebase" = "--squash";

// Files copied from the host into the worktree before the sandbox starts.
const COPY_TO_WORKTREE: string[] = [];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const prdArgIndex = process.argv.indexOf("--prd");
if (prdArgIndex === -1 || !process.argv[prdArgIndex + 1]) {
  throw new Error(
    "Usage: tsx .sandcastle/run-prd.mts --prd <N> [--idle-timeout <seconds>]",
  );
}
const prdNumber = Number.parseInt(process.argv[prdArgIndex + 1]!, 10);
if (!Number.isInteger(prdNumber) || prdNumber < 1) {
  throw new Error(
    `--prd must be a positive integer, got ${process.argv[prdArgIndex + 1]}`,
  );
}

const idleArgIndex = process.argv.indexOf("--idle-timeout");
let idleTimeoutSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS;
if (idleArgIndex !== -1) {
  const raw = process.argv[idleArgIndex + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--idle-timeout must be a positive integer, got ${raw}`);
  }
  idleTimeoutSeconds = parsed;
}
console.log(`Idle timeout: ${idleTimeoutSeconds}s`);

const padded = String(prdNumber).padStart(3, "0");
const prdLabel = `${LABEL_PREFIX}-${padded}`;
const prdBranch = `${LABEL_PREFIX}-${padded}`;

// ---------------------------------------------------------------------------
// PRD file resolution
// ---------------------------------------------------------------------------

const prdPattern = new RegExp(`^${padded}-.*\\.md$`);
const prdMatches = readdirSync(PRD_DIR).filter((f) => prdPattern.test(f));
if (prdMatches.length === 0) {
  throw new Error(`No PRD file found matching ${PRD_DIR}/${padded}-*.md`);
}
if (prdMatches.length > 1) {
  throw new Error(
    `Multiple PRD files match ${PRD_DIR}/${padded}-*.md: ${prdMatches.join(", ")}`,
  );
}
const prdPath = join(PRD_DIR, prdMatches[0]!);
const prdBody = readFileSync(prdPath, "utf8");
console.log(`Loaded PRD: ${prdPath}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8" });

const ghJson = <T>(args: string[]): T => JSON.parse(gh(args)) as T;

const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { encoding: "utf8", cwd });

function ensureBaseBranch(): void {
  const existing = git(["branch", "--list", prdBranch]).trim();
  if (!existing) {
    console.log(`Creating base branch ${prdBranch} from current HEAD`);
    git(["branch", prdBranch]);
  }
  const push = spawnSync("git", ["push", "-u", "origin", prdBranch], {
    encoding: "utf8",
  });
  if (push.status !== 0) {
    console.warn(
      `Could not push ${prdBranch} to origin (status ${push.status}). Subsequent PR creation may fail.\n${push.stderr ?? ""}`,
    );
  }
}

interface IssueListItem {
  number: number;
  labels: { name: string }[];
}

interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface IssueDetail {
  number: number;
  title: string;
  body: string;
  comments: IssueComment[];
  labels: { name: string }[];
}

function pickNextIssue(): IssueDetail | null {
  const list = ghJson<IssueListItem[]>([
    "issue",
    "list",
    "--label",
    prdLabel,
    "--state",
    "open",
    "--json",
    "number,labels",
    "--limit",
    "200",
  ]);
  const eligible = list
    .filter((i) => !i.labels.some((l) => l.name === STUCK_LABEL))
    .sort((a, b) => a.number - b.number);
  if (eligible.length === 0) return null;
  const top = eligible[0]!;
  return ghJson<IssueDetail>([
    "issue",
    "view",
    String(top.number),
    "--json",
    "number,title,body,comments,labels",
  ]);
}

function computeReviewDiff(worktreePath: string): string {
  const out = execFileSync(
    "git",
    [
      "diff",
      `${prdBranch}..HEAD`,
      "--",
      ".",
      ...REVIEW_DIFF_EXCLUDES,
    ],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (out.length <= REVIEW_DIFF_MAX_BYTES) return out;
  return (
    out.slice(0, REVIEW_DIFF_MAX_BYTES) +
    `\n\n... (diff truncated at ${REVIEW_DIFF_MAX_BYTES} bytes; ${out.length - REVIEW_DIFF_MAX_BYTES} bytes omitted)`
  );
}

function flattenComments(comments: IssueComment[]): string {
  if (comments.length === 0) return "(no comments)";
  return comments
    .map((c) => `### @${c.author.login} — ${c.createdAt}\n\n${c.body}`)
    .join("\n\n");
}

type GateResult = { ok: true } | { ok: false; feedback: string };

function runValidationGate(worktreePath: string): GateResult {
  for (const cmd of VALIDATION_COMMANDS) {
    console.log(`  $ ${cmd}`);
    const result = spawnSync(cmd, {
      shell: true,
      cwd: worktreePath,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      return {
        ok: false,
        feedback: [
          "## Validation failed",
          "",
          "Command:",
          "```",
          cmd,
          "```",
          "",
          "Output (truncated to last 4000 chars):",
          "```",
          output.slice(-4000),
          "```",
          "",
          "Fix the failures and commit again.",
        ].join("\n"),
      };
    }
  }
  return { ok: true };
}

interface ReviewFinding {
  severity?: string;
  file?: string;
  line?: number;
  problem: string;
  remediation: string;
}

interface ReviewResult {
  decision: "approved" | "changes_requested" | "needs_human_review";
  summary: string;
  findings: ReviewFinding[];
}

// Defensive parse: a low-powered local model may flub the format. Any parse
// failure becomes a synthetic `needs_human_review`, so the outer loop control
// stays deterministic.
function extractReview(stdout: string): ReviewResult {
  const tag = stdout.match(/<review>([\s\S]*?)<\/review>/);
  if (!tag) {
    return {
      decision: "needs_human_review",
      summary: "Reviewer did not emit a <review>...</review> block.",
      findings: [
        {
          problem: "Missing <review> tag in reviewer output.",
          remediation: "Inspect the run log and decide manually.",
        },
      ],
    };
  }
  try {
    const parsed = JSON.parse(tag[1]!.trim());
    const decision = parsed?.decision;
    if (
      typeof decision === "string" &&
      ["approved", "changes_requested", "needs_human_review"].includes(decision) &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.findings)
    ) {
      return parsed as ReviewResult;
    }
    throw new Error("shape");
  } catch {
    return {
      decision: "needs_human_review",
      summary: "Reviewer JSON could not be parsed or had the wrong shape.",
      findings: [
        {
          problem: "Unparseable reviewer output inside <review> tag.",
          remediation: "Inspect the run log and decide manually.",
        },
      ],
    };
  }
}

function formatFeedback(review: ReviewResult): string {
  const header =
    review.decision === "needs_human_review"
      ? "## Reviewer flagged human review (treat as blocking)"
      : "## Reviewer requested changes";
  const findings =
    review.findings.length === 0
      ? "(reviewer listed no specific findings)"
      : review.findings
          .map((f, i) => {
            const loc = [f.file, f.line ? `line ${f.line}` : null]
              .filter(Boolean)
              .join(" ");
            return [
              `### Finding ${i + 1}${loc ? ` (${loc})` : ""}`,
              "",
              `**Problem:** ${f.problem}`,
              "",
              `**Fix:** ${f.remediation}`,
            ].join("\n");
          })
          .join("\n\n");
  return [header, "", `**Summary:** ${review.summary}`, "", findings].join("\n");
}

function approveAndMerge(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
): void {
  execFileSync("git", ["push", "-u", "origin", issueBranch], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  // `Closes #N` only auto-closes on default-branch merges, so we close
  // explicitly after the PR merges into prd-<N>.
  execFileSync(
    "gh",
    [
      "pr",
      "create",
      "--base",
      prdBranch,
      "--head",
      issueBranch,
      "--title",
      issue.title,
      "--body",
      `Closes #${issue.number}\n\nAutomated merge from \`${issueBranch}\` into \`${prdBranch}\`.`,
    ],
    { stdio: "inherit", cwd: worktreePath },
  );
  execFileSync("gh", ["pr", "merge", issueBranch, PR_MERGE_STRATEGY], {
    stdio: "inherit",
    cwd: worktreePath,
  });
  execFileSync(
    "gh",
    [
      "issue",
      "close",
      String(issue.number),
      "--reason",
      "completed",
      "--comment",
      `Merged into \`${prdBranch}\` via PR for branch \`${issueBranch}\`.`,
    ],
    { stdio: "inherit" },
  );
  // Fast-forward local prd-<N> so the next issue's baseBranch sees the merge.
  const sync = spawnSync(
    "git",
    ["fetch", "origin", `${prdBranch}:${prdBranch}`],
    { stdio: "inherit" },
  );
  if (sync.status !== 0) {
    console.warn(
      `Could not fast-forward local ${prdBranch} after merge. Next issue may start from a stale base.`,
    );
  }
}

function markStuck(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
  lastFeedback: string,
): void {
  const push = spawnSync("git", ["push", "-u", "origin", issueBranch], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  if (push.status !== 0) {
    console.warn(`Could not push ${issueBranch} on stuck — continuing.`);
  }
  execFileSync(
    "gh",
    [
      "issue",
      "comment",
      String(issue.number),
      "--body",
      `Agent gave up after ${MAX_REVIEW_ROUNDS} review rounds. Last feedback:\n\n${lastFeedback}`,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "gh",
    ["issue", "edit", String(issue.number), "--add-label", STUCK_LABEL],
    { stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

ensureBaseBranch();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  const issue = pickNextIssue();
  if (!issue) {
    console.log(`No eligible issues with label '${prdLabel}'. Done.`);
    break;
  }

  console.log(`Picked issue #${issue.number}: ${issue.title}`);

  const issueBranch = `${prdBranch}-issue-${issue.number}`;
  const issueComments = flattenComments(issue.comments);

  const sandbox = await sandcastle.createSandbox({
    sandbox: docker({
      mounts: [
        {
          hostPath: "~/.config/opencode",
          sandboxPath: "~/.config/opencode",
          readonly: true,
        },
        {
          // Writable: opencode keeps SQLite (WAL) + logs + session state here
          // and login-flow refresh tokens may rotate. Sequential loop = no
          // concurrent-write conflicts on this dir.
          hostPath: "~/.local/share/opencode",
          sandboxPath: "~/.local/share/opencode",
        },
      ],
    }),
    branch: issueBranch,
    baseBranch: prdBranch,
    copyToWorktree: COPY_TO_WORKTREE,
    hooks: {
      sandbox: {
        onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({ command })),
      },
    },
  });

  let feedback = "";
  let lastFeedback = "";
  let approved = false;

  try {
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      console.log(`\n--- Round ${round}/${MAX_REVIEW_ROUNDS} for #${issue.number} ---`);

      const isRework = round > 1;
      const coderArgs: Record<string, string> = {
        ISSUE_NUMBER: String(issue.number),
        ISSUE_TITLE: issue.title,
        ISSUE_BODY: issue.body || "(no body)",
        ISSUE_COMMENTS: issueComments,
        PRD_BODY: prdBody,
      };
      if (isRework) coderArgs.REVIEW_FEEDBACK = feedback;

      const coderResult = await sandbox.run({
        name: `coder #${issue.number} r${round}`,
        agent: sandcastle.opencode(CODER_MODEL),
        maxIterations: CODER_MAX_ITERATIONS,
        completionSignal: "<promise>COMPLETE</promise>",
        idleTimeoutSeconds,
        promptFile: isRework
          ? "./.sandcastle/rework-prompt-prd.md"
          : "./.sandcastle/implement-prompt-prd.md",
        promptArgs: coderArgs,
      });

      const blockedMatch = coderResult.stdout.match(
        /<blocked>([\s\S]*?)<\/blocked>/,
      );
      if (blockedMatch) {
        const reason = blockedMatch[1]!.trim();
        console.log(`  coder signaled blocked: ${reason.slice(0, 200)}`);
        lastFeedback = `Coder signaled blocked on round ${round}:\n\n${reason}`;
        break;
      }

      if (coderResult.commits.length === 0) {
        feedback =
          "## No commits produced\n\nYour previous run finished without committing any changes. Re-read the issue and the PRD, then make the required code changes and commit them.";
        lastFeedback = feedback;
        continue;
      }

      console.log(`  coder committed ${coderResult.commits.length} time(s); running validation gate`);
      const gate = runValidationGate(sandbox.worktreePath);
      if (!gate.ok) {
        feedback = gate.feedback;
        lastFeedback = feedback;
        continue;
      }

      console.log(`  validation green; invoking reviewer`);
      const reviewDiff = computeReviewDiff(sandbox.worktreePath);
      const reviewerResult = await sandbox.run({
        name: `reviewer #${issue.number} r${round}`,
        agent: sandcastle.opencode(REVIEWER_MODEL),
        maxIterations: 1,
        idleTimeoutSeconds,
        promptFile: "./.sandcastle/review-prompt-prd.md",
        promptArgs: {
          ISSUE_NUMBER: String(issue.number),
          ISSUE_TITLE: issue.title,
          ISSUE_BODY: issue.body || "(no body)",
          ISSUE_COMMENTS: issueComments,
          PRD_BODY: prdBody,
          BASE_BRANCH: prdBranch,
          DIFF: reviewDiff,
        },
      });

      const review = extractReview(reviewerResult.stdout);
      console.log(`  reviewer decision: ${review.decision}`);
      if (review.decision === "approved") {
        approved = true;
        break;
      }
      feedback = formatFeedback(review);
      lastFeedback = feedback;
    }

    if (approved) {
      approveAndMerge(issue, sandbox.worktreePath, issueBranch);
      console.log(`Issue #${issue.number} merged into ${prdBranch}.`);
    } else {
      console.log(
        `Issue #${issue.number} stuck after ${MAX_REVIEW_ROUNDS} rounds.`,
      );
      markStuck(
        issue,
        sandbox.worktreePath,
        issueBranch,
        lastFeedback || "(no feedback recorded)",
      );
    }
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
