import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import {
  ensureOpencodeGitExclude,
  ensureSandboxGitExclude,
  writeAgentDefinitionFile,
} from "./custom-agent-worktree.mts";

test("ensureOpencodeGitExclude adds .opencode/ exactly once across repeated calls", () => {
  withGitFixture((repo) => {
    ensureOpencodeGitExclude(repo);
    ensureOpencodeGitExclude(repo);

    const excludePath = gitPath(repo, "info/exclude");
    const excludeContents = readFileSync(excludePath, "utf8");
    const lines = excludeContents.split("\n").filter((line) => line === ".opencode/");

    assert.equal(lines.length, 1);
    assert.match(excludeContents, /\.opencode\/\n$/);
  });
});

test("ensureOpencodeGitExclude leaves a preexisting .opencode/ entry byte-identical", () => {
  withGitFixture((repo) => {
    const excludePath = gitPath(repo, "info/exclude");
    const existing = "node_modules/\n.opencode/\n";
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, existing, "utf8");

    ensureOpencodeGitExclude(repo);

    assert.equal(readFileSync(excludePath, "utf8"), existing);
  });
});

test("ensureOpencodeGitExclude creates info/exclude when it does not exist", () => {
  withGitFixture((repo) => {
    const excludePath = gitPath(repo, "info/exclude");
    rmSync(excludePath, { force: true });

    ensureOpencodeGitExclude(repo);

    assert.equal(readFileSync(excludePath, "utf8"), ".opencode/\n");
  });
});

test("ensureSandboxGitExclude adds .sandcastle/ exactly once across repeated calls", () => {
  withGitFixture((repo) => {
    ensureSandboxGitExclude(repo);
    ensureSandboxGitExclude(repo);

    const excludePath = gitPath(repo, "info/exclude");
    const excludeContents = readFileSync(excludePath, "utf8");
    const lines = excludeContents.split("\n").filter((line) => line === ".sandcastle/");

    assert.equal(lines.length, 1);
    assert.match(excludeContents, /\.sandcastle\/\n$/);
  });
});

test("ensureSandboxGitExclude can coexist with a preexisting .opencode/ entry", () => {
  withGitFixture((repo) => {
    const excludePath = gitPath(repo, "info/exclude");
    const existing = ".opencode/\n";
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, existing, "utf8");

    ensureSandboxGitExclude(repo);

    assert.equal(readFileSync(excludePath, "utf8"), ".opencode/\n.sandcastle/\n");
  });
});

test("writeAgentDefinitionFile writes the agent file under .opencode/agents and returns its absolute path", () => {
  withGitFixture((repo) => {
    const path = writeAgentDefinitionFile(repo, "coder", "X");

    assert.equal(path, join(repo, ".opencode", "agents", "coder.md"));
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, "utf8"), "X");
  });
});

function withGitFixture(fn: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "custom-agent-worktree-"));
  try {
    git(repo, ["init"]);
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "user.name", "Custom Agent Test"]);
    git(repo, ["commit", "-m", "Base"]);
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitPath(cwd: string, path: string): string {
  const rawPath = git(cwd, ["rev-parse", "--git-path", path]);
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}
