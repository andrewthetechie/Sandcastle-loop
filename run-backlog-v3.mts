// run-backlog-v3.mts
//
// Backlog Issue-as-PRD loop. Processes one triaged parent issue at a time from
// the configured backlog label set. Each claimed parent owns a durable
// accumulation branch, may decompose into true GitHub child issues, readiness-
// gates those children before coding, fast-forwards approved child work into
// the accumulation branch, runs exactly one full-parent extra-review round,
// drains any follow-up children once, and then delivers a review-ready parent
// branch for a human to inspect and turn into a pull request.
//
// The loop never auto-merges and never auto-closes a parent. Clean delivery
// labels the parent `Review`; reviewed incomplete delivery adds
// `agent-partial`; reviewed delivery that now needs a manual mainline rebase
// adds `agent-rebase-needed`; parent-level failure with no review-ready
// delivery adds `agent-stuck` without `Review`.
//
// Usage:
//   tsx run-backlog-v3.mts --label <name[,name2]> [--base-branch main]
//     [--idle-timeout 1800]

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentDefinition,
  CODE_QUALITY_AGENT_CONFIG,
  CODER_AGENT_CONFIG,
  DECOMPOSER_AGENT_CONFIG,
  INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG,
  REVIEWER_AGENT_CONFIG,
  REWORK_AGENT_CONFIG,
  SUBTASK_READINESS_AGENT_CONFIG,
  TWO_AXIS_AGENT_CONFIG,
} from "./custom-agent-defs.mts";
import { enforceArgvSizeLimit } from "./custom-agent-argv-guard.mts";
import { renderSlimMessage } from "./custom-agent-render.mts";
import {
  ensureOpencodeGitExclude,
  writeAgentDefinitionFile,
} from "./custom-agent-worktree.mts";
import { EXTRA_REVIEW_INPUT_DIFF_EXCLUDES } from "./extra-review-inputs.mts";
import {
  writeCompletedBranchReviewInputs,
} from "./extra-review-inputs.mts";
import type {
  ExtraReviewPrdArtifactIdentity,
  ExtraReviewRoundArtifactIdentity,
} from "./extra-review-artifacts.mts";
import { runSequentialExtraReviewSessions } from "./extra-review-sessions.mts";
import {
  GitHubIssuesClient,
  type GitHubIssueRecord,
  type GitHubRepoRef,
} from "./github-issues.mts";
import {
  closeIssueAsPrdAlreadySatisfiedChild,
  listIssueAsPrdParentChildren,
  markIssueAsPrdChildStuck,
  publishIssueAsPrdParentChildren,
} from "./backlog-v3-issue-as-prd-children-adapter.mts";
import {
  recordIssueOutcome,
  recordMeasuredAgentRun,
  recordReviewerResult,
  recordValidationRun,
} from "./metrics-recorder.mts";
import {
  sha1,
  type WorktreeProgressSnapshot,
} from "./loop-progress.mts";
import {
  formatStuckIssueComment,
  type StuckTerminalReason,
} from "./mark-stuck-comment.mts";
import {
  installLoopCrashHandlers,
  recordFailureDiagnostic,
  type FailureDiagnosticInput,
} from "./failure-diagnostics.mts";
import {
  acquireReviewerResult,
  buildReviewerAttemptRunName,
  sanitizeReviewerExcerpt,
  type ReviewResult,
} from "./reviewer-result.mts";
import {
  runPerBranchEngine,
  type EngineReviewerAcquisitionResult,
  type PerBranchEngineOutcome,
} from "./per-branch-engine.mts";
import {
  AGENT_STUCK_LABEL,
  ISSUE_AS_PRD_LABELS,
} from "./issue-as-prd-queue-state.mts";
import {
  accumulationBranchName,
  childBranchName,
  permanentIssueAsPrdParentLabels,
  terminalActionForParentResult,
  terminalRepairLabelPlan,
  queueLabelName,
} from "./backlog-v3-issue-as-prd-adapter.mts";
import { nextParentState } from "./issue-as-prd-state.mts";
import { acquireNextIssueAsPrdParent } from "./backlog-v3-issue-as-prd-acquire.mts";
import { verifyIssueAsPrdParentOwnership } from "./backlog-v3-issue-as-prd-ownership.mts";
import { persistIssueAsPrdParentStateComment } from "./backlog-v3-issue-as-prd-state-comment.mts";
import {
  integrateIssueAsPrdChild,
  observeIssueAsPrdTerminalMainline,
  refreshIssueAsPrdAccumulationBeforeReview,
} from "./backlog-v3-issue-as-prd-git-adapter.mts";
import { BACKLOG_V3_ENGINE_POLICY } from "./per-branch-policy.mts";
import { loadSandcastleLoopConfig } from "./sandcastle-loop-config.mts";
import { aggregateDependencySetupCommands } from "./aggregate-validation-worktree.mts";
import { createHostCommandEnv } from "./host-command-env.mts";
import { resolveHostValidationCommand } from "./host-validation-command.mts";
import { formatHostValidationFailureFeedback } from "./host-validation-feedback.mts";
import { readCliStringFlag } from "./cli-string-flag.mts";
import {
  createLivelockWatchdogSandcastleRunOptions,
  resolveRound1CoderLivelockControlFlow,
  resolveReworkLivelockControlFlow,
} from "./agent-invocation-livelock.mts";
import { tuiEmitter } from "./tui-emitter.mts";
import { tuiWorkingLogPath } from "./tui-status.mts";
import type { ObservedParentRecoveryState } from "./issue-as-prd-state-contracts.mts";
import { splitQueueChildren } from "./backlog-v3-issue-as-prd-recovery-state.mts";
import {
  INITIAL_ISSUE_DECOMPOSER_USER_PROMPT_FILE,
  SUBTASK_READINESS_USER_PROMPT_FILE,
  acquireInitialDecomposition,
  acquireSubtaskReadiness,
  buildInitialIssueDecomposerRunName,
  buildSubtaskReadinessRunName,
  extractSingleTaggedOutput,
} from "./issue-as-prd-sessions.mts";
import { runSubtaskReadinessBatch } from "./subtask-readiness.mts";
import { runAggregateValidation } from "./issue-as-prd-validation.mts";
import { runIssueAsPrdExtraReview } from "./issue-as-prd-extra-review.mts";
import { runIssueAsPrdParent } from "./issue-as-prd-orchestrator.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const LOOP_CONFIG = await loadSandcastleLoopConfig(REPO_ROOT);

const REVIEWER_MODEL = LOOP_CONFIG.models.reviewer;
const INITIAL_ISSUE_DECOMPOSER_MODEL = LOOP_CONFIG.models.initialIssueDecomposer;
const SUBTASK_READINESS_MODEL = LOOP_CONFIG.models.subtaskReadiness;
const CODE_QUALITY_MODEL = LOOP_CONFIG.models.codeQuality;
const TWO_AXIS_MODEL = LOOP_CONFIG.models.twoAxis;
const ISSUE_DECOMPOSER_MODEL = LOOP_CONFIG.models.issueDecomposer;

const CODER_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/coder-agent-system-prompt-prd.md";
const CODER_USER_PROMPT_FILE = "./.sandcastle/coder-user-prompt-prd.md";
const REWORK_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/rework-agent-system-prompt-prd.md";
const REWORK_USER_PROMPT_FILE = "./.sandcastle/rework-user-prompt-prd.md";
const REVIEWER_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/reviewer-agent-system-prompt-prd.md";
const REVIEWER_USER_PROMPT_FILE = "./.sandcastle/reviewer-user-prompt-prd.md";
const CODE_QUALITY_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/code-quality-agent-system-prompt-prd.md";
const CODE_QUALITY_USER_PROMPT_FILE =
  "./.sandcastle/code-quality-user-prompt-prd.md";
const TWO_AXIS_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/two-axis-agent-system-prompt-prd.md";
const TWO_AXIS_USER_PROMPT_FILE = "./.sandcastle/two-axis-user-prompt-prd.md";
const DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE =
  "./.sandcastle/decomposer-agent-system-prompt-prd.md";
const DECOMPOSER_USER_PROMPT_FILE =
  "./.sandcastle/decomposer-user-prompt-prd.md";
const INITIAL_ISSUE_DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE = fileURLToPath(
  new URL("./initial-issue-decomposer-agent-system-prompt-prd.md", import.meta.url),
);
const SUBTASK_READINESS_AGENT_SYSTEM_PROMPT_FILE = fileURLToPath(
  new URL("./subtask-readiness-agent-system-prompt-prd.md", import.meta.url),
);

// Labels
const REVIEW_LABEL = "Review"; // added on clean approval; issue kept open
const STUCK_LABEL = "agent-stuck"; // added when the loop cannot land the issue

// Loop bounds
const MAX_REVIEW_ROUNDS = BACKLOG_V3_ENGINE_POLICY.maxReviewRounds;
const FAILED_ROUND_REPEAT_LIMIT =
  BACKLOG_V3_ENGINE_POLICY.failedRoundRepeatLimit;
const MAX_ITERATIONS = 250; // outer-loop safety backstop (re-run to continue)
const CODER_MAX_ITERATIONS = BACKLOG_V3_ENGINE_POLICY.coderMaxIterations;
const MAX_RECOVERY_ATTEMPTS = BACKLOG_V3_ENGINE_POLICY.maxRecoveryAttempts;
const MAX_PUSH_RECOVERY_ATTEMPTS = 2; // remote issue-branch push recovery
const BACKLOG_V3_SHARED_ENGINE_POLICY = {
  ...BACKLOG_V3_ENGINE_POLICY,
  reviewerMaxAttempts: LOOP_CONFIG.reviewer.maxAttempts,
};

// Idle timeout for the agent (sandcastle fails the run if stdout is silent
// this long). Override on the command line with `--idle-timeout <seconds>`.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;
const DEFAULT_BASE_BRANCH = "main";

// Host-side validation gate. Runs after each coder commit, before the reviewer.
// Empty array disables the gate.
const VALIDATION_COMMANDS: string[] = LOOP_CONFIG.validationCommands;

// Commands to run inside the sandbox once it's ready (e.g. install deps).
const SANDBOX_READY_COMMANDS: string[] = LOOP_CONFIG.setupCommands;

// Git pathspec exclusions for the reviewer diff.
const REVIEW_DIFF_EXCLUDES: string[] = [...EXTRA_REVIEW_INPUT_DIFF_EXCLUDES];

// Hard cap on the reviewer diff (bytes). opencode passes the whole prompt as a
// single CLI arg and the Linux execve argv limit is ~128KB system-wide, so keep
// this well under that with headroom for the rest of the prompt.
const REVIEW_DIFF_MAX_BYTES = BACKLOG_V3_ENGINE_POLICY.reviewDiffMaxBytes;

// Tracked task files must not be copied from the host into a worktree: doing
// so would leave the issue branch dirty. Validation resolves its PostgreSQL
// reset helper to the canonical host path instead.
const COPY_TO_WORKTREE: string[] = [];

const OPENCODE_MOUNTS = [
  {
    hostPath: "~/.config/opencode",
    sandboxPath: "~/.config/opencode",
    readonly: true,
  },
  {
    hostPath: "~/.local/share/opencode",
    sandboxPath: "~/.local/share/opencode",
  },
];

const CACHE_MOUNTS = LOOP_CONFIG.cache.mounts.map((mount) => ({
  hostPath: mount.hostPath,
  sandboxPath: mount.sandboxPath,
}));

const HOST_COMMAND_ENV = createHostCommandEnv({
  processEnv: process.env,
  configuredEnv: LOOP_CONFIG.cache.hostEnv,
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: tsx run-backlog-v3.mts --label <name[,name2]> [--base-branch <name>] [--idle-timeout <seconds>] [--model-coder <model>] [--model-rework <model>]";

function readStringFlag(flag: string): string | undefined {
  try {
    return readCliStringFlag(process.argv, flag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${USAGE}\n\n${message}`);
  }
}

const labelArg = readStringFlag("--label");
if (!labelArg) {
  throw new Error(`${USAGE}\n\nMissing required argument: --label <name[,name2]>`);
}
// Bind to a definitely-string const: control-flow narrowing of the original
// `string | undefined` read is not retained inside the loop's nested functions.
const label: string = labelArg;
// Support comma-separated labels (e.g. --label foo,bar). Issues must carry
// ALL specified labels to be eligible. This lets two loops on different
// machines partition the same backlog by secondary label.
const labels: string[] = label.split(",").map((l) => l.trim()).filter(Boolean);

const baseBranch = readStringFlag("--base-branch") ?? DEFAULT_BASE_BRANCH;
const modelCoderOverride = readStringFlag("--model-coder");
const modelReworkOverride = readStringFlag("--model-rework");
const CODER_MODEL = modelCoderOverride ?? LOOP_CONFIG.models.coder;
const REWORK_MODEL = modelReworkOverride ?? LOOP_CONFIG.models.rework;

let idleTimeoutSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS;
const idleRaw = readStringFlag("--idle-timeout");
if (idleRaw !== undefined) {
  const parsed = Number.parseInt(idleRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--idle-timeout must be a positive integer, got ${idleRaw}`);
  }
  idleTimeoutSeconds = parsed;
}

console.log(`Backlog label(s): ${labels.join(", ")}`);
console.log(`Base branch: ${baseBranch} (fork point: origin/${baseBranch})`);
console.log(`Idle timeout: ${idleTimeoutSeconds}s`);
console.log(
  [
    LOOP_CONFIG.loadedConfig
      ? `Sandcastle config: ${LOOP_CONFIG.configPath}`
      : `Sandcastle config: using built-in defaults; ${LOOP_CONFIG.configPath} not found`,
    `models=coder:${CODER_MODEL},rework:${REWORK_MODEL},reviewer:${REVIEWER_MODEL}`,
    `reviewerMaxAttempts=${LOOP_CONFIG.reviewer.maxAttempts}`,
    `setupCommands=${SANDBOX_READY_COMMANDS.length}`,
    `validationCommands=${VALIDATION_COMMANDS.length}`,
    `cacheMounts=${LOOP_CONFIG.cache.mounts.map((m) => m.name).join(",") || "(none)"}`,
    `cacheEnv=${Object.keys(LOOP_CONFIG.cache.sandboxEnv).join(",") || "(none)"}`,
  ].join("\n"),
);
logCoderReworkModelStartupWarning(CODER_MODEL, REWORK_MODEL);

// Companion TUI: begin emitting the read-only status snapshot for this loop.
// Side-effect-only; a failure here can never affect loop control flow. The
// backlog loop stays in the normal_issue phase (no extra-review tier).
tuiEmitter.startLoop({
  loopType: "backlog",
  loopId: labels.join(","),
  phase: "normal_issue",
});

// Capture a diagnostics bundle before dying on any otherwise-unhandled crash.
installLoopCrashHandlers({
  prd: label,
  repoRoot: REPO_ROOT,
  baseRef: originBaseRef(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sameCoderReworkModelWarning(
  coderModel: string,
  reworkModel: string,
): string | null {
  if (coderModel !== reworkModel) return null;
  return `CODER_MODEL and REWORK_MODEL are both "${coderModel}"; rework escalation is prompt-only, not model escalation.`;
}

export function logCoderReworkModelStartupWarning(
  coderModel: string,
  reworkModel: string,
  warn: (message: string) => void = console.warn,
): void {
  const message = sameCoderReworkModelWarning(coderModel, reworkModel);
  if (message) warn(message);
}

// Post-mortem capture for stuck/crash terminals. Best-effort by contract:
// recordFailureDiagnostic never throws, so wiring it into terminal paths can
// never change loop control flow.
function recordLoopFailureDiagnostic(
  input: Omit<FailureDiagnosticInput, "prd" | "baseRef">,
): void {
  recordFailureDiagnostic(
    { ...input, prd: label, baseRef: originBaseRef() },
    { repoRoot: REPO_ROOT },
  );
}

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8" });

const ghJson = <T extends unknown>(args: string[]): T =>
  JSON.parse(gh(args)) as T;

const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { encoding: "utf8", cwd });

function gitSpawn(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function originBaseRef(): string {
  return `origin/${baseBranch}`;
}

function captureWorktreeProgressSnapshot(
  worktreePath: string,
): WorktreeProgressSnapshot {
  return {
    head: git(["rev-parse", "HEAD"], worktreePath).trim(),
    porcelainStatus: git(["status", "--porcelain"], worktreePath).trim(),
  };
}

function agentRunLogPath(branch: string, runName: string): string {
  const sanitizedBranch = branch.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const sanitizedName = runName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return join(
    REPO_ROOT,
    ".sandcastle",
    "logs",
    `${sanitizedBranch}-${sanitizedName}.log`,
  );
}

function treeShaOf(ref: string, cwd?: string): string {
  return git(["rev-parse", `${ref}^{tree}`], cwd).trim();
}

function countCommitsAheadOfBase(worktreePath: string, baseRef: string): number {
  const raw = git(
    ["rev-list", "--count", `${baseRef}..HEAD`],
    worktreePath,
  ).trim();
  const parsed = Number.parseInt(raw || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function branchExists(branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", branch], {
      encoding: "utf8",
    }).status === 0
  );
}

function fetchOriginBase(worktreePath?: string): string {
  execFileSync("git", ["fetch", "origin", baseBranch], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  return git(["rev-parse", originBaseRef()], worktreePath).trim();
}

function resolveTaskBaseSha(worktreePath: string, baseRef: string): string {
  return baseRef === originBaseRef()
    ? fetchOriginBase(worktreePath)
    : git(["rev-parse", baseRef], worktreePath).trim();
}

// Fetch the mainline once at startup so origin/<base> exists and is current.
// Unlike run-prd this loop never creates the base branch; a missing mainline is
// a fatal misconfiguration.
function ensureBaseBranchAvailable(): void {
  const fetch = spawnSync("git", ["fetch", "origin", baseBranch], {
    encoding: "utf8",
  });
  if (fetch.status !== 0) {
    throw new Error(
      `Could not fetch origin/${baseBranch}. The base branch must already exist on origin.\n${`${fetch.stdout ?? ""}${fetch.stderr ?? ""}`.trim()}`,
    );
  }
}

// `gh issue edit --add-label` fails if the label does not already exist, so
// create the terminal labels up front if the repo is missing them.
function ensureLabels(): void {
  const existing = ghJson<{ name: string }[]>([
    "label",
    "list",
    "--json",
    "name",
    "--limit",
    "1000",
  ]);
  const have = new Set(existing.map((l) => l.name));
  const wanted: { name: string; color: string; description: string }[] = [
    {
      name: REVIEW_LABEL,
      color: "0e8a16",
      description: "Agent produced a review-ready branch; open a PR.",
    },
    {
      name: STUCK_LABEL,
      color: "b60205",
      description: "Agent could not land this issue; needs a human.",
    },
    {
      name: ISSUE_AS_PRD_LABELS.inProgress.name,
      color: ISSUE_AS_PRD_LABELS.inProgress.color,
      description: ISSUE_AS_PRD_LABELS.inProgress.description,
    },
    {
      name: ISSUE_AS_PRD_LABELS.partial.name,
      color: ISSUE_AS_PRD_LABELS.partial.color,
      description: ISSUE_AS_PRD_LABELS.partial.description,
    },
    {
      name: ISSUE_AS_PRD_LABELS.rebaseNeeded.name,
      color: ISSUE_AS_PRD_LABELS.rebaseNeeded.color,
      description: ISSUE_AS_PRD_LABELS.rebaseNeeded.description,
    },
  ];
  for (const wantedLabel of wanted) {
    if (have.has(wantedLabel.name)) continue;
    console.log(`Creating missing label '${wantedLabel.name}'`);
    gh([
      "label",
      "create",
      wantedLabel.name,
      "--color",
      wantedLabel.color,
      "--description",
      wantedLabel.description,
    ]);
  }
}

function preflightExistingIssueBranch(
  issue: IssueDetail,
  issueBranch: string,
): void {
  fetchOriginBase();
  if (!branchExists(issueBranch)) return;

  const baseSha = git(["rev-parse", originBaseRef()]).trim();
  const mergeBase = git(["merge-base", originBaseRef(), issueBranch]).trim();
  const diff = execFileSync(
    "git",
    [
      "diff",
      `${originBaseRef()}..${issueBranch}`,
      "--",
      ".",
      ...REVIEW_DIFF_EXCLUDES,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const changedFiles = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      `${originBaseRef()}..${issueBranch}`,
      "--",
      ".",
      ...REVIEW_DIFF_EXCLUDES,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  )
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const stale = mergeBase !== baseSha;
  const tooLarge = Buffer.byteLength(diff, "utf8") > REVIEW_DIFF_MAX_BYTES;
  const polluted = looksLikeWorkflowPollution(issue, changedFiles);
  if (!stale || (!tooLarge && !polluted)) return;

  const worktreePath = findManagedWorktreeForBranch(issueBranch);
  if (worktreePath) {
    const dirty = git(["status", "-s"], worktreePath).trim();
    if (dirty) {
      console.warn(
        `Existing branch ${issueBranch} looks stale/polluted, but managed worktree ${worktreePath} has uncommitted changes; reusing it rather than deleting work.`,
      );
      return;
    }
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      stdio: "inherit",
    });
  }

  const diagnosticBranch = `diagnostic/${issueBranch}-prestart-${Date.now()}`;
  console.warn(
    `Existing branch ${issueBranch} is stale and ${tooLarge ? "oversized" : "polluted"}; quarantining to ${diagnosticBranch} and starting fresh from ${originBaseRef()}.`,
  );
  git(["branch", "-f", diagnosticBranch, issueBranch]);
  execFileSync("git", ["branch", "-D", issueBranch], { stdio: "inherit" });
  const deleteRemote = spawnSync(
    "git",
    ["push", "origin", "--delete", issueBranch],
    { encoding: "utf8" },
  );
  if (deleteRemote.status !== 0) {
    console.warn(
      `Could not delete remote ${issueBranch}; later push may need manual cleanup. ${deleteRemote.stderr || deleteRemote.stdout || ""}`,
    );
  }
}

function findManagedWorktreeForBranch(branch: string): string | null {
  const worktreeList = git(["worktree", "list", "--porcelain"]);
  let currentPath: string | null = null;
  for (const line of worktreeList.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line === `branch refs/heads/${branch}` && currentPath) {
      return currentPath.includes("/.sandcastle/worktrees/")
        ? currentPath
        : null;
    }
  }
  return null;
}

interface IssueListItem {
  number: number;
  title?: string;
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

// Backlog issue eligibility: open, carries the target label, and carries
// neither terminal label. `skip` holds issues already handled in this run so a
// crash (which leaves no terminal label) can't wedge the loop on one issue.
function pickNextIssue(skip: ReadonlySet<number>): IssueDetail | null {
  // Fetch fresh from GitHub on every call — this is invoked inside the outer
  // loop so newly-labelled issues are picked up without restarting the script.
  const list = ghJson<IssueListItem[]>([
    "issue",
    "list",
    "--state",
    "open",
    "--json",
    "number,labels",
    "--limit",
    "200",
  ]);
  const eligible = list
    .filter((i) => {
      if (skip.has(i.number)) return false;
      if (i.labels.some((l) => l.name === STUCK_LABEL || l.name === REVIEW_LABEL)) {
        return false;
      }
      // Issue must carry ALL specified labels.
      const issueLabelNames = new Set(i.labels.map((l) => l.name));
      return labels.every((wanted) => issueLabelNames.has(wanted));
    })
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

function observeIssueAsPrdParentRecoveryState(
  parent: Pick<IssueDetail, "number" | "labels">,
): ObservedParentRecoveryState {
  const accumulationBranch = accumulationBranchName(parent.number);
  const queueLabel = queueLabelName(parent.number);

  const accumulationBranchExists =
    spawnSync(
      "git",
      ["rev-parse", "--verify", accumulationBranch],
      { encoding: "utf8" },
    ).status === 0;

  const localAccumulationHeadSha = accumulationBranchExists
    ? git(["rev-parse", accumulationBranch]).trim()
    : null;

  const remoteAccumulationHeadSha = readRemoteHead(accumulationBranch);

  const queueChildren = ghJson<Array<{ number: number; state: "OPEN" | "CLOSED" }>>([
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    "1000",
    "--label",
    queueLabel,
    "--json",
    "number,state",
  ]);
  const childNumbers = splitQueueChildren({
    parentNumber: parent.number,
    queueIssues: queueChildren,
  });

  return {
    accumulationBranchExists,
    localAccumulationHeadSha,
    remoteAccumulationHeadSha,
    parentLabels: parent.labels.map((label) => label.name),
    openChildNumbers: childNumbers.openChildNumbers,
    closedChildNumbers: childNumbers.closedChildNumbers,
  };
}

function readRemoteHead(branch: string): string | null {
  const result = spawnSync(
    "git",
    ["ls-remote", "--heads", "origin", branch],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const line = (result.stdout ?? "")
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) return null;
  const sha = line.split(/\s+/u)[0]?.trim();
  return sha ? sha : null;
}

// Detect git push's non-fast-forward rejection from its combined output. Git
// emits both a `! [rejected] ... (non-fast-forward)` line and a hint block; we
// match on either to stay robust across git versions and locales.
function isNonFastForwardRejection(pushOutput: string): boolean {
  return /non-fast-forward|!\s*\[rejected\]/i.test(pushOutput);
}

const skippedAmbiguousParentNumbers = new Set<number>();

async function acquireNextIssueAsPrdParentForLoop() {
  return acquireNextIssueAsPrdParent(
    {
      backlogLabels: labels,
      maxCommentBytes: LOOP_CONFIG.issueAsPrd.parentCommentMaxBytes,
    },
    {
      now: () => new Date().toISOString(),
      listOpenParents: () =>
        ghJson<Array<{ number: number; state: "OPEN" | "CLOSED"; labels: { name: string }[] }>>([
          "issue",
          "list",
          "--state",
          "open",
          "--json",
          "number,state,labels",
          "--limit",
          "200",
        ]).filter((issue) => !skippedAmbiguousParentNumbers.has(issue.number)),
      viewParent: (parentNumber) => issueClient().viewIssue(parentNumber),
      observeRecovery: (parent) => observeIssueAsPrdParentRecoveryState(parent),
      addInProgressLabel(parentNumber) {
        gh([
          "issue",
          "edit",
          String(parentNumber),
          "--add-label",
          ISSUE_AS_PRD_LABELS.inProgress.name,
        ]);
      },
      ensureQueueLabel(parentNumber) {
        const name = queueLabelName(parentNumber);
        const description = ISSUE_AS_PRD_LABELS.parentQueue.description.replace(
          "#N",
          `#${parentNumber}`,
        );
        gh([
          "label",
          "create",
          name,
          "--color",
          ISSUE_AS_PRD_LABELS.parentQueue.color,
          "--description",
          description,
          "--force",
        ]);
        gh([
          "issue",
          "edit",
          String(parentNumber),
          "--add-label",
          name,
        ]);
      },
      fetchMainline() {
        return fetchOriginBase();
      },
      createAccumulationBranch({ branchName, baseSha }) {
        execFileSync("git", ["branch", "-f", branchName, baseSha], {
          stdio: "inherit",
        });
      },
      pushInitialCheckpoint({ branchName, expectedHeadSha }) {
        const localHead = git(["rev-parse", branchName]).trim();
        if (localHead !== expectedHeadSha) {
          throw new Error(
            `Initial checkpoint local head mismatch for ${branchName}: expected ${expectedHeadSha}, observed ${localHead}.`,
          );
        }
        // Try a fast-forward-only push first. The accumulation branch was just
        // force-created at `expectedHeadSha`, so on a clean first claim the
        // remote either doesn't exist yet or sits at an ancestor of `expectedHeadSha`,
        // and the push succeeds. The failure mode we recover from here is a
        // *prior interrupted claim*: an earlier run pushed the initial
        // checkpoint (possibly at a different mainline tip, possibly with
        // integrated child work the durable state comment never recorded) and
        // then died before writing the state comment. On resume, the loop
        // re-runs the claim from scratch and tries to overwrite that remote
        // branch, which git rejects as non-fast-forward. Rather than clobbering
        // prior work or crashing, adopt the remote tip as the parent's true
        // original fork and let the durable state record it.
        // Capture stdout/stderr (NOT "inherit") so the non-fast-forward
        // detection regex below has actual text to match against. With
        // `stdio: "inherit"`, git's rejection output streams straight to the
        // terminal — the operator sees it, but `pushResult.stdout`/`stderr`
        // are `null`, `isNonFastForwardRejection("")` returns false, and the
        // recovery path that adopts an existing remote accumulation branch on
        // interrupted restart never runs. We pipe the streams and echo the
        // captured output to the console ourselves so the operator still sees
        // git's wording on a real failure.
        const pushResult = spawnSync(
          "git",
          ["push", "-u", "origin", `${expectedHeadSha}:refs/heads/${branchName}`],
          { stdio: ["inherit", "pipe", "pipe"] },
        );
        if (pushResult.status === 0) {
          const remoteHead = readRemoteHead(branchName);
          if (remoteHead !== expectedHeadSha) {
            throw new Error(
              `Initial checkpoint remote head mismatch for ${branchName}: expected ${expectedHeadSha}, observed ${remoteHead ?? "(missing)"}.`,
            );
          }
          return expectedHeadSha;
        }
        const pushOutput = `${pushResult.stdout ?? ""}${pushResult.stderr ?? ""}`;
        for (const stream of [pushResult.stdout, pushResult.stderr]) {
          if (stream && stream.length > 0) process.stderr.write(stream);
        }
        if (!isNonFastForwardRejection(pushOutput)) {
          // Genuine push failure (auth, network, hook rejection). Surface it
          // verbatim — the operator needs the real error, not a misleading
          // recovery message.
          throw new Error(
            `Initial checkpoint push failed for ${branchName}: ${pushOutput.trim() || `git exited ${pushResult.status}`}`,
          );
        }
        // Non-fast-forward rejection: a remote accumulation branch already
        // exists at a different SHA. Fetch it, adopt its tip as the base, and
        // re-point the local branch at it so the rest of the claim sees a
        // consistent local+remote head.
        spawnSync("git", ["fetch", "origin", branchName], {
          stdio: "inherit",
        });
        const remoteTip = readRemoteHead(branchName);
        if (!remoteTip) {
          throw new Error(
            `Initial checkpoint push for ${branchName} was rejected as non-fast-forward, but the remote branch could not be read after fetch.`,
          );
        }
        if (remoteTip === expectedHeadSha) {
          // Race: another worker pushed the same SHA between our push attempt
          // and the fetch. Nothing to adopt; the branch is already where we
          // wanted it.
          return expectedHeadSha;
        }
        execFileSync("git", ["branch", "-f", branchName, remoteTip], {
          stdio: "inherit",
        });
        const recheckedLocal = git(["rev-parse", branchName]).trim();
        if (recheckedLocal !== remoteTip) {
          throw new Error(
            `Initial checkpoint recovery for ${branchName}: local head did not match adopted remote tip ${remoteTip} after reset (observed ${recheckedLocal}).`,
          );
        }
        console.warn(
          `Initial checkpoint for ${branchName}: adopted existing remote tip ${remoteTip.slice(0, 12)} as originalForkSha after non-fast-forward rejection (expected ${expectedHeadSha.slice(0, 12)}).`,
        );
        return remoteTip;
      },
      createStateComment({ parentNumber, body }) {
        const response = ghJson<{ id: number }>([
          "api",
          `repos/${repoOwnerAndName()}/issues/${parentNumber}/comments`,
          "--method",
          "POST",
          "-F",
          `body=${body}`,
        ]);
        return response.id;
      },
      updateStateComment({ commentId, body }) {
        issueClient().updateComment(commentId, body);
      },
      removeStuckLabelFromOpenChildren({ parentNumber, queueLabel }) {
        const stuckChildren = listIssueAsPrdParentChildren({
          parentNumber,
          queueLabel,
          client: issueClient(),
        }).filter(
          (child) =>
            child.state === "OPEN" &&
            child.labels.some((label) => label.name === AGENT_STUCK_LABEL),
        );
        for (const child of stuckChildren) {
          console.log(
            `  requeue: removing ${AGENT_STUCK_LABEL} from open child #${child.number}`,
          );
          gh([
            "issue",
            "edit",
            String(child.number),
            "--remove-label",
            AGENT_STUCK_LABEL,
          ]);
        }
      },
    },
  );
}

let cachedRepoOwnerAndName: string | null = null;
let cachedRepoRef: GitHubRepoRef | null = null;
let cachedIssueClient: GitHubIssuesClient | null = null;

function repoOwnerAndName(): string {
  if (cachedRepoOwnerAndName) return cachedRepoOwnerAndName;
  const remote = git(["remote", "get-url", "origin"]).trim();
  const match =
    remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/u) ??
    remote.match(/([^/:]+\/[^/]+?)(?:\.git)?$/u);
  if (!match?.[1]) {
    throw new Error(`Could not parse owner/repo from origin remote: ${remote}`);
  }
  cachedRepoOwnerAndName = match[1];
  return cachedRepoOwnerAndName;
}

function repoRef(): GitHubRepoRef {
  if (cachedRepoRef) return cachedRepoRef;
  const [owner, repo] = repoOwnerAndName().split("/");
  if (!owner || !repo) {
    throw new Error(`Could not split owner/repo from ${repoOwnerAndName()}`);
  }
  cachedRepoRef = { owner, repo };
  return cachedRepoRef;
}

function issueClient(): GitHubIssuesClient {
  if (cachedIssueClient) return cachedIssueClient;
  cachedIssueClient = new GitHubIssuesClient(repoRef());
  return cachedIssueClient;
}

function toIssueDetail(issue: GitHubIssueRecord): IssueDetail {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    comments: issue.comments,
    labels: issue.labels,
  };
}

function dockerSandboxProvider() {
  return docker({
    mounts: [...OPENCODE_MOUNTS, ...CACHE_MOUNTS],
    env: LOOP_CONFIG.cache.sandboxEnv,
  });
}

function sandboxReadyHooks() {
  return {
    sandbox: {
      onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({ command })),
    },
  };
}

type AggregateValidationCommandInput = {
  gate: "pre_review" | "pre_delivery";
  command: string;
  accumulationSha: string;
};

type AggregateValidationCommandResult =
  | { ok: true }
  | { ok: false; exitCode: number; output: string };

function createAggregateValidationCommandRunner(parentNumber: number) {
  const sessions = new Map<
    string,
    { worktreePath: string; setupFailure?: AggregateValidationCommandResult }
  >();

  function createSession(accumulationSha: string) {
    const worktreePath = join(
      REPO_ROOT,
      ".sandcastle",
      "worktrees",
      `aggregate-${accumulationSha.slice(0, 12)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    execFileSync(
      "git",
      ["worktree", "add", "--detach", worktreePath, accumulationSha],
      { stdio: "inherit" },
    );

    const session: {
      worktreePath: string;
      setupFailure?: AggregateValidationCommandResult;
    } = { worktreePath };
    for (const command of aggregateDependencySetupCommands({
      hasPackageLock: existsSync(join(worktreePath, "package-lock.json")),
      hasUvLock: existsSync(join(worktreePath, "uv.lock")),
    })) {
      const result = spawnSync(command, {
        shell: true,
        cwd: worktreePath,
        encoding: "utf8",
        env: HOST_COMMAND_ENV,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) {
        session.setupFailure = {
          ok: false,
          exitCode: result.status ?? 1,
          output: [
            `Aggregate validation setup failed: ${command}`,
            `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
          ].join("\n"),
        };
        break;
      }
    }
    sessions.set(accumulationSha, session);
    return session;
  }

  return {
    async run(input: AggregateValidationCommandInput): Promise<AggregateValidationCommandResult> {
      tuiEmitter.beginHostStep("aggregate_validation", input.command);
      const startedMs = Date.now();
      let result: AggregateValidationCommandResult;
      try {
        const session = sessions.get(input.accumulationSha) ??
          createSession(input.accumulationSha);
        if (session.setupFailure) {
          result = session.setupFailure;
        } else {
          const commandResult = spawnSync(
            resolveHostValidationCommand(input.command, REPO_ROOT),
            {
              shell: true,
              cwd: session.worktreePath,
              encoding: "utf8",
              env: HOST_COMMAND_ENV,
              maxBuffer: 16 * 1024 * 1024,
            },
          );
          result = commandResult.status === 0
            ? { ok: true }
            : {
                ok: false,
                exitCode: commandResult.status ?? 1,
                output: `${commandResult.stdout ?? ""}${commandResult.stderr ?? ""}`.trim(),
              };
        }
      } catch (error) {
        result = {
          ok: false,
          exitCode: 1,
          output: error instanceof Error ? error.message : String(error),
        };
      }
      const endedMs = Date.now();
      recordValidationRun(
        {
          prd: label,
          issue: parentNumber,
          round: input.gate,
          gate: "issue",
          command: input.command,
          commandIndex: 0,
        },
        {
          startedMs,
          endedMs,
          status: result.ok ? "success" : "failed",
          exitCode: result.ok ? 0 : result.exitCode,
        },
      );
      return result;
    },
    close() {
      for (const session of sessions.values()) {
        spawnSync("git", ["worktree", "remove", "--force", session.worktreePath], {
          encoding: "utf8",
        });
      }
      sessions.clear();
    },
  };
}

async function runIssueAsPrdPromptSession(input: {
  branch: string;
  baseRef: string;
  stage: "initial_issue_decomposer" | "subtask_readiness";
  runName: string;
  model: string;
  promptFile: string;
  promptArgs: Record<string, string>;
}): Promise<{ stdout: string }> {
  const agentDefinition =
    input.stage === "initial_issue_decomposer"
      ? {
          config: INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG,
          systemPromptFile: INITIAL_ISSUE_DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE,
        }
      : {
          config: SUBTASK_READINESS_AGENT_CONFIG,
          systemPromptFile: SUBTASK_READINESS_AGENT_SYSTEM_PROMPT_FILE,
        };
  const sandbox = await sandcastle.createSandbox({
    sandbox: dockerSandboxProvider(),
    branch: input.branch,
    baseBranch: input.baseRef,
    copyToWorktree: COPY_TO_WORKTREE,
    hooks: sandboxReadyHooks(),
  });
  ensureOpencodeGitExclude(sandbox.worktreePath);
  writeAgentDefinitionFile(
    sandbox.worktreePath,
    agentDefinition.config.name,
    buildAgentDefinition(
      agentDefinition.config,
      input.model,
      readFileSync(agentDefinition.systemPromptFile, "utf8"),
    ),
  );

  const activeLogPath = tuiWorkingLogPath(input.runName);
  const sessionLogPath = agentRunLogPath(input.branch, input.runName);
  const outputTag = input.stage === "initial_issue_decomposer"
    ? "initial_issue_decomposition"
    : "subtask_readiness";
  try {
    const result = await sandbox.run({
      name: input.runName,
      agent: sandcastle.opencode(input.model, {
        agent: agentDefinition.config.name,
      }),
      maxIterations: 1,
      completionSignal:
        input.stage === "initial_issue_decomposer"
          ? "</initial_issue_decomposition>"
          : "</subtask_readiness>",
      idleTimeoutSeconds,
      promptFile: input.promptFile,
      promptArgs: input.promptArgs,
      logging: {
        type: "file",
        path: sessionLogPath,
        onAgentStreamEvent: tuiEmitter.workingLogSink(activeLogPath),
      },
    });
    const recoveredOutput = existsSync(sessionLogPath)
      ? extractSingleTaggedOutput(readFileSync(sessionLogPath, "utf8"), outputTag)
      : undefined;
    if (recoveredOutput) return { stdout: recoveredOutput };
    return { stdout: result.stdout };
  } finally {
    await sandbox.close();
  }
}

interface ReviewContext {
  baseSha: string;
  diff: string;
  diffBytes: number;
  diffStat: string;
  changedFiles: string[];
  reviewAspects: string[];
  ecosystems: string[];
}

function computeReviewContext(
  worktreePath: string,
  baseSha: string,
): ReviewContext {
  const diff = execFileSync(
    "git",
    ["diff", `${baseSha}..HEAD`, "--", ".", ...REVIEW_DIFF_EXCLUDES],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const changedFiles = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      `${baseSha}..HEAD`,
      "--",
      ".",
      ...REVIEW_DIFF_EXCLUDES,
    ],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: 1024 * 1024 },
  )
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const diffStat = execFileSync(
    "git",
    ["diff", "--stat", `${baseSha}..HEAD`, "--", ".", ...REVIEW_DIFF_EXCLUDES],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: 1024 * 1024 },
  ).trim();
  const ecosystems = detectEcosystems(worktreePath, changedFiles);
  const reviewAspects = classifyReviewAspects(diff, changedFiles);
  return {
    baseSha,
    diff,
    diffBytes: Buffer.byteLength(diff, "utf8"),
    diffStat: diffStat || "(no diff stat)",
    changedFiles,
    reviewAspects,
    ecosystems,
  };
}

function detectEcosystems(
  worktreePath: string,
  changedFiles: string[],
): string[] {
  const ecosystems = new Set<string>();
  const has = (path: string) =>
    existsSync(join(worktreePath, path)) || changedFiles.includes(path);
  if (has("package.json")) ecosystems.add("node");
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    ecosystems.add("python");
  }
  if (has("go.mod")) ecosystems.add("go");
  if (has("Cargo.toml")) ecosystems.add("rust");
  if (has("Gemfile")) ecosystems.add("ruby");
  if (has("composer.json")) ecosystems.add("php");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    ecosystems.add("jvm");
  }
  if (has("mix.exs")) ecosystems.add("elixir");
  if (has("Package.swift")) ecosystems.add("swift");
  return [...ecosystems].sort();
}

function classifyReviewAspects(diff: string, changedFiles: string[]): string[] {
  const aspects = new Set<string>(["code", "scope"]);
  const changedLineText = diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line))
    .join("\n");

  const testFiles = changedFiles.filter(isTestFile);
  const sourceFiles = changedFiles.filter(isSourceFile);
  if (testFiles.length > 0 || sourceFiles.length > 0) aspects.add("tests");
  if (changedFiles.some(isConfigBuildFile)) aspects.add("config-build");
  if (
    /\b(try|catch|except|raise|throw|throws|panic!?|recover|finally|defer|Result|Err|Error|\.catch|onError|fallback|rollback|null|undefined|None|nil|unwrap|expect)\b/i.test(
      changedLineText,
    )
  ) {
    aspects.add("errors");
  }
  if (
    /\b(interface|type|struct|class|enum|trait|impl|record|dataclass|TypedDict|BaseModel|schema|model|DTO|Request|Response|message|protobuf|z\.object)\b/i.test(
      changedLineText,
    )
  ) {
    aspects.add("types-contracts");
  }
  if (
    /(^|\n)[+-]\s*(\/\/|#|\/\*|\*|"""|'''|--|;|<!--|\/\/\/|\/\/!)/.test(diff) ||
    changedFiles.some((f) => /\.(md|mdx|rst|adoc|txt)$/i.test(f))
  ) {
    aspects.add("comments-docs");
  }
  if (
    /\b(goroutine|go\s+func|chan|channel|mutex|lock|async|await|Promise|tokio|thread|spawn|context\.Context|cancel|AbortController|useEffect|cleanup|defer)\b/i.test(
      changedLineText,
    )
  ) {
    aspects.add("concurrency-lifecycle");
  }
  if (
    /\b(select|insert|update|delete|migration|transaction|sql|query|db\.|database|fetch|axios|http|request|response|readFile|writeFile|open\(|fs\.|os\.)\b/i.test(
      changedLineText,
    )
  ) {
    aspects.add("persistence-io");
  }
  if (
    /\b(auth|permission|role|policy|token|secret|password|session|cookie|csrf|cors|crypto|encrypt|decrypt|validate|sanitize)\b/i.test(
      changedLineText,
    )
  ) {
    aspects.add("security-auth");
  }
  return [...aspects].sort();
}

function isTestFile(file: string): boolean {
  const normalized = file.toLowerCase();
  return (
    /(^|\/)(__tests__|tests?|specs?|testing)(\/|$)/.test(normalized) ||
    /(^|\/)testdata(\/|$)/.test(normalized) ||
    /(^|\/)test_[^/]+$/.test(normalized) ||
    /(^|\/)[^/]+(_test|_spec)\.[^/.]+$/.test(normalized) ||
    /(^|\/)[^/]+\.(test|spec)\.[^/.]+$/.test(normalized) ||
    /(^|\/)[^/]+tests?\.(java|cs)$/.test(normalized)
  );
}

function isSourceFile(file: string): boolean {
  if (
    /(^|\/)(node_modules|vendor|dist|build|target|\.next|\.venv|coverage)(\/|$)/.test(
      file,
    )
  ) {
    return false;
  }
  if (isTestFile(file) || isConfigBuildFile(file)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|rb|php|c|cc|cpp|h|hpp|swift|scala|ex|exs|clj|cljs|erl|hrl|lua|dart)$/i.test(
    file,
  );
}

function isConfigBuildFile(file: string): boolean {
  const base = file.split("/").pop()?.toLowerCase() ?? file.toLowerCase();
  return (
    [
      "package.json",
      "pyproject.toml",
      "requirements.txt",
      "setup.py",
      "go.mod",
      "cargo.toml",
      "gemfile",
      "composer.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "makefile",
      "dockerfile",
      "tsconfig.json",
      "vite.config.ts",
      "webpack.config.js",
      "eslint.config.js",
      ".eslintrc",
      ".prettierrc",
    ].includes(base) || /\.(ya?ml|toml|json|ini|cfg|conf)$/i.test(file)
  );
}

function flattenComments(comments: IssueComment[]): string {
  if (comments.length === 0) return "(no comments)";
  return comments
    .map((c) => `### @${c.author.login} — ${c.createdAt}\n\n${c.body}`)
    .join("\n\n");
}

type GateResult =
  | { ok: true }
  | { ok: false; feedback: string; signature: string };

function summarizeFailureOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim().length > 0);

  const isNoise = (l: string) =>
    /^npm (error|warn|notice)\b/i.test(l) ||
    /^\s*>\s/.test(l) ||
    /Lifecycle script .* failed/.test(l) ||
    /^npm error code\b/i.test(l) ||
    /^npm error path\b/i.test(l) ||
    /^npm error workspace\b/i.test(l) ||
    /^npm error location\b/i.test(l) ||
    /^npm error command\b/i.test(l);

  const errorPatterns = [
    /error TS\d+:/i,
    /error\[E\d+\]/,
    /ModuleNotFoundError\b/,
    /^Failed to resolve import\b/,
    /^\s*Cannot find module\b/,
    /^FAIL\s/,
    /^\s*×\s/,
    /^\s*✗\s/,
    /^\s*❯\s/,
    /\bcompilation failed\b/i,
    /\bbuild failed\b/i,
    /^Error:\s/,
    /^\s*panic:\s/i,
    /^\s*thread .* panicked\b/,
  ];

  for (const pattern of errorPatterns) {
    const idx = lines.findIndex((l) => pattern.test(l) && !isNoise(l));
    if (idx >= 0) {
      return lines
        .slice(idx, Math.min(idx + 3, lines.length))
        .join(" | ")
        .slice(0, 280);
    }
  }

  const tail = lines
    .filter((l) => !isNoise(l))
    .slice(-3)
    .join(" | ");
  return tail.slice(0, 280) || "(no informative output)";
}

function runValidationGate(
  worktreePath: string,
  context: {
    prd: string;
    issue?: number;
    round: number | string;
    gate: "issue";
  },
): GateResult {
  for (const [index, cmd] of VALIDATION_COMMANDS.entries()) {
    tuiEmitter.beginHostStep("validation", cmd);
    console.log(`  $ ${cmd}`);
    const startedMs = Date.now();
    const result = spawnSync(resolveHostValidationCommand(cmd, REPO_ROOT), {
      shell: true,
      cwd: worktreePath,
      encoding: "utf8",
      env: HOST_COMMAND_ENV,
    });
    const endedMs = Date.now();
    recordValidationRun(
      {
        prd: context.prd,
        issue: context.issue,
        round: context.round,
        gate: context.gate,
        command: cmd,
        commandIndex: index,
      },
      {
        startedMs,
        endedMs,
        status: result.status === 0 ? "success" : "failed",
        exitCode: result.status,
      },
    );
    const elapsedS = ((endedMs - startedMs) / 1000).toFixed(1);
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      const summary = summarizeFailureOutput(output);
      console.log(
        `    ✗ failed (exit ${result.status}) in ${elapsedS}s: ${summary}`,
      );
      return {
        ok: false,
        signature: `${cmd} :: ${summary}`,
        feedback: formatHostValidationFailureFeedback({ output }),
      };
    }
    console.log(`    ✓ ${elapsedS}s`);
  }
  return { ok: true };
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
            const meta = [
              f.aspect ? `aspect: ${f.aspect}` : null,
              typeof f.confidence === "number"
                ? `confidence: ${f.confidence}`
                : null,
              f.severity ? `severity: ${f.severity}` : null,
            ]
              .filter(Boolean)
              .join(", ");
            return [
              `### Finding ${i + 1}${loc ? ` (${loc})` : ""}`,
              meta ? `_${meta}_` : "",
              "",
              `**Problem:** ${f.problem}`,
              "",
              `**Fix:** ${f.remediation}`,
            ]
              .filter((line) => line !== "")
              .join("\n");
          })
          .join("\n\n");
  return [header, "", `**Summary:** ${review.summary}`, "", findings].join(
    "\n",
  );
}

function buildValidationFailureFingerprint(
  reviewDiff: string,
  signature: string,
): {
  diffHash: string;
  source: "validation";
  signatureHash: string;
  signatureSummary: string;
} {
  return {
    diffHash: sha1(normalizeForHash(reviewDiff)),
    source: "validation",
    signatureHash: sha1(normalizeForHash(signature)),
    signatureSummary: normalizeSignatureSummary(signature),
  };
}

function buildReviewerFailureFingerprint(
  reviewDiff: string,
  review: ReviewResult,
): {
  diffHash: string;
  source: "reviewer_changes_requested";
  signatureHash: string;
  signatureSummary: string;
} {
  const canonicalFindings = review.findings.map((finding) => ({
    problem: normalizeForHash(finding.problem),
    remediation: normalizeForHash(finding.remediation),
    file: finding.file ?? "",
    line: finding.line ?? null,
  }));
  return {
    diffHash: sha1(normalizeForHash(reviewDiff)),
    source: "reviewer_changes_requested",
    signatureHash: sha1(JSON.stringify(canonicalFindings)),
    signatureSummary: canonicalFindings
      .slice(0, 2)
      .map((finding) => finding.problem)
      .join(" | ")
      .slice(0, 300),
  };
}

function normalizeForHash(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeSignatureSummary(value: string): string {
  return value.replace(/\r\n/g, "\n").trim().slice(0, 300);
}

function formatNoProgressFeedback(input: {
  round: number;
  source: string;
  repeatedCount: number;
  signatureSummary: string;
  lastFeedback: string;
}): string {
  return [
    "## No progress",
    "",
    `Stopped early after round ${input.round}: the same failed ${input.source} outcome repeated ${input.repeatedCount + 1} times in total.`,
    "",
    `Repeated outcome source: ${input.source}`,
    `Signature summary: ${input.signatureSummary || "(none)"}`,
    `Repeat count: ${input.repeatedCount + 1} total identical failures`,
    "",
    "Last feedback:",
    "",
    input.lastFeedback || "(none recorded)",
  ].join("\n");
}

function formatReviewerAcquisitionFeedback(input: {
  header: string;
  round: number;
  attempt: number;
  maxAttempts: number;
  runName: string;
  reviewBaseSha: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  logFilePath?: string;
  resultSource: "stdout" | "run_log" | "none";
  failureCode: string;
  excerpt: string;
  diagnostics: string[];
}): string {
  return [
    input.header,
    "",
    `Issue round: ${input.round}`,
    `Reviewer attempt: ${input.attempt}/${input.maxAttempts}`,
    `Reviewer run: ${input.runName}`,
    `Review base SHA: ${input.reviewBaseSha}`,
    `Candidate HEAD: ${input.candidateHeadSha}`,
    `Candidate tree: ${input.candidateTreeSha}`,
    `Reviewer log: ${input.logFilePath ?? "(unavailable)"}`,
    `Result source: ${input.resultSource}`,
    `Failure code: ${input.failureCode}`,
    input.diagnostics.length > 0
      ? `Diagnostics: ${input.diagnostics.join("; ")}`
      : null,
    "",
    "Reviewer excerpt:",
    "",
    input.excerpt || "(no assistant excerpt available)",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pre-coder rebase guard
// ---------------------------------------------------------------------------

type RebaseGuardResult =
  | { ok: true; rebased: boolean }
  | { ok: false; feedback: string };

function formatRebaseGuardFeedback(
  input:
    | { kind: "dirty_worktree"; baseRef: string; baseSha: string; detail: string }
    | { kind: "conflict"; baseRef: string; baseSha: string; conflicts: string; detail: string },
): string {
  if (input.kind === "dirty_worktree") {
    return [
      "## Worktree not clean: resolve before implementing",
      "",
      `The issue branch worktree has uncommitted changes left over from an earlier run, so the host could not rebase it onto \`${input.baseRef}\` (\`${input.baseSha.slice(0, 8)}\`).`,
      "",
      "Before implementing the issue: inspect the uncommitted changes with `git status` and `git diff`. Commit them if they belong to this issue, or discard them (`git checkout -- <file>` / `git clean -fd` for untracked leftovers) if they do not.",
      `Then rebase the branch onto \`${input.baseRef}\` yourself (\`git rebase ${input.baseRef}\`), resolve any conflicts, and continue with the issue.`,
      "",
      "Uncommitted changes:",
      "```",
      input.detail.slice(0, 3000),
      "```",
    ].join("\n");
  }
  return [
    "## Rebase conflict with base branch: resolve before implementing",
    "",
    `The issue branch carries commits from an earlier run that conflict with the current base \`${input.baseRef}\` (\`${input.baseSha.slice(0, 8)}\`). The host aborted its automatic rebase; you must complete it:`,
    "",
    `1. Run \`git rebase ${input.baseRef}\`.`,
    "2. Resolve each conflicted file. For generated lockfiles (package-lock.json, uv.lock, etc.), do not hand-merge: take the base branch's version (`git checkout --ours <lockfile>` during the rebase) and regenerate it from the manifest afterwards (e.g. `npm install --package-lock-only`) so it reflects both sides' dependency changes.",
    "3. `git add` the resolved files and run `git rebase --continue` until the rebase finishes.",
    "4. Re-verify the branch still satisfies the issue, commit anything missing, and finish as usual.",
    "",
    input.conflicts
      ? `Conflicted files:\n\`\`\`\n${input.conflicts.slice(0, 3000)}\n\`\`\``
      : "(no conflicted files detected)",
    "",
    "Rebase output (truncated):",
    "```",
    input.detail.slice(-3000),
    "```",
  ].join("\n");
}

// Pre-coder guard: bring a resumed, stale issue branch onto the current base
// BEFORE the coder runs. A conflict or dirty worktree here is not terminal:
// the guard's feedback is handed to the coder (in rework mode) so the agent
// can resolve the rebase itself before implementing the issue.
function rebaseStaleIssueBranchBeforeCoder(
  worktreePath: string,
  issueBranch: string,
  baseRef: string,
): RebaseGuardResult {
  const baseSha = resolveTaskBaseSha(worktreePath, baseRef);
  const mergeBase = git(
    ["merge-base", baseRef, "HEAD"],
    worktreePath,
  ).trim();
  if (mergeBase === baseSha) return { ok: true, rebased: false }; // not stale

  const dirty = git(["status", "--porcelain"], worktreePath).trim();
  if (dirty) {
    return {
      ok: false,
      feedback: formatRebaseGuardFeedback({
        kind: "dirty_worktree",
        baseRef,
        baseSha,
        detail: dirty,
      }),
    };
  }

  console.log(
    `  ${issueBranch} is stale vs ${baseRef}; rebasing before coder`,
  );
  const rebase = gitSpawn(["rebase", baseRef], worktreePath);
  if (rebase.status === 0) return { ok: true, rebased: true };

  // Capture conflicts BEFORE aborting, then restore the pre-rebase state.
  const conflicts = git(
    ["diff", "--name-only", "--diff-filter=U"],
    worktreePath,
  ).trim();
  const output = `${rebase.stdout || ""}\n${rebase.stderr || ""}`.trim();
  gitSpawn(["rebase", "--abort"], worktreePath);
  return {
    ok: false,
      feedback: formatRebaseGuardFeedback({
        kind: "conflict",
        baseRef,
      baseSha,
      conflicts,
      detail: output,
    }),
  };
}

type PrepResult =
  | { ok: true; baseSha: string; recoveryAttempts: number }
  | { ok: false; feedback: string; recoveryAttempts: number };

function prepareBranchForReview(
  worktreePath: string,
  issueBranch: string,
  baseRef: string,
  recoveryAttempts: number,
): PrepResult {
  const baseSha = resolveTaskBaseSha(worktreePath, baseRef);
  const oldHead = git(["rev-parse", "HEAD"], worktreePath).trim();
  console.log(`  rebasing ${issueBranch} onto ${baseRef}`);
  const rebase = gitSpawn(["rebase", baseRef], worktreePath);
  if (rebase.status !== 0) {
    gitSpawn(["rebase", "--abort"], worktreePath);
    console.log(`  rebase failed; attempting fresh branch recovery`);
    return recoverFreshBranch(
      worktreePath,
      issueBranch,
      baseRef,
      oldHead,
      recoveryAttempts,
      `rebase onto ${baseRef} failed`,
      `${rebase.stdout || ""}\n${rebase.stderr || ""}`.trim(),
    );
  }

  const mergeBase = git(
    ["merge-base", baseRef, "HEAD"],
    worktreePath,
  ).trim();
  if (mergeBase !== baseSha) {
    console.log(
      `  branch ancestry is not clean; attempting fresh branch recovery`,
    );
    return recoverFreshBranch(
      worktreePath,
      issueBranch,
      baseRef,
      git(["rev-parse", "HEAD"], worktreePath).trim(),
      recoveryAttempts,
      `merge-base ${mergeBase} did not match reviewed base ${baseSha}`,
      "",
    );
  }

  return { ok: true, baseSha, recoveryAttempts };
}

function recoverFreshBranch(
  worktreePath: string,
  issueBranch: string,
  baseRef: string,
  oldHead: string,
  recoveryAttempts: number,
  reason: string,
  detail: string,
): PrepResult {
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    return {
      ok: false,
      recoveryAttempts,
      feedback: [
        "## Branch recovery failed",
        "",
        `The host tried to recover this issue branch ${MAX_RECOVERY_ATTEMPTS} time(s), but the branch still could not be prepared for validation/review.`,
        "",
        `Reason: ${reason}`,
        detail ? `\nDetails:\n\`\`\`\n${detail.slice(-3000)}\n\`\`\`` : "",
        "",
        "Continue from the current branch state, reduce the diff to this issue's scope, resolve conflicts if present, commit, and emit `<promise>COMPLETE</promise>`.",
      ].join("\n"),
    };
  }

  const attempt = recoveryAttempts + 1;
  const diagnosticBranch = `diagnostic/${issueBranch}-recovery-${attempt}`;
  const baseSha = resolveTaskBaseSha(worktreePath, baseRef);
  const oldBase = git(
    ["merge-base", baseRef, oldHead],
    worktreePath,
  ).trim();
  const commits = git(
    ["rev-list", "--reverse", `${baseRef}..${oldHead}`],
    worktreePath,
  )
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);

  console.log(
    `  recovery ${attempt}/${MAX_RECOVERY_ATTEMPTS}: replaying ${commits.length} commit(s) on ${baseRef}`,
  );
  gitSpawn(["branch", "-f", diagnosticBranch, oldHead], worktreePath);
  execFileSync("git", ["reset", "--hard", baseSha], {
    cwd: worktreePath,
    stdio: "inherit",
  });

  if (commits.length > 0) {
    const pick = gitSpawn(["cherry-pick", ...commits], worktreePath);
    if (pick.status === 0) {
      return { ok: true, baseSha, recoveryAttempts: attempt };
    }
    gitSpawn(["cherry-pick", "--abort"], worktreePath);
    execFileSync("git", ["reset", "--hard", baseSha], {
      cwd: worktreePath,
      stdio: "inherit",
    });
    console.log(`  cherry-pick recovery failed; trying net patch replay`);
  }

  const patch = execFileSync(
    "git",
    ["diff", `${oldBase}..${oldHead}`, "--", "."],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (!patch.trim()) {
    return {
      ok: false,
      recoveryAttempts: attempt,
      feedback: [
        "## Branch recovery found no issue changes",
        "",
        `The branch looked polluted or stale, but replay from ${oldBase} to ${oldHead} produced an empty patch.`,
        "",
        "Re-read the issue, make the required scoped changes on the fresh branch, commit, and emit `<promise>COMPLETE</promise>`.",
      ].join("\n"),
    };
  }

  const apply = spawnSync("git", ["apply", "--3way", "--index"], {
    cwd: worktreePath,
    encoding: "utf8",
    input: patch,
  });
  if (apply.status !== 0) {
    execFileSync("git", ["reset", "--hard", baseSha], {
      cwd: worktreePath,
      stdio: "inherit",
    });
    return {
      ok: false,
      recoveryAttempts: attempt,
      feedback: [
        "## Branch recovery needs coder help",
        "",
        `The host could not replay this issue's patch onto ${baseRef}.`,
        "",
        `Reason: ${reason}`,
        "",
        "Patch replay output:",
        "```",
        `${apply.stdout || ""}\n${apply.stderr || ""}`.trim().slice(-3000),
        "```",
        "",
        `A local diagnostic branch was left at \`${diagnosticBranch}\`. Continue from the fresh branch, re-apply only the issue-scoped changes, commit, and emit \`<promise>COMPLETE</promise>\`.`,
      ].join("\n"),
    };
  }

  execFileSync(
    "git",
    ["commit", "-m", `recover ${issueBranch} on ${baseRef}`],
    { cwd: worktreePath, stdio: "inherit" },
  );
  return { ok: true, baseSha, recoveryAttempts: attempt };
}

function maybeRecoverOversizedOrPollutedDiff(
  worktreePath: string,
  issue: IssueDetail,
  issueBranch: string,
  baseRef: string,
  context: ReviewContext,
  recoveryAttempts: number,
): PrepResult {
  const tooLarge = context.diffBytes > REVIEW_DIFF_MAX_BYTES;
  const workflowPollution = looksLikeWorkflowPollution(
    issue,
    context.changedFiles,
  );
  if (!tooLarge && !workflowPollution) {
    return { ok: true, baseSha: context.baseSha, recoveryAttempts };
  }
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    return {
      ok: false,
      recoveryAttempts,
      feedback: tooLarge
        ? formatDiffTooLargeFeedback(context)
        : formatWorkflowPollutionFeedback(context),
    };
  }
  const reason = tooLarge
    ? `review diff is ${context.diffBytes} bytes, above ${REVIEW_DIFF_MAX_BYTES}`
    : "review diff includes likely workflow-file pollution";
  return recoverFreshBranch(
    worktreePath,
    issueBranch,
    baseRef,
    git(["rev-parse", "HEAD"], worktreePath).trim(),
    recoveryAttempts,
    reason,
    context.diffStat,
  );
}

function looksLikeWorkflowPollution(
  issue: IssueDetail,
  changedFiles: string[],
): boolean {
  const issueText = `${issue.title}\n${issue.body ?? ""}`.toLowerCase();
  if (issueText.includes("sandcastle") || issueText.includes(".sandcastle")) {
    return false;
  }
  return (
    changedFiles.some((f) => f.startsWith(".sandcastle/")) &&
    changedFiles.some((f) => !f.startsWith(".sandcastle/"))
  );
}

// The reviewer diff is passed to opencode as a single CLI argument, so the
// Linux execve argv limit (~128KB system-wide) is a hard technical ceiling —
// not a preference for small changes. Oversized diffs cannot be reviewed at
// all, so we ask the coder to split the work rather than reduce ambition.
function formatDiffTooLargeFeedback(context: ReviewContext): string {
  return [
    "## Diff too large to review",
    "",
    `The review diff is ${context.diffBytes} bytes, above the ${REVIEW_DIFF_MAX_BYTES} byte limit.`,
    "",
    "This is a hard technical constraint: the diff is passed to the reviewer as a single command-line argument and the OS caps argument size. A diff over the limit cannot be reviewed at all.",
    "",
    "Remove unrelated or generated changes from the branch. If the issue genuinely requires a change larger than the limit, split it into smaller commits that each stay reviewable, and keep this branch scoped to what fits.",
    "",
    "Changed files:",
    "```",
    context.changedFiles.join("\n").slice(0, 3000) || "(none)",
    "```",
    "",
    "Diff stat:",
    "```",
    context.diffStat.slice(0, 3000),
    "```",
  ].join("\n");
}

function formatWorkflowPollutionFeedback(context: ReviewContext): string {
  return [
    "## Diff includes workflow-file pollution",
    "",
    "The review diff includes `.sandcastle/` workflow files alongside product files, but this issue does not appear to be about Sandcastle workflow changes.",
    "",
    "Remove unrelated workflow changes from the issue branch, keep only this issue's scoped product changes, commit, and emit `<promise>COMPLETE</promise>`.",
    "",
    "Changed files:",
    "```",
    context.changedFiles.join("\n").slice(0, 3000),
    "```",
  ].join("\n");
}

function pushIssueBranch(
  worktreePath: string,
  issueBranch: string,
  purpose: "review" | "stuck",
): void {
  for (let attempt = 1; attempt <= MAX_PUSH_RECOVERY_ATTEMPTS; attempt++) {
    const localHead = git(["rev-parse", "HEAD"], worktreePath).trim();
    const lsRemote = spawnSync(
      "git",
      ["ls-remote", "--heads", "origin", issueBranch],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (lsRemote.status !== 0) {
      throw new Error(
        `Could not inspect remote ${issueBranch} before ${purpose} push:\n${`${lsRemote.stdout ?? ""}${lsRemote.stderr ?? ""}`.trim()}`,
      );
    }

    const remoteLine = (lsRemote.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    const remoteSha = remoteLine?.split(/\s+/)[0] ?? "";

    if (!remoteSha) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${issueBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      throw new Error(
        `Could not create remote ${issueBranch} for ${purpose} push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const fetch = spawnSync("git", ["fetch", "origin", issueBranch], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    if (fetch.status !== 0) {
      throw new Error(
        `Could not fetch remote ${issueBranch} before ${purpose} push:\n${`${fetch.stdout ?? ""}${fetch.stderr ?? ""}`.trim()}`,
      );
    }

    if (remoteSha === localHead) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${issueBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      throw new Error(
        `Could not update remote ${issueBranch} for ${purpose} push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const fastForward =
      spawnSync(
        "git",
        ["merge-base", "--is-ancestor", remoteSha, localHead],
        { cwd: worktreePath, encoding: "utf8" },
      ).status === 0;

    if (fastForward) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${issueBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      if (attempt < MAX_PUSH_RECOVERY_ATTEMPTS) continue;
      throw new Error(
        `Could not fast-forward remote ${issueBranch} for ${purpose} push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const diagnosticBranch = `diagnostic/${issueBranch}-prepush-${Date.now()}`;
    console.warn(
      `  remote ${issueBranch} diverged from local HEAD; archiving ${remoteSha.slice(0, 7)} to ${diagnosticBranch} and replacing ${issueBranch} with lease protection`,
    );
    const archive = spawnSync(
      "git",
      ["push", "origin", `${remoteSha}:refs/heads/${diagnosticBranch}`],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (archive.status !== 0) {
      throw new Error(
        `Could not archive remote ${issueBranch} to ${diagnosticBranch}:\n${`${archive.stdout ?? ""}${archive.stderr ?? ""}`.trim()}`,
      );
    }

    const replace = spawnSync(
      "git",
      [
        "push",
        `--force-with-lease=refs/heads/${issueBranch}:${remoteSha}`,
        "-u",
        "origin",
        `HEAD:refs/heads/${issueBranch}`,
      ],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (replace.status === 0) return;
    if (attempt < MAX_PUSH_RECOVERY_ATTEMPTS) continue;
    throw new Error(
      `Could not replace remote ${issueBranch} after archiving ${diagnosticBranch}:\n${`${replace.stdout ?? ""}${replace.stderr ?? ""}`.trim()}`,
    );
  }
}

// Terminal success: push the issue branch to origin and add the `Review`
// label. The loop never opens the PR, merges, or closes the issue — that is a
// human's call. The issue stays open so it surfaces as needing a PR.
function deliverReviewReady(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
): void {
  pushIssueBranch(worktreePath, issueBranch, "review");
  execFileSync(
    "gh",
    [
      "issue",
      "comment",
      String(issue.number),
      "--body",
      [
        `Review-ready: pushed branch \`${issueBranch}\` to origin.`,
        "",
        `It passed the validation gate and earned a clean reviewer approval against \`${originBaseRef()}\`. Open a pull request from \`${issueBranch}\` into \`${baseBranch}\` when you're ready.`,
        "",
        "The agent loop did not merge or close this issue.",
      ].join("\n"),
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "gh",
    ["issue", "edit", String(issue.number), "--add-label", REVIEW_LABEL],
    { stdio: "inherit" },
  );
}

function markStuck(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
  options: {
    lastFeedback: string;
    roundsUsed?: number;
    terminalReason?: StuckTerminalReason;
    headline?: string;
  },
): void {
  recordLoopFailureDiagnostic({
    scope: "issue",
    outcome: options.terminalReason ?? "stuck",
    issue: issue.number,
    branch: issueBranch,
    worktreePath,
    roundsUsed: options.roundsUsed,
    lastFeedback: options.lastFeedback,
    detail: options.headline ? { headline: options.headline } : undefined,
  });
  try {
    pushIssueBranch(worktreePath, issueBranch, "stuck");
  } catch (err) {
    console.warn(
      `Could not push ${issueBranch} on stuck — continuing. ${err instanceof Error ? err.message : err}`,
    );
  }
  execFileSync(
    "gh",
    [
      "issue",
      "comment",
      String(issue.number),
      "--body",
      formatStuckIssueComment({
        lastFeedback: options.lastFeedback,
        roundsUsed: options.roundsUsed,
        maxReviewRounds: MAX_REVIEW_ROUNDS,
        terminalReason: options.terminalReason,
        headline: options.headline,
      }),
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
// Per-issue pipeline
// ---------------------------------------------------------------------------

async function runBacklogIssueViaSharedEngine(input: {
  issue: IssueDetail;
  issueBranch: string;
  issueComments: string;
  sandboxBaseBranch?: string;
  taskBaseRef?: string;
}): Promise<{
  outcome: PerBranchEngineOutcome;
  worktreePath: string;
  issueBranch: string;
  closeSandbox(): Promise<void>;
}> {
  const {
    issue,
    issueBranch,
    issueComments,
    sandboxBaseBranch = originBaseRef(),
    taskBaseRef = sandboxBaseBranch,
  } = input;
  tuiEmitter.beginHostStep("sandbox_setup", issueBranch);
  const sandbox = await sandcastle.createSandbox({
    sandbox: dockerSandboxProvider(),
    branch: issueBranch,
    baseBranch: sandboxBaseBranch,
    copyToWorktree: COPY_TO_WORKTREE,
    hooks: {
      sandbox: {
        onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({ command })),
      },
    },
  });
  ensureOpencodeGitExclude(sandbox.worktreePath);

  let roundsUsed = 0;
  let sandboxClosedByEngine = false;
  let announcedRound = 0;
  const closeSandbox = async (): Promise<void> => {
    if (sandboxClosedByEngine) return;
    sandboxClosedByEngine = true;
    await sandbox.close();
  };

  try {
    const task = {
      number: issue.number,
      title: issue.title,
      body: issue.body || "",
      comments: issueComments,
      branch: issueBranch,
      baseRef: taskBaseRef,
    };
    let recoveryAttempts = 0;
    const noteRound = (round: number): void => {
      if (announcedRound === round) return;
      announcedRound = round;
      roundsUsed = round;
      console.log(
        `\n--- Round ${round}/${MAX_REVIEW_ROUNDS} for #${issue.number} ---`,
      );
      tuiEmitter.setRound({ current: round, max: MAX_REVIEW_ROUNDS });
    };

    const outcome = await runPerBranchEngine({
      task,
      policy: BACKLOG_V3_SHARED_ENGINE_POLICY,
      deps: {
        async createSandbox() {
          return {
            worktreePath: sandbox.worktreePath,
            async close() {
              sandboxClosedByEngine = true;
              await sandbox.close();
            },
          };
        },
        async preCoderRebaseGuard() {
          const guard = rebaseStaleIssueBranchBeforeCoder(
            sandbox.worktreePath,
            issueBranch,
            taskBaseRef,
          );
          return guard.ok ? { ok: true } : { ok: false, feedback: guard.feedback };
        },
        async invokeCoder(input) {
          noteRound(input.round);
          // The engine forces rework mode whenever feedback exists — including
          // round 1 after a pre-coder rebase-guard failure, where the guard's
          // instructions must reach the agent through the rework prompt.
          const isRework = input.isRework;
          let runResult: Awaited<ReturnType<typeof sandbox.run>>;

          if (isRework) {
            const reworkUserArgs = {
              ISSUE_NUMBER: String(issue.number),
              ISSUE_TITLE: issue.title,
              ISSUE_BODY: issue.body || "(no body)",
              REVIEW_FEEDBACK: input.feedback,
            };
            const reworkTemplate = readFileSync(
              REWORK_USER_PROMPT_FILE.replace(/^\.\//, ""),
              "utf8",
            );
            const rendered = renderSlimMessage(reworkTemplate, reworkUserArgs);
            const sizeCheck = enforceArgvSizeLimit(rendered);
            if (!sizeCheck.ok) {
              return { kind: "failed", feedback: sizeCheck.error };
            }

            writeAgentDefinitionFile(
              sandbox.worktreePath,
              REWORK_AGENT_CONFIG.name,
              buildAgentDefinition(
                REWORK_AGENT_CONFIG,
                REWORK_MODEL,
                readFileSync(
                  REWORK_AGENT_SYSTEM_PROMPT_FILE.replace(/^\.\//, ""),
                  "utf8",
                ),
              ),
            );

            const reworkRunName = `rework #${issue.number} r${input.round}`;
            const reworkActiveLogPath = tuiWorkingLogPath(reworkRunName);
            const reworkLivelockWatchdog =
              createLivelockWatchdogSandcastleRunOptions({
                logPath: agentRunLogPath(issueBranch, reworkRunName),
                getWorktreeSnapshot: () =>
                  captureWorktreeProgressSnapshot(sandbox.worktreePath),
                onStreamEvent: tuiEmitter.workingLogSink(reworkActiveLogPath),
              });
            try {
              runResult = await recordMeasuredAgentRun(
                {
                  prd: label,
                  issue: issue.number,
                  stage: "rework",
                  agent: REWORK_AGENT_CONFIG.name,
                  round: input.round,
                  model: REWORK_MODEL,
                  runName: reworkRunName,
                  worktreePath: sandbox.worktreePath,
                  promptFile: REWORK_USER_PROMPT_FILE,
                  promptArgs: reworkUserArgs,
                  activeLogPath: reworkActiveLogPath,
                },
                () =>
                  sandbox.run({
                    name: reworkRunName,
                    agent: sandcastle.opencode(REWORK_MODEL, {
                      agent: REWORK_AGENT_CONFIG.name,
                    }),
                    maxIterations: input.maxIterations,
                    completionSignal: "<promise>COMPLETE</promise>",
                    idleTimeoutSeconds,
                    promptFile: REWORK_USER_PROMPT_FILE,
                    promptArgs: reworkUserArgs,
                    signal: reworkLivelockWatchdog.signal,
                    logging: reworkLivelockWatchdog.logging,
                  }),
              );
            } catch (reworkErr) {
              const control = resolveReworkLivelockControlFlow(reworkErr);
              if (control.action === "break_to_stuck") {
                console.log(
                  `  rework livelock on round ${input.round}; bailing to stuck`,
                );
                return { kind: "livelock", feedback: control.feedback };
              }
              throw control.error;
            }
          } else {
            const coderUserArgs = {
              ISSUE_NUMBER: String(issue.number),
              ISSUE_TITLE: issue.title,
              ISSUE_BODY: issue.body || "(no body)",
              ISSUE_COMMENTS: issueComments,
            };
            const coderTemplate = readFileSync(
              CODER_USER_PROMPT_FILE.replace(/^\.\//, ""),
              "utf8",
            );
            const rendered = renderSlimMessage(coderTemplate, coderUserArgs);
            const sizeCheck = enforceArgvSizeLimit(rendered);
            if (!sizeCheck.ok) {
              return { kind: "failed", feedback: sizeCheck.error };
            }

            writeAgentDefinitionFile(
              sandbox.worktreePath,
              CODER_AGENT_CONFIG.name,
              buildAgentDefinition(
                CODER_AGENT_CONFIG,
                CODER_MODEL,
                readFileSync(
                  CODER_AGENT_SYSTEM_PROMPT_FILE.replace(/^\.\//, ""),
                  "utf8",
                ),
              ),
            );

            const coderRunName = `coder #${issue.number} r${input.round}`;
            const coderActiveLogPath = tuiWorkingLogPath(coderRunName);
            const livelockWatchdog = createLivelockWatchdogSandcastleRunOptions({
              logPath: agentRunLogPath(issueBranch, coderRunName),
              getWorktreeSnapshot: () =>
                captureWorktreeProgressSnapshot(sandbox.worktreePath),
              onStreamEvent: tuiEmitter.workingLogSink(coderActiveLogPath),
            });
            try {
              runResult = await recordMeasuredAgentRun(
                {
                  prd: label,
                  issue: issue.number,
                  stage: "coder",
                  agent: CODER_AGENT_CONFIG.name,
                  round: input.round,
                  model: CODER_MODEL,
                  runName: coderRunName,
                  worktreePath: sandbox.worktreePath,
                  promptFile: CODER_USER_PROMPT_FILE,
                  promptArgs: coderUserArgs,
                  activeLogPath: coderActiveLogPath,
                },
                () =>
                  sandbox.run({
                    name: coderRunName,
                    agent: sandcastle.opencode(CODER_MODEL, {
                      agent: CODER_AGENT_CONFIG.name,
                    }),
                    maxIterations: input.maxIterations,
                    completionSignal: "<promise>COMPLETE</promise>",
                    idleTimeoutSeconds,
                    promptFile: CODER_USER_PROMPT_FILE,
                    promptArgs: coderUserArgs,
                    signal: livelockWatchdog.signal,
                    logging: livelockWatchdog.logging,
                  }),
              );
            } catch (coderErr) {
              const control = resolveRound1CoderLivelockControlFlow(coderErr);
              if (control.action === "continue_with_feedback") {
                console.log(
                  `  coder livelock on round ${input.round}; escalating to rework`,
                );
                return { kind: "failed", feedback: control.feedback };
              }
              throw control.error;
            }
          }

          const blockedMatch = runResult.stdout.match(
            /<blocked>([\s\S]*?)<\/blocked>/,
          );
          if (blockedMatch) {
            const reason = blockedMatch[1]!.trim();
            console.log(`  coder signaled blocked: ${reason.slice(0, 200)}`);
            return {
              kind: "blocked",
              feedback: `Coder signaled blocked on round ${input.round}:\n\n${reason}`,
            };
          }

          const alreadySatisfiedMatch = runResult.stdout.match(
            /<already_satisfied>([\s\S]*?)<\/already_satisfied>/,
          );
          if (alreadySatisfiedMatch) {
            const reason = alreadySatisfiedMatch[1]!.trim();
            const existingAheadCount = countCommitsAheadOfBase(
              sandbox.worktreePath,
              taskBaseRef,
            );
            if (existingAheadCount > 0) {
              console.log(
                `  coder signaled already_satisfied, but branch has ${existingAheadCount} commit(s) ahead of ${taskBaseRef}; routing through validation/review`,
              );
              const dirty = git(["status", "-s"], sandbox.worktreePath).trim();
              if (dirty) {
                return {
                  kind: "failed",
                  feedback: [
                    "## Uncommitted changes after commit",
                    "",
                    "Your run produced commits, but the worktree still has uncommitted changes:",
                    "",
                    "```",
                    dirty,
                    "```",
                    "",
                    "Commit the intended issue changes and revert unrelated edits. The host validates and reviews only a clean, committed branch.",
                  ].join("\n"),
                };
              }
              return {
                kind: "committed",
                committedCount: existingAheadCount,
              };
            }
            console.log(
              `  coder signaled already_satisfied: ${reason.slice(0, 200)}`,
            );
            return { kind: "already_satisfied", evidence: reason };
          }

          let committedCount = runResult.commits.length;
          if (committedCount === 0) {
            const uncommitted = git(["status", "-s"], sandbox.worktreePath).trim();
            if (uncommitted) {
              console.log(
                "  coder produced no commits but worktree has uncommitted edits; feeding back commit reminder",
              );
              return {
                kind: "failed",
                feedback: [
                  "## You edited files but did not commit",
                  "",
                  "These files have uncommitted changes in the worktree:",
                  "",
                  "```",
                  uncommitted,
                  "```",
                  "",
                  'Edits without a commit are invisible to the host. Sandcastle only sees `git log` history, not the working tree. Run `git add <files>` and `git commit -m "<message>"` to save your work. Then re-verify and emit `<promise>COMPLETE</promise>`.',
                ].join("\n"),
              };
            }
            const existingAheadCount = countCommitsAheadOfBase(
              sandbox.worktreePath,
              taskBaseRef,
            );
            if (existingAheadCount > 0) {
              console.log(
                `  coder produced no new commits, but branch already has ${existingAheadCount} commit(s) ahead of ${taskBaseRef}; validating existing branch state`,
              );
              committedCount = existingAheadCount;
            } else {
              console.log(
                '  coder produced no commits and no uncommitted changes; feeding back "no commits" message',
              );
              return {
                kind: "failed",
                feedback:
                  "## No commits produced\n\nYour previous run finished without committing any changes. Re-read the issue, then make the required code changes and commit them.",
              };
            }
          }

          const dirty = git(["status", "-s"], sandbox.worktreePath).trim();
          if (dirty) {
            console.log(
              `  branch has ${committedCount} new commit(s) but uncommitted edits remain; feeding back cleanup request`,
            );
            return {
              kind: "failed",
              feedback: [
                "## Uncommitted changes after commit",
                "",
                "Your run produced commits, but the worktree still has uncommitted changes:",
                "",
                "```",
                dirty,
                "```",
                "",
                "Commit the intended issue changes and revert unrelated edits. The host validates and reviews only a clean, committed branch.",
              ].join("\n"),
            };
          }

          console.log(
            `  branch has ${committedCount} new commit(s); syncing branch for validation/review`,
          );
          return { kind: "committed", committedCount };
        },
        async prepareBranchForReview(input) {
          recoveryAttempts = 0;
          const prep = prepareBranchForReview(
            sandbox.worktreePath,
            issueBranch,
            taskBaseRef,
            recoveryAttempts,
          );
          recoveryAttempts = prep.recoveryAttempts;
          if (!prep.ok) {
            return { ok: false, feedback: prep.feedback, recoverable: false };
          }

          const reviewContext = computeReviewContext(
            sandbox.worktreePath,
            prep.baseSha,
          );
          const recovery = maybeRecoverOversizedOrPollutedDiff(
            sandbox.worktreePath,
            issue,
            issueBranch,
            taskBaseRef,
            reviewContext,
            recoveryAttempts,
          );
          recoveryAttempts = recovery.recoveryAttempts;
          if (!recovery.ok) {
            return { ok: false, feedback: recovery.feedback, recoverable: false };
          }

          return { ok: true, reviewedBaseSha: recovery.baseSha };
        },
        async recoverBranch(input) {
          const recovered = recoverFreshBranch(
            sandbox.worktreePath,
            issueBranch,
            taskBaseRef,
            git(["rev-parse", "HEAD"], sandbox.worktreePath).trim(),
            input.attempt - 1,
            "shared engine requested branch recovery",
            input.feedback,
          );
          recoveryAttempts = recovered.recoveryAttempts;
          return {
            ok: recovered.ok,
            feedback: recovered.ok ? "" : recovered.feedback,
          };
        },
        async computeReviewContext(input) {
          const context = computeReviewContext(
            sandbox.worktreePath,
            input.reviewedBaseSha,
          );
          console.log(
            `  review diff: ${context.diffBytes} bytes, ${context.changedFiles.length} file(s), aspects: ${context.reviewAspects.join(", ")}`,
          );
          return context;
        },
        async runValidation(input) {
          console.log(`  running validation gate`);
          const gate = runValidationGate(sandbox.worktreePath, {
            prd: label,
            issue: issue.number,
            round: input.round,
            gate: "issue",
          });
          if (gate.ok) return { ok: true };
          return {
            ok: false,
            command: gate.signature.split(" :: ")[0] ?? gate.signature,
            exitCode: 1,
            feedback: gate.feedback,
          };
        },
        async acquireReviewer(input) {
          noteRound(input.round);
          console.log(`  validation green; invoking reviewer`);
          const reviewerUserArgs = {
            ISSUE_NUMBER: String(issue.number),
            ISSUE_TITLE: issue.title,
            ISSUE_BODY: issue.body || "(no body)",
            ISSUE_COMMENTS: issueComments,
            BASE_BRANCH: taskBaseRef,
            REVIEW_BASE_SHA: input.context.baseSha,
            DIFF: input.context.diff,
            DIFF_BYTES: String(input.context.diffBytes),
            DIFF_MAX_BYTES: String(REVIEW_DIFF_MAX_BYTES),
            CHANGED_FILES: input.context.changedFiles.join("\n") || "(none)",
            DIFF_STAT: input.context.diffStat,
            REVIEW_ASPECTS: input.context.reviewAspects.join(", "),
            ECOSYSTEMS: input.context.ecosystems.join(", ") || "(unknown)",
          };
          const reviewerTemplate = readFileSync(
            REVIEWER_USER_PROMPT_FILE.replace(/^\.\//, ""),
            "utf8",
          );
          const renderedReviewerMessage = renderSlimMessage(
            reviewerTemplate,
            reviewerUserArgs,
          );
          const reviewerSizeCheck = enforceArgvSizeLimit(renderedReviewerMessage);
          if (!reviewerSizeCheck.ok) {
            return {
              kind: "incomplete",
              code: "host_input_limit",
              diagnostics: [reviewerSizeCheck.error],
              resultSource: "none" as const,
              logFallbackUsed: false,
              excerpt: reviewerSizeCheck.error,
            };
          }

          writeAgentDefinitionFile(
            sandbox.worktreePath,
            REVIEWER_AGENT_CONFIG.name,
            buildAgentDefinition(
              REVIEWER_AGENT_CONFIG,
              REVIEWER_MODEL,
              readFileSync(
                REVIEWER_AGENT_SYSTEM_PROMPT_FILE.replace(/^\.\//, ""),
                "utf8",
              ),
            ),
          );

          const reviewerRunName = buildReviewerAttemptRunName(
            issue.number,
            input.round,
            input.attempt,
          );
          const reviewerActiveLogPath = tuiWorkingLogPath(reviewerRunName);
          const reviewerResult: Awaited<ReturnType<typeof sandbox.run>> =
            await recordMeasuredAgentRun(
            {
              prd: label,
              issue: issue.number,
              stage: "reviewer",
              agent: REVIEWER_AGENT_CONFIG.name,
              round: input.round,
              model: REVIEWER_MODEL,
              runName: reviewerRunName,
              worktreePath: sandbox.worktreePath,
              promptFile: REVIEWER_USER_PROMPT_FILE,
              promptArgs: reviewerUserArgs,
              activeLogPath: reviewerActiveLogPath,
            },
            () =>
              sandbox.run({
                name: reviewerRunName,
                agent: sandcastle.opencode(REVIEWER_MODEL, {
                  agent: REVIEWER_AGENT_CONFIG.name,
                }),
                maxIterations: 1,
                completionSignal: "</review>",
                idleTimeoutSeconds,
                promptFile: REVIEWER_USER_PROMPT_FILE,
                promptArgs: reviewerUserArgs,
                logging: {
                  type: "file",
                  path: agentRunLogPath(issueBranch, reviewerRunName),
                  onAgentStreamEvent:
                    tuiEmitter.workingLogSink(reviewerActiveLogPath),
                },
              }),
          );
          const logFilePath =
            typeof reviewerResult === "object" &&
            reviewerResult !== null &&
            "logFilePath" in reviewerResult &&
            typeof reviewerResult.logFilePath === "string"
              ? reviewerResult.logFilePath
              : undefined;
          const runLogText =
            logFilePath && existsSync(logFilePath)
              ? readFileSync(logFilePath, "utf8")
              : undefined;
          const acquisition = acquireReviewerResult({
            stdout: reviewerResult.stdout,
            runLogText,
            runLogReadError:
              logFilePath && !existsSync(logFilePath)
                ? `missing log file at ${logFilePath}`
                : undefined,
            logFilePath,
          });
          recordReviewerResult({
            prd: label,
            issue: issue.number,
            round: input.round,
            attempt: input.attempt,
            maxAttempts: BACKLOG_V3_SHARED_ENGINE_POLICY.reviewerMaxAttempts,
            status:
              acquisition.kind === "verdict"
                ? acquisition.review.decision
                : acquisition.kind,
            resultSource: acquisition.resultSource,
            logFallbackUsed: acquisition.logFallbackUsed,
            logFilePath,
            parseFailureCode:
              acquisition.kind === "parse_failed" ? acquisition.code : undefined,
          });
          if (acquisition.kind === "verdict") {
            console.log(`  reviewer decision: ${acquisition.review.decision}`);
          }
          return {
            ...acquisition,
            excerpt: runLogText ?? reviewerResult.stdout,
          } satisfies EngineReviewerAcquisitionResult;
        },
        currentHeadSha() {
          return git(["rev-parse", "HEAD"], sandbox.worktreePath).trim();
        },
        currentTreeSha() {
          return treeShaOf("HEAD", sandbox.worktreePath);
        },
        onHostStep(name, detail) {
          tuiEmitter.beginHostStep(
            name as "sandbox_setup" | "branch_prep" | "validation" | "deliver_review_ready",
            detail,
          );
        },
      },
    });
    roundsUsed = outcome.roundsUsed;
    return {
      outcome,
      worktreePath: sandbox.worktreePath,
      issueBranch,
      closeSandbox,
    };
  } catch (iterErr) {
    return {
      outcome: {
        kind: "crashed",
        error:
          iterErr instanceof Error
            ? (iterErr.stack ?? iterErr.message)
            : String(iterErr),
        roundsUsed,
      },
      worktreePath: sandbox.worktreePath,
      issueBranch,
      closeSandbox,
    };
  }
}

function readAccumulationHeads(accumulationBranch: string): {
  localHeadSha: string;
  remoteHeadSha: string;
} {
  const remoteHeadSha = readRemoteHead(accumulationBranch);
  if (!remoteHeadSha) {
    throw new Error(`Missing remote accumulation branch ${accumulationBranch}.`);
  }
  return {
    localHeadSha: git(["rev-parse", accumulationBranch]).trim(),
    remoteHeadSha,
  };
}

function pushAccumulationBranchWithLease(input: {
  accumulationBranch: string;
  expectedHeadSha: string;
}): void {
  const localHeadSha = git(["rev-parse", input.accumulationBranch]).trim();
  if (localHeadSha !== input.expectedHeadSha) {
    throw new Error(
      `Local accumulation head mismatch for ${input.accumulationBranch}: expected ${input.expectedHeadSha}, observed ${localHeadSha}.`,
    );
  }
  const remoteHeadSha = readRemoteHead(input.accumulationBranch);
  if (!remoteHeadSha) {
    throw new Error(`Missing remote accumulation branch ${input.accumulationBranch}.`);
  }
  execFileSync(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${input.accumulationBranch}:${remoteHeadSha}`,
      "origin",
      `${input.expectedHeadSha}:refs/heads/${input.accumulationBranch}`,
    ],
    { stdio: "inherit" },
  );
  const verifiedRemote = readRemoteHead(input.accumulationBranch);
  if (verifiedRemote !== input.expectedHeadSha) {
    throw new Error(
      `Remote accumulation head mismatch for ${input.accumulationBranch}: expected ${input.expectedHeadSha}, observed ${verifiedRemote ?? "(missing)"}.`,
    );
  }
}

function verifyTerminalChildren(input: {
  parentNumber: number;
  result: { kind: "clean_delivery" | "partial_delivery"; stuckChildNumber?: number };
  queueLabel: string;
  client: GitHubIssuesClient;
}): { ok: true } | { ok: false; diagnostics: string[] } {
  const children = listIssueAsPrdParentChildren({
    parentNumber: input.parentNumber,
    queueLabel: input.queueLabel,
    client: input.client,
  });
  const openChildren = children.filter((child) => child.state === "OPEN");
  if (input.result.kind === "clean_delivery") {
    if (openChildren.length === 0) return { ok: true };
    return {
      ok: false,
      diagnostics: [
        `Clean delivery still has open child issues: ${openChildren.map((child) => `#${child.number}`).join(", ")}`,
      ],
    };
  }

  const nonStuckOpen = openChildren.filter(
    (child) => !child.labels.some((label) => label.name === AGENT_STUCK_LABEL),
  );
  if (nonStuckOpen.length > 0) {
    return {
      ok: false,
      diagnostics: [
        `Partial delivery still has open non-stuck child issues: ${nonStuckOpen.map((child) => `#${child.number}`).join(", ")}`,
      ],
    };
  }
  if (
    input.result.stuckChildNumber !== undefined &&
    !openChildren.some((child) => child.number === input.result.stuckChildNumber)
  ) {
    return {
      ok: false,
      diagnostics: [
        `Partial delivery expected stuck child #${input.result.stuckChildNumber} to remain open.`,
      ],
    };
  }
  return { ok: true };
}

async function applyVerifiedParentTerminalLabels(input: {
  parentNumber: number;
  add: readonly string[];
  remove: readonly string[];
  client: GitHubIssuesClient;
}): Promise<{ ok: true } | { ok: false; diagnostics: string[] }> {
  const verification = await runVerifiedHostMutation({
    mutate: () => {
      const args = [
        "issue",
        "edit",
        String(input.parentNumber),
        ...input.remove.flatMap((value) => ["--remove-label", value]),
        ...input.add.flatMap((value) => ["--add-label", value]),
      ];
      if (args.length > 3) gh(args);
    },
    readBack: () => input.client.viewIssue(input.parentNumber),
    verify: (value) =>
      input.add.every((label) => value.labels.some((entry) => entry.name === label)) &&
      input.remove.every((label) => !value.labels.some((entry) => entry.name === label)),
    describe: (value) =>
      `issue #${value.number} labels=${value.labels.map((label) => label.name).sort().join(",")}`,
  });
  return verification.ok ? { ok: true } : { ok: false, diagnostics: verification.diagnostics };
}

async function appendVerifiedParentComment(input: {
  parentNumber: number;
  body: string;
  client: GitHubIssuesClient;
}): Promise<{ ok: true } | { ok: false; diagnostics: string[] }> {
  const verification = await runVerifiedHostMutation({
    mutate: () => {
      input.client.createComment(input.parentNumber, input.body);
    },
    readBack: () => input.client.viewIssue(input.parentNumber),
    verify: (value) => value.comments.some((comment) => comment.body === input.body),
    describe: (value) => `issue #${value.number} comments=${value.comments.length}`,
  });
  return verification.ok ? { ok: true } : { ok: false, diagnostics: verification.diagnostics };
}

async function runIssueAsPrdChildEngine(input: {
  parentNumber: number;
  child: GitHubIssueRecord;
  accumulationSha: string;
}): Promise<PerBranchEngineOutcome> {
  const issueBranch = childBranchName(input.parentNumber, input.child.number);
  tuiEmitter.setTicket({
    number: input.child.number,
    title: input.child.title,
    branch: issueBranch,
  });
  const run = await runBacklogIssueViaSharedEngine({
    issue: toIssueDetail(input.child),
    issueBranch,
    issueComments: flattenComments(input.child.comments),
    sandboxBaseBranch: input.accumulationSha,
    taskBaseRef: input.accumulationSha,
  });
  try {
    return run.outcome;
  } finally {
    await run.closeSandbox();
  }
}

async function runIssueAsPrdDirectParentEngine(input: {
  parent: GitHubIssueRecord;
  accumulationBranch: string;
  accumulationSha: string;
  renderedContext: string;
}): Promise<PerBranchEngineOutcome> {
  tuiEmitter.setTicket({
    number: input.parent.number,
    title: input.parent.title,
    branch: input.accumulationBranch,
  });
  const run = await runBacklogIssueViaSharedEngine({
    issue: {
      number: input.parent.number,
      title: input.parent.title,
      body: input.renderedContext,
      comments: [],
      labels: input.parent.labels,
    },
    issueBranch: input.accumulationBranch,
    issueComments: "(normalized parent context embedded in issue body)",
    sandboxBaseBranch: input.accumulationBranch,
    taskBaseRef: input.accumulationSha,
  });
  try {
    return run.outcome;
  } finally {
    await run.closeSandbox();
  }
}

async function runRefreshForAccumulation(input: {
  accumulationBranch: string;
  mainlineRef: string;
  originalForkSha: string;
  currentReviewBaseSha: string;
}) {
  let worktreePath: string | null = null;
  const ensureWorktree = (): string => {
    if (worktreePath) return worktreePath;
    worktreePath = join(
      REPO_ROOT,
      ".sandcastle",
      "worktrees",
      `${input.accumulationBranch}-refresh`,
    );
    if (existsSync(worktreePath)) {
      spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
        encoding: "utf8",
      });
    }
    execFileSync(
      "git",
      ["worktree", "add", worktreePath, input.accumulationBranch],
      { stdio: "inherit" },
    );
    return worktreePath;
  };

  try {
    return await refreshIssueAsPrdAccumulationBeforeReview(input, {
      readAccumulationHeads: ({ accumulationBranch }) =>
        readAccumulationHeads(accumulationBranch),
      fetchMainline: ({ mainlineRef }) => {
        fetchOriginBase();
        return git(["rev-parse", mainlineRef]).trim();
      },
      createDiagnosticCheckpoint: ({ branchName, sourceSha }) => {
        execFileSync("git", ["branch", "-f", branchName, sourceSha], {
          stdio: "inherit",
        });
      },
      rebaseAccumulationOntoMainline: ({ ontoSha }) => {
        const cwd = ensureWorktree();
        const result = spawnSync("git", ["rebase", ontoSha], {
          cwd,
          encoding: "utf8",
        });
        if (result.status === 0) return { ok: true as const };
        return {
          ok: false as const,
          stderr: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
        };
      },
      abortRebase: () => {
        if (!worktreePath) return;
        spawnSync("git", ["rebase", "--abort"], {
          cwd: worktreePath,
          encoding: "utf8",
        });
      },
      resetAccumulationToRef: ({ targetRef }) => {
        const cwd = ensureWorktree();
        execFileSync("git", ["reset", "--hard", targetRef], {
          cwd,
          stdio: "inherit",
        });
      },
      pushAccumulationWithLease: ({ accumulationBranch, expectedRemoteSha }) => {
        const cwd = ensureWorktree();
        const localHead = git(["rev-parse", "HEAD"], cwd).trim();
        execFileSync(
          "git",
          [
            "push",
            `--force-with-lease=refs/heads/${accumulationBranch}:${expectedRemoteSha}`,
            "origin",
            `HEAD:refs/heads/${accumulationBranch}`,
          ],
          { cwd, stdio: "inherit" },
        );
        execFileSync(
          "git",
          [
            "update-ref",
            `refs/heads/${accumulationBranch}`,
            localHead,
          ],
          { stdio: "inherit" },
        );
      },
      revParse: (ref) => git(["rev-parse", ref], worktreePath ?? undefined).trim(),
    });
  } finally {
    if (worktreePath) {
      spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
        encoding: "utf8",
      });
    }
  }
}

// A crash between the terminal state-comment write and the terminal label
// apply leaves a parent recorded as delivered/failed while its labels still
// say in-progress. Finish the label plan so the parent leaves the queue the
// way the completed run intended, then skip it for this run.
async function repairTerminalParentLabels(input: {
  parent: GitHubIssueRecord;
  state: Parameters<typeof terminalRepairLabelPlan>[0];
  diagnostics: string[];
}): Promise<{ stopLoop: boolean; skippedParentNumber?: number }> {
  const plan = terminalRepairLabelPlan(input.state);
  console.warn(
    [
      `Parent #${input.parent.number} recorded terminal phase '${input.state.phase}' but still carries in-progress labels; completing the terminal label plan.`,
      ...input.diagnostics,
    ].join("\n"),
  );
  const client = issueClient();
  const finalParent = client.viewIssue(input.parent.number);
  const add = plan.add.filter((label) => !finalParent.labels.some((value) => value.name === label));
  const remove = plan.remove.filter((label) => finalParent.labels.some((value) => value.name === label));
  const labelVerification = await applyVerifiedParentTerminalLabels({
    parentNumber: input.parent.number,
    add,
    remove,
    client,
  });
  if (!labelVerification.ok) {
    console.error(
      `Terminal label repair failed for parent #${input.parent.number}:\n${labelVerification.diagnostics.join("\n")}`,
    );
    return { stopLoop: true };
  }
  if (plan.deleteQueueLabel) {
    try {
      gh(["label", "delete", input.state.queueLabel, "--yes"]);
    } catch (err) {
      console.warn(
        `Warning: failed to delete queue label ${input.state.queueLabel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { stopLoop: false, skippedParentNumber: input.parent.number };
}

async function processIssueAsPrdParent(input: Awaited<ReturnType<typeof acquireNextIssueAsPrdParentForLoop>>): Promise<{
  stopLoop: boolean;
  skippedParentNumber?: number;
}> {
  if (input.kind === "none") return { stopLoop: false };
  if (input.kind === "ownership_ambiguous") {
    console.error(
      `Ownership ambiguous for parent #${input.parent.number}:\n${input.diagnostics.join("\n")}`,
    );
    return { stopLoop: false, skippedParentNumber: input.parent.number };
  }
  if (input.kind === "terminal_label_repair") {
    return repairTerminalParentLabels(input);
  }

  let stateCommentId = input.commentId;
  let currentState = input.state;
  const parent = input.parent;
  const client = issueClient();

  // The durable state comment is the source of truth for recovery, so the
  // terminal phase must land there BEFORE the terminal label plan mutates the
  // issue. Otherwise a finished parent is left recorded at an in-progress
  // phase, which wedges it as ownership-ambiguous the moment its labels
  // change (crash, partial label apply, or a human requeueing it).
  const persistTerminalPhase = async (
    phase: "delivered" | "failed",
  ): Promise<void> => {
    const next = nextParentState({
      previous: currentState,
      now: new Date().toISOString(),
      next: { ...currentState, phase },
    });
    const persisted = await persistIssueAsPrdParentStateComment(
      { parentNumber: parent.number, commentId: stateCommentId, state: next },
      {
        createComment: ({ parentNumber, body }) =>
          client.createComment(parentNumber, body).id,
        updateComment: ({ commentId, body }) =>
          client.updateComment(commentId, body),
      },
    );
    currentState = next;
    stateCommentId = persisted.commentId;
  };

  tuiEmitter.setTicket({
    number: parent.number,
    title: parent.title,
    branch: input.state.accumulationBranch,
  });
  tuiEmitter.beginHostStep("parent_claim", input.state.accumulationBranch);

  const result = await runIssueAsPrdParent(
    {
      parent,
      state: input.state,
      normalizedContext: input.normalizedContext,
    },
    {
      now: () => new Date().toISOString(),
      verifyOwnership: async ({ parent, state }) => {
        const observed = observeIssueAsPrdParentRecoveryState(parent);
        return verifyIssueAsPrdParentOwnership({
          parent,
          expectedState: state,
          observed,
          maxCommentBytes: LOOP_CONFIG.issueAsPrd.parentCommentMaxBytes,
        });
      },
      readAccumulationHead: async ({ accumulationBranch }) =>
        git(["rev-parse", accumulationBranch]).trim(),
      acquireInitialDecomposition: async ({ parent, context }) =>
        acquireInitialDecomposition({
          prd: label,
          parentIssueNumber: parent.number,
          model: INITIAL_ISSUE_DECOMPOSER_MODEL,
          round: 1,
          promptFile: INITIAL_ISSUE_DECOMPOSER_USER_PROMPT_FILE,
          promptArgs: {
            PARENT_ISSUE_NUMBER: String(parent.number),
            PARENT_ISSUE_TITLE: parent.title,
            PARENT_CONTEXT: context.rendered,
          },
          runAttempt: async (attempt) =>
            runIssueAsPrdPromptSession({
              branch: `issue-${parent.number}-decomposer-a${attempt}`,
              baseRef: input.state.accumulationBranch,
              stage: "initial_issue_decomposer",
              runName: buildInitialIssueDecomposerRunName(parent.number, attempt),
              model: INITIAL_ISSUE_DECOMPOSER_MODEL,
              promptFile: INITIAL_ISSUE_DECOMPOSER_USER_PROMPT_FILE,
              promptArgs: {
                PARENT_ISSUE_NUMBER: String(parent.number),
                PARENT_ISSUE_TITLE: parent.title,
                PARENT_CONTEXT: context.rendered,
              },
            }),
        }),
      persistState: async (state) => {
        const persisted = await persistIssueAsPrdParentStateComment(
          {
            parentNumber: parent.number,
            commentId: stateCommentId,
            state,
          },
          {
            createComment: ({ parentNumber, body }) =>
              client.createComment(parentNumber, body).id,
            updateComment: ({ commentId, body }) =>
              client.updateComment(commentId, body),
          },
        );
        currentState = state;
        stateCommentId = persisted.commentId;
      },
      publishChildren: async ({ parent, drafts, queueLabel }) => {
        tuiEmitter.beginHostStep("child_publication", queueLabel);
        return publishIssueAsPrdParentChildren({
          parent,
          drafts,
          queueLabel,
          client,
        });
      },
      listChildren: async ({ parent, queueLabel }) =>
        // The orchestrator only ever acts on open children: closed children
        // are inert and must not block re-decomposition (a claimed parent
        // whose previous children were all closed as duplicates would
        // otherwise never get a fresh decomposition) or feed readiness.
        listIssueAsPrdParentChildren({
          parentNumber: parent.number,
          queueLabel,
          client,
        }).filter((child) => child.state === "OPEN"),
      readiness: async ({
        parentContext,
        children,
        siblingSummaries,
        accumulationSha,
      }) => {
        tuiEmitter.beginHostStep("readiness_apply", accumulationSha);
        return runSubtaskReadinessBatch({
          parentContext,
          children,
          siblingSummaries,
          accumulationSha,
          client,
          acquire: (child, activeSiblings) =>
            acquireSubtaskReadiness({
              prd: label,
              childIssueNumber: child.number,
              model: SUBTASK_READINESS_MODEL,
              round: 1,
              promptFile: SUBTASK_READINESS_USER_PROMPT_FILE,
              promptArgs: {
                PARENT_ISSUE_NUMBER: String(parent.number),
                PARENT_ISSUE_TITLE: parent.title,
                ACCUMULATION_HEAD_SHA: accumulationSha,
                SUBTASK_TITLE: child.title,
                ACTIVE_SIBLINGS: activeSiblings
                  .map((sibling) => `#${sibling.number}: ${sibling.title}\n${sibling.body}`)
                  .join("\n\n"),
                PARENT_CONTEXT: parentContext.rendered,
                SUBTASK_BODY: child.body,
              },
              measuredRunDeps: {
                beginAgentStep: (agentStep) => {
                  tuiEmitter.setTicket({
                    number: child.number,
                    title: child.title,
                    branch: childBranchName(parent.number, child.number),
                  });
                  tuiEmitter.beginAgentStep(agentStep);
                },
              },
              runAttempt: async (attempt) =>
                runIssueAsPrdPromptSession({
                  branch: `issue-${parent.number}-readiness-${child.number}-a${attempt}`,
                  baseRef: accumulationSha,
                  stage: "subtask_readiness",
                  runName: buildSubtaskReadinessRunName(child.number, attempt),
                  model: SUBTASK_READINESS_MODEL,
                  promptFile: SUBTASK_READINESS_USER_PROMPT_FILE,
                  promptArgs: {
                    PARENT_ISSUE_NUMBER: String(parent.number),
                    PARENT_ISSUE_TITLE: parent.title,
                    ACCUMULATION_HEAD_SHA: accumulationSha,
                    SUBTASK_TITLE: child.title,
                    ACTIVE_SIBLINGS: activeSiblings
                      .map((sibling) => `#${sibling.number}: ${sibling.title}\n${sibling.body}`)
                      .join("\n\n"),
                    PARENT_CONTEXT: parentContext.rendered,
                    SUBTASK_BODY: child.body,
                  },
                }),
            }),
        });
      },
      runChildEngine: async ({ child, accumulationSha }) =>
        runIssueAsPrdChildEngine({
          parentNumber: parent.number,
          child,
          accumulationSha,
        }),
      runDirectParentEngine: async ({
        parent,
        context,
        accumulationBranch,
        accumulationSha,
      }) =>
        runIssueAsPrdDirectParentEngine({
          parent,
          accumulationBranch,
          accumulationSha,
          renderedContext: context.rendered,
        }),
      verifyInitialAlreadySatisfied: async ({ reviewedBaseSha, headSha }) => {
        if (!reviewedBaseSha || !headSha) {
          return {
            ok: false as const,
            diagnostics: [
              `already_satisfied verification needs both SHAs (base='${reviewedBaseSha}', head='${headSha}').`,
            ],
          };
        }
        try {
          return {
            ok: true as const,
            empty: treeShaOf(reviewedBaseSha) === treeShaOf(headSha),
            evidence: `Tree comparison: ${reviewedBaseSha} vs ${headSha}.`,
          };
        } catch (error) {
          return {
            ok: false as const,
            diagnostics: [
              `Tree comparison between ${reviewedBaseSha} and ${headSha} failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
          };
        }
      },
      closeAlreadySatisfiedChild: ({ child, evidence }) =>
        closeIssueAsPrdAlreadySatisfiedChild({ child, evidence, client }),
      markChildStuck: ({ child, reason }) => {
        recordLoopFailureDiagnostic({
          scope: "child",
          outcome: "child_stuck",
          issue: child.number,
          parentIssue: parent.number,
          branch: childBranchName(parent.number, child.number),
          lastFeedback: reason,
        });
        return markIssueAsPrdChildStuck({ child, reason, client });
      },
      integrateChild: async (integration) =>
        {
          const childRecord = client.viewIssue(integration.childNumber);
          tuiEmitter.setTicket({
            number: childRecord.number,
            title: childRecord.title,
            branch: childBranchName(parent.number, childRecord.number),
          });
          tuiEmitter.beginHostStep("child_integration", currentState.accumulationBranch);
          return integrateIssueAsPrdChild(integration, {
            readAccumulationHeads: ({ accumulationBranch }) =>
              readAccumulationHeads(accumulationBranch),
            isAncestor: ({ ancestorSha, descendantSha }) =>
              spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
                encoding: "utf8",
              }).status === 0,
            fastForwardLocalAccumulation: ({ accumulationBranch, targetSha }) => {
              const currentHead = git(["rev-parse", accumulationBranch]).trim();
              execFileSync(
                "git",
                ["update-ref", `refs/heads/${accumulationBranch}`, targetSha, currentHead],
                { stdio: "inherit" },
              );
            },
            pushAccumulationBranch: ({ accumulationBranch, expectedHeadSha }) =>
              pushAccumulationBranchWithLease({
                accumulationBranch,
                expectedHeadSha,
              }),
            closeChildIssue: ({ childNumber, comment }) => {
              const record = client.viewIssue(childNumber);
              if (record.state === "CLOSED") return "already_closed" as const;
              client.closeIssue(childNumber, comment);
              return "closed" as const;
            },
            readChildIssue: ({ childNumber }) => client.viewIssue(childNumber),
          });
        },
      refreshBeforeReview: (refreshInput) => {
        tuiEmitter.setTicket({
          number: parent.number,
          title: parent.title,
          branch: currentState.accumulationBranch,
        });
        tuiEmitter.beginHostStep("pre_review_refresh", currentState.accumulationBranch);
        return runRefreshForAccumulation(refreshInput);
      },
      runAggregateValidation: async ({
        gate,
        commands,
        accumulationSha,
        repairAlreadyUsed,
      }) => {
        const aggregateValidationRunner =
          createAggregateValidationCommandRunner(parent.number);
        try {
          return await runAggregateValidation(
          {
            gate,
            commands,
            accumulationSha,
            repairAlreadyUsed,
          },
          {
            parent,
            accumulationBranch: input.state.accumulationBranch,
            queueLabel: input.state.queueLabel,
            siblingSummaries: [],
            runValidationCommand: aggregateValidationRunner.run,
            publishChildren: ({ drafts }) =>
              publishIssueAsPrdParentChildren({
                parent,
                drafts,
                queueLabel: input.state.queueLabel,
                client,
              }),
            markRepairBudgetUsed: async ({ gate }) => {
              const nextState = {
                ...currentState,
                aggregateValidationRepairs: {
                  ...currentState.aggregateValidationRepairs,
                  [gate]: 1 as const,
                },
              };
              const persisted = await persistIssueAsPrdParentStateComment(
                {
                  parentNumber: parent.number,
                  commentId: stateCommentId,
                  state: nextState,
                },
                {
                  createComment: ({ parentNumber, body }) =>
                    client.createComment(parentNumber, body).id,
                  updateComment: ({ commentId, body }) =>
                    client.updateComment(commentId, body),
                },
              );
              currentState = nextState;
              stateCommentId = persisted.commentId;
            },
            readiness: ({ children, siblingSummaries, accumulationSha }) =>
              runSubtaskReadinessBatch({
                parentContext: input.normalizedContext,
                children,
                siblingSummaries,
                accumulationSha,
                client,
                acquire: (child, activeSiblings) =>
                  acquireSubtaskReadiness({
                    prd: label,
                    childIssueNumber: child.number,
                    model: SUBTASK_READINESS_MODEL,
                    round: gate,
                    promptFile: SUBTASK_READINESS_USER_PROMPT_FILE,
                    promptArgs: {
                      PARENT_ISSUE_NUMBER: String(parent.number),
                      PARENT_ISSUE_TITLE: parent.title,
                      ACCUMULATION_HEAD_SHA: accumulationSha,
                      SUBTASK_TITLE: child.title,
                      ACTIVE_SIBLINGS: activeSiblings
                        .map((sibling) => `#${sibling.number}: ${sibling.title}\n${sibling.body}`)
                        .join("\n\n"),
                      PARENT_CONTEXT: input.normalizedContext.rendered,
                      SUBTASK_BODY: child.body,
                    },
                    measuredRunDeps: {
                      beginAgentStep: (agentStep) => {
                        tuiEmitter.setTicket({
                          number: child.number,
                          title: child.title,
                          branch: childBranchName(parent.number, child.number),
                        });
                        tuiEmitter.beginAgentStep(agentStep);
                      },
                    },
                    runAttempt: async (attempt) =>
                      runIssueAsPrdPromptSession({
                        branch: `issue-${parent.number}-repair-readiness-${child.number}-a${attempt}`,
                        baseRef: accumulationSha,
                        stage: "subtask_readiness",
                        runName: buildSubtaskReadinessRunName(child.number, attempt),
                        model: SUBTASK_READINESS_MODEL,
                        promptFile: SUBTASK_READINESS_USER_PROMPT_FILE,
                        promptArgs: {
                          PARENT_ISSUE_NUMBER: String(parent.number),
                          PARENT_ISSUE_TITLE: parent.title,
                          ACCUMULATION_HEAD_SHA: accumulationSha,
                          SUBTASK_TITLE: child.title,
                          ACTIVE_SIBLINGS: activeSiblings
                            .map((sibling) => `#${sibling.number}: ${sibling.title}\n${sibling.body}`)
                            .join("\n\n"),
                          PARENT_CONTEXT: input.normalizedContext.rendered,
                          SUBTASK_BODY: child.body,
                        },
                      }),
                  }),
              }),
            runEngine: ({ child, accumulationSha }) =>
              runIssueAsPrdChildEngine({
                parentNumber: parent.number,
                child,
                accumulationSha,
              }),
            integrate: (integration) =>
              integrateIssueAsPrdChild(integration, {
                readAccumulationHeads: ({ accumulationBranch }) =>
                  readAccumulationHeads(accumulationBranch),
                isAncestor: ({ ancestorSha, descendantSha }) =>
                  spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
                    encoding: "utf8",
                  }).status === 0,
                fastForwardLocalAccumulation: ({ accumulationBranch, targetSha }) => {
                  const currentHead = git(["rev-parse", accumulationBranch]).trim();
                  execFileSync(
                    "git",
                    ["update-ref", `refs/heads/${accumulationBranch}`, targetSha, currentHead],
                    { stdio: "inherit" },
                  );
                },
                pushAccumulationBranch: ({ accumulationBranch, expectedHeadSha }) =>
                  pushAccumulationBranchWithLease({
                    accumulationBranch,
                    expectedHeadSha,
                  }),
                closeChildIssue: ({ childNumber, comment }) => {
                  const record = client.viewIssue(childNumber);
                  if (record.state === "CLOSED") return "already_closed" as const;
                  client.closeIssue(childNumber, comment);
                  return "closed" as const;
                },
                readChildIssue: ({ childNumber }) => client.viewIssue(childNumber),
              }),
            closeChild: ({ childNumber, comment }) => {
              client.closeIssue(childNumber, comment);
            },
            readChild: ({ childNumber }) => client.viewIssue(childNumber),
            markChildStuck: ({ childNumber, reason }) =>
              markIssueAsPrdChildStuck({
                child: { number: childNumber },
                reason,
                client,
              }),
          },
          );
        } finally {
          aggregateValidationRunner.close();
        }
      },
      runFullParentExtraReview: ({
        parent,
        parentContext,
        queueLabel,
        originalForkSha,
        reviewBaseSha,
        accumulationHeadSha,
        roundNumber,
      }) => {
        tuiEmitter.setPhase("extra_review");
        tuiEmitter.beginHostStep("full_parent_review", accumulationHeadSha);
        return runIssueAsPrdExtraReview(
          {
            parent,
            parentContext,
            queueLabel,
            originalForkSha,
            reviewBaseSha,
            accumulationHeadSha,
            roundNumber,
          },
          {
            prdIdentity: ({ parent, queueLabel }): ExtraReviewPrdArtifactIdentity => ({
              number: parent.number,
              label: queueLabel,
              title: parent.title,
            }),
            makeRound: ({ roundNumber, accumulationHeadSha }): ExtraReviewRoundArtifactIdentity & { number: 1 } => ({
              number: roundNumber,
              id: `round-${String(roundNumber).padStart(2, "0")}-head-${accumulationHeadSha.slice(0, 7)}`,
            }),
            writeReviewInputs: ({
              parent,
              parentContext,
              prd,
              round,
              originalReviewBaseArg,
              resolvedReviewBaseSha,
              reviewedHeadSha,
            }) =>
              writeCompletedBranchReviewInputs({
                prd: {
                  number: parent.number,
                  label: prd.label ?? input.state.queueLabel,
                  branch: input.state.accumulationBranch,
                  title: parent.title,
                  body: parentContext.rendered,
                },
                round,
                originalReviewBaseArg,
                resolvedReviewBaseSha,
                reviewedHeadSha,
              }),
            runSequentialSessions: (sessionInput) =>
              runSequentialExtraReviewSessions({
                ...sessionInput,
                sandboxBaseBranch: input.state.accumulationBranch,
                idleTimeoutSeconds,
                copyToWorktree: COPY_TO_WORKTREE,
                hooks: sandboxReadyHooks(),
                onAgentSession: ({ runName }) => {
                  const activeLogPath = tuiWorkingLogPath(runName);
                  return {
                    activeLogPath,
                    logging: {
                      type: "file",
                      path: agentRunLogPath(input.state.accumulationBranch, runName),
                      onAgentStreamEvent: tuiEmitter.workingLogSink(activeLogPath),
                    },
                  };
                },
                createSandbox: (sandboxInput) =>
                  sandcastle.createSandbox({
                    sandbox: dockerSandboxProvider(),
                    branch: sandboxInput.branch,
                    baseBranch: sandboxInput.baseBranch,
                    copyToWorktree: sandboxInput.copyToWorktree,
                    hooks: sandboxInput.hooks,
                  }),
                createAgent: (model, agentName) =>
                  agentName
                    ? sandcastle.opencode(model, { agent: agentName })
                    : sandcastle.opencode(model),
                sessionAgents: {
                  code_quality: {
                    agentName: CODE_QUALITY_AGENT_CONFIG.name,
                    promptFile: CODE_QUALITY_USER_PROMPT_FILE,
                  },
                  two_axis: {
                    agentName: TWO_AXIS_AGENT_CONFIG.name,
                    promptFile: TWO_AXIS_USER_PROMPT_FILE,
                  },
                  issue_decomposer: {
                    agentName: DECOMPOSER_AGENT_CONFIG.name,
                    promptFile: DECOMPOSER_USER_PROMPT_FILE,
                  },
                },
                writeAgentDefinition: ({ worktreePath, session, agentName }) => {
                  ensureOpencodeGitExclude(worktreePath);
                  const spec = {
                    code_quality: {
                      config: CODE_QUALITY_AGENT_CONFIG,
                      model: CODE_QUALITY_MODEL,
                      system: CODE_QUALITY_AGENT_SYSTEM_PROMPT_FILE,
                    },
                    two_axis: {
                      config: TWO_AXIS_AGENT_CONFIG,
                      model: TWO_AXIS_MODEL,
                      system: TWO_AXIS_AGENT_SYSTEM_PROMPT_FILE,
                    },
                    issue_decomposer: {
                      config: DECOMPOSER_AGENT_CONFIG,
                      model: ISSUE_DECOMPOSER_MODEL,
                      system: DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE,
                    },
                  }[session];
                  writeAgentDefinitionFile(
                    worktreePath,
                    agentName,
                    buildAgentDefinition(
                      spec.config,
                      spec.model,
                      readFileSync(spec.system.replace(/^\.\//, ""), "utf8"),
                    ),
                  );
                },
              }),
            completedPrdBranch: () => input.state.accumulationBranch,
          },
        );
      },
      observeTerminalMainline: ({ mainlineRef, fullParentReviewBaseSha, preReviewConflict }) =>
        observeIssueAsPrdTerminalMainline(
          { mainlineRef, fullParentReviewBaseSha, preReviewConflict },
          {
            fetchMainline: ({ mainlineRef }) => {
              fetchOriginBase();
              return git(["rev-parse", mainlineRef]).trim();
            },
            revParse: (ref) => git(["rev-parse", ref]).trim(),
          },
        ),
      mainlineRef: originBaseRef(),
      preReviewValidationCommands: VALIDATION_COMMANDS,
      preDeliveryValidationCommands: VALIDATION_COMMANDS,
    },
  );

  const terminal = terminalActionForParentResult(result);
  if (terminal.kind === "ownership_ambiguous") {
    console.error(
      `Ownership ambiguous after processing parent #${parent.number}:\n${terminal.diagnostics.join("\n")}`,
    );
    recordLoopFailureDiagnostic({
      scope: "parent",
      outcome: "ownership_ambiguous",
      issue: parent.number,
      branch: accumulationBranchName(parent.number),
      detail: { diagnostics: terminal.diagnostics },
    });
    return { stopLoop: false, skippedParentNumber: parent.number };
  }

  tuiEmitter.setPhase("normal_issue");
  tuiEmitter.setTicket({
    number: parent.number,
    title: parent.title,
    branch: currentState.accumulationBranch,
  });

  const finalParent = client.viewIssue(parent.number);
  if (terminal.kind === "deliver") {
    tuiEmitter.beginHostStep("deliver_review_ready", currentState.accumulationBranch);
    const childVerification = verifyTerminalChildren({
      parentNumber: parent.number,
      result:
        result.kind === "partial_delivery"
          ? {
              kind: "partial_delivery",
              stuckChildNumber: result.stuckChildNumber,
            }
          : { kind: "clean_delivery" },
      queueLabel: currentState.queueLabel,
      client,
    });
    if (!childVerification.ok) {
      console.error(
        `Terminal child verification failed for parent #${parent.number}:\n${childVerification.diagnostics.join("\n")}`,
      );
      return { stopLoop: true };
    }
    pushAccumulationBranchWithLease({
      accumulationBranch: currentState.accumulationBranch,
      expectedHeadSha: git(["rev-parse", currentState.accumulationBranch]).trim(),
    });
    await persistTerminalPhase("delivered");
    const add = terminal.labelPlan.add.filter((label) => !finalParent.labels.some((value) => value.name === label));
    const remove = terminal.labelPlan.remove.filter((label) => finalParent.labels.some((value) => value.name === label));
    const labelVerification = await applyVerifiedParentTerminalLabels({
      parentNumber: parent.number,
      add,
      remove,
      client,
    });
    if (!labelVerification.ok) {
      console.error(
        `Terminal label verification failed for parent #${parent.number}:\n${labelVerification.diagnostics.join("\n")}`,
      );
      return { stopLoop: true };
    }
    if (terminal.labelPlan.deleteQueueLabel) {
      try {
        gh(["label", "delete", currentState.queueLabel, "--yes"]);
      } catch (err) {
        console.warn(
          `Warning: failed to delete queue label ${currentState.queueLabel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    recordIssueOutcome({
      prd: label,
      issue: parent.number,
      outcome: "review_ready",
      roundsUsed: 1,
    });
    return { stopLoop: false };
  }

  if (terminal.kind === "close_complete") {
    tuiEmitter.beginHostStep("deliver_review_ready", currentState.accumulationBranch);
    const childVerification = verifyTerminalChildren({
      parentNumber: parent.number,
      result: { kind: "clean_delivery" },
      queueLabel: currentState.queueLabel,
      client,
    });
    if (!childVerification.ok) {
      console.error(
        `Already-complete child verification failed for parent #${parent.number}:\n${childVerification.diagnostics.join("\n")}`,
      );
      return { stopLoop: true };
    }
    await persistTerminalPhase("delivered");
    const add = terminal.labelPlan.add.filter((label) => !finalParent.labels.some((value) => value.name === label));
    const remove = terminal.labelPlan.remove.filter((label) => finalParent.labels.some((value) => value.name === label));
    const labelVerification = await applyVerifiedParentTerminalLabels({
      parentNumber: parent.number,
      add,
      remove,
      client,
    });
    if (!labelVerification.ok) {
      console.error(
        `Already-complete label verification failed for parent #${parent.number}:\n${labelVerification.diagnostics.join("\n")}`,
      );
      return { stopLoop: true };
    }
    if (terminal.labelPlan.deleteQueueLabel) {
      try {
        gh(["label", "delete", currentState.queueLabel, "--yes"]);
      } catch (err) {
        console.warn(
          `Warning: failed to delete queue label ${currentState.queueLabel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const closeVerification = await runVerifiedHostMutation({
      mutate: () =>
        client.closeIssue(
          parent.number,
          [
            "Closing as already complete: the deliverable already exists on the current base with a host-verified empty diff.",
            "",
            "Evidence:",
            terminal.evidence,
          ].join("\n"),
        ),
      readBack: () => client.viewIssue(parent.number),
      verify: (value) => value.state === "CLOSED",
      describe: (value) => `issue #${value.number} state=${value.state}`,
    });
    if (!closeVerification.ok) {
      console.error(
        `Already-complete close verification failed for parent #${parent.number}:\n${closeVerification.diagnostics.join("\n")}`,
      );
      return { stopLoop: true };
    }
    recordIssueOutcome({
      prd: label,
      issue: parent.number,
      outcome: "already_satisfied",
      roundsUsed: 1,
    });
    return { stopLoop: false };
  }

  tuiEmitter.setTicket({
    number: parent.number,
    title: parent.title,
    branch: currentState.accumulationBranch,
  });
  pushAccumulationBranchWithLease({
    accumulationBranch: currentState.accumulationBranch,
    expectedHeadSha: git(["rev-parse", currentState.accumulationBranch]).trim(),
  });
  await persistTerminalPhase("failed");
  const add = terminal.labelPlan.add.filter((label) => !finalParent.labels.some((value) => value.name === label));
  const remove = terminal.labelPlan.remove.filter((label) => finalParent.labels.some((value) => value.name === label));
  const labelVerification = await applyVerifiedParentTerminalLabels({
    parentNumber: parent.number,
    add,
    remove,
    client,
  });
  if (!labelVerification.ok) {
    console.error(
      `Parent-stuck label verification failed for parent #${parent.number}:\n${labelVerification.diagnostics.join("\n")}`,
    );
    return { stopLoop: true };
  }
  const commentBody = [
    `Parent issue cannot continue automatically: ${terminal.reason}`,
    "",
    ...terminal.diagnostics,
  ].join("\n");
  recordLoopFailureDiagnostic({
    scope: "parent",
    outcome: "parent_stuck",
    issue: parent.number,
    branch: currentState.accumulationBranch,
    lastFeedback: commentBody,
    detail: { reason: terminal.reason },
  });
  const commentVerification = await appendVerifiedParentComment({
    parentNumber: parent.number,
    body: commentBody,
    client,
  });
  if (!commentVerification.ok) {
    console.error(
      `Parent-stuck comment verification failed for parent #${parent.number}:\n${commentVerification.diagnostics.join("\n")}`,
    );
    return { stopLoop: true };
  }
  recordIssueOutcome({
    prd: label,
    issue: parent.number,
    outcome: "blocked",
    roundsUsed: 1,
  });
  return { stopLoop: false };
}

async function processIssue(issue: IssueDetail): Promise<void> {
  console.log(`Picked issue #${issue.number}: ${issue.title}`);

  const issueBranch = `issue-${issue.number}`;
  const issueComments = flattenComments(issue.comments);
  tuiEmitter.setTicket({
    number: issue.number,
    title: issue.title,
    branch: issueBranch,
  });

  preflightExistingIssueBranch(issue, issueBranch);

  const run = await runBacklogIssueViaSharedEngine({
    issue,
    issueBranch,
    issueComments,
  });

  try {
    const { outcome, worktreePath } = run;
    if (outcome.kind === "already_satisfied") {
      markStuck(issue, worktreePath, issueBranch, {
        headline: `Coder reported this issue is already satisfied on \`${baseBranch}\`; no code changes were produced. A human should confirm before closing.`,
        lastFeedback: outcome.evidence,
        roundsUsed: outcome.roundsUsed,
      });
      console.log(
        `Issue #${issue.number} marked ${STUCK_LABEL}: coder reported already satisfied.`,
      );
      recordIssueOutcome({
        prd: label,
        issue: issue.number,
        outcome: "already_satisfied",
        roundsUsed: outcome.roundsUsed,
      });
    } else if (outcome.kind === "approved") {
      try {
        tuiEmitter.beginHostStep("deliver_review_ready", issueBranch);
        deliverReviewReady(issue, worktreePath, issueBranch);
        console.log(
          `Issue #${issue.number} is review-ready: branch ${issueBranch} pushed and labelled ${REVIEW_LABEL}.`,
        );
        recordIssueOutcome({
          prd: label,
          issue: issue.number,
          outcome: "review_ready",
          roundsUsed: outcome.roundsUsed,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Issue #${issue.number} approved but review-ready delivery failed: ${msg.slice(0, 300)}`,
        );
        try {
          markStuck(issue, worktreePath, issueBranch, {
            headline:
              "Reviewer approved but the host could not push the branch or apply the Review label. Manual intervention required.",
            lastFeedback: msg.slice(0, 4000),
          });
        } catch (stuckErr) {
          console.error(
            `markStuck also failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
          );
        }
      }
    } else if (outcome.kind === "stuck") {
      const reasonHeader =
        (outcome.lastFeedback || "(no feedback recorded)")
          .split("\n")
          .find((l) => l.trim().startsWith("##"))
          ?.trim()
          .replace(/^##\s*/, "") ?? "(no recognizable reason header)";
      console.log(
        `Issue #${issue.number} stuck after ${outcome.roundsUsed} round(s) (${outcome.reason}). Reason: ${reasonHeader}`,
      );
      const preview = (outcome.lastFeedback || "")
        .split("\n")
        .slice(0, 12)
        .map((l) => `    ${l}`)
        .join("\n");
      if (preview) {
        console.log("  Last feedback (first 12 lines):");
        console.log(preview);
      }
      try {
        markStuck(issue, worktreePath, issueBranch, {
          lastFeedback: outcome.lastFeedback || "(no feedback recorded)",
          roundsUsed: outcome.roundsUsed,
          terminalReason: outcome.reason,
        });
      } catch (stuckErr) {
        console.error(
          `markStuck failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
        );
      }
      recordIssueOutcome({
        prd: label,
        issue: issue.number,
        outcome: outcome.reason,
        roundsUsed: outcome.roundsUsed,
      });
    } else {
      console.error(
        `Issue #${issue.number} crashed unexpectedly. Continuing to next issue.\n${outcome.error}`,
      );
      recordLoopFailureDiagnostic({
        scope: "issue",
        outcome: "crashed",
        issue: issue.number,
        branch: issueBranch,
        worktreePath,
        roundsUsed: outcome.roundsUsed,
        error: outcome.error,
      });
      recordIssueOutcome({
        prd: label,
        issue: issue.number,
        outcome: "crashed",
        roundsUsed: outcome.roundsUsed,
      });
    }
  } finally {
    await run.closeSandbox();
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

ensureBaseBranchAvailable();
ensureLabels();

let completedIterations = 0;
let consecutiveAcquisitionFailures = 0;
const MAX_ACQUISITION_FAILURES = 3;
let stopReason:
  | "no_eligible_issue"
  | "max_iterations" = "no_eligible_issue";

while (true) {
  if (completedIterations >= MAX_ITERATIONS) {
    stopReason = "max_iterations";
    break;
  }
  const iteration = completedIterations + 1;
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  tuiEmitter.setIteration({ current: iteration, max: MAX_ITERATIONS });

  let parent: Awaited<ReturnType<typeof acquireNextIssueAsPrdParentForLoop>>;
  try {
    parent = await acquireNextIssueAsPrdParentForLoop();
    consecutiveAcquisitionFailures = 0;
  } catch (error) {
    // Acquisition failures (gh/API hiccups) name no parent to skip, so retry
    // a few times before giving up on the whole run.
    consecutiveAcquisitionFailures++;
    console.error(
      `Parent acquisition failed (${consecutiveAcquisitionFailures}/${MAX_ACQUISITION_FAILURES}):\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    recordLoopFailureDiagnostic({
      scope: "loop",
      outcome: "acquisition_failed",
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      detail: {
        consecutive_failures: consecutiveAcquisitionFailures,
        max_failures: MAX_ACQUISITION_FAILURES,
      },
    });
    if (consecutiveAcquisitionFailures >= MAX_ACQUISITION_FAILURES) break;
    continue;
  }
  if (parent.kind === "none") {
    console.log(`No eligible issues with label(s) '${labels.join(", ")}'.`);
    tuiEmitter.clearTicket();
    stopReason = "no_eligible_issue";
    break;
  }

  let processed: Awaited<ReturnType<typeof processIssueAsPrdParent>>;
  try {
    processed = await processIssueAsPrdParent(parent);
  } catch (error) {
    // One parent's host-side crash must not kill the whole loop: skip the
    // parent for this run (the recover script can requeue it) and move on.
    const parentNumber = parent.parent.number;
    console.error(
      `Processing parent #${parentNumber} crashed; skipping it for this run.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    skippedAmbiguousParentNumbers.add(parentNumber);
    recordLoopFailureDiagnostic({
      scope: "parent",
      outcome: "crashed",
      issue: parentNumber,
      branch: accumulationBranchName(parentNumber),
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    recordIssueOutcome({
      prd: label,
      issue: parentNumber,
      outcome: "crashed",
      roundsUsed: 1,
    });
    tuiEmitter.clearTicket();
    continue;
  }
  if (processed.skippedParentNumber !== undefined) {
    skippedAmbiguousParentNumbers.add(processed.skippedParentNumber);
    tuiEmitter.clearTicket();
    continue;
  }
  if (processed.stopLoop) break;
  completedIterations++;
}

// Companion TUI: write the terminal snapshot with the clean stop reason.
tuiEmitter.stop(stopReason);

console.log(
  [
    "\nBacklog loop stopped.",
    `Reason: ${stopReason}`,
    `Label(s): ${labels.join(", ")}`,
    `Issues processed: ${completedIterations}/${MAX_ITERATIONS}`,
  ].join("\n"),
);

console.log("\nAll done.");
