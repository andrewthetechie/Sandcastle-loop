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
