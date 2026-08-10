import {
  type AgentAttemptArtifact,
  type ExhaustedAcquisitionFailure,
  type InitialDecompositionAcquisition,
  type InitialIssueDecomposition,
  type InitialIssueDecompositionParseFailure,
  type SubtaskReadinessAcquisition,
  type SubtaskReadinessParseFailure,
  type SubtaskReadinessResult,
  type SubtaskImprovementAcquisition,
  type SubtaskImprovementParseFailure,
  type SubtaskImprovementResult,
} from "./issue-as-prd-contracts.mts";
import {
  parseInitialIssueDecomposition,
  parseSubtaskReadiness,
  parseSubtaskImprovement,
} from "./issue-as-prd-parsers.mts";
import {
  recordMeasuredAgentRun,
  type RecordMeasuredAgentRunDeps,
} from "./metrics-recorder.mts";
import { tuiWorkingLogPath } from "./tui-status.mts";
import { fileURLToPath } from "node:url";

export const INITIAL_ISSUE_DECOMPOSER_STAGE = "initial_issue_decomposer";
export const SUBTASK_READINESS_STAGE = "subtask_readiness";
export const SUBTASK_IMPROVEMENT_STAGE = "subtask_improvement";
export const ISSUE_AS_PRD_MAX_ATTEMPTS = 2;

export const INITIAL_ISSUE_DECOMPOSER_USER_PROMPT_FILE =
  fileURLToPath(new URL("./initial-issue-decomposer-user-prompt-prd.md", import.meta.url));
export const SUBTASK_READINESS_USER_PROMPT_FILE =
  fileURLToPath(new URL("./subtask-readiness-user-prompt-prd.md", import.meta.url));
export const SUBTASK_IMPROVEMENT_USER_PROMPT_FILE =
  fileURLToPath(new URL("./subtask-improvement-user-prompt-prd.md", import.meta.url));

export function extractSingleTaggedOutput(
  logText: string,
  tag: "initial_issue_decomposition" | "subtask_readiness" | "subtask_improvement" | "rebase_result",
): string | undefined {
  const currentRunStart = logText.lastIndexOf("--- Run started:");
  const currentRunLog = currentRunStart === -1
    ? logText
    : logText.slice(currentRunStart);
  const matches = [...currentRunLog.matchAll(
    new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"),
  )];
  return matches.length === 1 ? matches[0]![0]!.trim() : undefined;
}

export interface IssueAsPrdAttemptResult {
  stdout: string;
}

export interface AcquireInitialDecompositionInput {
  prd: number | string;
  parentIssueNumber: number;
  model: string;
  round: number | string;
  worktreePath?: string;
  promptFile: string;
  promptArgs: Record<string, string>;
  runAttempt(attempt: 1 | 2): Promise<IssueAsPrdAttemptResult>;
  measuredRunDeps?: RecordMeasuredAgentRunDeps;
  workingLogPathForAttempt?: (attempt: 1 | 2) => string | undefined;
}

export interface AcquireSubtaskReadinessInput {
  prd: number | string;
  childIssueNumber: number;
  model: string;
  round: number | string;
  worktreePath?: string;
  promptFile: string;
  promptArgs: Record<string, string>;
  runAttempt(attempt: 1 | 2): Promise<IssueAsPrdAttemptResult>;
  measuredRunDeps?: RecordMeasuredAgentRunDeps;
  workingLogPathForAttempt?: (attempt: 1 | 2) => string | undefined;
}

export interface AcquireSubtaskImprovementInput extends AcquireSubtaskReadinessInput {
  validateResult?(result: SubtaskImprovementResult): string[];
}

export async function acquireInitialDecomposition(
  input: AcquireInitialDecompositionInput,
): Promise<InitialDecompositionAcquisition> {
  return acquireWithRetries<
    InitialIssueDecomposition,
    InitialIssueDecompositionParseFailure
  >({
    prd: input.prd,
    issue: input.parentIssueNumber,
    model: input.model,
    round: input.round,
    worktreePath: input.worktreePath,
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    stage: INITIAL_ISSUE_DECOMPOSER_STAGE,
    runName: (attempt) =>
      buildInitialIssueDecomposerRunName(input.parentIssueNumber, attempt),
    workingLogPathForAttempt:
      input.workingLogPathForAttempt ??
      ((attempt) =>
        initialIssueDecomposerWorkingLogPath(
          input.parentIssueNumber,
          attempt,
        )),
    measuredRunDeps: input.measuredRunDeps,
    runAttempt: input.runAttempt,
    parse: parseInitialIssueDecomposition,
    accept(result, artifact, diagnostics) {
      if (result.status === "needs_human_review") {
        const detail = [
          "returned needs_human_review",
          result.needs_human_review_reason
            ? `reason: ${result.needs_human_review_reason}`
            : null,
        ]
          .filter(Boolean)
          .join("; ");
        artifact.diagnostics.push(detail);
        diagnostics.push(detail);
        return { accept: false };
      }
      return { accept: true, result };
    },
  });
}

export async function acquireSubtaskReadiness(
  input: AcquireSubtaskReadinessInput,
): Promise<SubtaskReadinessAcquisition> {
  return acquireWithRetries<
    SubtaskReadinessResult,
    SubtaskReadinessParseFailure
  >({
    prd: input.prd,
    issue: input.childIssueNumber,
    model: input.model,
    round: input.round,
    worktreePath: input.worktreePath,
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    stage: SUBTASK_READINESS_STAGE,
    runName: (attempt) =>
      buildSubtaskReadinessRunName(input.childIssueNumber, attempt),
    workingLogPathForAttempt:
      input.workingLogPathForAttempt ??
      ((attempt) =>
        subtaskReadinessWorkingLogPath(input.childIssueNumber, attempt)),
    measuredRunDeps: input.measuredRunDeps,
    runAttempt: input.runAttempt,
    parse: parseSubtaskReadiness,
    accept(result) {
      return { accept: true, result };
    },
  });
}

export async function acquireSubtaskImprovement(
  input: AcquireSubtaskImprovementInput,
): Promise<SubtaskImprovementAcquisition> {
  return acquireWithRetries<
    SubtaskImprovementResult,
    SubtaskImprovementParseFailure
  >({
    prd: input.prd,
    issue: input.childIssueNumber,
    model: input.model,
    round: input.round,
    worktreePath: input.worktreePath,
    promptFile: input.promptFile,
    promptArgs: input.promptArgs,
    stage: SUBTASK_IMPROVEMENT_STAGE,
    runName: (attempt) => buildSubtaskImprovementRunName(input.childIssueNumber, attempt),
    workingLogPathForAttempt:
      input.workingLogPathForAttempt ??
      ((attempt) => subtaskImprovementWorkingLogPath(input.childIssueNumber, attempt)),
    measuredRunDeps: input.measuredRunDeps,
    runAttempt: input.runAttempt,
    parse: parseSubtaskImprovement,
    accept(result, artifact, diagnostics) {
      const resultDiagnostics = input.validateResult?.(result) ?? [];
      if (resultDiagnostics.length > 0) {
        const detail = `improvement contract failure: ${resultDiagnostics.join("; ")}`;
        artifact.diagnostics.push(detail);
        diagnostics.push(detail);
        return { accept: false };
      }
      return { accept: true, result };
    },
  });
}

export function buildInitialIssueDecomposerRunName(
  parentIssueNumber: number,
  attempt: 1 | 2,
): string {
  return `initial issue decomposer #${parentIssueNumber} a${attempt}`;
}

export function buildSubtaskReadinessRunName(
  childIssueNumber: number,
  attempt: 1 | 2,
): string {
  return `subtask readiness #${childIssueNumber} a${attempt}`;
}

export function buildSubtaskImprovementRunName(
  childIssueNumber: number,
  attempt: 1 | 2,
): string {
  return `subtask improvement #${childIssueNumber} a${attempt}`;
}

export function initialIssueDecomposerWorkingLogPath(
  parentIssueNumber: number,
  attempt: 1 | 2,
  cwd?: string,
): string {
  return tuiWorkingLogPath(
    buildInitialIssueDecomposerRunName(parentIssueNumber, attempt),
    cwd,
  );
}

export function subtaskReadinessWorkingLogPath(
  childIssueNumber: number,
  attempt: 1 | 2,
  cwd?: string,
): string {
  return tuiWorkingLogPath(
    buildSubtaskReadinessRunName(childIssueNumber, attempt),
    cwd,
  );
}

export function subtaskImprovementWorkingLogPath(
  childIssueNumber: number,
  attempt: 1 | 2,
  cwd?: string,
): string {
  return tuiWorkingLogPath(buildSubtaskImprovementRunName(childIssueNumber, attempt), cwd);
}

async function acquireWithRetries<
  Result,
  ParseFailure extends {
    kind: "parse_failure";
    parse_failure: {
      parser: string;
      code: string;
      summary: string;
      details: Array<{ path: string; message: string }>;
    };
  },
>(input: {
  prd: number | string;
  issue: number;
  model: string;
  round: number | string;
  worktreePath?: string;
  promptFile: string;
  promptArgs: Record<string, string>;
  stage: string;
  runName(attempt: 1 | 2): string;
  workingLogPathForAttempt(attempt: 1 | 2): string | undefined;
  measuredRunDeps?: RecordMeasuredAgentRunDeps;
  runAttempt(attempt: 1 | 2): Promise<IssueAsPrdAttemptResult>;
  parse(stdout: string): Result | ParseFailure;
  accept(
    result: Result,
    artifact: AgentAttemptArtifact,
    diagnostics: string[],
  ): { accept: true; result: Result } | { accept: false };
}): Promise<
  | {
      ok: true;
      result: Result;
      attemptsUsed: 1 | 2;
      artifacts: [AgentAttemptArtifact] | [AgentAttemptArtifact, AgentAttemptArtifact];
      diagnostics: string[];
    }
  | ExhaustedAcquisitionFailure
> {
  const artifacts: AgentAttemptArtifact[] = [];
  const diagnostics: string[] = [];

  for (const attempt of [1, 2] as const) {
    const logFilePath = input.workingLogPathForAttempt(attempt);
    try {
      const runResult = await recordMeasuredAgentRun(
        {
          prd: input.prd,
          issue: input.issue,
          stage: input.stage,
          agent: input.stage,
          round: `${input.round}-a${attempt}`,
          model: input.model,
          runName: input.runName(attempt),
          worktreePath: input.worktreePath,
          promptFile: input.promptFile,
          promptArgs: input.promptArgs,
          activeLogPath: logFilePath,
        },
        () => input.runAttempt(attempt),
        input.measuredRunDeps,
      );

      const artifact: AgentAttemptArtifact = {
        attempt,
        stdout: runResult.stdout,
        diagnostics: [],
        logFilePath,
      };
      artifacts.push(artifact);

      const parsed = input.parse(runResult.stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "kind" in parsed &&
        parsed.kind === "parse_failure"
      ) {
        const detail = summarizeParseFailure(parsed.parse_failure);
        artifact.diagnostics.push(detail);
        diagnostics.push(detail);
      } else {
        const accepted = input.accept(parsed as Result, artifact, diagnostics);
        if (accepted.accept) {
          return {
            ok: true,
            result: accepted.result,
            attemptsUsed: attempt,
            artifacts:
              attempt === 1
                ? [artifacts[0]!]
                : [artifacts[0]!, artifacts[1]!],
            diagnostics,
          };
        }
      }
    } catch (err) {
      const message = `invocation error: ${err instanceof Error ? err.message : String(err)}`;
      diagnostics.push(message);
      artifacts.push({
        attempt,
        stdout: "",
        diagnostics: [message],
        logFilePath,
      });
    }
  }

  return {
    ok: false,
    attemptsUsed: 2,
    artifacts: [artifacts[0]!, artifacts[1]!],
    diagnostics,
  };
}

function summarizeParseFailure(input: {
  parser: string;
  code: string;
  summary: string;
  details: Array<{ path: string; message: string }>;
}): string {
  const first = input.details[0];
  return [
    `parse failure: ${input.parser}`,
    `code: ${input.code}`,
    input.summary,
    first ? `${first.path}: ${first.message}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}
