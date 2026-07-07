export async function runVerifiedHostMutation<T>(input: {
  maxAttempts?: number;
  mutate(): Promise<void> | void;
  readBack(): Promise<T> | T;
  verify(value: T): boolean;
  describe(value: T): string;
}): Promise<
  | { ok: true; attemptsUsed: number; value: T; diagnostics: string[] }
  | { ok: false; attemptsUsed: number; diagnostics: string[] }
> {
  const maxAttempts = input.maxAttempts ?? 3;
  const diagnostics: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await input.mutate();
    } catch (err) {
      diagnostics.push(
        `attempt ${attempt}: mutate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    let value: T;
    try {
      value = await input.readBack();
    } catch (err) {
      diagnostics.push(
        `attempt ${attempt}: read-back failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const description = input.describe(value);
    if (input.verify(value)) {
      diagnostics.push(`attempt ${attempt}: verified ${description}`);
      return { ok: true, attemptsUsed: attempt, value, diagnostics };
    }

    diagnostics.push(`attempt ${attempt}: verification mismatch: ${description}`);
  }

  return { ok: false, attemptsUsed: maxAttempts, diagnostics };
}
