import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  writeAgentDefinitionFile,
} from "./custom-agent-worktree.mts";
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
  ForgejoTeaClient,
  type ForgejoPullMergeStrategy,
} from "./forgejo-tea.mts";
import { recordMeasuredAgentRun } from "./metrics-recorder.mts";
import { loadSandcastleLoopConfig } from "./sandcastle-loop-config.mts";

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

// PRD layout
const PRD_DIR = "docs/prd";
const LABEL_PREFIX = "prd"; // -> label `prd-<N>`, base branch `prd-<N>`
const STUCK_LABEL = "agent-stuck";

// Loop bounds
const MAX_REVIEW_ROUNDS = 10; // coder<->reviewer attempts per issue
const MAX_ITERATIONS = 50; // outer-loop safety cap
const CODER_MAX_ITERATIONS = 30; // per coder invocation
const MAX_RECOVERY_ATTEMPTS = 2; // branch-hygiene recovery attempts per issue
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
const REVIEW_DIFF_MAX_BYTES = 60_000;

// Pull merge strategy. The Forgejo adapter maps this to `tea pulls merge`.
const PR_MERGE_STRATEGY: ForgejoPullMergeStrategy = "squash";

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
  "Usage: tsx run-prd-extra-review-custom-agents-shared-cache-forgejo.mts --prd <N> --review-base <commit-ish> [--idle-timeout <seconds>]";

const prdArgIndex = process.argv.indexOf("--prd");
if (prdArgIndex === -1 || !process.argv[prdArgIndex + 1]) {
  throw new Error(USAGE);
}
const prdNumber = Number.parseInt(process.argv[prdArgIndex + 1]!, 10);
if (!Number.isInteger(prdNumber) || prdNumber < 1) {
  throw new Error(
    `--prd must be a positive integer, got ${process.argv[prdArgIndex + 1]}`,
  );
}

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

const forgejo = new ForgejoTeaClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { encoding: "utf8", cwd });

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
  const list = forgejo.listIssues({
    label: prdLabel,
    state: "open",
    limit: 200,
  }) as IssueListItem[];
  const eligible = list
    .filter((i) => !i.labels.some((l) => l.name === STUCK_LABEL))
    .sort((a, b) => a.number - b.number);
  if (eligible.length === 0) return null;
  const top = eligible[0]!;
  return forgejo.viewIssue(top.number) as IssueDetail;
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

type GateResult = { ok: true } | { ok: false; feedback: string };

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

function runValidationGate(worktreePath: string): GateResult {
  for (const cmd of VALIDATION_COMMANDS) {
    console.log(`  $ ${cmd}`);
    const result = spawnSync(cmd, {
      shell: true,
      cwd: worktreePath,
      encoding: "utf8",
      env: HOST_COMMAND_ENV,
    });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      console.log(
        `    ✗ failed (exit ${result.status}): ${summarizeFailureOutput(output)}`,
      );
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
  aspect?: string;
  confidence?: number;
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

function syntheticReview(
  decision: ReviewResult["decision"],
  summary: string,
  problem: string,
  remediation: string,
): ReviewResult {
  return {
    decision,
    summary,
    findings: [{ problem, remediation }],
  };
}

// Defensive parse: a low-powered local model may flub the format. Any parse
// failure becomes a synthetic `needs_human_review`, so the outer loop control
// stays deterministic.
function extractReview(stdout: string): ReviewResult {
  const tag = stdout.match(/<review>([\s\S]*?)<\/review>/);
  if (!tag) {
    return syntheticReview(
      "needs_human_review",
      "Reviewer did not emit a <review>...</review> block.",
      "Missing <review> tag in reviewer output.",
      "Inspect the run log and decide manually.",
    );
  }
  try {
    const parsed = JSON.parse(tag[1]!.trim());
    const decision = parsed?.decision;
    if (
      typeof decision === "string" &&
      ["approved", "changes_requested", "needs_human_review"].includes(
        decision,
      ) &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.findings)
    ) {
      if (decision === "approved" && parsed.findings.length > 0) {
        return {
          decision: "changes_requested",
          summary: [
            "Reviewer returned an inconsistent approved review with findings; treating the findings as required rework.",
            parsed.summary,
          ].join(" "),
          findings: parsed.findings as ReviewFinding[],
        };
      }
      if (decision !== "approved" && parsed.findings.length === 0) {
        return syntheticReview(
          "needs_human_review",
          "Reviewer returned a blocking decision without findings.",
          `Reviewer output had decision ${decision} but no actionable findings.`,
          "Inspect the run log and decide manually.",
        );
      }
      return parsed as ReviewResult;
    }
    throw new Error("shape");
  } catch {
    return syntheticReview(
      "needs_human_review",
      "Reviewer JSON could not be parsed or had the wrong shape.",
      "Unparseable reviewer output inside <review> tag.",
      "Inspect the run log and decide manually.",
    );
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

function ensureBaseBranchIsGreen(lastValidatedBaseSha: string): string {
  const baseSha = syncLocalPrdBranchToOrigin();
  if (baseSha === lastValidatedBaseSha) return lastValidatedBaseSha;

  console.log(
    `Running base validation for ${originPrdRef()} at ${baseSha.slice(0, 7)}`,
  );
  const gate = runValidationGate(process.cwd());
  if (!gate.ok) {
    throw new Error(
      `Base branch ${originPrdRef()} is red. Stop the loop and repair ${prdBranch} before processing more issues.\n\n${gate.feedback}`,
    );
  }

  return baseSha;
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
  const pull = forgejo.createPull(
    {
      base: prdBranch,
      head: issueBranch,
      title: issue.title,
      body: `Closes #${issue.number}\n\nAutomated merge from \`${issueBranch}\` into \`${prdBranch}\`.`,
    },
    worktreePath,
  );
  forgejo.mergePull(pull, PR_MERGE_STRATEGY, worktreePath);
  forgejo.closeIssue(
    issue.number,
    `Merged into \`${prdBranch}\` via PR for branch \`${issueBranch}\`.`,
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

function markStuck(
  issue: IssueDetail,
  worktreePath: string,
  issueBranch: string,
  lastFeedback: string,
): void {
  try {
    pushIssueBranch(worktreePath, issueBranch, "stuck");
  } catch (err) {
    console.warn(
      `Could not push ${issueBranch} on stuck — continuing. ${err instanceof Error ? err.message : err}`,
    );
  }
  forgejo.commentIssue(
    issue.number,
    `Agent gave up after ${MAX_REVIEW_ROUNDS} review rounds. Last feedback:\n\n${lastFeedback}`,
  );
  forgejo.addLabelToIssue(issue.number, STUCK_LABEL);
}

function closeIssueAsAlreadySatisfied(
  issue: IssueDetail,
  reason: string,
): void {
  const baseSha = fetchOriginPrd().slice(0, 7);
  forgejo.closeIssue(
    issue.number,
    [
      `Already satisfied on \`${prdBranch}\` at \`${baseSha}\`; no code changes were required.`,
      "",
      "Agent note:",
      "",
      reason,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

forgejo.preflight();
ensureBaseBranch();
let lastValidatedBaseSha = "";

async function processNormalIssueIteration(context: {
  completedIterations: number;
}): Promise<NormalIssueIterationResult> {
  const iteration = context.completedIterations + 1;
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  const issue = pickNextIssue();
  if (!issue) {
    console.log(`No eligible issues with label '${prdLabel}'.`);
    return { kind: "no_eligible_issue" };
  }

  console.log(`Picked issue #${issue.number}: ${issue.title}`);

  const issueBranch = `${prdBranch}-issue-${issue.number}`;
  const issueComments = flattenComments(issue.comments);

  preflightExistingIssueBranch(issue, issueBranch);

  const sandbox = await sandcastle.createSandbox({
    sandbox: dockerSandboxProvider(),
    branch: issueBranch,
    // Use the remote-tracking ref as the fork point. This is always current
    // after the post-merge `git fetch origin <prdBranch>`, and avoids relying
    // on the local prdBranch being up-to-date (which it can't be if it's
    // checked out in the host repo).
    baseBranch: `origin/${prdBranch}`,
    copyToWorktree: COPY_TO_WORKTREE,
    hooks: {
      sandbox: {
        onSandboxReady: SANDBOX_READY_COMMANDS.map((command) => ({ command })),
      },
    },
  });
  ensureOpencodeGitExclude(sandbox.worktreePath);

  let feedback = "";
  let lastFeedback = "";
  let approved = false;
  let alreadySatisfiedReason = "";
  let reviewedBaseSha = "";
  let recoveryAttempts = 0;
  let hostOnlyReview = false;
  let hostOnlyReviewAttempts = 0;

  try {
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      console.log(
        `\n--- Round ${round}/${MAX_REVIEW_ROUNDS} for #${issue.number} ---`,
      );

      let committedCount = 0;
      if (hostOnlyReview) {
        console.log(
          `  base advanced after review; re-syncing and re-reviewing without invoking coder`,
        );
        hostOnlyReview = false;
        committedCount = Number.parseInt(
          git(
            ["rev-list", "--count", `${originPrdRef()}..HEAD`],
            sandbox.worktreePath,
          ).trim() || "0",
          10,
        );
      } else {
        const isRework = round > 1;
        let coderResult: Awaited<ReturnType<typeof sandbox.run>>;

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
            feedback = sizeCheck.error;
            lastFeedback = feedback;
            continue;
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

          const coderRunName = `coder #${issue.number} r${round}`;
          coderResult = await recordMeasuredAgentRun(
            {
              prd: prdNumber,
              issue: issue.number,
              stage: "coder",
              round,
              model: REWORK_MODEL,
              runName: coderRunName,
              worktreePath: sandbox.worktreePath,
              promptFile: REWORK_USER_PROMPT_FILE,
              promptArgs: reworkUserArgs,
            },
            () =>
              sandbox.run({
                name: coderRunName,
                agent: sandcastle.opencode(REWORK_MODEL, {
                  agent: REWORK_AGENT_CONFIG.name,
                }),
                maxIterations: CODER_MAX_ITERATIONS,
                completionSignal: "<promise>COMPLETE</promise>",
                idleTimeoutSeconds,
                promptFile: REWORK_USER_PROMPT_FILE,
                promptArgs: reworkUserArgs,
              }),
          );
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
            feedback = sizeCheck.error;
            lastFeedback = feedback;
            continue;
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

          const coderRunName = `coder #${issue.number} r${round}`;
          coderResult = await recordMeasuredAgentRun(
            {
              prd: prdNumber,
              issue: issue.number,
              stage: "coder",
              round,
              model: CODER_MODEL,
              runName: coderRunName,
              worktreePath: sandbox.worktreePath,
              promptFile: CODER_USER_PROMPT_FILE,
              promptArgs: coderUserArgs,
            },
            () =>
              sandbox.run({
                name: coderRunName,
                agent: sandcastle.opencode(CODER_MODEL, {
                  agent: CODER_AGENT_CONFIG.name,
                }),
                maxIterations: CODER_MAX_ITERATIONS,
                completionSignal: "<promise>COMPLETE</promise>",
                idleTimeoutSeconds,
                promptFile: CODER_USER_PROMPT_FILE,
                promptArgs: coderUserArgs,
              }),
          );
        }

        const blockedMatch = coderResult.stdout.match(
          /<blocked>([\s\S]*?)<\/blocked>/,
        );
        if (blockedMatch) {
          const reason = blockedMatch[1]!.trim();
          console.log(`  coder signaled blocked: ${reason.slice(0, 200)}`);
          lastFeedback = `Coder signaled blocked on round ${round}:\n\n${reason}`;
          break;
        }

        const alreadySatisfiedMatch = coderResult.stdout.match(
          /<already_satisfied>([\s\S]*?)<\/already_satisfied>/,
        );
        if (alreadySatisfiedMatch) {
          const reason = alreadySatisfiedMatch[1]!.trim();
          console.log(
            `  coder signaled already_satisfied: ${reason.slice(0, 200)}`,
          );
          alreadySatisfiedReason = reason;
          break;
        }

        if (coderResult.commits.length === 0) {
          // Distinguish "did nothing" from "edited but forgot to commit"
          const uncommitted = git(
            ["status", "-s"],
            sandbox.worktreePath,
          ).trim();
          if (uncommitted) {
            console.log(
              `  coder produced no commits but worktree has uncommitted edits; feeding back commit reminder`,
            );
            feedback = [
              "## You edited files but did not commit",
              "",
              "These files have uncommitted changes in the worktree:",
              "",
              "```",
              uncommitted,
              "```",
              "",
              'Edits without a commit are invisible to the host. Sandcastle only sees `git log` history, not the working tree. Run `git add <files>` and `git commit -m "<message>"` to save your work. Then re-verify and emit `<promise>COMPLETE</promise>`.',
            ].join("\n");
          } else {
            const existingAheadCount = countCommitsAheadOfBase(
              sandbox.worktreePath,
            );
            if (existingAheadCount > 0) {
              // A restarted loop may re-enter an existing issue branch that
              // already contains committed work from a prior run. Treat that
              // branch state as the candidate for validation/review instead of
              // looping forever on "No commits produced".
              console.log(
                `  coder produced no new commits, but branch already has ${existingAheadCount} commit(s) ahead of ${originPrdRef()}; validating existing branch state`,
              );
              committedCount = existingAheadCount;
            } else {
              console.log(
                `  coder produced no commits and no uncommitted changes; feeding back "no commits" message`,
              );
              feedback =
                "## No commits produced\n\nYour previous run finished without committing any changes. Re-read the issue and the PRD, then make the required code changes and commit them.";
            }
          }
          if (committedCount === 0) {
            lastFeedback = feedback;
            continue;
          }
        }
        if (committedCount === 0) {
          committedCount = coderResult.commits.length;
        }
      }

      const dirty = git(["status", "-s"], sandbox.worktreePath).trim();
      if (dirty) {
        console.log(
          `  branch has ${committedCount} new commit(s) but uncommitted edits remain; feeding back cleanup request`,
        );
        feedback = [
          "## Uncommitted changes after commit",
          "",
          "Your run produced commits, but the worktree still has uncommitted changes:",
          "",
          "```",
          dirty,
          "```",
          "",
          "Commit the intended issue changes and revert unrelated edits. The host validates and reviews only a clean, committed branch.",
        ].join("\n");
        lastFeedback = feedback;
        continue;
      }

      console.log(
        `  branch has ${committedCount} new commit(s); syncing branch for validation/review`,
      );
      const prep = prepareBranchForReview(
        sandbox.worktreePath,
        issueBranch,
        recoveryAttempts,
      );
      recoveryAttempts = prep.recoveryAttempts;
      if (!prep.ok) {
        feedback = prep.feedback;
        lastFeedback = feedback;
        continue;
      }

      let reviewContext = computeReviewContext(
        sandbox.worktreePath,
        prep.baseSha,
      );
      const recoveryAttemptsBeforeDiffCheck = recoveryAttempts;
      const recovery = maybeRecoverOversizedOrPollutedDiff(
        sandbox.worktreePath,
        issue,
        issueBranch,
        reviewContext,
        recoveryAttempts,
      );
      recoveryAttempts = recovery.recoveryAttempts;
      if (!recovery.ok) {
        feedback = recovery.feedback;
        lastFeedback = feedback;
        continue;
      }
      if (
        recovery.baseSha !== reviewContext.baseSha ||
        recovery.recoveryAttempts !== recoveryAttemptsBeforeDiffCheck
      ) {
        reviewContext = computeReviewContext(
          sandbox.worktreePath,
          recovery.baseSha,
        );
      }
      if (reviewContext.diffBytes > REVIEW_DIFF_MAX_BYTES) {
        feedback = formatDiffTooLargeFeedback(reviewContext);
        lastFeedback = feedback;
        continue;
      }
      if (looksLikeWorkflowPollution(issue, reviewContext.changedFiles)) {
        feedback = formatWorkflowPollutionFeedback(reviewContext);
        lastFeedback = feedback;
        continue;
      }

      console.log(
        `  review diff: ${reviewContext.diffBytes} bytes, ${reviewContext.changedFiles.length} file(s), aspects: ${reviewContext.reviewAspects.join(", ")}`,
      );
      console.log(`  running validation gate`);
      const gate = runValidationGate(sandbox.worktreePath);
      if (!gate.ok) {
        feedback = gate.feedback;
        lastFeedback = feedback;
        continue;
      }

      console.log(`  validation green; invoking reviewer`);
      const reviewerUserArgs = {
        ISSUE_NUMBER: String(issue.number),
        ISSUE_TITLE: issue.title,
        ISSUE_BODY: issue.body || "(no body)",
        ISSUE_COMMENTS: issueComments,
        BASE_BRANCH: originPrdRef(),
        REVIEW_BASE_SHA: reviewContext.baseSha,
        DIFF: reviewContext.diff,
        DIFF_BYTES: String(reviewContext.diffBytes),
        DIFF_MAX_BYTES: String(REVIEW_DIFF_MAX_BYTES),
        CHANGED_FILES: reviewContext.changedFiles.join("\n") || "(none)",
        DIFF_STAT: reviewContext.diffStat,
        REVIEW_ASPECTS: reviewContext.reviewAspects.join(", "),
        ECOSYSTEMS: reviewContext.ecosystems.join(", ") || "(unknown)",
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
        feedback = reviewerSizeCheck.error;
        lastFeedback = feedback;
        continue;
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

      const reviewerRunName = `reviewer #${issue.number} r${round}`;
      const reviewerResult = await recordMeasuredAgentRun(
        {
          prd: prdNumber,
          issue: issue.number,
          stage: "reviewer",
          round,
          model: REVIEWER_MODEL,
          runName: reviewerRunName,
          worktreePath: sandbox.worktreePath,
          promptFile: REVIEWER_USER_PROMPT_FILE,
          promptArgs: reviewerUserArgs,
        },
        () =>
          sandbox.run({
            name: reviewerRunName,
            agent: sandcastle.opencode(REVIEWER_MODEL, {
              agent: REVIEWER_AGENT_CONFIG.name,
            }),
            maxIterations: 1,
            idleTimeoutSeconds,
            promptFile: REVIEWER_USER_PROMPT_FILE,
            promptArgs: reviewerUserArgs,
          }),
      );

      const review = extractReview(reviewerResult.stdout);
      console.log(`  reviewer decision: ${review.decision}`);
      if (review.decision === "approved") {
        const currentBaseSha = fetchOriginPrd(sandbox.worktreePath);
        if (currentBaseSha !== reviewContext.baseSha) {
          if (hostOnlyReviewAttempts < 2) {
            hostOnlyReviewAttempts++;
            hostOnlyReview = true;
            round--;
            console.log(
              `  ${originPrdRef()} advanced after review; running host-only re-review attempt ${hostOnlyReviewAttempts}/2`,
            );
          } else {
            feedback = [
              "## Base branch keeps advancing after review",
              "",
              `${originPrdRef()} advanced from reviewed base ${reviewContext.baseSha} to ${currentBaseSha} after validation/review completed.`,
              "",
              "The host already retried re-sync/re-validation/re-review twice. Continue from the current branch and emit `<promise>COMPLETE</promise>` so the host can try again.",
            ].join("\n");
            lastFeedback = feedback;
          }
          continue;
        }
        reviewedBaseSha = reviewContext.baseSha;
        approved = true;
        break;
      }
      feedback = formatFeedback(review);
      lastFeedback = feedback;
    }

    if (alreadySatisfiedReason) {
      try {
        closeIssueAsAlreadySatisfied(issue, alreadySatisfiedReason);
        console.log(
          `Issue #${issue.number} closed as already satisfied on ${prdBranch}.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Issue #${issue.number} was reported as already satisfied, but close step failed: ${msg.slice(0, 300)}`,
        );
        try {
          markStuck(
            issue,
            sandbox.worktreePath,
            issueBranch,
            `Coder reported the issue is already satisfied on ${prdBranch}, but the host could not close it automatically.\n\n${alreadySatisfiedReason}\n\n${msg.slice(0, 4000)}`,
          );
        } catch (stuckErr) {
          console.error(
            `markStuck also failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
          );
        }
      }
    } else if (approved) {
      try {
        approveAndMerge(
          issue,
          sandbox.worktreePath,
          issueBranch,
          reviewedBaseSha,
        );
        console.log(`Issue #${issue.number} merged into ${prdBranch}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Issue #${issue.number} approved but merge step failed: ${msg.slice(0, 300)}`,
        );
        try {
          markStuck(
            issue,
            sandbox.worktreePath,
            issueBranch,
            `Reviewer approved but the host could not complete the merge. Manual intervention required.\n\n${msg.slice(0, 4000)}`,
          );
        } catch (stuckErr) {
          console.error(
            `markStuck also failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
          );
        }
      }
    } else {
      const reasonHeader =
        (lastFeedback || "(no feedback recorded)")
          .split("\n")
          .find((l) => l.trim().startsWith("##"))
          ?.trim()
          .replace(/^##\s*/, "") ?? "(no recognizable reason header)";
      console.log(
        `Issue #${issue.number} stuck after ${MAX_REVIEW_ROUNDS} rounds. Reason: ${reasonHeader}`,
      );
      const preview = (lastFeedback || "")
        .split("\n")
        .slice(0, 12)
        .map((l) => `    ${l}`)
        .join("\n");
      if (preview) {
        console.log("  Last feedback (first 12 lines):");
        console.log(preview);
      }
      try {
        markStuck(
          issue,
          sandbox.worktreePath,
          issueBranch,
          lastFeedback || "(no feedback recorded)",
        );
      } catch (stuckErr) {
        console.error(
          `markStuck failed for #${issue.number}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
        );
      }
    }
  } catch (iterErr) {
    console.error(
      `Iteration ${iteration} for #${issue.number} crashed unexpectedly. Continuing to next issue.\n${iterErr instanceof Error ? (iterErr.stack ?? iterErr.message) : iterErr}`,
    );
  } finally {
    await sandbox.close();
  }

  return { kind: "processed_issue", issueNumber: issue.number };
}

function listOpenPrdIssuesForExtraReview(): ExtraReviewQueueIssue[] {
  return (forgejo.listIssues({
    label: prdLabel,
    state: "open",
    limit: 200,
  }) as IssueListItem[]).map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
  }));
}

function validateBaseForExtraReview(): ExtraReviewBaseValidationState {
  try {
    lastValidatedBaseSha = ensureBaseBranchIsGreen(lastValidatedBaseSha);
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
        return agentName
          ? sandcastle.opencode(roleModel, { agent: agentName })
          : sandcastle.opencode(roleModel);
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
      client: forgejo,
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
