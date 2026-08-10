import { dirname, posix } from "node:path";

const ROOT_STANDARD_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "CONTRIBUTING.md",
  "CODING_STANDARDS.md",
  "CODE_STYLE.md",
  "STYLE_GUIDE.md",
  "DEVELOPMENT.md",
]);

const SCOPED_INSTRUCTION_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
]);

const WELL_KNOWN_STANDARD_PATHS = new Set([
  ".github/CONTRIBUTING.md",
  "docs/architecture.md",
  "docs/conventions.md",
  "docs/development.md",
]);

const STANDARD_DOCUMENT_PATTERN =
  /(?:^|[-_.])(standards?|conventions?|guidelines?|style[-_]?guide)(?:[-_.]|$)/i;

/**
 * Select the repository-owned instruction files that govern the changed paths.
 * The host writes this explicit list into the review manifest so the Standards
 * specialist spends its context applying rules instead of rediscovering them.
 */
export function discoverPrReviewStandardsFiles(
  repositoryFiles: readonly string[],
  changedFiles: readonly string[],
): string[] {
  const governingDirectories = new Set<string>(["."]);
  for (const changedFile of changedFiles) {
    let current = normalizePath(posix.dirname(normalizePath(changedFile)));
    while (current !== ".") {
      governingDirectories.add(current);
      const parent = normalizePath(dirname(current));
      if (parent === current) break;
      current = parent;
    }
  }

  return [...new Set(repositoryFiles.map(normalizePath))]
    .filter((file) => {
      if (WELL_KNOWN_STANDARD_PATHS.has(file)) return true;
      const directory = normalizePath(posix.dirname(file));
      const base = posix.basename(file);
      if (directory === "." && ROOT_STANDARD_NAMES.has(base)) return true;
      if (
        (governingDirectories.has(directory) ||
          directory === "docs" ||
          directory.startsWith("docs/")) &&
        /\.(md|mdx|rst|adoc|txt)$/i.test(base) &&
        STANDARD_DOCUMENT_PATTERN.test(base)
      ) {
        return true;
      }
      return (
        governingDirectories.has(directory) &&
        SCOPED_INSTRUCTION_NAMES.has(base)
      );
    })
    .sort();
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length === 0 ? "." : normalized;
}
