import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverPrReviewStandardsFiles } from "./pr-review-context.mts";

test("standards discovery includes repository and changed-file-local instructions", () => {
  const result = discoverPrReviewStandardsFiles(
    [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "backend-standards.md",
      "docs/backend-standards.md",
      "docs/conventions.md",
      "docs/adr/0001-routing.md",
      "packages/api/AGENTS.md",
      "packages/api/src/CLAUDE.local.md",
      "packages/web/AGENTS.md",
      "README.md",
    ],
    [
      "packages/api/src/routes/game.ts",
      "packages/api/test/game.test.ts",
    ],
  );

  assert.deepEqual(result, [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "backend-standards.md",
    "docs/backend-standards.md",
    "docs/conventions.md",
    "packages/api/AGENTS.md",
    "packages/api/src/CLAUDE.local.md",
  ]);
});

test("standards discovery excludes instructions for unrelated subtrees", () => {
  const result = discoverPrReviewStandardsFiles(
    ["AGENTS.md", "services/a/AGENTS.md", "services/b/AGENTS.md"],
    ["services/a/source.ts"],
  );

  assert.deepEqual(result, ["AGENTS.md", "services/a/AGENTS.md"]);
});
