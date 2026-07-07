declare module "@ai-hero/sandcastle" {
  export interface LoggingOption {
    type: "file" | string;
    [key: string]: unknown;
  }

  export interface SandcastleRunResult {
    stdout: string;
    commits: unknown[];
  }

  export interface SandcastleAgent {
    model: string;
    name?: string;
  }

  export function opencode(
    model: string,
    options?: string | { agent?: string },
  ): SandcastleAgent;

  export interface SandcastleSandbox {
    worktreePath: string;
    run(input: any): Promise<SandcastleRunResult>;
    close(): Promise<void>;
  }

  export function createAgent(model: string, name?: string): SandcastleAgent;
  export function createSandbox(input: Record<string, unknown>): Promise<SandcastleSandbox>;
}

declare module "@ai-hero/sandcastle/sandboxes/docker" {
  export function docker(input?: Record<string, unknown>): unknown;
}
