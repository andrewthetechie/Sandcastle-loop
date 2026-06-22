export type CustomAgentPermissionValue = "allow" | "deny";

export type CustomAgentBashPermission =
  | CustomAgentPermissionValue
  | Array<[pattern: string, decision: CustomAgentPermissionValue]>;

export interface CustomAgentPermission {
  edit: CustomAgentPermissionValue;
  bash: CustomAgentBashPermission;
  task: "deny";
  question: "deny";
  webfetch: "deny";
  websearch: "deny";
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
    "---",
    "",
    systemBody,
  ];

  return lines.join("\n");
}
