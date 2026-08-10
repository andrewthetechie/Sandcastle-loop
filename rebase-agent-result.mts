import { preview } from "./extra-review-parser-utils.mts";

export interface RebaseAgentResult {
  kind: "rebase_result";
  outcome: "resolved" | "unresolved";
  pre_rebase_sha: string;
  target_mainline_sha: string;
  rebased_sha: string;
  conflicted_files: string[];
  resolution_summaries: string[];
  validation: string[];
  diagnostics: string[];
}

export function parseRebaseAgentResult(stdout: string):
  | { ok: true; result: RebaseAgentResult }
  | { ok: false; diagnostics: string[] } {
  const matches = [...stdout.matchAll(/<rebase_result>([\s\S]*?)<\/rebase_result>/g)];
  if (matches.length !== 1 || stdout.replace(/<rebase_result>[\s\S]*?<\/rebase_result>/g, "").trim() !== "") {
    return { ok: false, diagnostics: ["Expected exactly one standalone <rebase_result> JSON block."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(matches[0]![1]!.trim());
  } catch (error) {
    return { ok: false, diagnostics: [`Malformed rebase result JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(value)) return { ok: false, diagnostics: ["Rebase result must be a JSON object."] };
  const keys = [
    "kind", "outcome", "pre_rebase_sha", "target_mainline_sha", "rebased_sha",
    "conflicted_files", "resolution_summaries", "validation", "diagnostics",
  ];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    return { ok: false, diagnostics: ["Rebase result must contain exactly the required keys."] };
  }
  const string = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] as string : undefined;
  const array = (key: string): string[] | undefined =>
    Array.isArray(value[key]) && (value[key] as unknown[]).every((item) => typeof item === "string")
      ? value[key] as string[]
      : undefined;
  const kind = string("kind");
  const outcome = string("outcome");
  const pre = string("pre_rebase_sha");
  const target = string("target_mainline_sha");
  const rebased = string("rebased_sha");
  const conflicted = array("conflicted_files");
  const summaries = array("resolution_summaries");
  const validation = array("validation");
  const diagnostics = array("diagnostics");
  if (
    kind !== "rebase_result" ||
    (outcome !== "resolved" && outcome !== "unresolved") ||
    !isSha(pre) ||
    !isSha(target) ||
    rebased === undefined ||
    !conflicted || !summaries || !validation || !diagnostics
  ) {
    return { ok: false, diagnostics: [`Invalid rebase result: ${preview(stdout, 400)}`] };
  }
  if (
    outcome === "resolved" &&
    (!isSha(rebased) || conflicted.length === 0 || summaries.length === 0 || validation.length === 0)
  ) {
    return {
      ok: false,
      diagnostics: [
        "Resolved rebase result needs a rebased SHA, conflicted files, resolution summaries, and validation results.",
      ],
    };
  }
  if (outcome === "unresolved" && (rebased !== "" || diagnostics.length === 0)) {
    return { ok: false, diagnostics: ["Unresolved rebase result needs empty rebased_sha and diagnostics."] };
  }
  return {
    ok: true,
    result: {
      kind, outcome, pre_rebase_sha: pre, target_mainline_sha: target,
      rebased_sha: rebased, conflicted_files: conflicted,
      resolution_summaries: summaries, validation, diagnostics,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/iu.test(value);
}
