export type CustomAgentPermissionValue = "allow" | "deny";

export type CustomAgentBashPermission =
  | CustomAgentPermissionValue
  | Array<[pattern: string, decision: CustomAgentPermissionValue]>;

export interface CustomAgentPermission {
  edit: CustomAgentPermissionValue;
  bash: CustomAgentBashPermission;
  task: CustomAgentPermissionValue;
  question: CustomAgentPermissionValue;
  webfetch: CustomAgentPermissionValue;
  websearch: CustomAgentPermissionValue;
  skill?: Record<string, CustomAgentPermissionValue>;
}

export interface CustomAgentConfig {
  name: string;
  description: string;
  temperature: number;
  permission: CustomAgentPermission;
}

const DENY_ONLY_PERMISSION = {
  task: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
} as const;

export const CODER_AGENT_CONFIG: CustomAgentConfig = {
  name: "coder",
  description: "Implements one scoped PRD issue and commits it",
  temperature: 0.3,
  permission: {
    edit: "allow",
    bash: "allow",
    ...DENY_ONLY_PERMISSION,
  },
};

export const REWORK_AGENT_CONFIG: CustomAgentConfig = {
  name: "rework",
  description: "Applies reviewer findings to a rejected issue branch and commits",
  temperature: 0.2,
  permission: {
    edit: "allow",
    bash: "allow",
    ...DENY_ONLY_PERMISSION,
  },
};

export const REVIEWER_AGENT_CONFIG: CustomAgentConfig = {
  name: "reviewer",
  description: "Reviews one issue diff and emits a single verdict block",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const CODE_QUALITY_AGENT_CONFIG: CustomAgentConfig = {
  name: "code-quality",
  description: "Maintainability gate over the completed PRD branch",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const TWO_AXIS_AGENT_CONFIG: CustomAgentConfig = {
  name: "two-axis",
  description: "Standards + spec-fit gate over the completed PRD branch",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const DECOMPOSER_AGENT_CONFIG: CustomAgentConfig = {
  name: "decomposer",
  description: "Turns review findings into follow-up PRD issue drafts",
  temperature: 0.3,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG: CustomAgentConfig = {
  name: "initial-issue-decomposer",
  description: "Turns one parent issue into implementation-ready child issue drafts",
  temperature: 0.3,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const SUBTASK_READINESS_AGENT_CONFIG: CustomAgentConfig = {
  name: "subtask-readiness",
  description: "Readiness-gates one generated child issue before implementation",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const SUBTASK_IMPROVEMENT_AGENT_CONFIG: CustomAgentConfig = {
  name: "subtask-improvement",
  description: "Read-only evidence-backed improvement of one child issue immediately before coding",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: [
      ["*", "deny"],
      ["git status", "allow"],
      ["git status *", "allow"],
      ["git log *", "allow"],
      ["git show *", "allow"],
      ["git diff *", "allow"],
      ["git grep *", "allow"],
      ["git rev-parse *", "allow"],
      ["git merge-base *", "allow"],
      ["rg *", "allow"],
      ["grep *", "allow"],
      ["find *", "allow"],
      ["ls", "allow"],
      ["ls *", "allow"],
      ["npm test", "allow"],
      ["npm test *", "allow"],
      ["npm run test", "allow"],
      ["npm run test *", "allow"],
    ],
    ...DENY_ONLY_PERMISSION,
  },
};

export const REBASE_AGENT_CONFIG: CustomAgentConfig = {
  name: "rebase",
  description: "Resolves one local accumulation rebase without remote or tracker mutation",
  temperature: 0.1,
  permission: {
    edit: "allow",
    bash: [
      ["*", "deny"],
      ["git *", "allow"],
      ["git push", "deny"],
      ["git push *", "deny"],
      ["git fetch", "deny"],
      ["git fetch *", "deny"],
      ["git pull", "deny"],
      ["git pull *", "deny"],
      ["git clone *", "deny"],
      ["git ls-remote *", "deny"],
      ["git remote update *", "deny"],
      ["git archive --remote *", "deny"],
      ["gh", "deny"],
      ["gh *", "deny"],
      ["curl *", "deny"],
      ["wget *", "deny"],
      ["ssh *", "deny"],
      ["scp *", "deny"],
      ["npm test", "allow"],
      ["npm test *", "allow"],
      ["npm run test", "allow"],
      ["npm run test *", "allow"],
      ["npm run typecheck", "allow"],
      ["npm run build", "allow"],
      ["pnpm test", "allow"],
      ["pnpm test *", "allow"],
      ["yarn test", "allow"],
      ["yarn test *", "allow"],
      ["bun test", "allow"],
      ["bun test *", "allow"],
      ["pytest *", "allow"],
      ["uv run pytest *", "allow"],
      ["cargo test *", "allow"],
      ["cargo check *", "allow"],
      ["go test *", "allow"],
    ],
    ...DENY_ONLY_PERMISSION,
    skill: { "*": "deny", "rebase-on-main": "allow" },
  },
};

// ---------------------------------------------------------------------------
// PR Review agents (run-pr-review-v1.mts)
// ---------------------------------------------------------------------------

export const PR_REVIEW_AGENT_CONFIG: CustomAgentConfig = {
  name: "pr-review",
  description:
    "Fixes host-verified PR review findings, records every disposition, and commits",
  temperature: 0.2,
  permission: {
    edit: "allow",
    bash: "allow",
    task: "deny",
    question: "deny",
    webfetch: "deny",
    websearch: "deny",
  },
};

export const PR_STANDARDS_REVIEW_AGENT_CONFIG: CustomAgentConfig = {
  name: "pr-standards-review",
  description:
    "Read-only sub-agent: reviews a PR diff against coding standards and the Fowler smell baseline",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

export const PR_SPEC_REVIEW_AGENT_CONFIG: CustomAgentConfig = {
  name: "pr-spec-review",
  description:
    "Read-only sub-agent: reviews a PR diff against the PR description and linked issues for spec compliance",
  temperature: 0.1,
  permission: {
    edit: "deny",
    bash: "deny",
    ...DENY_ONLY_PERMISSION,
  },
};

function buildBashPermission(bash: CustomAgentBashPermission): string[] {
  if (typeof bash === "string") {
    return [`  bash: ${bash}`];
  }

  return ["  bash:", ...bash.map(([pattern, decision]) => `    "${pattern}": ${decision}`)];
}

export function buildAgentDefinition(
  config: CustomAgentConfig,
  model: string,
  systemBody: string,
): string {
  const lines = [
    "---",
    `description: ${config.description}`,
    "mode: primary",
    `model: ${model}`,
    `temperature: ${config.temperature}`,
    "permission:",
    `  edit: ${config.permission.edit}`,
    ...buildBashPermission(config.permission.bash),
    `  task: ${config.permission.task}`,
    `  question: ${config.permission.question}`,
    `  webfetch: ${config.permission.webfetch}`,
    `  websearch: ${config.permission.websearch}`,
    ...(config.permission.skill
      ? [
          "  skill:",
          ...Object.entries(config.permission.skill).map(
            ([name, decision]) => `    \"${name}\": ${decision}`,
          ),
        ]
      : []),
    "---",
    "",
    systemBody,
  ];

  return lines.join("\n");
}
