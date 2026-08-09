import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

test("PR review runner prompt files exist at the paths it loads", () => {
  const runner = read("run-pr-review-v1.mts");
  for (const name of [
    "pr-review-agent-system-prompt.md",
    "pr-standards-review-agent-system-prompt.md",
    "pr-spec-review-agent-system-prompt.md",
    "pr-review-user-prompt.md",
  ]) {
    assert.match(runner, new RegExp(`new URL\\(\"\\./${name}\"`));
    assert.ok(read(name).length > 0, `${name} must not be empty`);
  }
});

test("coordinator prompt enforces sequential reviews and guarded completion", () => {
  const prompt = read("pr-review-agent-system-prompt.md");

  assert.match(prompt, /untrusted review data/i);
  assert.match(prompt, /Do not edit files before both specialist reviews finish/i);
  assert.ok(
    prompt.indexOf("pr-standards-review") < prompt.indexOf("pr-spec-review"),
    "Standards must run before Spec",
  );
  assert.match(prompt, /retry once/i);
  assert.match(prompt, /never use `git add -A` or `git add \.`/i);
  assert.match(prompt, /never emit it for partial, blocked, or unvalidated work/i);
  assert.match(prompt, /<\/pr_review_complete>/);
  assert.match(prompt, /file-backed review input/i);
  assert.match(prompt, /input file paths/i);
});

test("specialist prompts require read-only tagged JSON with an evidence bar", () => {
  const cases = [
    ["pr-standards-review-agent-system-prompt.md", "standards_findings", "STD-001"],
    ["pr-spec-review-agent-system-prompt.md", "spec_findings", "SPEC-001"],
  ] as const;

  for (const [name, tag, id] of cases) {
    const prompt = read(name);
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /untrusted data/i);
    assert.match(prompt, /strict JSON/i);
    assert.match(prompt, new RegExp(`<${tag}>`));
    assert.match(prompt, new RegExp(`<\\/${tag}>`));
    assert.match(prompt, new RegExp(id));
    assert.match(prompt, /Confidence is at least 80/i);
    assert.match(prompt, /at most five findings/i);
    assert.match(prompt, /supplied file paths/i);
  }
});

test("user prompt contains exactly the runtime placeholders supplied by the runner", () => {
  const prompt = read("pr-review-user-prompt.md");
  const placeholders = [
    ...prompt.matchAll(/{{([^{}]+)}}/g),
  ].map((match) => match[1]!).sort();

  assert.deepEqual(placeholders, [
    "BASE_SHA",
    "CHANGED_FILES_PATH",
    "DIFF_BYTES",
    "DIFF_PATH",
    "DIFF_STAT_PATH",
    "ECOSYSTEMS",
    "LINKED_ISSUES_PATH",
    "METADATA_PATH",
    "PR_BODY_PATH",
    "PR_NUMBER",
    "PR_TITLE",
    "REVIEW_ASPECTS",
  ]);
  assert.match(prompt, /untrusted review data/i);
  assert.match(prompt, /File-backed inputs/i);
  assert.match(prompt, /Do not expect .* inline/i);
});

test("runner passes file paths and labels via REST", () => {
  const runner = read("run-pr-review-v1.mts");

  assert.match(runner, /PR_BODY_PATH:\s+reviewInputs\.paths\.prBody/);
  assert.match(runner, /LINKED_ISSUES_PATH:\s+reviewInputs\.paths\.linkedIssues/);
  assert.match(runner, /DIFF_PATH:\s+reviewInputs\.paths\.diff/);
  assert.match(runner, /METADATA_PATH:\s+reviewInputs\.paths\.metadata/);
  assert.doesNotMatch(runner, /\{\{DIFF\}\}/);
  assert.doesNotMatch(runner, /\{\{PR_BODY\}\}/);
  assert.doesNotMatch(runner, /\{\{LINKED_ISSUES\}\}/);

  assert.match(runner, /repos\/\{owner\}\/\{repo\}\/issues\/\$\{pr\.number\}\/labels/);
  assert.doesNotMatch(runner, /\[\s*"pr",\s*"edit",/);
});
