import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE_QUALITY_AGENT_CONFIG,
  CODER_AGENT_CONFIG,
  DECOMPOSER_AGENT_CONFIG,
  INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG,
  REVIEWER_AGENT_CONFIG,
  REWORK_AGENT_CONFIG,
  SUBTASK_READINESS_AGENT_CONFIG,
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

test("all eight configs emit expected values and shared deny permissions", () => {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
