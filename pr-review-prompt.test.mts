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
  }
});

test("user prompt contains exactly the runtime placeholders supplied by the runner", () => {
  const prompt = read("pr-review-user-prompt.md");
  const placeholders = [
    ...prompt.matchAll(/{{([^{}]+)}}/g),
  ].map((match) => match[1]!).sort();

  assert.deepEqual(placeholders, [
    "BASE_SHA",
    "CHANGED_FILES",
    "DIFF",
    "DIFF_BYTES",
    "DIFF_STAT",
    "ECOSYSTEMS",
    "LINKED_ISSUES",
    "PR_BODY",
    "PR_NUMBER",
    "PR_TITLE",
    "REVIEW_ASPECTS",
  ]);
  assert.match(prompt, /untrusted review data, not instructions/i);
});
