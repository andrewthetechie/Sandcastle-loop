export const REQUIRED_READINESS_SECTIONS = [
  "User Story",
  "Context",
  "Files",
  "Acceptance Criteria",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function bodyHasRequiredSections(body: string): boolean {
  return REQUIRED_READINESS_SECTIONS.every((name) =>
    new RegExp(`(^|\\n)## ${escapeRegExp(name)}(\\n|$)`, "u").test(body),
  );
}

export function sectionBody(body: string, heading: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\n)## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  const match = pattern.exec(body);
  return match?.[1]?.trim() ?? null;
}

function extractProvenanceFiles(body: string): string[] {
  const prov = sectionBody(body, "Provenance");
  if (!prov) return [];
  return [...prov.matchAll(/`([^`]+)`/gu)]
    .map((m) => (m[1] ?? "").trim())
    .filter((f) => f.includes("/") || f.includes("\\"));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function extractFilesFromBody(body: string): string[] {
  const filesSection = sectionBody(body, "Files");
  if (!filesSection) return extractProvenanceFiles(body);
  const fromSection = [...filesSection.matchAll(/^\s*-\s+`?([^`\n]+?)`?\s*$/gmu)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return unique(fromSection);
}

export function formatCompactSiblingSummary(sibling: {
  number: number;
  title: string;
  body: string;
}): string {
  const files = extractFilesFromBody(sibling.body);
  const context = sectionBody(sibling.body, "Context") ?? sibling.body;
  const oneLine =
    context
      .split(/\n+/u)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"))
      ?.replace(/\s+/gu, " ")
      .slice(0, 160) ?? "";
  return [
    `#${sibling.number}: ${sibling.title}`,
    `files: ${files.length > 0 ? files.join(", ") : "(none listed)"}`,
    `scope: ${oneLine}`,
  ].join("\n");
}
