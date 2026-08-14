import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildAgentDefinition,
  CODE_QUALITY_AGENT_CONFIG,
  CODER_AGENT_CONFIG,
  DECOMPOSER_AGENT_CONFIG,
  REVIEWER_AGENT_CONFIG,
  REWORK_AGENT_CONFIG,
  TWO_AXIS_AGENT_CONFIG,
} from "./custom-agent-defs.mts";
import { enforceArgvSizeLimit } from "./custom-agent-argv-guard.mts";
import { renderSlimMessage } from "./custom-agent-render.mts";
import {
  ensureOpencodeGitExclude,
  ensureSandboxGitExclude,
  writeAgentDefinitionFile,
} from "./custom-agent-worktree.mts";
import { installStructuredResultMcp } from "./structured-result-mcp-install.mts";
import { withStructuredResultMcpAgent } from "./structured-result-agent-provider.mts";
import { clearStructuredResultFromWorktree } from "./structured-result-acquisition.mts";
import {
  EXTRA_DECOMPOSER_MAX_ITERATIONS,
  EXTRA_REVIEWER_MAX_ITERATIONS,
  MAX_EXTRA_REVIEW_ROUNDS,
  REVIEW_FOLLOW_UP_LABEL,
} from "./extra-review-config.mts";
import {
  writeExtraReviewRoundArtifacts,
  type ExtraReviewPrdArtifactIdentity,
  type ExtraReviewRoundArtifactIdentity,
} from "./extra-review-artifacts.mts";
import {
  EXTRA_REVIEW_INPUT_DIFF_EXCLUDES,
  writeCompletedBranchReviewInputs,
} from "./extra-review-inputs.mts";
import {
  publishExtraReviewIssues,
  type ExtraReviewIssueArtifactRefs,
  type ExtraReviewIssueGhClient,
} from "./extra-review-issues.mts";
import {
  runBoundedExtraReviewMainLoop,
  type ExtraReviewRoundResult,
  type NormalIssueIterationResult,
} from "./extra-review-main-loop.mts";
import type {
  ExtraReviewBaseValidationState,
  ExtraReviewQueueIssue,
} from "./extra-review-queue-state.mts";
import { runSequentialExtraReviewSessions } from "./extra-review-sessions.mts";
import {
  recordIssueOutcome,
  recordMeasuredAgentRun,
  recordReviewerResult,
  recordValidationRun,
} from "./metrics-recorder.mts";
import {
  initialNoProgressState,
  observeFailedRoundFingerprint,
  sha1,
  type NoProgressState,
  type WorktreeProgressSnapshot,
} from "./loop-progress.mts";
import {
  formatStuckIssueComment,
  type StuckTerminalReason,
} from "./mark-stuck-comment.mts";
import {
  acquireReviewerResult,
  buildReviewerAttemptRunName,
  sanitizeReviewerExcerpt,
  summarizeReviewerAttemptFailure,
  type ReviewFinding,
  type ReviewResult,
} from "./reviewer-result.mts";
import {
  runPerBranchEngine,
  type EngineCoderResult,
  type EngineReviewerAcquisitionResult,
  type PerBranchEngineOutcome,
  type PerBranchEnginePolicy,
  type PerBranchTask,
} from "./per-branch-engine.mts";
import { PRD_V4_ENGINE_POLICY } from "./per-branch-policy.mts";
import { loadSandcastleLoopConfig } from "./sandcastle-loop-config.mts";
import {
  createLivelockWatchdogSandcastleRunOptions,
  agentInvocationStageForRound,
  resolveRound1CoderLivelockControlFlow,
  resolveReworkLivelockControlFlow,
} from "./agent-invocation-livelock.mts";
import { tuiEmitter } from "./tui-emitter.mts";
import { tuiWorkingLogPath } from "./tui-status.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const LOOP_CONFIG = await loadSandcastleLoopConfig(REPO_ROOT);

const CODER_MODEL = LOOP_CONFIG.models.coder;
const REWORK_MODEL = LOOP_CONFIG.models.rework;
const REVIEWER_MODEL = LOOP_CONFIG.models.reviewer;
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

const STUCK_LABEL = "agent-stuck";

// Loop bounds
const MAX_REVIEW_ROUNDS = PRD_V4_ENGINE_POLICY.maxReviewRounds; // coder<->reviewer attempts per issue (lowered from 10)
const FAILED_ROUND_REPEAT_LIMIT =
  PRD_V4_ENGINE_POLICY.failedRoundRepeatLimit;
const MAX_ITERATIONS = 50; // outer-loop safety cap
const CODER_MAX_ITERATIONS = PRD_V4_ENGINE_POLICY.coderMaxIterations;
const MAX_RECOVERY_ATTEMPTS = PRD_V4_ENGINE_POLICY.maxRecoveryAttempts;
const MAX_PUSH_RECOVERY_ATTEMPTS = 2; // remote issue-branch push recovery

// Idle timeout for the agent (sandcastle fails the run if stdout is silent
// this long). Local LLMs like Qwen 35B on a single GPU often go silent for
// many minutes during a single generation — opencode buffers stdout until
// the next tool call or final response. 1800s = 30 min is a safe default;
// override on the command line with `--idle-timeout <seconds>`.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

// Host-side validation gate. Runs after each coder commit, before the reviewer.
// Empty array disables the gate. Commands run sequentially; first failure stops
// the gate and is fed back to the coder as the next round's REVIEW_FEEDBACK.
const VALIDATION_COMMANDS: string[] = LOOP_CONFIG.validationCommands;

// Commands to run inside the sandbox once it's ready (e.g. install deps).
const SANDBOX_READY_COMMANDS: string[] = LOOP_CONFIG.setupCommands;

// Git pathspec exclusions for the reviewer diff. Lockfiles and other
// auto-generated bulk bloat the prompt fast and have no review value.
const REVIEW_DIFF_EXCLUDES: string[] = [...EXTRA_REVIEW_INPUT_DIFF_EXCLUDES];

// Hard cap on the reviewer diff (bytes). Linux execve argv limit is ~128KB
// system-wide and opencode passes the whole prompt as a single CLI arg, so
// keep this well under that with headroom for the rest of the prompt.
const REVIEW_DIFF_MAX_BYTES = LOOP_CONFIG.reviewDiffMaxBytes;
const PRD_V4_RUN_ENGINE_POLICY: PerBranchEnginePolicy = {
  ...PRD_V4_ENGINE_POLICY,
  reviewerMaxAttempts: LOOP_CONFIG.reviewer.maxAttempts,
  reviewDiffMaxBytes: LOOP_CONFIG.reviewDiffMaxBytes,
};

// `gh pr merge` strategy flag. Repos may disable certain strategies in
// branch protection; use whichever your repo allows.
const PR_MERGE_STRATEGY: "--merge" | "--squash" | "--rebase" = "--squash";

// Files copied from the host into the worktree before the sandbox starts.
const COPY_TO_WORKTREE: string[] = [];

const OPENCODE_MOUNTS = [
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
];

const CACHE_MOUNTS = LOOP_CONFIG.cache.mounts.map((mount) => ({
  hostPath: mount.hostPath,
  sandboxPath: mount.sandboxPath,
}));

const HOST_COMMAND_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...LOOP_CONFIG.cache.hostEnv,
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: tsx run-prd-v5.mts --prd-file <path> --tag <label> --branch <branch> --review-base <commit-ish> [--idle-timeout <seconds>]";

function readRequiredArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (
    index === -1 ||
    !process.argv[index + 1] ||
    process.argv[index + 1]!.startsWith("--")
  ) {
    throw new Error(`${USAGE}\n\nMissing required argument: ${flag} <value>`);
  }
  return process.argv[index + 1]!;
}

function resolvePrdFilePath(fileArg: string): string {
  const prdPath = isAbsolute(fileArg) ? fileArg : resolve(REPO_ROOT, fileArg);
  if (!existsSync(prdPath)) {
    throw new Error(`PRD file not found: ${prdPath}`);
  }
  return prdPath;
}

function resolvePrdNumber(prdPath: string, tag: string): number {
  const basename = prdPath.split("/").pop() ?? prdPath;
  const match = basename.match(/^(\d+)-/);
  if (match) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const hash = createHash("sha1").update(tag).digest();
  return (hash.readUInt32BE(0) % 999_999) + 1;
}

const prdPath = resolvePrdFilePath(readRequiredArg("--prd-file"));
const prdLabel = readRequiredArg("--tag").trim();
if (!prdLabel) {
  throw new Error("--tag must be a non-empty GitHub label");
}
const prdBranch = readRequiredArg("--branch").trim();
if (!prdBranch) {
  throw new Error("--branch must be a non-empty git branch name");
}
const prdNumber = resolvePrdNumber(prdPath, prdLabel);
const prdBody = readFileSync(prdPath, "utf8");
console.log(`Loaded PRD: ${prdPath}`);
console.log(`Issue label: ${prdLabel}`);
console.log(`Feature branch: ${prdBranch}`);

const reviewBaseArgIndex = process.argv.indexOf("--review-base");
if (
  reviewBaseArgIndex === -1 ||
  !process.argv[reviewBaseArgIndex + 1] ||
  process.argv[reviewBaseArgIndex + 1]!.startsWith("--")
) {
  throw new Error(
    `${USAGE}\n\nMissing required argument: --review-base <commit-ish>`,
  );
}
const extraReviewBaseArg = process.argv[reviewBaseArgIndex + 1]!;

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

const extraReviewBaseSha = resolveExtraReviewBaseSha(extraReviewBaseArg);
console.log(
  `Extra review base: ${extraReviewBaseArg} -> ${extraReviewBaseSha}`,
);
console.log(
  [
    `Extra review config: rounds=${MAX_EXTRA_REVIEW_ROUNDS}`,
    `codeReviewModel=${CODE_QUALITY_MODEL}`,
    `twoAxisModel=${TWO_AXIS_MODEL}`,
    `issueDecomposerModel=${ISSUE_DECOMPOSER_MODEL}`,
    `reviewerMaxIterations=${EXTRA_REVIEWER_MAX_ITERATIONS}`,
    `decomposerMaxIterations=${EXTRA_DECOMPOSER_MAX_ITERATIONS}`,
    `followUpLabel=${REVIEW_FOLLOW_UP_LABEL}`,
  ].join(", "),
);
console.log(
  [
    LOOP_CONFIG.loadedConfig
      ? `Sandcastle config: ${LOOP_CONFIG.configPath}`
      : `Sandcastle config: using built-in defaults; ${LOOP_CONFIG.configPath} not found`,
    `models=${Object.entries(LOOP_CONFIG.models)
      .map(([role, model]) => `${role}:${model}`)
      .join(",")}`,
    `setupCommands=${SANDBOX_READY_COMMANDS.length}`,
    `validationCommands=${VALIDATION_COMMANDS.length}`,
    `cacheMounts=${LOOP_CONFIG.cache.mounts.map((m) => m.name).join(",") || "(none)"}`,
    `cacheEnv=${Object.keys(LOOP_CONFIG.cache.sandboxEnv).join(",") || "(none)"}`,
  ].join("\n"),
);
logCoderReworkModelStartupWarning(CODER_MODEL, REWORK_MODEL);

// Companion TUI: begin emitting the read-only status snapshot for this loop.
// Side-effect-only; a failure here can never affect loop control flow.
tuiEmitter.startLoop({ loopType: "prd", loopId: prdLabel });

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

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8" });

const ghJson = <T extends unknown>(args: string[]): T =>
  JSON.parse(gh(args)) as T;

const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { encoding: "utf8", cwd });

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

function resolveExtraReviewBaseSha(reviewBaseArg: string): string {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${reviewBaseArg}^{commit}`],
    { encoding: "utf8" },
  );
  const resolvedSha = (result.stdout ?? "").trim();
  if (result.status !== 0 || !resolvedSha) {
    throw new Error(
      [
        `--review-base must resolve to a commit, got ${reviewBaseArg}`,
        `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return resolvedSha;
}

function gitSpawn(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function treeShaOf(ref: string, cwd?: string): string {
  return git(["rev-parse", `${ref}^{tree}`], cwd).trim();
}

function countCommitsAheadOfBase(worktreePath: string): number {
  const raw = git(
    ["rev-list", "--count", `${originPrdRef()}..HEAD`],
    worktreePath,
  ).trim();
  const parsed = Number.parseInt(raw || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function originPrdRef(): string {
  return `origin/${prdBranch}`;
}

function branchExists(branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", branch], {
      encoding: "utf8",
    }).status === 0
  );
}

function ensureBaseBranch(): void {
  // Fetch first so origin/<prdBranch> is current — it's what we use as
  // baseBranch for every new issue sandbox.
  const fetch = spawnSync("git", ["fetch", "origin", prdBranch], {
    encoding: "utf8",
  });

  if (fetch.status === 0) {
    // origin/<prdBranch> exists and is now fresh — nothing else to do.
    return;
  }

  // origin/<prdBranch> doesn't exist yet. Create it from current HEAD and
  // push, so future iterations have a remote-tracking ref to fork from.
  console.log(
    `origin/${prdBranch} not found; creating ${prdBranch} from current HEAD and pushing`,
  );
  const localExists = git(["branch", "--list", prdBranch]).trim();
  if (!localExists) {
    git(["branch", prdBranch]);
  }
  const push = spawnSync("git", ["push", "-u", "origin", prdBranch], {
    encoding: "utf8",
  });
  if (push.status !== 0) {
    throw new Error(
      `Could not create ${prdBranch} on origin: ${push.stderr ?? ""}`,
    );
  }
}

function preflightExistingIssueBranch(
  issue: IssueDetail,
  issueBranch: string,
): void {
  fetchOriginPrd();
  if (!branchExists(issueBranch)) return;

  const baseSha = git(["rev-parse", originPrdRef()]).trim();
  const mergeBase = git(["merge-base", originPrdRef(), issueBranch]).trim();
  const diff = execFileSync(
    "git",
    [
      "diff",
      `${originPrdRef()}..${issueBranch}`,
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
      `${originPrdRef()}..${issueBranch}`,
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
    `Existing branch ${issueBranch} is stale and ${tooLarge ? "oversized" : "polluted"}; quarantining to ${diagnosticBranch} and starting fresh from ${originPrdRef()}.`,
  );
  git(["branch", "-f", diagnosticBranch, issueBranch]);
  execFileSync("git", ["branch", "-D", issueBranch], { stdio: "inherit" });
  const deleteRemote = spawnSync(
    "git",
    ["push", "origin", "--delete", issueBranch],
    {
      encoding: "utf8",
    },
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
  | {
      ok: false;
      feedback: string;
      signature: string;
      command: string;
      exitCode: number;
    };

function summarizeFailureOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim().length > 0);

  // Wrapper noise that's not the actual error — useful for context but never
  // the headline.
  const isNoise = (l: string) =>
    /^npm (error|warn|notice)\b/i.test(l) ||
    /^\s*>\s/.test(l) ||
    /Lifecycle script .* failed/.test(l) ||
    /^npm error code\b/i.test(l) ||
    /^npm error path\b/i.test(l) ||
    /^npm error workspace\b/i.test(l) ||
    /^npm error location\b/i.test(l) ||
    /^npm error command\b/i.test(l);

  // Patterns that almost always indicate the real failure. First-match wins;
  // ordered roughly by specificity.
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

  // Fallback: last 3 non-noise lines.
  const tail = lines
    .filter((l) => !isNoise(l))
    .slice(-3)
    .join(" | ");
  return tail.slice(0, 280) || "(no informative output)";
}

function runValidationGate(
  worktreePath: string,
  context: {
    prd: number;
    issue?: number;
    round: number | string;
    gate: "issue" | "base";
  },
): GateResult {
  const hostStepName = context.gate === "base" ? "base_validation" : "validation";
  for (const [index, cmd] of VALIDATION_COMMANDS.entries()) {
    tuiEmitter.beginHostStep(hostStepName, cmd);
    console.log(`  $ ${cmd}`);
    const startedMs = Date.now();
    const result = spawnSync(cmd, {
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
        command: cmd,
        exitCode: result.status ?? 1,
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
  resultSource: "stdout" | "run_log" | "structured_result_file" | "none";
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

type PrepResult =
  | { ok: true; baseSha: string; recoveryAttempts: number }
  | { ok: false; feedback: string; recoveryAttempts: number };

function prepareBranchForReview(
  worktreePath: string,
  issueBranch: string,
  recoveryAttempts: number,
): PrepResult {
  const baseSha = fetchOriginPrd(worktreePath);
  const oldHead = git(["rev-parse", "HEAD"], worktreePath).trim();
  console.log(`  rebasing ${issueBranch} onto ${originPrdRef()}`);
  const rebase = gitSpawn(["rebase", originPrdRef()], worktreePath);
  if (rebase.status !== 0) {
    gitSpawn(["rebase", "--abort"], worktreePath);
    console.log(`  rebase failed; attempting fresh branch recovery`);
    return recoverFreshBranch(
      worktreePath,
      issueBranch,
      oldHead,
      recoveryAttempts,
      `rebase onto ${originPrdRef()} failed`,
      `${rebase.stdout || ""}\n${rebase.stderr || ""}`.trim(),
    );
  }

  const mergeBase = git(
    ["merge-base", originPrdRef(), "HEAD"],
    worktreePath,
  ).trim();
  if (mergeBase !== baseSha) {
    console.log(
      `  branch ancestry is not clean; attempting fresh branch recovery`,
    );
    return recoverFreshBranch(
      worktreePath,
      issueBranch,
      git(["rev-parse", "HEAD"], worktreePath).trim(),
      recoveryAttempts,
      `merge-base ${mergeBase} did not match reviewed base ${baseSha}`,
      "",
    );
  }

  return { ok: true, baseSha, recoveryAttempts };
}

function fetchOriginPrd(worktreePath?: string): string {
  execFileSync("git", ["fetch", "origin", prdBranch], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  return git(["rev-parse", originPrdRef()], worktreePath).trim();
}

function syncLocalPrdBranchToOrigin(): string {
  const baseSha = fetchOriginPrd();
  const currentBranch = git(["branch", "--show-current"]).trim();
  if (currentBranch !== prdBranch) {
    throw new Error(
      `Host repo must be on ${prdBranch} before the loop can run; found ${currentBranch || "(detached HEAD)"}.`,
    );
  }

  const trackedDirty = git(["status", "--short", "--untracked-files=no"]).trim();
  if (trackedDirty) {
    throw new Error(
      [
        `Host repo has tracked changes on ${prdBranch}; refusing to validate against a dirty base.`,
        "",
        "```",
        trackedDirty,
        "```",
      ].join("\n"),
    );
  }

  const currentSha = git(["rev-parse", "HEAD"]).trim();
  if (currentSha === baseSha) return baseSha;

  console.log(
    `Fast-forwarding local ${prdBranch} from ${currentSha.slice(0, 7)} to ${baseSha.slice(0, 7)}`,
  );
  const ff = spawnSync("git", ["merge", "--ff-only", originPrdRef()], {
    encoding: "utf8",
  });
  if (ff.status !== 0) {
    throw new Error(
      `Could not fast-forward local ${prdBranch} to ${originPrdRef()}:\n${`${ff.stdout ?? ""}${ff.stderr ?? ""}`.trim()}`,
    );
  }

  return baseSha;
}

function ensureBaseBranchIsGreen(lastValidatedTreeSha: string): string {
  syncLocalPrdBranchToOrigin();
  const baseTreeSha = treeShaOf(originPrdRef());
  if (baseTreeSha === lastValidatedTreeSha) {
    console.log(
      `Base ${originPrdRef()} tree ${baseTreeSha.slice(0, 7)} already validated; skipping base re-validation.`,
    );
    return baseTreeSha;
  }

  console.log(
    `Running base validation for ${originPrdRef()} (tree ${baseTreeSha.slice(0, 7)})`,
  );
  const gate = runValidationGate(process.cwd(), {
    prd: prdNumber,
    round: "base",
    gate: "base",
  });
  if (!gate.ok) {
    throw new Error(
      `Base branch ${originPrdRef()} is red. Stop the loop and repair ${prdBranch} before processing more issues.\n\n${gate.feedback}`,
    );
  }

  return baseTreeSha;
}

function recoverFreshBranch(
  worktreePath: string,
  issueBranch: string,
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
  const baseSha = fetchOriginPrd(worktreePath);
  const oldBase = git(
    ["merge-base", originPrdRef(), oldHead],
    worktreePath,
  ).trim();
  const commits = git(
    ["rev-list", "--reverse", `${originPrdRef()}..${oldHead}`],
    worktreePath,
  )
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);

  console.log(
    `  recovery ${attempt}/${MAX_RECOVERY_ATTEMPTS}: replaying ${commits.length} commit(s) on ${originPrdRef()}`,
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
        `The host could not replay this issue's patch onto the latest ${originPrdRef()}.`,
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
    ["commit", "-m", `recover ${issueBranch} on latest ${prdBranch}`],
    {
      cwd: worktreePath,
      stdio: "inherit",
    },
  );
  return { ok: true, baseSha, recoveryAttempts: attempt };
}

function maybeRecoverOversizedOrPollutedDiff(
  worktreePath: string,
  issue: IssueDetail,
  issueBranch: string,
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

function formatDiffTooLargeFeedback(context: ReviewContext): string {
  return [
    "## Diff too large",
    "",
    `The review diff is ${context.diffBytes} bytes, above the ${REVIEW_DIFF_MAX_BYTES} byte limit.`,
    "",
    "These PRD issues are expected to be small, scoped changes. Reduce scope, remove unrelated/generated changes, and commit a smaller diff.",
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

class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeConflictError";
  }
}

class BaseAdvancedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseAdvancedError";
  }
}

function pushIssueBranch(
  worktreePath: string,
  issueBranch: string,
  purpose: "merge" | "stuck",
): void {
  for (
    let attempt = 1;
    attempt <= MAX_PUSH_RECOVERY_ATTEMPTS;
    attempt++
  ) {
    const localHead = git(["rev-parse", "HEAD"], worktreePath).trim();
    const lsRemote = spawnSync(
      "git",
      ["ls-remote", "--heads", "origin", issueBranch],
      {
        cwd: worktreePath,
        encoding: "utf8",
      },
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
        {
          cwd: worktreePath,
          encoding: "utf8",
        },
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
        {
          cwd: worktreePath,
          encoding: "utf8",
        },
      );
      if (push.status === 0) return;
      throw new Error(
        `Could not update remote ${issueBranch} for ${purpose} push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const fastForward = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", remoteSha, localHead],
      {
        cwd: worktreePath,
        encoding: "utf8",
      },
    ).status === 0;

    if (fastForward) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${issueBranch}`],
        {
          cwd: worktreePath,
          encoding: "utf8",
        },
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
      {
        cwd: worktreePath,
        encoding: "utf8",
      },
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
      {
        cwd: worktreePath,
        encoding: "utf8",
      },
    );
    if (replace.status === 0) return;
    if (attempt < MAX_PUSH_RECOVERY_ATTEMPTS) continue;
    throw new Error(
      `Could not replace remote ${issueBranch} after archiving ${diagnosticBranch}:\n${`${replace.stdout ?? ""}${replace.stderr ?? ""}`.trim()}`,
    );
  }
}

function approveAndMerge(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
  reviewedBaseSha: string,
): void {
  console.log(`  verifying ${originPrdRef()} has not advanced since review`);
  const currentBaseSha = fetchOriginPrd(worktreePath);
  if (currentBaseSha !== reviewedBaseSha) {
    throw new BaseAdvancedError(
      `${originPrdRef()} advanced from reviewed base ${reviewedBaseSha} to ${currentBaseSha}. Re-validation and re-review are required before merge.`,
    );
  }

  pushIssueBranch(worktreePath, issueBranch, "merge");
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
  // Refresh origin/<prdBranch> so the next issue's baseBranch (which uses the
  // remote-tracking ref) sees the merge. We don't touch the local prdBranch:
  // git refuses to update a branch that's the active HEAD in another worktree
  // or the main repo, and we don't actually need the local ref to advance.
  const sync = spawnSync("git", ["fetch", "origin", prdBranch], {
    stdio: "inherit",
  });
  if (sync.status !== 0) {
    console.warn(
      `Could not refresh origin/${prdBranch} after merge. Next issue may start from a stale base.`,
    );
  }
}

async function runPrdV4IssueViaSharedEngine(input: {
  issue: IssueDetail;
  issueBranch: string;
  issueComments: string;
}): Promise<{
  outcome: PerBranchEngineOutcome;
  worktreePath: string;
  approvedTreeSha: string;
  closeSandbox(): Promise<void>;
}> {
  const { issue, issueBranch, issueComments } = input;
  const task: PerBranchTask = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    comments: issueComments,
    branch: issueBranch,
    baseRef: originPrdRef(),
  };
  let sandbox: Awaited<ReturnType<typeof sandcastle.createSandbox>> | null =
    null;
  let recoveryAttempts = 0;
  let approvedTreeSha = "";
  let announcedRound = 0;

  const requireSandbox = () => {
    if (!sandbox) {
      throw new Error(`Sandbox not initialized for ${issueBranch}`);
    }
    return sandbox;
  };

  const announceRound = (round: number) => {
    if (announcedRound === round) return;
    announcedRound = round;
    console.log(`\n--- Round ${round}/${MAX_REVIEW_ROUNDS} for #${issue.number} ---`);
    tuiEmitter.setRound({ current: round, max: MAX_REVIEW_ROUNDS });
  };

  const outcome = await runPerBranchEngine({
    task,
    policy: PRD_V4_RUN_ENGINE_POLICY,
    deps: {
      async createSandbox() {
        tuiEmitter.beginHostStep("sandbox_setup", issueBranch);
        sandbox = await sandcastle.createSandbox({
          sandbox: dockerSandboxProvider(),
          branch: issueBranch,
          baseBranch: `origin/${prdBranch}`,
          copyToWorktree: COPY_TO_WORKTREE,
          hooks: {
            sandbox: {
              onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({
                command,
              })),
            },
          },
        });
        ensureOpencodeGitExclude(sandbox.worktreePath);
        ensureSandboxGitExclude(sandbox.worktreePath);
        installStructuredResultMcp(sandbox.worktreePath);
        return {
          worktreePath: sandbox.worktreePath,
          async close() {
            // Shared engine closes its sandbox in finally, but merge/stuck
            // routing in this file still needs the worktree afterwards.
          },
        };
      },
      async preCoderRebaseGuard() {
        return { ok: true };
      },
      async invokeCoder({
        round,
        feedback,
        isRework,
        maxIterations,
      }): Promise<EngineCoderResult> {
        announceRound(round);
        const activeSandbox = requireSandbox();

        if (isRework) {
          const reworkUserArgs = {
            ISSUE_NUMBER: String(issue.number),
            ISSUE_TITLE: issue.title,
            ISSUE_BODY: issue.body || "(no body)",
            REVIEW_FEEDBACK: feedback,
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
            activeSandbox.worktreePath,
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

          const reworkRunName = `rework #${issue.number} r${round}`;
          const reworkActiveLogPath = tuiWorkingLogPath(reworkRunName);
          const reworkLivelockWatchdog =
            createLivelockWatchdogSandcastleRunOptions({
              logPath: agentRunLogPath(issueBranch, reworkRunName),
              getWorktreeSnapshot: () =>
                captureWorktreeProgressSnapshot(activeSandbox.worktreePath),
              onStreamEvent: tuiEmitter.workingLogSink(reworkActiveLogPath),
            });
          try {
            const reworkResult: Awaited<ReturnType<typeof activeSandbox.run>> =
              await recordMeasuredAgentRun(
              {
                prd: prdNumber,
                issue: issue.number,
                stage: "rework",
                agent: REWORK_AGENT_CONFIG.name,
                round,
                model: REWORK_MODEL,
                runName: reworkRunName,
                worktreePath: activeSandbox.worktreePath,
                promptFile: REWORK_USER_PROMPT_FILE,
                promptArgs: reworkUserArgs,
                activeLogPath: reworkActiveLogPath,
              },
              () =>
                activeSandbox.run({
                  name: reworkRunName,
                  agent: sandcastle.opencode(REWORK_MODEL, {
                    agent: REWORK_AGENT_CONFIG.name,
                  }),
                  maxIterations,
                  completionSignal: "<promise>COMPLETE</promise>",
                  idleTimeoutSeconds,
                  promptFile: REWORK_USER_PROMPT_FILE,
                  promptArgs: reworkUserArgs,
                  signal: reworkLivelockWatchdog.signal,
                  logging: reworkLivelockWatchdog.logging,
                }),
            );
            const blockedMatch = reworkResult.stdout.match(
              /<blocked>([\s\S]*?)<\/blocked>/,
            );
            if (blockedMatch) {
              return {
                kind: "blocked",
                feedback: `Coder signaled blocked on round ${round}:\n\n${blockedMatch[1]!.trim()}`,
              };
            }
            if (reworkResult.commits.length === 0) {
              const uncommitted = git(
                ["status", "-s"],
                activeSandbox.worktreePath,
              ).trim();
              if (uncommitted) {
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
              return {
                kind: "failed",
                feedback:
                  "## No commits produced\n\nYour previous run finished without committing any changes. Re-read the issue and the PRD, then make the required code changes and commit them.",
              };
            }
            const dirty = git(["status", "-s"], activeSandbox.worktreePath).trim();
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
              committedCount: reworkResult.commits.length,
            };
          } catch (reworkErr) {
            const control = resolveReworkLivelockControlFlow(reworkErr);
            if (control.action === "break_to_stuck") {
              return { kind: "livelock", feedback: control.feedback };
            }
            throw control.error;
          }
        }

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
          activeSandbox.worktreePath,
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

        const coderRunName = `coder #${issue.number} r${round}`;
        const coderActiveLogPath = tuiWorkingLogPath(coderRunName);
        const livelockWatchdog = createLivelockWatchdogSandcastleRunOptions({
          logPath: agentRunLogPath(issueBranch, coderRunName),
          getWorktreeSnapshot: () =>
            captureWorktreeProgressSnapshot(activeSandbox.worktreePath),
          onStreamEvent: tuiEmitter.workingLogSink(coderActiveLogPath),
        });
        try {
            const coderResult: Awaited<ReturnType<typeof activeSandbox.run>> =
              await recordMeasuredAgentRun(
              {
                prd: prdNumber,
                issue: issue.number,
              stage: "coder",
              agent: CODER_AGENT_CONFIG.name,
              round,
              model: CODER_MODEL,
              runName: coderRunName,
              worktreePath: activeSandbox.worktreePath,
              promptFile: CODER_USER_PROMPT_FILE,
              promptArgs: coderUserArgs,
              activeLogPath: coderActiveLogPath,
            },
            () =>
              activeSandbox.run({
                name: coderRunName,
                agent: sandcastle.opencode(CODER_MODEL, {
                  agent: CODER_AGENT_CONFIG.name,
                }),
                maxIterations,
                completionSignal: "<promise>COMPLETE</promise>",
                idleTimeoutSeconds,
                promptFile: CODER_USER_PROMPT_FILE,
                promptArgs: coderUserArgs,
                signal: livelockWatchdog.signal,
                logging: livelockWatchdog.logging,
              }),
          );
          const blockedMatch = coderResult.stdout.match(
            /<blocked>([\s\S]*?)<\/blocked>/,
          );
          if (blockedMatch) {
            return {
              kind: "blocked",
              feedback: `Coder signaled blocked on round ${round}:\n\n${blockedMatch[1]!.trim()}`,
            };
          }

          const alreadySatisfiedMatch = coderResult.stdout.match(
            /<already_satisfied>([\s\S]*?)<\/already_satisfied>/,
          );
          let committedCount = coderResult.commits.length;
          if (alreadySatisfiedMatch) {
            const reason = alreadySatisfiedMatch[1]!.trim();
            const existingAheadCount = countCommitsAheadOfBase(
              activeSandbox.worktreePath,
            );
            if (existingAheadCount > 0) {
              committedCount = existingAheadCount;
            } else {
              return { kind: "already_satisfied", evidence: reason };
            }
          } else if (committedCount === 0) {
            const uncommitted = git(
              ["status", "-s"],
              activeSandbox.worktreePath,
            ).trim();
            if (uncommitted) {
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
              activeSandbox.worktreePath,
            );
            if (existingAheadCount > 0) {
              committedCount = existingAheadCount;
            } else {
              return {
                kind: "failed",
                feedback:
                  "## No commits produced\n\nYour previous run finished without committing any changes. Re-read the issue and the PRD, then make the required code changes and commit them.",
              };
            }
          }

          const dirty = git(["status", "-s"], activeSandbox.worktreePath).trim();
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

          return { kind: "committed", committedCount };
        } catch (coderErr) {
          const control = resolveRound1CoderLivelockControlFlow(coderErr);
          if (control.action === "continue_with_feedback") {
            return { kind: "failed", feedback: control.feedback };
          }
          throw control.error;
        }
      },
      async prepareBranchForReview() {
        const activeSandbox = requireSandbox();
        const prep = prepareBranchForReview(
          activeSandbox.worktreePath,
          issueBranch,
          recoveryAttempts,
        );
        recoveryAttempts = prep.recoveryAttempts;
        if (!prep.ok) {
          return { ok: false, feedback: prep.feedback, recoverable: false };
        }
        const context = computeReviewContext(
          activeSandbox.worktreePath,
          prep.baseSha,
        );
        const recovery = maybeRecoverOversizedOrPollutedDiff(
          activeSandbox.worktreePath,
          issue,
          issueBranch,
          context,
          recoveryAttempts,
        );
        recoveryAttempts = recovery.recoveryAttempts;
        if (!recovery.ok) {
          return { ok: false, feedback: recovery.feedback, recoverable: false };
        }
        return { ok: true, reviewedBaseSha: recovery.baseSha };
      },
      async recoverBranch() {
        return {
          ok: false,
          feedback:
            "Shared engine requested branch recovery after adapter recovery had already completed.",
        };
      },
      async computeReviewContext({ reviewedBaseSha }) {
        const activeSandbox = requireSandbox();
        const context = computeReviewContext(
          activeSandbox.worktreePath,
          reviewedBaseSha,
        );
        approvedTreeSha = treeShaOf("HEAD", activeSandbox.worktreePath);
        console.log(
          `  review diff: ${context.diffBytes} bytes, ${context.changedFiles.length} file(s), aspects: ${context.reviewAspects.join(", ")}`,
        );
        return context;
      },
      async runValidation({ round }) {
        announceRound(round);
        const activeSandbox = requireSandbox();
        console.log(`  running validation gate`);
        const gate = runValidationGate(activeSandbox.worktreePath, {
          prd: prdNumber,
          issue: issue.number,
          round,
          gate: "issue",
        });
        if (!gate.ok) {
          return {
            ok: false,
            command: gate.command,
            exitCode: gate.exitCode,
            feedback: gate.feedback,
          };
        }
        console.log(`  validation green; invoking reviewer`);
        return { ok: true };
      },
      async acquireReviewer({ round, attempt, context }) {
        announceRound(round);
        const activeSandbox = requireSandbox();
        const reviewerUserArgs = {
          ISSUE_NUMBER: String(issue.number),
          ISSUE_TITLE: issue.title,
          ISSUE_BODY: issue.body || "(no body)",
          ISSUE_COMMENTS: issueComments,
          BASE_BRANCH: originPrdRef(),
          REVIEW_BASE_SHA: context.baseSha,
          DIFF: context.diff,
          DIFF_BYTES: String(context.diffBytes),
          DIFF_MAX_BYTES: String(REVIEW_DIFF_MAX_BYTES),
          CHANGED_FILES: context.changedFiles.join("\n") || "(none)",
          DIFF_STAT: context.diffStat,
          REVIEW_ASPECTS: context.reviewAspects.join(", "),
          ECOSYSTEMS: context.ecosystems.join(", ") || "(unknown)",
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
            resultSource: "none",
            logFallbackUsed: false,
            diagnostics: [reviewerSizeCheck.error],
            excerpt: reviewerSizeCheck.error,
          } satisfies EngineReviewerAcquisitionResult;
        }

        writeAgentDefinitionFile(
          activeSandbox.worktreePath,
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
          round,
          attempt,
        );
        const reviewerActiveLogPath = tuiWorkingLogPath(reviewerRunName);
        clearStructuredResultFromWorktree(
          activeSandbox.worktreePath,
          "review",
        );
        const reviewerResult: Awaited<ReturnType<typeof activeSandbox.run>> =
          await recordMeasuredAgentRun(
          {
            prd: prdNumber,
            issue: issue.number,
            stage: "reviewer",
            agent: REVIEWER_AGENT_CONFIG.name,
            round,
            model: REVIEWER_MODEL,
            runName: reviewerRunName,
            worktreePath: activeSandbox.worktreePath,
            promptFile: REVIEWER_USER_PROMPT_FILE,
            promptArgs: reviewerUserArgs,
            activeLogPath: reviewerActiveLogPath,
          },
          () =>
            activeSandbox.run({
              name: reviewerRunName,
              agent: withStructuredResultMcpAgent(
                sandcastle.opencode(REVIEWER_MODEL, {
                  agent: REVIEWER_AGENT_CONFIG.name,
                }),
              ),
              maxIterations: 1,
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
        const acquisition = acquireReviewerResult({
          worktreePath: activeSandbox.worktreePath,
          logFilePath,
        });
        recordReviewerResult({
          prd: prdNumber,
          issue: issue.number,
          round,
          attempt,
          maxAttempts: PRD_V4_RUN_ENGINE_POLICY.reviewerMaxAttempts,
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
        if (acquisition.kind !== "verdict") {
          console.log(
            `  reviewer attempt ${attempt}/${PRD_V4_RUN_ENGINE_POLICY.reviewerMaxAttempts} failed to produce a valid verdict (${summarizeReviewerAttemptFailure(acquisition)});${attempt < PRD_V4_RUN_ENGINE_POLICY.reviewerMaxAttempts ? " retrying" : ""}`,
          );
        } else {
          console.log(`  reviewer decision: ${acquisition.review.decision}`);
        }
        return {
          ...acquisition,
          excerpt: sanitizeReviewerExcerpt(
            acquisition.diagnostics.join("\n") || reviewerResult.stdout,
          ),
        } satisfies EngineReviewerAcquisitionResult;
      },
      currentHeadSha() {
        return git(["rev-parse", "HEAD"], requireSandbox().worktreePath).trim();
      },
      currentTreeSha() {
        return treeShaOf("HEAD", requireSandbox().worktreePath);
      },
      onHostStep(name, detail) {
        tuiEmitter.beginHostStep(name, detail);
      },
    },
  });

  const worktreePath = requireSandbox().worktreePath;

  return {
    outcome,
    worktreePath,
    approvedTreeSha,
    async closeSandbox() {
      await sandbox?.close();
    },
  };
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

function closeIssueAsAlreadySatisfied(
  issue: IssueDetail,
  reason: string,
): void {
  const baseSha = fetchOriginPrd().slice(0, 7);
  execFileSync(
    "gh",
    [
      "issue",
      "close",
      String(issue.number),
      "--reason",
      "completed",
      "--comment",
      [
        `Already satisfied on \`${prdBranch}\` at \`${baseSha}\`; no code changes were required.`,
        "",
        "Agent note:",
        "",
        reason,
      ].join("\n"),
    ],
    { stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

ensureBaseBranch();
let lastValidatedTreeSha = "";

async function processNormalIssueIteration(context: {
  completedIterations: number;
}): Promise<NormalIssueIterationResult> {
  const iteration = context.completedIterations + 1;
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  tuiEmitter.setPhase("normal_issue");
  tuiEmitter.setIteration({ current: iteration, max: MAX_ITERATIONS });

  const issue = pickNextIssue();
  if (!issue) {
    console.log(`No eligible issues with label '${prdLabel}'.`);
    tuiEmitter.clearTicket();
    return { kind: "no_eligible_issue" };
  }

  console.log(`Picked issue #${issue.number}: ${issue.title}`);

  const issueBranch = `${prdBranch}-issue-${issue.number}`;
  const issueComments = flattenComments(issue.comments);
  tuiEmitter.setTicket({
    number: issue.number,
    title: issue.title,
    branch: issueBranch,
  });

  preflightExistingIssueBranch(issue, issueBranch);

  let roundsUsed = 0;
  let shared: Awaited<ReturnType<typeof runPrdV4IssueViaSharedEngine>> | null =
    null;
  try {
    shared = await runPrdV4IssueViaSharedEngine({
      issue,
      issueBranch,
      issueComments,
    });
    const { outcome, worktreePath, approvedTreeSha } = shared;
    roundsUsed = outcome.roundsUsed;

    if (outcome.kind === "already_satisfied") {
      try {
        closeIssueAsAlreadySatisfied(issue, outcome.evidence);
        console.log(
          `Issue #${issue.number} closed as already satisfied on ${prdBranch}.`,
        );
        recordIssueOutcome({
          prd: prdNumber,
          issue: issue.number,
          outcome: "already_satisfied",
          roundsUsed: outcome.roundsUsed,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Issue #${issue.number} was reported as already satisfied, but close step failed: ${msg.slice(0, 300)}`,
        );
        try {
          markStuck(issue, worktreePath, issueBranch, {
            headline: `Coder reported the issue is already satisfied on ${prdBranch}, but the host could not close it automatically.`,
            lastFeedback: `${outcome.evidence}\n\n${msg.slice(0, 4000)}`,
          });
        } catch (stuckErr) {
          console.error(
            `markStuck also failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
          );
        }
      }
    } else if (outcome.kind === "approved") {
      try {
        tuiEmitter.beginHostStep("merge", issueBranch);
        approveAndMerge(issue, worktreePath, issueBranch, outcome.reviewedBaseSha);
        lastValidatedTreeSha = approvedTreeSha;
        console.log(`Issue #${issue.number} merged into ${prdBranch}.`);
        recordIssueOutcome({
          prd: prdNumber,
          issue: issue.number,
          outcome: "merged",
          roundsUsed: outcome.roundsUsed,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Issue #${issue.number} approved but merge step failed: ${msg.slice(0, 300)}`,
        );
        try {
          markStuck(issue, worktreePath, issueBranch, {
            headline:
              "Reviewer approved but the host could not complete the merge. Manual intervention required.",
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
        prd: prdNumber,
        issue: issue.number,
        outcome: outcome.reason,
        roundsUsed: outcome.roundsUsed,
      });
    } else {
      console.error(
        `Iteration ${iteration} for #${issue.number} crashed unexpectedly. Continuing to next issue.\n${outcome.error}`,
      );
      recordIssueOutcome({
        prd: prdNumber,
        issue: issue.number,
        outcome: "crashed",
        roundsUsed: outcome.roundsUsed,
      });
    }
  } catch (iterErr) {
    console.error(
      `Iteration ${iteration} for #${issue.number} crashed unexpectedly. Continuing to next issue.\n${iterErr instanceof Error ? (iterErr.stack ?? iterErr.message) : iterErr}`,
    );
    recordIssueOutcome({
      prd: prdNumber,
      issue: issue.number,
      outcome: "crashed",
      roundsUsed,
    });
  } finally {
    await shared?.closeSandbox();
  }

  return { kind: "processed_issue", issueNumber: issue.number };
}

function listOpenPrdIssuesForExtraReview(): ExtraReviewQueueIssue[] {
  return ghJson<IssueListItem[]>([
    "issue",
    "list",
    "--label",
    prdLabel,
    "--state",
    "open",
    "--json",
    "number,title,labels",
    "--limit",
    "200",
  ]).map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
  }));
}

function validateBaseForExtraReview(): ExtraReviewBaseValidationState {
  try {
    lastValidatedTreeSha = ensureBaseBranchIsGreen(lastValidatedTreeSha);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Base validation failed before issue pick:\n${msg}`);
    return {
      ok: false,
      summary: "Base validation failed before issue pick.",
      feedback: msg,
    };
  }
}

function currentReviewedPrdHeadSha(): string {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${originPrdRef()}^{commit}`],
    { encoding: "utf8" },
  );
  const sha = (result.stdout ?? "").trim();
  if (result.status === 0 && sha) return sha;
  return git(["rev-parse", "HEAD"]).trim();
}

async function runExtraReviewRound(input: {
  round: ExtraReviewRoundArtifactIdentity & { number: number };
}): Promise<ExtraReviewRoundResult> {
  const reviewedHeadSha = currentReviewedPrdHeadSha();
  const round = extraReviewRoundIdentity(input.round.number, reviewedHeadSha);
  const prd = prdArtifactIdentity();

  try {
    console.log(
      `\n=== Extra Review Round ${round.number}/${MAX_EXTRA_REVIEW_ROUNDS} ===\n`,
    );
    console.log(
      `Reviewing ${extraReviewBaseSha.slice(0, 7)}..${reviewedHeadSha.slice(0, 7)} on ${prdBranch}`,
    );
    tuiEmitter.setPhase("extra_review");
    tuiEmitter.setExtraReviewRound({
      current: round.number,
      max: MAX_EXTRA_REVIEW_ROUNDS,
    });
    tuiEmitter.clearTicket();

    const reviewInputs = writeCompletedBranchReviewInputs({
      prd: {
        number: prdNumber,
        label: prdLabel,
        branch: prdBranch,
        path: prdPath,
        title: prd.title,
        body: prdBody,
      },
      round,
      originalReviewBaseArg: extraReviewBaseArg,
      resolvedReviewBaseSha: extraReviewBaseSha,
      reviewedHeadSha,
    });

    const sessions = await runSequentialExtraReviewSessions({
      prd,
      round,
      reviewInputs,
      completedPrdBranch: prdBranch,
      sandboxBaseBranch: originPrdRef(),
      idleTimeoutSeconds,
      copyToWorktree: COPY_TO_WORKTREE,
      hooks: sandboxReadyHooks(),
      resultAcquisition: "structured_result_file",
      onAgentSession: ({ runName }) => {
        const activeLogPath = tuiWorkingLogPath(runName);
        return {
          activeLogPath,
          logging: {
            type: "file",
            path: agentRunLogPath(prdBranch, runName),
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
      createAgent: (model, agentName) => {
        const roleModel = extraReviewModelForAgent(agentName) ?? model;
        return withStructuredResultMcpAgent(
          agentName
            ? sandcastle.opencode(roleModel, { agent: agentName })
            : sandcastle.opencode(roleModel),
        );
      },
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
        ensureSandboxGitExclude(worktreePath);
        installStructuredResultMcp(worktreePath);

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
    });

    if (sessions.stopReason !== "success") {
      console.log(
        `Extra review round ${round.number} stopped with ${sessions.stopReason}. Handoff: ${sessions.artifactWrite.paths.files.handoff}`,
      );
      return {
        stopReason: sessions.stopReason,
        createdIssueCount: 0,
        skippedDuplicateIssueCount: 0,
        artifactWrite: sessions.artifactWrite,
      };
    }

    const decomposition = sessions.outputs.issueDecomposer?.parsed;
    if (!decomposition) {
      const artifactWrite = writeExtraReviewRoundArtifacts({
        runsRootDir: reviewInputs.paths.runsRootDir,
        prd,
        round,
        reviewBase: extraReviewBaseSha,
        reviewedHead: reviewedHeadSha,
        stopReason: "failure",
        stopDetails: ["Issue decomposer output was missing after a success round."],
        outputs: sessions.outputs,
      });
      return {
        stopReason: "failure",
        createdIssueCount: 0,
        skippedDuplicateIssueCount: 0,
        artifactWrite,
      };
    }

    const publication = publishExtraReviewIssues({
      decomposition,
      context: {
        prd: {
          number: prdNumber,
          label: prdLabel,
          path: prdPath,
          title: prd.title,
        },
        round,
        originalReviewBaseArg: extraReviewBaseArg,
        resolvedReviewBaseSha: extraReviewBaseSha,
        reviewedHeadSha,
        artifactRefs: artifactRefsFromRound(sessions.artifactWrite.paths),
        reviewFollowUpLabel: REVIEW_FOLLOW_UP_LABEL,
      },
      gh: extraReviewGhClient(),
    });

    const artifactWrite = writeExtraReviewRoundArtifacts({
      runsRootDir: reviewInputs.paths.runsRootDir,
      prd,
      round,
      reviewBase: extraReviewBaseSha,
      reviewedHead: reviewedHeadSha,
      stopReason: publication.stopReason,
      outputs: sessions.outputs,
      createdIssues: publication.createdIssues,
      skippedDuplicateIssues: publication.skippedDuplicateIssues,
    });

    console.log(
      [
        `Extra review round ${round.number} publication: ${publication.stopReason}.`,
        `Created: ${publication.createdIssues.length}.`,
        `Skipped duplicates: ${publication.skippedDuplicateIssues.length}.`,
        `Handoff: ${artifactWrite.paths.files.handoff}`,
      ].join(" "),
    );

    return {
      stopReason: publication.stopReason,
      createdIssueCount: publication.createdIssues.length,
      skippedDuplicateIssueCount: publication.skippedDuplicateIssues.length,
      artifactWrite,
    };
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`Extra review round ${round.number} failed:\n${msg}`);
    const artifactWrite = writeExtraReviewRoundArtifacts({
      prd,
      round,
      reviewBase: extraReviewBaseSha,
      reviewedHead: reviewedHeadSha,
      stopReason: "failure",
      stopDetails: [msg.slice(0, 4000)],
    });
    return {
      stopReason: "failure",
      createdIssueCount: 0,
      skippedDuplicateIssueCount: 0,
      artifactWrite,
    };
  }
}

function prdArtifactIdentity(): ExtraReviewPrdArtifactIdentity {
  return {
    number: prdNumber,
    id: prdLabel,
    label: prdLabel,
    path: prdPath,
    title: prdTitle(),
  };
}

function prdTitle(): string | undefined {
  return prdBody.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function extraReviewRoundIdentity(
  roundNumber: number,
  reviewedHeadSha: string,
): ExtraReviewRoundArtifactIdentity & { number: number } {
  return {
    number: roundNumber,
    id: `round-${String(roundNumber).padStart(2, "0")}-head-${reviewedHeadSha.slice(0, 7)}`,
  };
}

function sandboxReadyHooks() {
  return {
    sandbox: {
      onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({ command })),
    },
  };
}

function dockerSandboxProvider() {
  return docker({
    mounts: [...OPENCODE_MOUNTS, ...CACHE_MOUNTS],
    env: LOOP_CONFIG.cache.sandboxEnv,
  });
}

function extraReviewModelForAgent(agentName: string | undefined): string | null {
  switch (agentName) {
    case CODE_QUALITY_AGENT_CONFIG.name:
      return CODE_QUALITY_MODEL;
    case TWO_AXIS_AGENT_CONFIG.name:
      return TWO_AXIS_MODEL;
    case DECOMPOSER_AGENT_CONFIG.name:
      return ISSUE_DECOMPOSER_MODEL;
    default:
      return null;
  }
}

function artifactRefsFromRound(
  paths: ReturnType<typeof writeExtraReviewRoundArtifacts>["paths"],
): ExtraReviewIssueArtifactRefs {
  return {
    roundDir: paths.roundDir,
    codeReviewRaw: paths.files.codeReviewRaw,
    codeReviewParsed: paths.files.codeReviewParsed,
    twoAxisReviewRaw: paths.files.twoAxisReviewRaw,
    twoAxisReviewParsed: paths.files.twoAxisReviewParsed,
    issueDecomposerRaw: paths.files.issueDecomposerRaw,
    issueDecomposerParsed: paths.files.issueDecomposerParsed,
    handoff: paths.files.handoff,
  };
}

function extraReviewGhClient(): ExtraReviewIssueGhClient {
  return {
    listIssues(args) {
      return ghJson([...args]);
    },
    viewIssue(args) {
      return ghJson([...args]);
    },
    createIssue(args) {
      const url = gh([...args]).trim();
      return { url };
    },
    ensureLabel(name, description, color) {
      const existing = ghJson<{ name: string }[]>([
        "label",
        "list",
        "--json",
        "name",
        "--limit",
        "1000",
      ]);
      if (existing.some((label) => label.name === name)) return;
      gh([
        "label",
        "create",
        name,
        "--color",
        color ?? "5319e7",
        "--description",
        description ?? "",
      ]);
    },
  };
}

const mainLoopResult = await runBoundedExtraReviewMainLoop({
  prd: prdArtifactIdentity(),
  reviewBase: extraReviewBaseSha,
  maxIterations: MAX_ITERATIONS,
  maxExtraReviewRounds: MAX_EXTRA_REVIEW_ROUNDS,
  listOpenIssues: listOpenPrdIssuesForExtraReview,
  validateBase: validateBaseForExtraReview,
  getReviewedHead: currentReviewedPrdHeadSha,
  runNormalIssueIteration: processNormalIssueIteration,
  runExtraReviewRound,
});

// Companion TUI: write the terminal snapshot with the clean stop reason.
tuiEmitter.stop(mainLoopResult.reason);

console.log(
  [
    "\nLoop stopped.",
    `Reason: ${mainLoopResult.reason}`,
    `Normal issue iterations: ${mainLoopResult.completedIterations}/${MAX_ITERATIONS}`,
    `Extra review rounds: ${mainLoopResult.completedExtraReviewRounds}/${MAX_EXTRA_REVIEW_ROUNDS}`,
    `Created follow-up issues: ${mainLoopResult.createdIssueCount}`,
    `Skipped duplicate follow-up issues: ${mainLoopResult.skippedDuplicateIssueCount}`,
    mainLoopResult.artifactWrite
      ? `Handoff: ${mainLoopResult.artifactWrite.paths.files.handoff}`
      : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

console.log("\nAll done.");
