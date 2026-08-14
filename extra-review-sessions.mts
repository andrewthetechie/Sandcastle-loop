import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveExtraReviewRoundArtifactPaths,
  writeExtraReviewRoundArtifacts,
  type ExtraReviewPrdArtifactIdentity,
  type ExtraReviewRoundArtifactIdentity,
  type ExtraReviewRoundArtifactInput,
  type ExtraReviewRoundArtifactPaths,
  type ExtraReviewRoundOutputArtifacts,
  type ExtraReviewRoundStopReason,
  type ExtraReviewRoundWriteResult,
} from "./extra-review-artifacts.mts";
import type { ExtraReviewInputMetadata } from "./extra-review-inputs.mts";
import {
  clearStructuredResultFromWorktree,
  readCodeQualityExtraReviewFromWorktree,
  readFollowupIssuesFromWorktree,
  readTwoAxisExtraReviewFromWorktree,
} from "./structured-result-acquisition.mts";
import {
  parseCodeQualityExtraReview,
  parseFollowupIssues,
  parseTwoAxisExtraReview,
} from "./extra-review-parsers.mts";
import type { StructuredResultStageId } from "./structured-result-contracts.mts";
import type {
  CodeQualityExtraReviewParseResult,
  ExtraReviewParseFailure,
  FollowupIssuesParseResult,
  TwoAxisExtraReviewParseResult,
} from "./extra-review-contracts.mts";
import {
  EXTRA_CODE_REVIEW_MODEL,
  EXTRA_CODE_REVIEW_PROMPT_FILE,
  EXTRA_DECOMPOSER_MAX_ITERATIONS,
  EXTRA_ISSUE_DECOMPOSER_MODEL,
  EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE,
  EXTRA_REVIEWER_MAX_ITERATIONS,
  EXTRA_TWO_AXIS_REVIEW_MODEL,
  EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE,
} from "./extra-review-config.mts";
import { recordMeasuredAgentRun } from "./metrics-recorder.mts";

export {
  EXTRA_CODE_REVIEW_MODEL,
  EXTRA_CODE_REVIEW_PROMPT_FILE,
  EXTRA_DECOMPOSER_MAX_ITERATIONS,
  EXTRA_ISSUE_DECOMPOSER_MODEL,
  EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE,
  EXTRA_REVIEWER_MAX_ITERATIONS,
  EXTRA_TWO_AXIS_REVIEW_MODEL,
  EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE,
} from "./extra-review-config.mts";

export const DEFAULT_EXTRA_REVIEW_IDLE_TIMEOUT_SECONDS = 1800;

export type ExtraReviewSessionKind =
  | "code_quality"
  | "two_axis"
  | "issue_decomposer";

export interface ExtraReviewSessionDefinition {
  kind: ExtraReviewSessionKind;
  runName: string;
  model: string;
  promptFile: string;
  maxIterations: number;
  completionSignal: string;
}

export const EXTRA_CODE_REVIEW_SESSION: ExtraReviewSessionDefinition = {
  kind: "code_quality",
  runName: "extra code-quality review",
  model: EXTRA_CODE_REVIEW_MODEL,
  promptFile: EXTRA_CODE_REVIEW_PROMPT_FILE,
  maxIterations: EXTRA_REVIEWER_MAX_ITERATIONS,
  completionSignal: "</extra_review>",
};

export const EXTRA_TWO_AXIS_REVIEW_SESSION: ExtraReviewSessionDefinition = {
  kind: "two_axis",
  runName: "extra two-axis review",
  model: EXTRA_TWO_AXIS_REVIEW_MODEL,
  promptFile: EXTRA_TWO_AXIS_REVIEW_PROMPT_FILE,
  maxIterations: EXTRA_REVIEWER_MAX_ITERATIONS,
  completionSignal: "</extra_review>",
};

export const EXTRA_ISSUE_DECOMPOSER_SESSION: ExtraReviewSessionDefinition = {
  kind: "issue_decomposer",
  runName: "extra issue decomposer",
  model: EXTRA_ISSUE_DECOMPOSER_MODEL,
  promptFile: EXTRA_ISSUE_DECOMPOSER_PROMPT_FILE,
  maxIterations: EXTRA_DECOMPOSER_MAX_ITERATIONS,
  completionSignal: "</followup_issues>",
};

export interface ExtraReviewSandboxRunInput {
  name: string;
  agent: unknown;
  maxIterations: number;
  completionSignal?: string;
  idleTimeoutSeconds: number;
  promptFile: string;
  promptArgs: Record<string, string>;
  /**
   * Optional Sandcastle `LoggingOption` (kept structural as `unknown` so this
   * module stays free of a Sandcastle runtime import). The PRD v4 loop supplies a
   * `{ type: "file", path, onAgentStreamEvent }` here so extra-review agents also
   * produce a Companion-TUI working log.
   */
  logging?: unknown;
}

/**
 * Optional per-session hook the instrumented loop passes so extra-review agents
 * emit a Companion-TUI working log. Returns the working-log path (recorded in the
 * agent-step snapshot) and the Sandcastle `logging` option to feed `sandbox.run`.
 */
export type RunSessionAgentHook = (info: {
  session: ExtraReviewSessionKind;
  runName: string;
  worktreePath: string;
}) => { activeLogPath?: string; logging?: unknown } | undefined;

export interface ExtraReviewSandboxRunResult {
  stdout: string;
  commits?: unknown[];
}

export interface ExtraReviewSandbox {
  worktreePath: string;
  run(input: ExtraReviewSandboxRunInput): Promise<ExtraReviewSandboxRunResult>;
  close(): Promise<void> | void;
}

export interface ExtraReviewSandboxCreateInput {
  branch: string;
  baseBranch: string;
  copyToWorktree?: readonly string[];
  hooks?: unknown;
}

export type ExtraReviewSandboxFactory = (
  input: ExtraReviewSandboxCreateInput,
) => Promise<ExtraReviewSandbox> | ExtraReviewSandbox;

export type ExtraReviewAgentFactory = (
  model: string,
  agentName?: string,
  session?: ExtraReviewSessionKind,
) => unknown;

export type ExtraReviewResultAcquisition =
  | "tagged_stdout"
  | "structured_result_file";

export interface ExtraReviewSessionAgentEntry {
  agentName: string;
  promptFile?: string;
}

export type ExtraReviewDirtyStatusReader = (worktreePath: string) => string;

export type ExtraReviewArtifactWriter = (
  input: ExtraReviewRoundArtifactInput,
) => ExtraReviewRoundWriteResult;

export interface ExtraReviewSessionLogger {
  warn(message: string): void;
}

export interface ExtraReviewSessionInputBundle {
  paths: ExtraReviewRoundArtifactPaths;
  metadata: ExtraReviewInputMetadata;
  writtenFiles?: readonly string[];
}

export interface RunSequentialExtraReviewSessionsInput {
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
  reviewInputs: ExtraReviewSessionInputBundle;
  completedPrdBranch: string;
  sandboxBaseBranch?: string;
  reviewBranch?: string;
  idleTimeoutSeconds?: number;
  copyToWorktree?: readonly string[];
  hooks?: unknown;
  createSandbox: ExtraReviewSandboxFactory;
  createAgent: ExtraReviewAgentFactory;
  /** Frozen callers retain tagged stdout; MCP-wired runners opt in explicitly. */
  resultAcquisition?: ExtraReviewResultAcquisition;
  /**
   * Per-session definition overrides. Any kind omitted falls back to the GLM
   * default (EXTRA_CODE_REVIEW_SESSION / EXTRA_TWO_AXIS_REVIEW_SESSION /
   * EXTRA_ISSUE_DECOMPOSER_SESSION), so existing callers are unaffected.
   */
  sessionDefinitions?: Partial<
    Record<ExtraReviewSessionKind, ExtraReviewSessionDefinition>
  >;
  sessionAgents?: Partial<
    Record<ExtraReviewSessionKind, ExtraReviewSessionAgentEntry>
  >;
  writeAgentDefinition?: (input: {
    worktreePath: string;
    session: ExtraReviewSessionKind;
    agentName: string;
  }) => void;
  readDirtyStatus?: ExtraReviewDirtyStatusReader;
  writeArtifacts?: ExtraReviewArtifactWriter;
  logger?: ExtraReviewSessionLogger;
  /**
   * Optional Companion-TUI working-log hook. Default undefined leaves existing
   * callers (and tests) unchanged.
   */
  onAgentSession?: RunSessionAgentHook;
  maxAcquisitionAttempts?: number;
}

export interface ExtraReviewDirtyWorktreeWarning {
  kind: "dirty_review_worktree";
  session: ExtraReviewSessionKind;
  worktreePath: string;
  status: string;
  message: string;
}

export interface SequentialExtraReviewSessionsResult {
  reviewBranch: string;
  sandboxBaseBranch: string;
  worktreePath: string;
  outputs: ExtraReviewRoundOutputArtifacts;
  dirtyWarnings: ExtraReviewDirtyWorktreeWarning[];
  stopReason: ExtraReviewRoundStopReason;
  stopDetails: string[];
  artifactWrite: ExtraReviewRoundWriteResult;
}

type CodeReviewOutput = {
  raw: string;
  parsed: CodeQualityExtraReviewParseResult;
};
type TwoAxisOutput = {
  raw: string;
  parsed: TwoAxisExtraReviewParseResult;
};
type IssueDecomposerOutput = {
  raw: string;
  parsed: FollowupIssuesParseResult;
};

export async function runSequentialExtraReviewSessions(
  input: RunSequentialExtraReviewSessionsInput,
): Promise<SequentialExtraReviewSessionsResult> {
  const idleTimeoutSeconds =
    input.idleTimeoutSeconds ?? DEFAULT_EXTRA_REVIEW_IDLE_TIMEOUT_SECONDS;
  const reviewBranch =
    input.reviewBranch ??
    defaultExtraReviewBranchName(input.completedPrdBranch, input.round);
  const sandboxBaseBranch = input.sandboxBaseBranch ?? input.completedPrdBranch;
  const writeArtifacts = input.writeArtifacts ?? writeExtraReviewRoundArtifacts;
  const readDirtyStatus = input.readDirtyStatus ?? readGitDirtyStatus;
  const logger = input.logger ?? console;
  const maxAcquisitionAttempts = input.maxAcquisitionAttempts ?? 1;
  const resultAcquisition = input.resultAcquisition ?? "tagged_stdout";

  const definitions: Record<ExtraReviewSessionKind, ExtraReviewSessionDefinition> = {
    code_quality:
      input.sessionDefinitions?.code_quality ?? EXTRA_CODE_REVIEW_SESSION,
    two_axis:
      input.sessionDefinitions?.two_axis ?? EXTRA_TWO_AXIS_REVIEW_SESSION,
    issue_decomposer:
      input.sessionDefinitions?.issue_decomposer ??
      EXTRA_ISSUE_DECOMPOSER_SESSION,
  };

  const outputs: ExtraReviewRoundOutputArtifacts = {};
  const dirtyWarnings: ExtraReviewDirtyWorktreeWarning[] = [];
  let artifactWrite: ExtraReviewRoundWriteResult | undefined;
  let lastWorktreePath = "";

  const checkpoint = (stopReason: ExtraReviewRoundStopReason): void => {
    artifactWrite = writeArtifacts(
      artifactInput(input, outputs, dirtyWarnings, stopReason),
    );
  };

  const createSessionSandbox = async (
    session: ExtraReviewSessionKind,
  ): Promise<ExtraReviewSandbox> => {
    const sandbox = await input.createSandbox({
      branch: defaultExtraReviewSessionBranchName(reviewBranch, session),
      baseBranch: sandboxBaseBranch,
      copyToWorktree: input.copyToWorktree,
      hooks: input.hooks,
    });
    lastWorktreePath = sandbox.worktreePath;
    return sandbox;
  };

  outputs.codeReview = await runSessionWithAcquisitionRetries<CodeReviewOutput>({
    attempts: maxAcquisitionAttempts,
    session: "code_quality",
    createSessionSandbox,
    readDirtyStatus,
    logger,
    warnings: dirtyWarnings,
    ignoredPaths: reviewerSandboxInputPaths(input.reviewInputs),
    isAcceptable: (parsed) =>
      parsed.kind === "extra_review" && parsed.decision !== "needs_human_review",
    onInvocationError: (message): CodeReviewOutput =>
      invocationParseFailure("code_quality", message) as CodeReviewOutput,
    run: async (sandbox, attempt) => {
      syncReviewerInputsToSandbox(sandbox.worktreePath, input.reviewInputs);
      return runCodeQualityReview({
        prd: input.prd,
        round: withAttemptRound(input.round, attempt),
        sandbox,
        createAgent: input.createAgent,
        session: "code_quality",
        agentEntry: input.sessionAgents?.code_quality,
        writeAgentDefinition: input.writeAgentDefinition,
        idleTimeoutSeconds,
        promptArgs: sharedReviewerPromptArgs(input.reviewInputs.metadata),
        definition: withAttemptDefinition(
          definitions.code_quality,
          attempt,
          maxAcquisitionAttempts,
        ),
        resultAcquisition,
        onAgentSession: input.onAgentSession,
      });
    },
  });
  checkpoint("failure");

  outputs.twoAxisReview = await runSessionWithAcquisitionRetries<TwoAxisOutput>({
    attempts: maxAcquisitionAttempts,
    session: "two_axis",
    createSessionSandbox,
    readDirtyStatus,
    logger,
    warnings: dirtyWarnings,
    ignoredPaths: reviewerSandboxInputPaths(input.reviewInputs),
    isAcceptable: (parsed) =>
      parsed.kind === "extra_review" && parsed.decision !== "needs_human_review",
    onInvocationError: (message): TwoAxisOutput =>
      invocationParseFailure("two_axis", message) as TwoAxisOutput,
    run: async (sandbox, attempt) => {
      syncReviewerInputsToSandbox(sandbox.worktreePath, input.reviewInputs);
      return runTwoAxisReview({
        prd: input.prd,
        round: withAttemptRound(input.round, attempt),
        sandbox,
        createAgent: input.createAgent,
        session: "two_axis",
        agentEntry: input.sessionAgents?.two_axis,
        writeAgentDefinition: input.writeAgentDefinition,
        idleTimeoutSeconds,
        promptArgs: sharedReviewerPromptArgs(input.reviewInputs.metadata),
        definition: withAttemptDefinition(
          definitions.two_axis,
          attempt,
          maxAcquisitionAttempts,
        ),
        resultAcquisition,
        onAgentSession: input.onAgentSession,
      });
    },
  });
  checkpoint("failure");

  outputs.issueDecomposer = await runSessionWithAcquisitionRetries<IssueDecomposerOutput>({
    attempts: maxAcquisitionAttempts,
    session: "issue_decomposer",
    createSessionSandbox,
    readDirtyStatus,
    logger,
    warnings: dirtyWarnings,
    ignoredPaths: () => decomposerSandboxInputPaths(input.reviewInputs, outputs),
    isAcceptable: (parsed) =>
      parsed.kind === "followup_issues" && parsed.status !== "needs_human_review",
    onInvocationError: (message): IssueDecomposerOutput =>
      invocationParseFailure("issue_decomposer", message) as IssueDecomposerOutput,
    run: async (sandbox, attempt) => {
      syncDecomposerInputsToSandbox(
        sandbox.worktreePath,
        input.reviewInputs,
        outputs,
      );

      return runIssueDecomposer({
        prd: input.prd,
        round: withAttemptRound(input.round, attempt),
        sandbox,
        createAgent: input.createAgent,
        session: "issue_decomposer",
        agentEntry: input.sessionAgents?.issue_decomposer,
        writeAgentDefinition: input.writeAgentDefinition,
        idleTimeoutSeconds,
        promptArgs: decomposerPromptArgs(
          input.reviewInputs.metadata,
          input.reviewInputs.paths,
        ),
        definition: withAttemptDefinition(
          definitions.issue_decomposer,
          attempt,
          maxAcquisitionAttempts,
        ),
        resultAcquisition,
        onAgentSession: input.onAgentSession,
      });
    },
  });

  const stopReason = decideExtraReviewSessionStopReason(outputs);
  checkpoint(stopReason);

  return {
    reviewBranch,
    sandboxBaseBranch,
    worktreePath: lastWorktreePath,
    outputs,
    dirtyWarnings,
    stopReason,
    stopDetails: stopDetailsForOutputs(outputs, dirtyWarnings),
    artifactWrite: artifactWrite!,
  };
}

export function sharedReviewerPromptArgs(
  metadata: ExtraReviewInputMetadata,
): Record<string, string> {
  return {
    PRD_NUMBER: String(metadata.prd_number),
    PRD_BODY_PATH: metadata.input_files.prd_body,
    REVIEW_METADATA_PATH: metadata.input_files.metadata,
    CHANGED_FILES_PATH: metadata.input_files.changed_files,
    DIFF_STAT_PATH: metadata.input_files.diff_stat,
    DIFF_PATH: metadata.input_files.diff,
    REVIEW_BASE_SHA: metadata.resolved_review_base_sha,
    REVIEWED_HEAD_SHA: metadata.reviewed_head_sha,
    ORIGINAL_REVIEW_BASE: metadata.original_review_base,
  };
}

export function decomposerPromptArgs(
  metadata: ExtraReviewInputMetadata,
  paths: ExtraReviewRoundArtifactPaths,
): Record<string, string> {
  return {
    PRD_NUMBER: String(metadata.prd_number),
    PRD_BODY_PATH: metadata.input_files.prd_body,
    REVIEW_METADATA_PATH: metadata.input_files.metadata,
    CHANGED_FILES_PATH: metadata.input_files.changed_files,
    DIFF_STAT_PATH: metadata.input_files.diff_stat,
    CODE_QUALITY_REVIEW_PATH: paths.files.codeReviewParsed,
    TWO_AXIS_REVIEW_PATH: paths.files.twoAxisReviewParsed,
  };
}

export function decideExtraReviewSessionStopReason(
  outputs: ExtraReviewRoundOutputArtifacts,
): ExtraReviewRoundStopReason {
  if (
    outputs.codeReview?.parsed?.kind === "parse_failure" ||
    outputs.twoAxisReview?.parsed?.kind === "parse_failure" ||
    outputs.issueDecomposer?.parsed?.kind === "parse_failure"
  ) {
    return "parse_failure";
  }

  if (
    (outputs.codeReview?.parsed?.kind === "extra_review" &&
      outputs.codeReview.parsed.decision === "needs_human_review") ||
    (outputs.twoAxisReview?.parsed?.kind === "extra_review" &&
      outputs.twoAxisReview.parsed.decision === "needs_human_review") ||
    (outputs.issueDecomposer?.parsed?.kind === "followup_issues" &&
      outputs.issueDecomposer.parsed.status === "needs_human_review")
  ) {
    return "needs_human_review";
  }

  if (
    outputs.issueDecomposer?.parsed?.kind === "followup_issues" &&
    outputs.issueDecomposer.parsed.status === "no_work"
  ) {
    return "no_work";
  }

  return "success";
}

export function defaultExtraReviewBranchName(
  completedPrdBranch: string,
  round: ExtraReviewRoundArtifactIdentity,
): string {
  const suffix =
    round.id ??
    (round.number !== undefined
      ? `round-${String(round.number).padStart(2, "0")}`
      : "round");
  return `${completedPrdBranch}-extra-review-${safeBranchComponent(suffix)}`;
}

export function defaultExtraReviewSessionBranchName(
  reviewBranch: string,
  session: ExtraReviewSessionKind,
): string {
  return `${reviewBranch}-${safeBranchComponent(formatSessionKind(session))}`;
}

export function readGitDirtyStatus(worktreePath: string): string {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `git status --short exited with status ${result.status}`,
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

export function decomposerSafeMetadata(
  metadata: ExtraReviewInputMetadata,
): Omit<ExtraReviewInputMetadata, "input_files"> & {
  input_files: Omit<ExtraReviewInputMetadata["input_files"], "diff">;
} {
  const { diff: _diff, ...inputFilesWithoutDiff } = metadata.input_files;
  return {
    ...metadata,
    input_files: inputFilesWithoutDiff,
  };
}

function syncReviewerInputsToSandbox(
  worktreePath: string,
  reviewInputs: ExtraReviewSessionInputBundle,
): void {
  copyFilesIntoSandbox(worktreePath, reviewerSandboxInputPaths(reviewInputs));
}

function syncDecomposerInputsToSandbox(
  worktreePath: string,
  reviewInputs: ExtraReviewSessionInputBundle,
  outputs: ExtraReviewRoundOutputArtifacts,
): void {
  copyFilesIntoSandbox(
    worktreePath,
    decomposerCopiedInputPaths(reviewInputs),
  );

  writeSandboxJson(
    worktreePath,
    reviewInputs.metadata.input_files.metadata,
    decomposerSafeMetadata(reviewInputs.metadata),
  );
  if (outputs.codeReview?.parsed !== undefined) {
    writeSandboxJson(
      worktreePath,
      reviewInputs.paths.files.codeReviewParsed,
      outputs.codeReview.parsed,
    );
  }
  if (outputs.twoAxisReview?.parsed !== undefined) {
    writeSandboxJson(
      worktreePath,
      reviewInputs.paths.files.twoAxisReviewParsed,
      outputs.twoAxisReview.parsed,
    );
  }
}

function reviewerSandboxInputPaths(
  reviewInputs: ExtraReviewSessionInputBundle,
): string[] {
  return unique(reviewInputs.writtenFiles ?? []);
}

function decomposerSandboxInputPaths(
  reviewInputs: ExtraReviewSessionInputBundle,
  outputs: ExtraReviewRoundOutputArtifacts,
): string[] {
  return unique([
    ...decomposerCopiedInputPaths(reviewInputs),
    reviewInputs.metadata.input_files.metadata,
    ...(outputs.codeReview?.parsed !== undefined
      ? [reviewInputs.paths.files.codeReviewParsed]
      : []),
    ...(outputs.twoAxisReview?.parsed !== undefined
      ? [reviewInputs.paths.files.twoAxisReviewParsed]
      : []),
  ]);
}

function decomposerCopiedInputPaths(
  reviewInputs: ExtraReviewSessionInputBundle,
): string[] {
  const allowedInputFiles = new Set([
    reviewInputs.metadata.input_files.prd_body,
    reviewInputs.metadata.input_files.changed_files,
    reviewInputs.metadata.input_files.diff_stat,
  ]);
  return (reviewInputs.writtenFiles ?? []).filter((file) =>
    allowedInputFiles.has(file),
  );
}

function copyFilesIntoSandbox(
  worktreePath: string,
  artifactPaths: readonly string[],
): void {
  for (const artifactPath of unique(artifactPaths)) {
    writeSandboxText(
      worktreePath,
      artifactPath,
      readFileSync(artifactPath, "utf8"),
    );
  }
}

function writeSandboxJson(
  worktreePath: string,
  artifactPath: string,
  value: unknown,
): void {
  writeSandboxText(worktreePath, artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSandboxText(
  worktreePath: string,
  artifactPath: string,
  contents: string,
): void {
  const target = sandboxArtifactPath(worktreePath, artifactPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function sandboxArtifactPath(worktreePath: string, artifactPath: string): string {
  return join(worktreePath, artifactPath);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function runCodeQualityReview(input: {
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
  sandbox: ExtraReviewSandbox;
  createAgent: ExtraReviewAgentFactory;
  session: ExtraReviewSessionKind;
  agentEntry?: ExtraReviewSessionAgentEntry;
  writeAgentDefinition?: (input: {
    worktreePath: string;
    session: ExtraReviewSessionKind;
    agentName: string;
  }) => void;
  idleTimeoutSeconds: number;
  promptArgs: Record<string, string>;
  definition: ExtraReviewSessionDefinition;
  resultAcquisition: ExtraReviewResultAcquisition;
  onAgentSession?: RunSessionAgentHook;
}): Promise<CodeReviewOutput> {
  const raw = await runSession(input, input.definition);
  return {
    raw,
    parsed:
      input.resultAcquisition === "structured_result_file"
        ? readCodeQualityExtraReviewFromWorktree(input.sandbox.worktreePath)
        : parseCodeQualityExtraReview(raw),
  };
}

async function runTwoAxisReview(input: {
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
  sandbox: ExtraReviewSandbox;
  createAgent: ExtraReviewAgentFactory;
  session: ExtraReviewSessionKind;
  agentEntry?: ExtraReviewSessionAgentEntry;
  writeAgentDefinition?: (input: {
    worktreePath: string;
    session: ExtraReviewSessionKind;
    agentName: string;
  }) => void;
  idleTimeoutSeconds: number;
  promptArgs: Record<string, string>;
  definition: ExtraReviewSessionDefinition;
  resultAcquisition: ExtraReviewResultAcquisition;
  onAgentSession?: RunSessionAgentHook;
}): Promise<TwoAxisOutput> {
  const raw = await runSession(input, input.definition);
  return {
    raw,
    parsed:
      input.resultAcquisition === "structured_result_file"
        ? readTwoAxisExtraReviewFromWorktree(input.sandbox.worktreePath)
        : parseTwoAxisExtraReview(raw),
  };
}

async function runIssueDecomposer(input: {
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
  sandbox: ExtraReviewSandbox;
  createAgent: ExtraReviewAgentFactory;
  session: ExtraReviewSessionKind;
  agentEntry?: ExtraReviewSessionAgentEntry;
  writeAgentDefinition?: (input: {
    worktreePath: string;
    session: ExtraReviewSessionKind;
    agentName: string;
  }) => void;
  idleTimeoutSeconds: number;
  promptArgs: Record<string, string>;
  definition: ExtraReviewSessionDefinition;
  resultAcquisition: ExtraReviewResultAcquisition;
  onAgentSession?: RunSessionAgentHook;
}): Promise<IssueDecomposerOutput> {
  const raw = await runSession(input, input.definition);
  return {
    raw,
    parsed:
      input.resultAcquisition === "structured_result_file"
        ? readFollowupIssuesFromWorktree(input.sandbox.worktreePath)
        : parseFollowupIssues(raw),
  };
}

async function runSession(
  input: {
    prd: ExtraReviewPrdArtifactIdentity;
    round: ExtraReviewRoundArtifactIdentity;
    sandbox: ExtraReviewSandbox;
    createAgent: ExtraReviewAgentFactory;
    session: ExtraReviewSessionKind;
    agentEntry?: ExtraReviewSessionAgentEntry;
    writeAgentDefinition?: (input: {
      worktreePath: string;
      session: ExtraReviewSessionKind;
      agentName: string;
    }) => void;
    idleTimeoutSeconds: number;
    promptArgs: Record<string, string>;
    resultAcquisition: ExtraReviewResultAcquisition;
    onAgentSession?: RunSessionAgentHook;
  },
  definition: ExtraReviewSessionDefinition,
): Promise<string> {
  if (input.agentEntry && !input.writeAgentDefinition) {
    throw new Error(
      `Custom agent '${input.agentEntry.agentName}' for ${formatSessionKind(input.session)} requires writeAgentDefinition`,
    );
  }

  if (input.agentEntry && input.writeAgentDefinition) {
    input.writeAgentDefinition({
      worktreePath: input.sandbox.worktreePath,
      session: input.session,
      agentName: input.agentEntry.agentName,
    });
  }
  const promptFile = input.agentEntry?.promptFile ?? definition.promptFile;
  const workingLog = input.onAgentSession?.({
    session: input.session,
    runName: definition.runName,
    worktreePath: input.sandbox.worktreePath,
  });
  const result = await recordMeasuredAgentRun(
    {
      prd: metricPrd(input.prd),
      stage: definition.kind,
      agent: input.agentEntry?.agentName ?? definition.kind,
      round: metricRound(input.round),
      model: definition.model,
      runName: definition.runName,
      worktreePath: input.sandbox.worktreePath,
      promptFile,
      promptArgs: input.promptArgs,
      activeLogPath: workingLog?.activeLogPath,
    },
    () => {
      if (input.resultAcquisition === "structured_result_file") {
        clearStructuredResultFromWorktree(
          input.sandbox.worktreePath,
          structuredResultStageForExtraReview(input.session),
        );
      }
      return input.sandbox.run({
        name: definition.runName,
        agent: input.createAgent(
          definition.model,
          input.agentEntry?.agentName,
          input.session,
        ),
        maxIterations:
          input.resultAcquisition === "structured_result_file"
            ? 1
            : definition.maxIterations,
        ...(input.resultAcquisition === "tagged_stdout"
          ? { completionSignal: definition.completionSignal }
          : {}),
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        promptFile,
        promptArgs: input.promptArgs,
        logging: workingLog?.logging,
      });
    },
  );
  return result.stdout;
}

function structuredResultStageForExtraReview(
  session: ExtraReviewSessionKind,
): StructuredResultStageId {
  switch (session) {
    case "code_quality":
      return "code_quality_extra_review";
    case "two_axis":
      return "two_axis_extra_review";
    case "issue_decomposer":
      return "followup_issues";
  }
}

async function runSessionWithAcquisitionRetries<Output extends { raw: string; parsed: unknown }>(input: {
  attempts: number;
  session: ExtraReviewSessionKind;
  createSessionSandbox(session: ExtraReviewSessionKind): Promise<ExtraReviewSandbox>;
  readDirtyStatus: ExtraReviewDirtyStatusReader;
  logger: ExtraReviewSessionLogger;
  warnings: ExtraReviewDirtyWorktreeWarning[];
  ignoredPaths: readonly string[] | ((output: Output) => readonly string[]);
  isAcceptable(parsed: Output["parsed"]): boolean;
  onInvocationError(message: string): Output;
  run(sandbox: ExtraReviewSandbox, attempt: number): Promise<Output>;
}): Promise<Output> {
  let last: Output | undefined;

  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const sandbox = await input.createSessionSandbox(input.session);
    try {
      try {
        const output = await input.run(sandbox, attempt);
        last = output;
        recordDirtyWarning({
          session: input.session,
          sandbox,
          readDirtyStatus: input.readDirtyStatus,
          logger: input.logger,
          warnings: input.warnings,
          ignoredPaths:
            typeof input.ignoredPaths === "function"
              ? input.ignoredPaths(output)
              : input.ignoredPaths,
        });
        if (input.isAcceptable(output.parsed)) return output;
      } catch (error) {
        if (
          error instanceof Error &&
          /requires writeAgentDefinition/u.test(error.message)
        ) {
          throw error;
        }
        last = input.onInvocationError(
          `attempt ${attempt}: invocation error: ${describeError(error)}`,
        );
      }
    } finally {
      await sandbox.close();
    }
  }

  return last ?? input.onInvocationError("session produced no output");
}

function withAttemptDefinition(
  definition: ExtraReviewSessionDefinition,
  attempt: number,
  maxAttempts: number,
): ExtraReviewSessionDefinition {
  if (maxAttempts <= 1) return definition;
  return {
    ...definition,
    runName: `${definition.runName} a${attempt}`,
  };
}

function withAttemptRound(
  round: ExtraReviewRoundArtifactIdentity,
  attempt: number,
): ExtraReviewRoundArtifactIdentity {
  return attempt === 1
    ? round
    : {
        ...round,
        id: round.id ? `${round.id}-a${attempt}` : undefined,
      };
}

function invocationParseFailure(
  session: ExtraReviewSessionKind,
  message: string,
): CodeReviewOutput | TwoAxisOutput | IssueDecomposerOutput {
  const parseFailure: ExtraReviewParseFailure = {
    parser:
      session === "code_quality"
        ? "code_quality_extra_review"
        : session === "two_axis"
          ? "two_axis_extra_review"
          : "followup_issues",
    expected_tag: session === "issue_decomposer" ? "followup_issues" : "extra_review",
    code: "missing_tag",
    summary: message,
    details: [{ code: "missing_tag", path: "$", message }],
    stdout_preview: "",
  };

  if (session === "code_quality") {
    return {
      raw: "",
      parsed: {
        kind: "parse_failure",
        reviewer: "code_quality",
        decision: "needs_human_review",
        summary: message,
        findings: [],
        parse_failure: parseFailure,
      },
    };
  }
  if (session === "two_axis") {
    return {
      raw: "",
      parsed: {
        kind: "parse_failure",
        reviewer: "two_axis",
        decision: "needs_human_review",
        summary: message,
        standards_findings: [],
        spec_findings: [],
        parse_failure: parseFailure,
      },
    };
  }
  return {
    raw: "",
    parsed: {
      kind: "parse_failure",
      status: "needs_human_review",
      summary: message,
      issues: [],
      needs_human_review_reason: message,
      parse_failure: parseFailure,
    },
  };
}

function metricPrd(prd: ExtraReviewPrdArtifactIdentity): number | string {
  return prd.number ?? prd.label ?? prd.id ?? "unknown";
}

function metricRound(round: ExtraReviewRoundArtifactIdentity): number | string {
  return round.number ?? round.id ?? "unknown";
}

function recordDirtyWarning(input: {
  session: ExtraReviewSessionKind;
  sandbox: ExtraReviewSandbox;
  readDirtyStatus: ExtraReviewDirtyStatusReader;
  logger: ExtraReviewSessionLogger;
  warnings: ExtraReviewDirtyWorktreeWarning[];
  ignoredPaths?: readonly string[];
}): void {
  const status = filterIgnoredDirtyStatus(
    input.readDirtyStatus(input.sandbox.worktreePath),
    input.ignoredPaths ?? [],
  ).trim();
  if (!status) return;

  const warning: ExtraReviewDirtyWorktreeWarning = {
    kind: "dirty_review_worktree",
    session: input.session,
    worktreePath: input.sandbox.worktreePath,
    status,
    message: formatDirtyWarning(input.session, input.sandbox.worktreePath, status),
  };
  input.warnings.push(warning);
  input.logger.warn(warning.message);
}

function artifactInput(
  input: RunSequentialExtraReviewSessionsInput,
  outputs: ExtraReviewRoundOutputArtifacts,
  dirtyWarnings: ExtraReviewDirtyWorktreeWarning[],
  stopReason: ExtraReviewRoundStopReason,
): ExtraReviewRoundArtifactInput {
  return {
    runsRootDir: input.reviewInputs.paths.runsRootDir,
    prd: input.prd,
    round: input.round,
    reviewBase: input.reviewInputs.metadata.resolved_review_base_sha,
    reviewedHead: input.reviewInputs.metadata.reviewed_head_sha,
    stopReason,
    stopDetails: stopDetailsForWarnings(dirtyWarnings),
    outputs,
  };
}

function stopDetailsForWarnings(
  dirtyWarnings: ExtraReviewDirtyWorktreeWarning[],
): string[] {
  return dirtyWarnings.map((warning) => warning.message);
}

function stopDetailsForOutputs(
  outputs: ExtraReviewRoundOutputArtifacts,
  dirtyWarnings: ExtraReviewDirtyWorktreeWarning[],
): string[] {
  const details = [...stopDetailsForWarnings(dirtyWarnings)];
  const parsedOutputs = [
    outputs.codeReview?.parsed,
    outputs.twoAxisReview?.parsed,
    outputs.issueDecomposer?.parsed,
  ];

  for (const parsed of parsedOutputs) {
    if (!parsed) continue;
    if ("kind" in parsed && parsed.kind === "parse_failure") {
      details.push(parsed.parse_failure.summary);
      continue;
    }
    if ("decision" in parsed && parsed.decision === "needs_human_review") {
      details.push(parsed.summary);
      continue;
    }
    if ("status" in parsed && parsed.status === "needs_human_review") {
      details.push(parsed.needs_human_review_reason || parsed.summary);
    }
  }

  return [...new Set(details.filter(Boolean))];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDirtyWarning(
  session: ExtraReviewSessionKind,
  worktreePath: string,
  status: string,
): string {
  const compactStatus = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
  return `Dirty disposable review worktree after ${formatSessionKind(session)} in ${worktreePath}: ${compactStatus}`;
}

function formatSessionKind(session: ExtraReviewSessionKind): string {
  return session.replaceAll("_", "-");
}

function filterIgnoredDirtyStatus(
  status: string,
  ignoredPaths: readonly string[],
): string {
  const ignored = new Set(ignoredPaths);
  return status
    .split("\n")
    .filter((line) => {
      const path = statusPath(line);
      return !path || !ignored.has(path);
    })
    .join("\n");
}

function statusPath(line: string): string | null {
  const path = line.slice(3).trim();
  return path || null;
}

function safeBranchComponent(raw: string): string {
  const component = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return component.replace(/^-+|-+$/g, "") || "round";
}

// Keep a direct reference in this module so tests and future callers can use
// the same path resolver without importing the artifact writer separately.
export const resolveSequentialExtraReviewArtifactPaths =
  resolveExtraReviewRoundArtifactPaths;
