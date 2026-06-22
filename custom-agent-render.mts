export function renderSlimMessage(
  templateText: string,
  args: Record<string, string>,
): string {
  const placeholders = [...templateText.matchAll(/{{([^{}]+)}}/g)].map(
    (match) => match[1]!,
  );

  for (const key of placeholders) {
    if (!(key in args)) {
      throw new Error(`Missing placeholder: ${key}`);
    }
  }

  return templateText.replace(/{{([^{}]+)}}/g, (_match, key: string) => args[key]!);
}
