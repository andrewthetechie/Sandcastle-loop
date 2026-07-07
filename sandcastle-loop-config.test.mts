import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSandcastleLoopConfig } from "./sandcastle-loop-config.mts";

function repoRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  return root;
}

test("reviewer.maxAttempts defaults to 2", async () => {
  const root = repoRoot("loop-config-default");

  const config = await loadSandcastleLoopConfig(root);
  assert.equal(config.reviewer.maxAttempts, 2);
});

test("reviewer.maxAttempts accepts bounds 1 and 5", async () => {
  const rootA = repoRoot("loop-config-one");
  writeFileSync(
    join(rootA, ".sandcastle", "config.mts"),
    "export default { reviewer: { maxAttempts: 1 } };",
  );
  const configA = await loadSandcastleLoopConfig(rootA);
  assert.equal(configA.reviewer.maxAttempts, 1);

  const rootB = repoRoot("loop-config-five");
  writeFileSync(
    join(rootB, ".sandcastle", "config.mts"),
    "export default { reviewer: { maxAttempts: 5 } };",
  );
  const configB = await loadSandcastleLoopConfig(rootB);
  assert.equal(configB.reviewer.maxAttempts, 5);
});

test("issue-as-prd models default to reviewer and follow reviewer override unless independently overridden", async () => {
  const rootA = repoRoot("loop-config-model-defaults");
  const configA = await loadSandcastleLoopConfig(rootA);
  assert.equal(
    configA.models.initialIssueDecomposer,
    configA.models.reviewer,
  );
  assert.equal(configA.models.subtaskReadiness, configA.models.reviewer);

  const rootB = repoRoot("loop-config-reviewer-override");
  writeFileSync(
    join(rootB, ".sandcastle", "config.mts"),
    "export default { models: { reviewer: 'custom-reviewer' } };",
  );
  const configB = await loadSandcastleLoopConfig(rootB);
  assert.equal(configB.models.reviewer, "custom-reviewer");
  assert.equal(configB.models.initialIssueDecomposer, "custom-reviewer");
  assert.equal(configB.models.subtaskReadiness, "custom-reviewer");

  const rootC = repoRoot("loop-config-model-independent");
  writeFileSync(
    join(rootC, ".sandcastle", "config.mts"),
    "export default { models: { reviewer: 'reviewer-x', initialIssueDecomposer: 'decomposer-y', subtaskReadiness: 'readiness-z' } };",
  );
  const configC = await loadSandcastleLoopConfig(rootC);
  assert.equal(configC.models.reviewer, "reviewer-x");
  assert.equal(configC.models.initialIssueDecomposer, "decomposer-y");
  assert.equal(configC.models.subtaskReadiness, "readiness-z");
});

test("issueAsPrd.parentCommentMaxBytes defaults to 32000 and accepts positive integers", async () => {
  const rootA = repoRoot("loop-config-parent-comment-default");
  const configA = await loadSandcastleLoopConfig(rootA);
  assert.equal(configA.issueAsPrd.parentCommentMaxBytes, 32_000);

  const rootB = repoRoot("loop-config-parent-comment-custom");
  writeFileSync(
    join(rootB, ".sandcastle", "config.mts"),
    "export default { issueAsPrd: { parentCommentMaxBytes: 1234 } };",
  );
  const configB = await loadSandcastleLoopConfig(rootB);
  assert.equal(configB.issueAsPrd.parentCommentMaxBytes, 1234);
});

test("issueAsPrd.parentCommentMaxBytes rejects non-positive and non-integer values", async () => {
  const cases = [
    "export default { issueAsPrd: { parentCommentMaxBytes: 0 } };",
    "export default { issueAsPrd: { parentCommentMaxBytes: -1 } };",
    "export default { issueAsPrd: { parentCommentMaxBytes: 1.5 } };",
    "export default { issueAsPrd: { parentCommentMaxBytes: 'large' } };",
  ];

  for (const [index, source] of cases.entries()) {
    const root = repoRoot(`loop-config-parent-comment-invalid-${index}`);
    const path = join(root, ".sandcastle", "config.mts");
    writeFileSync(path, source);
    await assert.rejects(
      () => loadSandcastleLoopConfig(root),
      new RegExp(
        `${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: issueAsPrd.parentCommentMaxBytes`,
      ),
    );
  }
});

test("reviewer.maxAttempts rejects zero, values above 5, non-integers, and non-numbers", async () => {
  const cases = [
    "export default { reviewer: { maxAttempts: 0 } };",
    "export default { reviewer: { maxAttempts: 6 } };",
    "export default { reviewer: { maxAttempts: 1.5 } };",
    "export default { reviewer: { maxAttempts: 'two' } };",
  ];

  for (const [index, source] of cases.entries()) {
    const root = repoRoot(`loop-config-invalid-${index}`);
    const path = join(root, ".sandcastle", "config.mts");
    writeFileSync(path, source);
    await assert.rejects(
      () => loadSandcastleLoopConfig(root),
      new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: reviewer.maxAttempts`),
    );
  }
});
