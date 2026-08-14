import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRUCTURED_RESULT_MCP_SERVER_NAME,
  STRUCTURED_RESULT_PR_REVIEW_DIR_ENV,
} from "./structured-result-contracts.mts";

/** MCP package root inside the worktree (and loop deploy tree). */
export const STRUCTURED_RESULT_MCP_WORKTREE_RELATIVE_DIR =
  ".sandcastle/structured-result-mcp";

/** Bundled stdio entrypoint copied into each worktree. */
export const STRUCTURED_RESULT_MCP_BUNDLE_RELATIVE_PATH =
  `${STRUCTURED_RESULT_MCP_WORKTREE_RELATIVE_DIR}/dist/server.mjs`;

export const STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV =
  "OPENCODE_CONFIG_CONTENT";

const STRUCTURED_RESULT_MCP_BUNDLE_FROM_DEPLOYED_MODULE =
  "structured-result-mcp/dist/server.mjs";

export interface StructuredResultMcpInstallOptions {
  /** Loop source root (defaults to this module's directory). */
  loopRootDir?: string;
}

export interface StructuredResultMcpConfigOptions {
  /** Relative to worktree; PR-review stages write artifact filenames here. */
  prReviewRelativeDir?: string;
}

export interface StructuredResultMcpLocalServerConfig {
  type: "local";
  command: string[];
  cwd: string;
  environment?: Record<string, string>;
}

export function buildStructuredResultMcpLocalServerConfig(
  options: StructuredResultMcpConfigOptions = {},
): StructuredResultMcpLocalServerConfig {
  const environment: Record<string, string> = {};
  if (options.prReviewRelativeDir) {
    environment[STRUCTURED_RESULT_PR_REVIEW_DIR_ENV] =
      options.prReviewRelativeDir;
  }
  return {
    type: "local",
    command: ["node", STRUCTURED_RESULT_MCP_BUNDLE_RELATIVE_PATH],
    cwd: ".",
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
}

export function buildStructuredResultMcpOpencodeFragment(
  options: StructuredResultMcpConfigOptions = {},
): { mcp: Record<string, StructuredResultMcpLocalServerConfig> } {
  return {
    mcp: {
      [STRUCTURED_RESULT_MCP_SERVER_NAME]:
        buildStructuredResultMcpLocalServerConfig(options),
    },
  };
}

/**
 * Inline OpenCode configuration payload for one structured-output invocation.
 * The Structured-result agent-provider decorator attaches it to the OpenCode
 * launch command so reusable sandboxes receive it without mutating the branch.
 */
export function buildStructuredResultMcpAgentEnv(
  options: StructuredResultMcpConfigOptions = {},
): Record<string, string> {
  return {
    [STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV]: JSON.stringify(
      buildStructuredResultMcpOpencodeFragment(options),
    ),
  };
}

export function resolveStructuredResultMcpBundleSource(
  moduleDir: string,
  loopRootDir?: string,
): string | undefined {
  const candidates = loopRootDir
    ? [join(loopRootDir, STRUCTURED_RESULT_MCP_BUNDLE_RELATIVE_PATH)]
    : [
        // Source checkout: this module is at the repository root.
        join(moduleDir, STRUCTURED_RESULT_MCP_BUNDLE_RELATIVE_PATH),
        // Deployed loop: this module itself has been copied into `.sandcastle/`.
        join(moduleDir, STRUCTURED_RESULT_MCP_BUNDLE_FROM_DEPLOYED_MODULE),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Copy the bundled Structured-result MCP into a sandbox worktree. The caller
 * wraps only structured-output OpenCode invocations with the invocation-local
 * config, so installation never writes project configuration.
 */
export function installStructuredResultMcp(
  worktreePath: string,
  options: StructuredResultMcpInstallOptions = {},
): void {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const bundleSource = resolveStructuredResultMcpBundleSource(
    moduleDir,
    options.loopRootDir,
  );
  if (!bundleSource) {
    throw new Error(
      `Structured-result MCP bundle missing beside ${moduleDir}; run npm run build`,
    );
  }

  const bundleDest = join(worktreePath, STRUCTURED_RESULT_MCP_BUNDLE_RELATIVE_PATH);
  mkdirSync(dirname(bundleDest), { recursive: true });
  cpSync(bundleSource, bundleDest);
}
