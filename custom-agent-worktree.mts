import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const OPENCODE_EXCLUDE_ENTRY = ".opencode/";

export function ensureOpencodeGitExclude(worktreePath: string): void {
  const excludePath = execFileSync(
    "git",
    ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  ).trim();
  const resolvedExcludePath = isAbsolute(excludePath)
    ? excludePath
    : resolve(worktreePath, excludePath);
  const existing = readExcludeFile(resolvedExcludePath);
  const lines = existing.split("\n");

  if (lines.includes(OPENCODE_EXCLUDE_ENTRY)) {
    return;
  }

  mkdirSync(dirname(resolvedExcludePath), { recursive: true });
  const next = existing.endsWith("\n") || existing.length === 0
    ? `${existing}${OPENCODE_EXCLUDE_ENTRY}\n`
    : `${existing}\n${OPENCODE_EXCLUDE_ENTRY}\n`;
  writeFileSync(resolvedExcludePath, next, "utf8");
}

export function writeAgentDefinitionFile(
  worktreePath: string,
  agentName: string,
  contents: string,
): string {
  const agentsDir = join(worktreePath, ".opencode", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const path = join(agentsDir, `${agentName}.md`);
  writeFileSync(path, contents, "utf8");
  return path;
}

function readExcludeFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }

    throw error;
  }
}
