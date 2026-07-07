import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Preserve a runner's inherited host environment while making user-installed
 * command-line tools available when the loop was launched by a non-login
 * service (whose PATH commonly omits ~/.local/bin).
 */
export function createHostCommandEnv(input: {
  processEnv: NodeJS.ProcessEnv;
  configuredEnv: Record<string, string>;
  homeDirectory?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.processEnv,
    ...input.configuredEnv,
  };
  const userLocalBin = join(input.homeDirectory ?? homedir(), ".local", "bin");
  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  if (!pathEntries.includes(userLocalBin)) {
    env.PATH = [userLocalBin, ...pathEntries].join(delimiter);
  }
  return env;
}
