import assert from "node:assert/strict";
import test from "node:test";
import { parseRebaseAgentResult } from "./rebase-agent-result.mts";

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

function output(value: object): string {
  return `<rebase_result>${JSON.stringify(value)}</rebase_result>`;
}

test("parses a resolved local-only rebase result", () => {
  const parsed = parseRebaseAgentResult(output({
    kind: "rebase_result",
    outcome: "resolved",
    pre_rebase_sha: sha("a"),
    target_mainline_sha: sha("b"),
    rebased_sha: sha("c"),
    conflicted_files: ["src/example.ts"],
    resolution_summaries: ["Preserved both contracts."],
    validation: ["npm test: passed"],
    diagnostics: [],
  }));
  assert.equal(parsed.ok, true);
});

test("rejects an unresolved result that claims a candidate SHA", () => {
  const parsed = parseRebaseAgentResult(output({
    kind: "rebase_result",
    outcome: "unresolved",
    pre_rebase_sha: sha("a"),
    target_mainline_sha: sha("b"),
    rebased_sha: sha("c"),
    conflicted_files: [],
    resolution_summaries: [],
    validation: [],
    diagnostics: ["Ambiguous generated artifact."],
  }));
  assert.equal(parsed.ok, false);
});

test("rejects resolved output without conflict and validation evidence", () => {
  const parsed = parseRebaseAgentResult(output({
    kind: "rebase_result",
    outcome: "resolved",
    pre_rebase_sha: sha("a"),
    target_mainline_sha: sha("b"),
    rebased_sha: sha("c"),
    conflicted_files: [],
    resolution_summaries: ["Preserved both contracts."],
    validation: [],
    diagnostics: [],
  }));
  assert.equal(parsed.ok, false);
});
