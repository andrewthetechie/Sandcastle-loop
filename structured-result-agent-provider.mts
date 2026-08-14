import {
  STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV,
  buildStructuredResultMcpAgentEnv,
  type StructuredResultMcpConfigOptions,
} from "./structured-result-mcp-install.mts";

export interface StructuredResultPrintCommand {
  command: string;
  stdin?: string;
  [key: string]: unknown;
}

export interface StructuredResultCommandAgentProvider {
  readonly env?: Record<string, string>;
  buildPrintCommand(input: unknown): StructuredResultPrintCommand;
}

/**
 * Decorate an OpenCode provider so invocation-local MCP config survives
 * Sandcastle's reusable `createSandbox().run()` path.
 *
 * Sandcastle 0.12 starts a reusable sandbox before it knows which agent will
 * run, then invokes only the provider's built command. That path does not pass
 * `provider.env` to `sandbox.exec`, so the config must be attached to the
 * command that launches OpenCode. Coder and rework providers are not wrapped.
 */
export function withStructuredResultMcpAgent<
  T extends StructuredResultCommandAgentProvider,
>(
  agent: T,
  options: StructuredResultMcpConfigOptions = {},
): T {
  const structuredEnv = buildStructuredResultMcpAgentEnv(options);
  const configContent = structuredEnv[
    STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV
  ]!;
  const baseBuildPrintCommand = agent.buildPrintCommand.bind(agent);
  const remainingEnv = { ...(agent.env ?? {}) };
  delete remainingEnv[STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV];

  return {
    ...agent,
    env: remainingEnv,
    buildPrintCommand(input: unknown): StructuredResultPrintCommand {
      const printCommand = baseBuildPrintCommand(input);
      return {
        ...printCommand,
        command:
          `${STRUCTURED_RESULT_MCP_OPENCODE_CONTENT_ENV}=${quoteShellWord(configContent)} ${printCommand.command}`,
      };
    },
  } as T;
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
