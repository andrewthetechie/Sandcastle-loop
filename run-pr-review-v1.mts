// run-pr-review-v1.mts
//
// PR Review loop. Fetches open PRs matching optional label filters, reviews
// each PR via a main agent that sequentially invokes Standards and Spec
// sub-agents, fixes all actionable findings, commits, and pushes. Applies the
// `ai-review-complete` label on success. Skips PRs with merge conflicts or
// commits within `--settle-seconds` of the current time.
//
// The loop fetches the full PR list at the start of each outer iteration,
// processes every eligible PR in that list, then sleeps and repeats up to
// `--loop-iterations` times.
//
// Usage:
//   tsx run-pr-review-v1.mts [--label <name[,name2]>] [--model-reviewer <model>]
//     [--settle-seconds 300] [--loop-iterations 2500]
//     [--iteration-sleep-seconds 300] [--base-branch main]
//     [--idle-timeout 1800]

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentDefinition,
  PR_REVIEW_AGENT_CONFIG,
  PR_STANDARDS_REVIEW_AGENT_CONFIG,
  PR_SPEC_REVIEW_AGENT_CONFIG,
} from "./custom-agent-defs.mts";
import { enforceArgvSizeLimit } from "./custom-agent-argv-guard.mts";
import { renderSlimMessage } from "./custom-agent-render.mts";
import {
  ensureOpencodeGitExclude,
  ensureSandboxGitExclude,
  writeAgentDefinitionFile,
} from "./custom-agent-worktree.mts";
import { EXTRA_REVIEW_INPUT_DIFF_EXCLUDES } from "./extra-review-inputs.mts";
import {
  writePrReviewInputs,
  type PrReviewInputData,
} from "./pr-review-inputs.mts";
import { loadSandcastleLoopConfig } from "./sandcastle-loop-config.mts";
import { hasFlag, readCliStringFlag } from "./cli-string-flag.mts";
import { recordMeasuredAgentRun } from "./metrics-recorder.mts";
import { tuiEmitter } from "./tui-emitter.mts";
import { tuiWorkingLogPath } from "./tui-status.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";
import {
  allRiskLabels,
  isRiskLabel,
  renderPrReviewComment,
  validatePrReviewResult,
  type PrReviewResult,
} from "./pr-review-result.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const LOOP_CONFIG = await loadSandcastleLoopConfig(REPO_ROOT);

// Prompt files
const PR_REVIEW_AGENT_SYSTEM_PROMPT_FILE = fileURLToPath(
  new URL("./pr-review-agent-system-prompt.md", import.meta.url),
);
const PR_STANDARDS_REVIEW_AGENT_SYSTEM_PROMPT_FILE = fileURLToPath(
  new URL("./pr-standards-review-agent-system-prompt.md", import.meta.url),
);
const PR_SPEC_REVIEW_AGENT_SYSTEM_PROMPT_FILE = fileURLToPath(
  new URL("./pr-spec-review-agent-system-prompt.md", import.meta.url),
);
const PR_REVIEW_USER_PROMPT_FILE = fileURLToPath(
  new URL("./pr-review-user-prompt.md", import.meta.url),
);

// Labels
const AI_REVIEW_COMPLETE_LABEL = "ai-review-complete";
const RISK_LABELS = allRiskLabels();

// Idle timeout for the agent (sandcastle fails the run if stdout is silent
// this long). Override on the command line with `--idle-timeout <seconds>`.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

// Commands to run inside the sandbox once it's ready (e.g. install deps).
const SANDBOX_READY_COMMANDS: string[] = LOOP_CONFIG.setupCommands;

// Git pathspec exclusions for the reviewer diff.
const REVIEW_DIFF_EXCLUDES: string[] = [...EXTRA_REVIEW_INPUT_DIFF_EXCLUDES];

// Files copied from the host into the worktree before the sandbox starts.
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

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: tsx run-pr-review-v1.mts [--label <name[,name2]>] [--model-reviewer <model>] [--settle-seconds <N>] [--loop-iterations <N>] [--iteration-sleep-seconds <N>] [--base-branch <name>] [--idle-timeout <seconds>]";

function readStringFlag(flag: string): string | undefined {
  try {
    return readCliStringFlag(process.argv, flag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${USAGE}\n\n${message}`);
  }
}

function readIntFlag(flag: string, min: number): number | undefined {
  const raw = readStringFlag(flag);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${USAGE}\n\n${flag} must be an integer >= ${min}, got ${raw}`);
  }
  return parsed;
}

// --label is optional; if absent, all open PRs are eligible.
const labelArg = readStringFlag("--label");
const labels: string[] = labelArg
  ? labelArg
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
  : [];

const modelReviewerOverride = readStringFlag("--model-reviewer");
const REVIEWER_MODEL = modelReviewerOverride ?? LOOP_CONFIG.models.reviewer;

const settleSeconds = readIntFlag("--settle-seconds", 1) ?? 300;
const loopIterations = readIntFlag("--loop-iterations", 1) ?? 2500;
const iterationSleepSeconds = readIntFlag("--iteration-sleep-seconds", 1) ?? 300;
const DEFAULT_BASE_BRANCH = "main";
const baseBranch = readStringFlag("--base-branch") ?? DEFAULT_BASE_BRANCH;

let idleTimeoutSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS;
const idleRaw = readStringFlag("--idle-timeout");
if (idleRaw !== undefined) {
  const parsed = Number.parseInt(idleRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--idle-timeout must be a positive integer, got ${idleRaw}`);
  }
  idleTimeoutSeconds = parsed;
}

// Max iterations for the main agent. Review + fix is a single pass, but the
// agent may need a few turns to invoke sub-agents, read findings, fix, and
// commit. 20 turns gives ample headroom without unbounded looping.
const PR_REVIEW_MAX_ITERATIONS = 20;

// Max push recovery attempts for the PR branch.
const MAX_PUSH_RECOVERY_ATTEMPTS = 2;

console.log(`PR labels: ${labels.length > 0 ? labels.join(", ") : "(all open PRs)"}`);
console.log(`Base branch: ${baseBranch}`);
console.log(`Review model: ${REVIEWER_MODEL}`);
console.log(`Settle seconds: ${settleSeconds}`);
console.log(`Loop iterations: ${loopIterations}`);
console.log(`Iteration sleep: ${iterationSleepSeconds}s`);
console.log(`Idle timeout: ${idleTimeoutSeconds}s`);
console.log(
  [
    LOOP_CONFIG.loadedConfig
      ? `Sandcastle config: ${LOOP_CONFIG.configPath}`
      : `Sandcastle config: using built-in defaults; ${LOOP_CONFIG.configPath} not found`,
    `setupCommands=${SANDBOX_READY_COMMANDS.length}`,
    `cacheMounts=${LOOP_CONFIG.cache.mounts.map((m) => m.name).join(",") || "(none)"}`,
    `cacheEnv=${Object.keys(LOOP_CONFIG.cache.sandboxEnv).join(",") || "(none)"}`,
  ].join("\n"),
);

// Companion TUI: begin emitting the read-only status snapshot for this loop.
tuiEmitter.startLoop({
  loopType: "pr-review",
  loopId: labels.join(",") || "all",
  phase: "pr_review",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function fetchOriginBase(worktreePath?: string): string {
  execFileSync("git", ["fetch", "origin", baseBranch], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  return git(["rev-parse", originBaseRef()], worktreePath).trim();
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

function branchExists(branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", branch], {
      encoding: "utf8",
    }).status === 0
  );
}

// Fetch the mainline once at startup so origin/<base> exists and is current.
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

// Adding a label fails if the label does not already exist, so create the
// label up front if the repo is missing it.
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

  if (!have.has(AI_REVIEW_COMPLETE_LABEL)) {
    console.log(`Creating missing label '${AI_REVIEW_COMPLETE_LABEL}'`);
    gh([
      "label",
      "create",
      AI_REVIEW_COMPLETE_LABEL,
      "--color",
      "0e8a16",
      "--description",
      "AI code review completed; fixes applied and pushed.",
    ]);
  }

  for (const riskLabel of RISK_LABELS) {
    if (have.has(riskLabel)) continue;
    console.log(`Creating missing label '${riskLabel}'`);
    gh([
      "label",
      "create",
      riskLabel,
      "--color",
      "5319e7",
      "--description",
      `AI PR review risk rating ${riskLabel.slice("risk-".length)}/5.`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// PR data types and fetching
// ---------------------------------------------------------------------------

interface PrListItem {
  number: number;
  headRefName: string;
  labels: { name: string }[];
}

interface PrCommit {
  committedDate: string;
}

interface PrDetail {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  commits: PrCommit[];
  labels: { name: string }[];
}

interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
}

function fetchPrList(labelsFilter?: string[]): PrListItem[] {
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,headRefName,labels",
    "--limit",
    "200",
  ];
  for (const label of labelsFilter ?? []) {
    args.push("--label", label);
  }
  return ghJson<PrListItem[]>(args);
}

function fetchPrDetail(prNumber: number): PrDetail {
  return ghJson<PrDetail>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,body,headRefName,baseRefName,state,mergeable,commits,labels",
  ]);
}

function prHasConflicts(pr: PrDetail): boolean {
  // null means GitHub is still computing mergeability — skip conservatively.
  return pr.mergeable !== "MERGEABLE";
}

function isPrSettled(pr: PrDetail, settleWindowSeconds: number): boolean {
  if (pr.commits.length === 0) return true; // no commits, always settled
  const lastCommit = pr.commits[pr.commits.length - 1]!;
  const lastCommitMs = new Date(lastCommit.committedDate).getTime();
  if (Number.isNaN(lastCommitMs)) return false; // unparseable date, skip
  const ageMs = Date.now() - lastCommitMs;
  return ageMs >= settleWindowSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Linked issue gathering
// ---------------------------------------------------------------------------

const ISSUE_REF_PATTERN =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|ref|refs|see)\s+#(\d+)\b|(?<!\w)#(\d+)\b/gi;

function extractIssueNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(ISSUE_REF_PATTERN)) {
    const num = Number.parseInt(match[1] ?? match[2] ?? "", 10);
    if (Number.isInteger(num) && num > 0) numbers.add(num);
  }
  return [...numbers].sort((a, b) => a - b);
}

function fetchLinkedIssue(issueNumber: number): LinkedIssue | null {
  try {
    return ghJson<LinkedIssue>([
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,state",
    ]);
  } catch {
    console.warn(`Could not fetch linked issue #${issueNumber}; skipping it.`);
    return null;
  }
}

function gatherLinkedIssues(prBody: string): string {
  const issueNumbers = extractIssueNumbers(prBody);
  if (issueNumbers.length === 0) return "(no linked issues found in PR description)";

  const issues: LinkedIssue[] = [];
  for (const num of issueNumbers) {
    const issue = fetchLinkedIssue(num);
    if (issue) issues.push(issue);
  }

  if (issues.length === 0) return "(linked issues could not be fetched)";

  return issues
    .map((issue) => {
      const stateTag = issue.state === "CLOSED" ? " [closed]" : "";
      return [
        `### Issue #${issue.number}: ${issue.title}${stateTag}`,
        "",
        issue.body || "(no body)",
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Review context (adapted from backlog loop)
// ---------------------------------------------------------------------------

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
    .map((f: string) => f.trim())
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

// ---------------------------------------------------------------------------
// Branch push (adapted from backlog loop's pushIssueBranch)
// ---------------------------------------------------------------------------

function pushPrBranch(
  worktreePath: string,
  prBranch: string,
): void {
  for (let attempt = 1; attempt <= MAX_PUSH_RECOVERY_ATTEMPTS; attempt++) {
    const localHead = git(["rev-parse", "HEAD"], worktreePath).trim();
    const lsRemote = spawnSync(
      "git",
      ["ls-remote", "--heads", "origin", prBranch],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (lsRemote.status !== 0) {
      throw new Error(
        `Could not inspect remote ${prBranch} before push:\n${`${lsRemote.stdout ?? ""}${lsRemote.stderr ?? ""}`.trim()}`,
      );
    }

    const remoteLine = (lsRemote.stdout ?? "")
      .split("\n")
      .map((line: string) => line.trim())
      .find(Boolean);
    const remoteSha = remoteLine?.split(/\s+/)[0] ?? "";

    if (!remoteSha) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${prBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      throw new Error(
        `Could not create remote ${prBranch} for push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const fetch = spawnSync("git", ["fetch", "origin", prBranch], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    if (fetch.status !== 0) {
      throw new Error(
        `Could not fetch remote ${prBranch} before push:\n${`${fetch.stdout ?? ""}${fetch.stderr ?? ""}`.trim()}`,
      );
    }

    if (remoteSha === localHead) {
      const push = spawnSync(
        "git",
        ["push", "-u", "origin", `HEAD:refs/heads/${prBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      throw new Error(
        `Could not update remote ${prBranch} for push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
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
        ["push", "-u", "origin", `HEAD:refs/heads/${prBranch}`],
        { cwd: worktreePath, encoding: "utf8" },
      );
      if (push.status === 0) return;
      if (attempt < MAX_PUSH_RECOVERY_ATTEMPTS) continue;
      throw new Error(
        `Could not fast-forward remote ${prBranch} for push:\n${`${push.stdout ?? ""}${push.stderr ?? ""}`.trim()}`,
      );
    }

    const diagnosticBranch = `diagnostic/${prBranch}-prepush-${Date.now()}`;
    console.warn(
      `  remote ${prBranch} diverged from local HEAD; archiving ${remoteSha.slice(0, 7)} to ${diagnosticBranch} and replacing ${prBranch} with lease protection`,
    );
    const archive = spawnSync(
      "git",
      ["push", "origin", `${remoteSha}:refs/heads/${diagnosticBranch}`],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (archive.status !== 0) {
      throw new Error(
        `Could not archive remote ${prBranch} to ${diagnosticBranch}:\n${`${archive.stdout ?? ""}${archive.stderr ?? ""}`.trim()}`,
      );
    }

    const replace = spawnSync(
      "git",
      [
        "push",
        `--force-with-lease=refs/heads/${prBranch}:${remoteSha}`,
        "-u",
        "origin",
        `HEAD:refs/heads/${prBranch}`,
      ],
      { cwd: worktreePath, encoding: "utf8" },
    );
    if (replace.status === 0) return;
    if (attempt < MAX_PUSH_RECOVERY_ATTEMPTS) continue;
    throw new Error(
      `Could not replace remote ${prBranch} after archiving ${diagnosticBranch}:\n${`${replace.stdout ?? ""}${replace.stderr ?? ""}`.trim()}`,
    );
  }
}

async function applyRiskLabel(prNumber: number, risk: number): Promise<void> {
  const wantedLabel = `risk-${risk}`;
  const currentLabels = ghJson<{ labels: { name: string }[] }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "labels",
  ]).labels.map((l) => l.name);
  const toRemove = currentLabels.filter(
    (label) => isRiskLabel(label) && label !== wantedLabel,
  );

  for (const label of toRemove) {
    const removal = await runVerifiedHostMutation<{ name: string }[]>({
      mutate: () => {
        gh([
          "api",
          `repos/{owner}/{repo}/issues/${prNumber}/labels/${label}`,
          "-X",
          "DELETE",
        ]);
      },
      readBack: () =>
        ghJson<{ labels: { name: string }[] }>([
          "pr",
          "view",
          String(prNumber),
          "--json",
          "labels",
        ]).labels,
      verify: (labels) => !labels.some((l) => l.name === label),
      describe: (labels) =>
        `labels=${labels.map((l) => l.name).sort().join(",")}`,
    });
    if (!removal.ok) {
      throw new Error(
        `Could not remove stale label ${label}: ${removal.diagnostics.join("; ")}`,
      );
    }
  }

  if (currentLabels.includes(wantedLabel)) return;

  const addition = await runVerifiedHostMutation<{ name: string }[]>({
    mutate: () => {
      gh([
        "api",
        `repos/{owner}/{repo}/issues/${prNumber}/labels`,
        "-X",
        "POST",
        "-f",
        `labels[]=${wantedLabel}`,
      ]);
    },
    readBack: () =>
      ghJson<{ labels: { name: string }[] }>([
        "pr",
        "view",
        String(prNumber),
        "--json",
        "labels",
      ]).labels,
    verify: (labels) => labels.some((l) => l.name === wantedLabel),
    describe: (labels) =>
      `labels=${labels.map((l) => l.name).sort().join(",")}`,
  });
  if (!addition.ok) {
    throw new Error(
      `Could not apply label ${wantedLabel}: ${addition.diagnostics.join("; ")}`,
    );
  }
}

async function applyAiReviewCompleteLabel(prNumber: number): Promise<void> {
  const addition = await runVerifiedHostMutation<{ name: string }[]>({
    mutate: () => {
      gh([
        "api",
        `repos/{owner}/{repo}/issues/${prNumber}/labels`,
        "-X",
        "POST",
        "-f",
        `labels[]=${AI_REVIEW_COMPLETE_LABEL}`,
      ]);
    },
    readBack: () =>
      ghJson<{ labels: { name: string }[] }>([
        "pr",
        "view",
        String(prNumber),
        "--json",
        "labels",
      ]).labels,
    verify: (labels) => labels.some((l) => l.name === AI_REVIEW_COMPLETE_LABEL),
    describe: (labels) =>
      `labels=${labels.map((l) => l.name).sort().join(",")}`,
  });
  if (!addition.ok) {
    throw new Error(
      `Could not apply label ${AI_REVIEW_COMPLETE_LABEL}: ${addition.diagnostics.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Docker sandbox
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-PR processing
// ---------------------------------------------------------------------------

async function processPr(pr: PrDetail): Promise<{ outcome: string }> {
  const prBranch = pr.headRefName;
  console.log(`\n--- PR #${pr.number}: ${pr.title} (branch: ${prBranch}) ---`);

  // Gather linked issues from the PR body.
  const linkedIssues = gatherLinkedIssues(pr.body ?? "");
  if (linkedIssues.startsWith("(no linked") || linkedIssues.startsWith("(linked issues could")) {
    console.log(`  linked issues: ${linkedIssues}`);
  } else {
    const count = (linkedIssues.match(/^### Issue #/gm) ?? []).length;
    console.log(`  gathered ${count} linked issue(s)`);
  }

  // Fetch the PR branch and compute the review base (merge-base with origin/<base>).
  console.log(`  fetching origin/${prBranch}`);
  execFileSync("git", ["fetch", "origin", prBranch], { stdio: "inherit" });
  if (!branchExists(prBranch)) {
    console.log(`  branch ${prBranch} not found locally; creating from origin/${prBranch}`);
    execFileSync("git", ["branch", prBranch, `origin/${prBranch}`], {
      stdio: "inherit",
    });
  }

  // Ensure the branch is up to date with origin.
  const originHead = git(["rev-parse", `origin/${prBranch}`]).trim();
  git(["branch", "-f", prBranch, originHead]);

  const baseSha = fetchOriginBase();
  const mergeBase = git(["merge-base", originBaseRef(), prBranch]).trim();
  console.log(`  review base (merge-base): ${mergeBase.slice(0, 8)}`);

  // Clean up any leftover managed worktree for this branch.
  const existingWorktree = findManagedWorktreeForBranch(prBranch);
  if (existingWorktree) {
    console.log(`  removing stale worktree: ${existingWorktree}`);
    execFileSync("git", ["worktree", "remove", "--force", existingWorktree], {
      stdio: "inherit",
    });
  }

  // Create the sandbox.
  const sandbox = await sandcastle.createSandbox({
    sandbox: dockerSandboxProvider(),
    branch: prBranch,
    baseBranch: originBaseRef(),
    copyToWorktree: COPY_TO_WORKTREE,
    hooks: sandboxReadyHooks(),
  });
  ensureOpencodeGitExclude(sandbox.worktreePath);
  ensureSandboxGitExclude(sandbox.worktreePath);

  try {
    // Write all three agent definitions to the worktree so the main agent
    // can invoke the sub-agents via the Task tool.
    writeAgentDefinitionFile(
      sandbox.worktreePath,
      PR_REVIEW_AGENT_CONFIG.name,
      buildAgentDefinition(
        PR_REVIEW_AGENT_CONFIG,
        REVIEWER_MODEL,
        readFileSync(PR_REVIEW_AGENT_SYSTEM_PROMPT_FILE, "utf8"),
      ),
    );
    writeAgentDefinitionFile(
      sandbox.worktreePath,
      PR_STANDARDS_REVIEW_AGENT_CONFIG.name,
      buildAgentDefinition(
        PR_STANDARDS_REVIEW_AGENT_CONFIG,
        REVIEWER_MODEL,
        readFileSync(PR_STANDARDS_REVIEW_AGENT_SYSTEM_PROMPT_FILE, "utf8"),
      ),
    );
    writeAgentDefinitionFile(
      sandbox.worktreePath,
      PR_SPEC_REVIEW_AGENT_CONFIG.name,
      buildAgentDefinition(
        PR_SPEC_REVIEW_AGENT_CONFIG,
        REVIEWER_MODEL,
        readFileSync(PR_SPEC_REVIEW_AGENT_SYSTEM_PROMPT_FILE, "utf8"),
      ),
    );

    // Compute review context (diff from merge-base to HEAD).
    const reviewContext = computeReviewContext(
      sandbox.worktreePath,
      mergeBase,
    );
    console.log(
      `  review diff: ${reviewContext.diffBytes} bytes, ${reviewContext.changedFiles.length} file(s), aspects: ${reviewContext.reviewAspects.join(", ")}`,
    );

    // Persist review inputs as files in the worktree so the full diff/body
    // do not have to travel through argv to the agent.
    const reviewInputData: PrReviewInputData = {
      prNumber: pr.number,
      title: pr.title,
      body: pr.body || "(no PR description)",
      linkedIssues,
      baseSha: mergeBase,
      diff: reviewContext.diff,
      diffStat: reviewContext.diffStat,
      changedFiles: reviewContext.changedFiles,
      reviewAspects: reviewContext.reviewAspects,
      ecosystems: reviewContext.ecosystems,
    };
    const reviewInputs = writePrReviewInputs(
      sandbox.worktreePath,
      reviewInputData,
    );
    console.log(
      `  review inputs written to ${reviewInputs.relativeDir} (${reviewContext.diffBytes} bytes diff)`,
    );

    // Render the user prompt (now small — only metadata and file paths).
    const userArgs = {
      PR_NUMBER: String(pr.number),
      PR_TITLE: pr.title,
      BASE_SHA: mergeBase,
      DIFF_BYTES: String(reviewContext.diffBytes),
      ECOSYSTEMS: reviewContext.ecosystems.join(", ") || "(unknown)",
      REVIEW_ASPECTS: reviewContext.reviewAspects.join(", "),
      PR_BODY_PATH: reviewInputs.paths.prBody,
      LINKED_ISSUES_PATH: reviewInputs.paths.linkedIssues,
      CHANGED_FILES_PATH: reviewInputs.paths.changedFiles,
      DIFF_STAT_PATH: reviewInputs.paths.diffStat,
      DIFF_PATH: reviewInputs.paths.diff,
      METADATA_PATH: reviewInputs.paths.metadata,
      RESULT_PATH: `${reviewInputs.relativeDir}/review-result.json`,
    };
    const userTemplate = readFileSync(PR_REVIEW_USER_PROMPT_FILE, "utf8");
    const rendered = renderSlimMessage(userTemplate, userArgs);
    const sizeCheck = enforceArgvSizeLimit(rendered);
    if (!sizeCheck.ok) {
      console.log(`  prompt too large for argv; skipping`);
      return { outcome: "prompt_too_large" };
    }

    // Run the main review agent.
    const runName = `pr-review #${pr.number}`;
    const activeLogPath = tuiWorkingLogPath(runName);
    console.log(`  invoking pr-review agent (model: ${REVIEWER_MODEL})`);

    // sandcastle.opencode run result carries a commits array.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recordMeasuredAgentRun<any>(
      {
        prd: `pr-review-${pr.number}`,
        stage: "pr_review",
        agent: PR_REVIEW_AGENT_CONFIG.name,
        round: 1,
        model: REVIEWER_MODEL,
        runName,
        worktreePath: sandbox.worktreePath,
        promptFile: PR_REVIEW_USER_PROMPT_FILE,
        promptArgs: userArgs,
        activeLogPath,
      },
      () =>
        sandbox.run({
          name: runName,
          agent: sandcastle.opencode(REVIEWER_MODEL, {
            agent: PR_REVIEW_AGENT_CONFIG.name,
          }),
          maxIterations: PR_REVIEW_MAX_ITERATIONS,
          completionSignal: "</pr_review_complete>",
          idleTimeoutSeconds,
          promptFile: PR_REVIEW_USER_PROMPT_FILE,
          promptArgs: userArgs,
          logging: {
            type: "file",
            path: agentRunLogPath(prBranch, runName),
            onAgentStreamEvent: tuiEmitter.workingLogSink(activeLogPath),
          },
        }),
    );

    const commitCount = result.commits.length;
    if (commitCount === 0) {
      console.log(`  no commits produced; no fixes were needed`);
    } else {
      console.log(
        `  agent produced ${commitCount} commit(s) on ${prBranch}`,
      );
    }

    // Read and validate the review result artifact the agent wrote.
    const resultPath = `${reviewInputs.relativeDir}/review-result.json`;
    console.log(`  reading review result artifact ${resultPath}`);
    let resultArtifactRaw: string;
    try {
      resultArtifactRaw = readFileSync(
        join(sandbox.worktreePath, resultPath),
        "utf8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read review result artifact: ${message}`);
    }
    const validation = validatePrReviewResult(resultArtifactRaw);
    if (!validation.ok) {
      throw new Error(
        `Invalid review result artifact: ${validation.errors.join("; ")}`,
      );
    }
    const reviewResult: PrReviewResult = validation.result;
    const reviewedHeadSha = git(
      ["rev-parse", "HEAD"],
      sandbox.worktreePath,
    ).trim();
    console.log(
      `  review result: risk ${reviewResult.risk}/5, ${reviewResult.findings.length} finding(s), ${reviewResult.fixes_applied.length} fix(es), ${reviewResult.not_fixed.length} not-fixed`,
    );

    // Push the branch (even if no commits — ensures the branch is up to date).
    console.log(`  pushing ${prBranch} to origin`);
    pushPrBranch(sandbox.worktreePath, prBranch);

    // Apply the risk label and ai-review-complete via verified mutations.
    // The risk label is durable state used by external automation, so it must
    // be read back and verified. ai-review-complete is the loop's memory.
    console.log(`  applying risk-${reviewResult.risk} label`);
    await applyRiskLabel(pr.number, reviewResult.risk);
    console.log(`  applying ${AI_REVIEW_COMPLETE_LABEL} label`);
    await applyAiReviewCompleteLabel(pr.number);

    // Post a summary comment. The comment is best-effort after durable labels;
    // if it fails, the PR is still marked reviewed. Use the REST API directly
    // (like labels) to avoid `gh pr comment` CLI quirks around body-file paths
    // and repo-context detection.
    const commentBody = renderPrReviewComment({
      result: reviewResult,
      reviewedHeadSha,
      commitCount,
    });
    try {
      console.log(`  posting review comment on PR #${pr.number}`);
      gh([
        "api",
        `repos/{owner}/{repo}/issues/${pr.number}/comments`,
        "-X",
        "POST",
        "-f",
        `body=${commentBody}`,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Could not post review comment on PR #${pr.number}: ${message}`,
      );
    }

    console.log(`  PR #${pr.number} review complete`);
    return { outcome: "review_complete" };
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  PR #${pr.number} failed: ${msg.slice(0, 500)}`);
    return { outcome: "error" };
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// Outer loop
// ---------------------------------------------------------------------------

ensureBaseBranchAvailable();
ensureLabels();

let completedIterations = 0;
let stopReason: "max_iterations" | "error" = "max_iterations";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (let iteration = 1; iteration <= loopIterations; iteration++) {
  tuiEmitter.setIteration({ current: iteration, max: loopIterations });

  let prList: PrListItem[];
  try {
    prList = fetchPrList(labels.length > 0 ? labels : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Iteration ${iteration}: failed to fetch PR list: ${msg.slice(0, 300)}`,
    );
    stopReason = "error";
    break;
  }

  if (prList.length === 0) {
    console.log(
      `Iteration ${iteration}: no eligible open PRs${labels.length > 0 ? ` with label(s) '${labels.join(", ")}'` : ""}. Sleeping ${iterationSleepSeconds}s.`,
    );
    tuiEmitter.clearTicket();
    await sleep(iterationSleepSeconds * 1000);
    completedIterations++;
    continue;
  }

  console.log(
    `\n=== Iteration ${iteration}/${loopIterations}: ${prList.length} PR(s) ===\n`,
  );

  let prsProcessed = 0;
  for (const listItem of prList) {
    tuiEmitter.setTicket({
      number: listItem.number,
      title: `PR #${listItem.number}`,
      branch: listItem.headRefName,
    });

    // Fetch full details for freshness checks.
    let pr: PrDetail;
    try {
      pr = fetchPrDetail(listItem.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Skipping PR #${listItem.number}: could not fetch details: ${msg.slice(0, 200)}`,
      );
      continue;
    }

    // Guard: only open PRs.
    if (pr.state !== "OPEN") {
      console.log(`  Skipping PR #${pr.number}: state is ${pr.state}`);
      continue;
    }

    // Guard: skip PRs already labeled ai-review-complete.
    if (pr.labels.some((l) => l.name === AI_REVIEW_COMPLETE_LABEL)) {
      console.log(
        `  Skipping PR #${pr.number}: already labeled ${AI_REVIEW_COMPLETE_LABEL}`,
      );
      continue;
    }

    // Guard: conflicts.
    if (prHasConflicts(pr)) {
      const reason = pr.mergeable === "CONFLICTING"
        ? "has merge conflicts"
        : pr.mergeable === null
          ? "mergeability unknown (still computing)"
          : `mergeable=${pr.mergeable}`;
      console.log(`  Skipping PR #${pr.number}: ${reason}`);
      continue;
    }

    // Guard: not settled.
    if (!isPrSettled(pr, settleSeconds)) {
      console.log(`  Skipping PR #${pr.number}: not yet settled`);
      continue;
    }

    // Process the PR.
    tuiEmitter.setTicket({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
    });
    try {
      await processPr(pr);
      prsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(
        `  PR #${pr.number} crashed; continuing to next PR.\n${msg.slice(0, 500)}`,
      );
    }
  }

  tuiEmitter.clearTicket();
  completedIterations++;

  console.log(
    `\nIteration ${iteration} complete: ${prsProcessed}/${prList.length} PR(s) processed.`,
  );

  if (iteration < loopIterations) {
    console.log(`Sleeping ${iterationSleepSeconds}s until next iteration...`);
    await sleep(iterationSleepSeconds * 1000);
  }
}

// Companion TUI: write the terminal snapshot.
tuiEmitter.stop(stopReason);

console.log(
  [
    "\nPR review loop stopped.",
    `Reason: ${stopReason}`,
    `Iterations completed: ${completedIterations}/${loopIterations}`,
    labels.length > 0
      ? `Labels: ${labels.join(", ")}`
      : "Labels: (all open PRs)",
  ].join("\n"),
);

console.log("\nAll done.");