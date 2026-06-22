import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SandcastleLoopRoleModels {
  coder: string;
  rework: string;
  reviewer: string;
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

export interface SandcastleLoopConfig {
  models?: Partial<SandcastleLoopRoleModels>;
  validationCommands?: string[];
  setupCommands?: string[];
  cache?: SandcastleLoopCacheConfig;
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
  reviewer: "zai-coding-plan/glm-5.1",
  codeQuality: "zai-coding-plan/glm-5.1",
  twoAxis: "zai-coding-plan/glm-5.1",
  issueDecomposer: "zai-coding-plan/glm-5.1",
  escalationReview: "anthropic/claude-sonnet-4-5",
};

const DEFAULT_VALIDATION_COMMANDS = [
  "npm run typecheck",
  "npm run test",
  "npm run build",
];

const DEFAULT_SETUP_COMMANDS = ["npm install"];

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

  return {
    configPath,
    loadedConfig: existsSync(configPath),
    models: {
      ...DEFAULT_MODELS,
      ...(userConfig.models ?? {}),
    },
    validationCommands:
      userConfig.validationCommands ?? [...DEFAULT_VALIDATION_COMMANDS],
    setupCommands: userConfig.setupCommands ?? [...DEFAULT_SETUP_COMMANDS],
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
