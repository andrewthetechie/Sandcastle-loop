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
    "pr-standards-review-user-prompt.md",
    "pr-spec-review-user-prompt.md",
  ]) {
    assert.match(runner, new RegExp(`new URL\\(\"\\./${name}\"`));
    assert.ok(read(name).length > 0, `${name} must not be empty`);
  }
});

test("fixer prompt preserves every host-owned finding disposition", () => {
  const prompt = read("pr-review-agent-system-prompt.md");

  assert.match(prompt, /untrusted review data/i);
  assert.match(prompt, /findings are immutable inputs/i);
  assert.match(prompt, /every finding ID exactly one disposition/i);
  assert.match(prompt, /serious unresolved finding does not prevent review completion/i);
  assert.match(prompt, /`fixed` or `not_fixed`/i);
  assert.match(prompt, /FIX_RESULT_PATH/);
  assert.match(prompt, /never use `git add -A` or `git add \.`/i);
  assert.match(prompt, /<\/pr_review_complete>/);
});

test("specialist prompts report non-local blockers without a finding cap", () => {
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
    assert.match(prompt, /Confidence must be at least 70/i);
    assert.match(prompt, /There is no arbitrary finding-count cap/i);
    assert.match(prompt, /architecture/i);
    assert.doesNotMatch(prompt, /fix is local/i);
  }
});

test("fixer user prompt contains immutable specialist artifact paths", () => {
  const prompt = read("pr-review-user-prompt.md");
  const placeholders = [
    ...prompt.matchAll(/{{([^{}]+)}}/g),
  ].map((match) => match[1]!).sort();

  assert.deepEqual(placeholders, [
    "BASE_SHA",
    "CHANGED_FILES_PATH",
    "COMMIT_LIST_PATH",
    "DIFF_BYTES",
    "DIFF_PATH",
    "DIFF_STAT_PATH",
    "ECOSYSTEMS",
    "FINDINGS_PATH",
    "FIX_RESULT_PATH",
    "LINKED_ISSUES_PATH",
    "METADATA_PATH",
    "PR_BODY_PATH",
    "PR_NUMBER",
    "PR_TITLE",
    "REVIEW_ASPECTS",
    "SPEC_REVIEW_PATH",
    "STANDARDS_FILES_PATH",
    "STANDARDS_REVIEW_PATH",
  ]);
  assert.match(prompt, /untrusted review data/i);
  assert.match(prompt, /Original review inputs/i);
  assert.match(prompt, /Immutable specialist outputs/i);
});

test("specialist user prompts receive explicit context manifests", () => {
  const standards = read("pr-standards-review-user-prompt.md");
  const spec = read("pr-spec-review-user-prompt.md");

  assert.deepEqual(placeholders(standards), [
    "BASE_SHA",
    "CHANGED_FILES_PATH",
    "COMMIT_LIST_PATH",
    "DIFF_BYTES",
    "DIFF_PATH",
    "DIFF_STAT_PATH",
    "ECOSYSTEMS",
    "METADATA_PATH",
    "REVIEW_ASPECTS",
    "STANDARDS_FILES_PATH",
  ]);
  assert.deepEqual(placeholders(spec), [
    "BASE_SHA",
    "CHANGED_FILES_PATH",
    "COMMIT_LIST_PATH",
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
});

test("runner passes file paths and labels via REST", () => {
  const runner = read("run-pr-review-v1.mts");

  assert.match(runner, /PR_BODY_PATH:\s+reviewInputs\.paths\.prBody/);
  assert.match(runner, /LINKED_ISSUES_PATH:\s+reviewInputs\.paths\.linkedIssues/);
  assert.match(runner, /DIFF_PATH:\s+reviewInputs\.paths\.diff/);
  assert.match(runner, /METADATA_PATH:\s+reviewInputs\.paths\.metadata/);
  assert.match(runner, /STANDARDS_FILES_PATH:\s+reviewInputs\.paths\.standardsFiles/);
  assert.match(runner, /COMMIT_LIST_PATH:\s+reviewInputs\.paths\.commitList/);
  assert.match(runner, /acquirePrReviewSpecialist<StandardsReview>/);
  assert.match(runner, /acquirePrReviewSpecialist<SpecReview>/);
  assert.match(runner, /writePrReviewSpecialistArtifacts/);
  assert.match(runner, /buildPrReviewResult/);
  assert.doesNotMatch(runner, /\{\{DIFF\}\}/);
  assert.doesNotMatch(runner, /\{\{PR_BODY\}\}/);
  assert.doesNotMatch(runner, /\{\{LINKED_ISSUES\}\}/);

  assert.match(runner, /repos\/\{owner\}\/\{repo\}\/issues\/\$\{prNumber\}\/labels/);
  assert.doesNotMatch(runner, /\[\s*"pr",\s*"edit",/);
});

test("runner host-acquires both reviews before starting the fixer", () => {
  const runner = read("run-pr-review-v1.mts");
  const standardsCall = runner.indexOf(
    "const standardsAcquisition = await acquirePrReviewSpecialist",
  );
  const specCall = runner.indexOf(
    "const specAcquisition = await acquirePrReviewSpecialist",
  );
  const artifactWrite = runner.indexOf(
    "const outputPaths = writePrReviewSpecialistArtifacts",
  );
  const fixerRun = runner.indexOf("const runName = `pr-review #${pr.number}`");

  assert.ok(standardsCall >= 0);
  assert.ok(specCall > standardsCall);
  assert.ok(artifactWrite > specCall);
  assert.ok(fixerRun > artifactWrite);
  assert.match(runner, /const PR_SPECIALIST_MAX_ATTEMPTS = 2/);
  assert.match(runner, /completionSignal: "<\/standards_findings>"/);
  assert.match(runner, /completionSignal: "<\/spec_findings>"/);
  assert.match(runner, /Invalid PR review finding accounting/);
});

test("fixer agent cannot delegate review work", () => {
  const definitions = read("custom-agent-defs.mts");
  const fixerBlock = definitions.slice(
    definitions.indexOf("export const PR_REVIEW_AGENT_CONFIG"),
    definitions.indexOf("export const PR_STANDARDS_REVIEW_AGENT_CONFIG"),
  );
  assert.match(fixerBlock, /task: "deny"/);
});

function placeholders(prompt: string): string[] {
  return [...prompt.matchAll(/{{([^{}]+)}}/g)]
    .map((match) => match[1]!)
    .sort();
}
