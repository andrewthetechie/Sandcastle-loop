import { preview } from "./extra-review-parser-utils.mts";
import { validateRebaseAgentResult } from "./structured-result-validators.mts";

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
  const validated = validateRebaseAgentResult(value);
  if (!validated.ok) {
    return {
      ok: false,
      diagnostics: validated.errors.map((error) => error.message).length > 0
        ? validated.errors.map((error) => error.message)
        : [`Invalid rebase result: ${preview(stdout, 400)}`],
    };
  }
  return { ok: true, result: validated.canonical };
}
