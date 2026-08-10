import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE_QUALITY_AGENT_CONFIG,
  CODER_AGENT_CONFIG,
  DECOMPOSER_AGENT_CONFIG,
  INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG,
  PR_REVIEW_AGENT_CONFIG,
  PR_SPEC_REVIEW_AGENT_CONFIG,
  PR_STANDARDS_REVIEW_AGENT_CONFIG,
  REVIEWER_AGENT_CONFIG,
  REWORK_AGENT_CONFIG,
  REBASE_AGENT_CONFIG,
  SUBTASK_READINESS_AGENT_CONFIG,
  SUBTASK_IMPROVEMENT_AGENT_CONFIG,
  TWO_AXIS_AGENT_CONFIG,
  buildAgentDefinition,
} from "./custom-agent-defs.mts";

test("buildAgentDefinition emits the exact flat-bash coder definition", () => {
  const definition = buildAgentDefinition(
    CODER_AGENT_CONFIG,
    "strix/qwen3.6-35b-a3b-8bit",
    "BODY",
  );

  assert.equal(
    definition,
    `---
description: Implements one scoped PRD issue and commits it
mode: primary
model: strix/qwen3.6-35b-a3b-8bit
temperature: 0.3
permission:
  edit: allow
  bash: allow
  task: deny
  question: deny
  webfetch: deny
  websearch: deny
---

BODY`,
  );
});

test("buildAgentDefinition denies bash for code-quality", () => {
  const definition = buildAgentDefinition(
    CODE_QUALITY_AGENT_CONFIG,
    "zai-coding-plan/glm-5.2",
    "BODY",
  );

  assert.equal(
    definition,
    `---
description: Maintainability gate over the completed PRD branch
mode: primary
model: zai-coding-plan/glm-5.2
temperature: 0.1
permission:
  edit: deny
  bash: deny
  task: deny
  question: deny
  webfetch: deny
  websearch: deny
---

BODY`,
  );
});

test("all configs emit expected values and shared deny permissions", () => {
  const cases = [
    {
      config: CODER_AGENT_CONFIG,
      description: "Implements one scoped PRD issue and commits it",
      temperature: 0.3,
      edit: "allow",
    },
    {
      config: REWORK_AGENT_CONFIG,
      description: "Applies reviewer findings to a rejected issue branch and commits",
      temperature: 0.2,
      edit: "allow",
    },
    {
      config: REVIEWER_AGENT_CONFIG,
      description: "Reviews one issue diff and emits a single verdict block",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: CODE_QUALITY_AGENT_CONFIG,
      description: "Maintainability gate over the completed PRD branch",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: TWO_AXIS_AGENT_CONFIG,
      description: "Standards + spec-fit gate over the completed PRD branch",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: DECOMPOSER_AGENT_CONFIG,
      description: "Turns review findings into follow-up PRD issue drafts",
      temperature: 0.3,
      edit: "deny",
    },
    {
      config: INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG,
      description: "Turns one parent issue into implementation-ready child issue drafts",
      temperature: 0.3,
      edit: "deny",
    },
    {
      config: SUBTASK_READINESS_AGENT_CONFIG,
      description: "Readiness-gates one generated child issue before implementation",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: SUBTASK_IMPROVEMENT_AGENT_CONFIG,
      description: "Read-only evidence-backed improvement of one child issue immediately before coding",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: PR_REVIEW_AGENT_CONFIG,
      description:
        "Fixes host-verified PR review findings, records every disposition, and commits",
      temperature: 0.2,
      edit: "allow",
    },
    {
      config: PR_STANDARDS_REVIEW_AGENT_CONFIG,
      description:
        "Read-only sub-agent: reviews a PR diff against coding standards and the Fowler smell baseline",
      temperature: 0.1,
      edit: "deny",
    },
    {
      config: PR_SPEC_REVIEW_AGENT_CONFIG,
      description:
        "Read-only sub-agent: reviews a PR diff against the PR description and linked issues for spec compliance",
      temperature: 0.1,
      edit: "deny",
    },
  ] as const;

  for (const { config, description, temperature, edit } of cases) {
    const definition = buildAgentDefinition(config, "model/x", "SYSTEM BODY");

    assert.match(definition, new RegExp(`^description: ${escapeRegExp(description)}$`, "m"));
    assert.match(definition, new RegExp(`^temperature: ${temperature}$`, "m"));
    assert.match(definition, new RegExp(`^  edit: ${edit}$`, "m"));
    assert.match(definition, /^  task: deny$/m);
    assert.match(definition, /^  question: deny$/m);
    assert.match(definition, /^  webfetch: deny$/m);
    assert.match(definition, /^  websearch: deny$/m);
    assert.ok(definition.endsWith("\n\nSYSTEM BODY"));
  }
});

test("rebase agent explicitly enables only the pinned rebase skill", () => {
  const definition = buildAgentDefinition(REBASE_AGENT_CONFIG, "model/x", "BODY");
  assert.match(definition, /^  skill:$/m);
  assert.match(definition, /^    "\*": deny$/m);
  assert.match(definition, /^    "rebase-on-main": allow$/m);
  assert.match(definition, /^  edit: allow$/m);
  assert.match(definition, /^  task: deny$/m);
  assert.match(definition, /^    "\*": deny$/m);
  assert.match(definition, /^    "git \*": allow$/m);
  assert.match(definition, /^    "git push \*": deny$/m);
  assert.match(definition, /^    "git fetch \*": deny$/m);
  assert.match(definition, /^    "gh \*": deny$/m);
});

test("subtask improvement bash permission is read-only by default", () => {
  const definition = buildAgentDefinition(
    SUBTASK_IMPROVEMENT_AGENT_CONFIG,
    "model/x",
    "BODY",
  );
  assert.match(definition, /^    "\*": deny$/m);
  assert.match(definition, /^    "git diff \*": allow$/m);
  assert.match(definition, /^    "rg \*": allow$/m);
  assert.doesNotMatch(definition, /^  bash: allow$/m);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
