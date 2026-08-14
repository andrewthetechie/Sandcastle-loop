import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveStructuredResultRelativePath,
  type StructuredResultPathOptions,
  type StructuredResultStageId,
} from "./structured-result-contracts.mts";
import { validateStructuredResultStage } from "./structured-result-stage-validation.mts";

export type StructuredResultSubmitResponse<T = unknown> =
  | { ok: true; canonical: T }
  | { ok: false; code: string; errors: Array<{ code: string; path: string; message: string }> };

/** Parsers inject `kind` into canonical objects; on-disk files omit it. */
const OMIT_KIND_FROM_RESULT_FILE = new Set<StructuredResultStageId>([
  "code_quality_extra_review",
  "two_axis_extra_review",
  "followup_issues",
]);

export function submitStructuredResult(
  stageId: StructuredResultStageId,
  value: unknown,
  options: StructuredResultPathOptions,
): StructuredResultSubmitResponse {
  const validation = validateStructuredResultStage(
    stageId,
    normalizeSubmitInput(stageId, value),
  );
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      errors: validation.errors,
    };
  }

  const relativePath = resolveStructuredResultRelativePath(stageId, options);
  writeCanonicalStructuredResult(
    options.worktreePath,
    relativePath,
    canonicalForResultFile(stageId, validation.canonical),
  );

  return {
    ok: true,
    canonical: validation.canonical,
  };
}

export function writeCanonicalStructuredResult(
  worktreePath: string,
  relativePath: string,
  canonical: unknown,
  stageId?: StructuredResultStageId,
): void {
  const payload =
    stageId !== undefined
      ? canonicalForResultFile(stageId, canonical)
      : canonical;
  const absolutePath = join(worktreePath, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

function canonicalForResultFile(
  stageId: StructuredResultStageId,
  canonical: unknown,
): unknown {
  if (!OMIT_KIND_FROM_RESULT_FILE.has(stageId) || !isRecord(canonical)) {
    return canonical;
  }
  const { kind: _kind, ...rest } = canonical;
  return rest;
}

function normalizeSubmitInput(
  stageId: StructuredResultStageId,
  value: unknown,
): unknown {
  if (!OMIT_KIND_FROM_RESULT_FILE.has(stageId) || !isRecord(value)) {
    return value;
  }
  if (!("kind" in value)) {
    return value;
  }
  const { kind: _kind, ...rest } = value;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatStructuredResultSubmitResponse(
  response: StructuredResultSubmitResponse,
): string {
  if (response.ok) {
    return JSON.stringify({
      ok: true,
      canonical: response.canonical,
    });
  }
  return JSON.stringify({
    ok: false,
    code: response.code,
    errors: response.errors,
  });
}
