export function aggregateDependencySetupCommands(input: {
  hasPackageLock: boolean;
  hasUvLock: boolean;
}): string[] {
  const commands: string[] = [];
  if (input.hasPackageLock) commands.push("npm ci");
  if (input.hasUvLock) commands.push("uv sync --frozen");
  return commands;
}
