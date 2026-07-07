/** Reads one optional CLI string flag in either `--flag value` or `--flag=value` form. */
export function readCliStringFlag(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const equalsPrefix = `${flag}=`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      values.push(value);
      index++;
      continue;
    }
    if (argument?.startsWith(equalsPrefix)) {
      const value = argument.slice(equalsPrefix.length);
      if (!value) throw new Error(`Missing value for ${flag}`);
      values.push(value);
    }
  }

  if (values.length > 1) {
    throw new Error(`${flag} specified more than once`);
  }
  return values[0];
}
