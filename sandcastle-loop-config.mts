import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SandcastleLoopRoleModels {
  coder: string;
  /** Rework tier 1 — the cheap model, rounds below `coderEscalation.tier2FromRound`. */
  rework: string;
  /** Rework tier 2 — used from `coderEscalation.tier2FromRound` (backlog v4). */
  reworkTier2: string;
  /** Rework tier 3 — used from `coderEscalation.tier3FromRound` (backlog v4). */
  reworkTier3: string;
  reviewer: string;
  prReviewStandards: string;
  prReviewSpec: string;
  prReviewFixer: string;
  initialIssueDecomposer: string;
  subtaskReadiness: string;
  subtaskImprovement: string;
  rebase: string;
  codeQuality: string;
  twoAxis: string;
  issueDecomposer: string;
  escalationReview: string;
}

export interface SandcastleLoopCacheMount {
  name: string;
  sandboxPath: string;
  hostPath?: string;
}

export interface SandcastleLoopCacheConfig {
  root?: string;
  mounts?: SandcastleLoopCacheMount[];
  env?: Record<string, string>;
}

/**
 * Round thresholds for the backlog-v4 coder escalation ladder. Rounds below
 * `tier2FromRound` run `models.rework`; rounds from `tier2FromRound` run
 * `models.reworkTier2`; rounds from `tier3FromRound` run `models.reworkTier3`.
 */
export interface SandcastleLoopCoderEscalationConfig {
  tier2FromRound?: number;
  tier3FromRound?: number;
}

export interface SandcastleLoopConfig {
  models?: Partial<SandcastleLoopRoleModels>;
  validationCommands?: string[];
  setupCommands?: string[];
  cache?: SandcastleLoopCacheConfig;
  reviewer?: {
    maxAttempts?: number;
  };
  issueAsPrd?: {
    parentCommentMaxBytes?: number;
  };
  reviewDiffMaxBytes?: number;
  coderEscalation?: SandcastleLoopCoderEscalationConfig;
}

export interface ResolvedSandcastleLoopCacheMount {
  name: string;
  hostPath: string;
  sandboxPath: string;
}

export interface ResolvedSandcastleLoopConfig {
  configPath: string;
  loadedConfig: boolean;
  models: SandcastleLoopRoleModels;
  validationCommands: string[];
  setupCommands: string[];
  reviewer: {
    maxAttempts: number;
  };
  issueAsPrd: {
    parentCommentMaxBytes: number;
  };
  reviewDiffMaxBytes: number;
  coderEscalation: {
    tier2FromRound: number;
    tier3FromRound: number;
  };
  cache: {
    root: string;
    mounts: ResolvedSandcastleLoopCacheMount[];
    sandboxEnv: Record<string, string>;
    hostEnv: Record<string, string>;
  };
}

const SANDBOX_HOME = "/home/agent";

const DEFAULT_MODELS: SandcastleLoopRoleModels = {
  coder: "strix/qwen3.6-35b-a3b-8bit",
  rework: "strix/qwen3.6-35b-a3b-8bit",
  // Escalation tiers default to models already present elsewhere in the stack
  // so a fresh v4 run has a working ladder without extra configuration.
  reworkTier2: "zai-coding-plan/glm-5.2",
  reworkTier3: "anthropic/claude-sonnet-4-5",
  reviewer: "zai-coding-plan/glm-5.2",
  prReviewStandards: "zai-coding-plan/glm-5.2",
  prReviewSpec: "zai-coding-plan/glm-5.2",
  prReviewFixer: "zai-coding-plan/glm-5.2",
  initialIssueDecomposer: "zai-coding-plan/glm-5.2",
  subtaskReadiness: "zai-coding-plan/glm-5.2",
  subtaskImprovement: "zai-coding-plan/glm-5.2",
  rebase: "anthropic/claude-sonnet-4-5",
  codeQuality: "zai-coding-plan/glm-5.2",
  twoAxis: "zai-coding-plan/glm-5.2",
  issueDecomposer: "zai-coding-plan/glm-5.2",
  escalationReview: "anthropic/claude-sonnet-4-5",
};

const DEFAULT_VALIDATION_COMMANDS = [
  "npm run typecheck",
  "npm run test",
  "npm run build",
];

const DEFAULT_SETUP_COMMANDS = ["npm install"];
const DEFAULT_REVIEWER_MAX_ATTEMPTS = 2;
const DEFAULT_PARENT_COMMENT_MAX_BYTES = 32_000;
// Policy backstop for a single reviewable branch diff once inputs are
// file-backed (see ADR 0006). Argv-inlined runners should pin a lower value.
const DEFAULT_REVIEW_DIFF_MAX_BYTES = 2_000_000;
const DEFAULT_CODER_ESCALATION_TIER2_FROM_ROUND = 3;
const DEFAULT_CODER_ESCALATION_TIER3_FROM_ROUND = 5;

export async function loadSandcastleLoopConfig(
  repoRoot: string,
): Promise<ResolvedSandcastleLoopConfig> {
  const configPath = join(repoRoot, ".sandcastle", "config.mts");
  const userConfig = existsSync(configPath)
    ? await importConfig(configPath)
    : {};

  const cacheRoot = expandHostPath(
    userConfig.cache?.root ?? "~/.cache/sandcastle-loop",
    repoRoot,
  );
  const repoKey = repoCacheKey(repoRoot);
  const mounts = resolveCacheMounts({
    repoRoot,
    cacheRoot,
    repoKey,
    mounts: userConfig.cache?.mounts ?? [],
  });
  const env = userConfig.cache?.env ?? {};
  const configuredModels = {
    ...DEFAULT_MODELS,
    ...(userConfig.models ?? {}),
  };
  const resolvedReviewerModel = configuredModels.reviewer;

  return {
    configPath,
    loadedConfig: existsSync(configPath),
    models: {
      ...configuredModels,
      initialIssueDecomposer:
        userConfig.models?.initialIssueDecomposer ?? resolvedReviewerModel,
      subtaskReadiness:
        userConfig.models?.subtaskReadiness ?? resolvedReviewerModel,
      // v3 improvement has a dedicated override but deliberately inherits the
      // existing readiness/reviewer choice for deployed configurations.
      subtaskImprovement:
        userConfig.models?.subtaskImprovement ??
        userConfig.models?.subtaskReadiness ??
        resolvedReviewerModel,
      rebase: userConfig.models?.rebase ?? configuredModels.reworkTier3,
      prReviewStandards:
        userConfig.models?.prReviewStandards ?? resolvedReviewerModel,
      prReviewSpec:
        userConfig.models?.prReviewSpec ?? resolvedReviewerModel,
      prReviewFixer:
        userConfig.models?.prReviewFixer ?? resolvedReviewerModel,
    },
    validationCommands:
      userConfig.validationCommands ?? [...DEFAULT_VALIDATION_COMMANDS],
    setupCommands: userConfig.setupCommands ?? [...DEFAULT_SETUP_COMMANDS],
    reviewer: {
      maxAttempts:
        userConfig.reviewer?.maxAttempts ?? DEFAULT_REVIEWER_MAX_ATTEMPTS,
    },
    issueAsPrd: {
      parentCommentMaxBytes:
        userConfig.issueAsPrd?.parentCommentMaxBytes ??
        DEFAULT_PARENT_COMMENT_MAX_BYTES,
    },
    reviewDiffMaxBytes:
      userConfig.reviewDiffMaxBytes ?? DEFAULT_REVIEW_DIFF_MAX_BYTES,
    coderEscalation: {
      tier2FromRound:
        userConfig.coderEscalation?.tier2FromRound ??
        DEFAULT_CODER_ESCALATION_TIER2_FROM_ROUND,
      tier3FromRound:
        userConfig.coderEscalation?.tier3FromRound ??
        DEFAULT_CODER_ESCALATION_TIER3_FROM_ROUND,
    },
    cache: {
      root: cacheRoot,
      mounts,
      sandboxEnv: resolveSandboxEnv(env),
      hostEnv: resolveHostEnv(env, mounts, repoRoot),
    },
  };
}

function repoCacheKey(repoRoot: string): string {
  const normalized = resolve(repoRoot);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${basename(normalized)}-${hash}`;
}

async function importConfig(configPath: string): Promise<SandcastleLoopConfig> {
  const imported = (await import(pathToFileURL(configPath).href)) as {
    default?: unknown;
  };
  if (imported.default === undefined) {
    throw new Error(`${configPath} must export a default config object`);
  }
  if (!isRecord(imported.default)) {
    throw new Error(`${configPath} default export must be an object`);
  }
  validateConfig(imported.default, configPath);
  return imported.default as SandcastleLoopConfig;
}

function resolveCacheMounts(input: {
  repoRoot: string;
  cacheRoot: string;
  repoKey: string;
  mounts: SandcastleLoopCacheMount[];
}): ResolvedSandcastleLoopCacheMount[] {
  return input.mounts.map((mount) => {
    validateMount(mount);
    const hostPath = expandHostPath(
      mount.hostPath ?? join(input.cacheRoot, input.repoKey, mount.name),
      input.repoRoot,
    );
    const sandboxPath = expandSandboxPath(mount.sandboxPath);
    mkdirSync(hostPath, { recursive: true });
    return { name: mount.name, hostPath, sandboxPath };
  });
}

function resolveSandboxEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, expandSandboxPath(value)]),
  );
}

function resolveHostEnv(
  env: Record<string, string>,
  mounts: ResolvedSandcastleLoopCacheMount[],
  repoRoot: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const sandboxValue = expandSandboxPath(value);
      const matchingMount = mounts.find(
        (mount) =>
          sandboxValue === mount.sandboxPath ||
          sandboxValue.startsWith(`${mount.sandboxPath}/`),
      );
      if (!matchingMount) {
        return [key, expandHostEnvValue(value)];
      }

      return [
        key,
        `${matchingMount.hostPath}${sandboxValue.slice(matchingMount.sandboxPath.length)}`,
      ];
    }),
  );
}

function expandHostPath(path: string, repoRoot: string): string {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path;
  return resolve(repoRoot, expanded);
}

function expandHostEnvValue(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function expandSandboxPath(path: string): string {
  if (path === "~") return SANDBOX_HOME;
  if (path.startsWith("~/")) return `${SANDBOX_HOME}/${path.slice(2)}`;
  return path;
}

function validateConfig(
  config: Record<string, unknown>,
  configPath: string,
): void {
  if (config.models !== undefined && !isRecord(config.models)) {
    throw new Error(`${configPath}: models must be an object`);
  }
  if (
    isRecord(config.models) &&
    !Object.values(config.models).every((model) => typeof model === "string")
  ) {
    throw new Error(`${configPath}: models values must be strings`);
  }
  if (
    config.validationCommands !== undefined &&
    !isStringArray(config.validationCommands)
  ) {
    throw new Error(`${configPath}: validationCommands must be a string array`);
  }
  if (config.setupCommands !== undefined && !isStringArray(config.setupCommands)) {
    throw new Error(`${configPath}: setupCommands must be a string array`);
  }
  if (config.reviewer !== undefined) {
    if (!isRecord(config.reviewer)) {
      throw new Error(`${configPath}: reviewer must be an object`);
    }
    if (config.reviewer.maxAttempts !== undefined) {
      const maxAttempts = config.reviewer.maxAttempts;
      if (
        typeof maxAttempts !== "number" ||
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > 5
      ) {
        throw new Error(
          `${configPath}: reviewer.maxAttempts must be an integer from 1 through 5`,
        );
      }
    }
  }
  if (config.issueAsPrd !== undefined) {
    if (!isRecord(config.issueAsPrd)) {
      throw new Error(`${configPath}: issueAsPrd must be an object`);
    }
    if (config.issueAsPrd.parentCommentMaxBytes !== undefined) {
      const parentCommentMaxBytes = config.issueAsPrd.parentCommentMaxBytes;
      if (
        typeof parentCommentMaxBytes !== "number" ||
        !Number.isInteger(parentCommentMaxBytes) ||
        parentCommentMaxBytes < 1
      ) {
        throw new Error(
          `${configPath}: issueAsPrd.parentCommentMaxBytes must be a positive integer`,
        );
      }
    }
  }
  if (config.reviewDiffMaxBytes !== undefined) {
    const reviewDiffMaxBytes = config.reviewDiffMaxBytes;
    if (
      typeof reviewDiffMaxBytes !== "number" ||
      !Number.isInteger(reviewDiffMaxBytes) ||
      reviewDiffMaxBytes < 1
    ) {
      throw new Error(
        `${configPath}: reviewDiffMaxBytes must be a positive integer`,
      );
    }
  }
  if (config.coderEscalation !== undefined) {
    if (!isRecord(config.coderEscalation)) {
      throw new Error(`${configPath}: coderEscalation must be an object`);
    }
    for (const field of ["tier2FromRound", "tier3FromRound"] as const) {
      const value = config.coderEscalation[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
        throw new Error(
          `${configPath}: coderEscalation.${field} must be an integer >= 2`,
        );
      }
    }
    const tier2 = config.coderEscalation.tier2FromRound;
    const tier3 = config.coderEscalation.tier3FromRound;
    if (
      typeof tier2 === "number" &&
      typeof tier3 === "number" &&
      tier3 <= tier2
    ) {
      throw new Error(
        `${configPath}: coderEscalation.tier3FromRound (${tier3}) must be greater than tier2FromRound (${tier2})`,
      );
    }
  }
  if (config.cache !== undefined) {
    if (!isRecord(config.cache)) {
      throw new Error(`${configPath}: cache must be an object`);
    }
    if (config.cache.root !== undefined && typeof config.cache.root !== "string") {
      throw new Error(`${configPath}: cache.root must be a string`);
    }
    if (
      config.cache.mounts !== undefined &&
      !Array.isArray(config.cache.mounts)
    ) {
      throw new Error(`${configPath}: cache.mounts must be an array`);
    }
    if (config.cache.env !== undefined && !isStringRecord(config.cache.env)) {
      throw new Error(`${configPath}: cache.env must be a string map`);
    }
  }
}

function validateMount(mount: SandcastleLoopCacheMount): void {
  if (!isRecord(mount)) {
    throw new Error("cache mount entries must be objects");
  }
  if (
    typeof mount.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mount.name)
  ) {
    throw new Error(
      `cache mount name must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'`,
    );
  }
  if (typeof mount.sandboxPath !== "string" || mount.sandboxPath.length === 0) {
    throw new Error(`cache mount '${mount.name}' must set sandboxPath`);
  }
  if (mount.hostPath !== undefined && typeof mount.hostPath !== "string") {
    throw new Error(`cache mount '${mount.name}' hostPath must be a string`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
