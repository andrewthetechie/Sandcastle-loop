/**
 * Shared Structured-result MCP contracts: stage ids, tool names, and canonical
 * result-file paths. Used by the MCP server, host acquisition, and sandbox install.
 */

export const STRUCTURED_RESULT_BASE_DIR = ".sandcastle/structured-results";

/** Worktree root for canonical result files (absolute or cwd-relative). */
export const STRUCTURED_RESULT_WORKTREE_ENV = "STRUCTURED_RESULT_WORKTREE";

/**
 * When set (relative to worktree), PR-review stages write to this directory
 * using their legacy artifact filenames instead of `structured-results/`.
 */
export const STRUCTURED_RESULT_PR_REVIEW_DIR_ENV =
  "STRUCTURED_RESULT_PR_REVIEW_DIR";

/** OpenCode server key used to namespace every Structured-result MCP tool. */
export const STRUCTURED_RESULT_MCP_SERVER_NAME = "structured-result";

/** OpenCode permission glob covering every tool exposed by this MCP server. */
export const STRUCTURED_RESULT_MCP_TOOL_GLOB =
  `${STRUCTURED_RESULT_MCP_SERVER_NAME}_*`;

export type StructuredResultStageId =
  | "review"
  | "initial_issue_decomposition"
  | "subtask_improvement"
  | "subtask_readiness"
  | "code_quality_extra_review"
  | "two_axis_extra_review"
  | "followup_issues"
  | "rebase_result"
  | "standards_findings"
  | "spec_findings"
  | "pr_review_fix";

export interface StructuredResultStageDefinition {
  id: StructuredResultStageId;
  toolName: string;
  description: string;
  /** Filename under {@link STRUCTURED_RESULT_BASE_DIR} for backlog stages. */
  backlogResultFile: string;
  /** Filename under the PR-review artifact dir when that env is set. */
  prReviewResultFile?: string;
}

export const STRUCTURED_RESULT_STAGES: readonly StructuredResultStageDefinition[] =
  [
    {
      id: "review",
      toolName: "submit_review",
      description:
        "Submit a validated per-branch reviewer result (decision, summary, findings).",
      backlogResultFile: "review.json",
    },
    {
      id: "initial_issue_decomposition",
      toolName: "submit_initial_issue_decomposition",
      description:
        "Submit a validated initial issue decomposition for an Issue-as-PRD parent.",
      backlogResultFile: "initial-issue-decomposition.json",
    },
    {
      id: "subtask_improvement",
      toolName: "submit_subtask_improvement",
      description: "Submit a validated subtask improvement result.",
      backlogResultFile: "subtask-improvement.json",
    },
    {
      id: "subtask_readiness",
      toolName: "submit_subtask_readiness",
      description: "Submit a validated subtask readiness result.",
      backlogResultFile: "subtask-readiness.json",
    },
    {
      id: "code_quality_extra_review",
      toolName: "submit_code_quality_extra_review",
      description: "Submit a validated code-quality extra-review result.",
      backlogResultFile: "code-quality-extra-review.json",
    },
    {
      id: "two_axis_extra_review",
      toolName: "submit_two_axis_extra_review",
      description: "Submit a validated two-axis extra-review result.",
      backlogResultFile: "two-axis-extra-review.json",
    },
    {
      id: "followup_issues",
      toolName: "submit_followup_issues",
      description: "Submit a validated follow-up issue decomposer result.",
      backlogResultFile: "followup-issues.json",
    },
    {
      id: "rebase_result",
      toolName: "submit_rebase_result",
      description: "Submit a validated rebase agent result.",
      backlogResultFile: "rebase-result.json",
    },
    {
      id: "standards_findings",
      toolName: "submit_standards_findings",
      description: "Submit a validated PR standards specialist result.",
      backlogResultFile: "standards-findings.json",
      prReviewResultFile: "review-output.standards.json",
    },
    {
      id: "spec_findings",
      toolName: "submit_spec_findings",
      description: "Submit a validated PR spec specialist result.",
      backlogResultFile: "spec-findings.json",
      prReviewResultFile: "review-output.spec.json",
    },
    {
      id: "pr_review_fix",
      toolName: "submit_pr_review_fix",
      description: "Submit a validated PR review fixer result.",
      backlogResultFile: "pr-review-fix-result.json",
      prReviewResultFile: "review-fix-result.json",
    },
  ] as const;

const STAGE_BY_ID = new Map(
  STRUCTURED_RESULT_STAGES.map((stage) => [stage.id, stage]),
);

export function getStructuredResultStage(
  stageId: StructuredResultStageId,
): StructuredResultStageDefinition {
  const stage = STAGE_BY_ID.get(stageId);
  if (!stage) {
    throw new Error(`Unknown structured-result stage: ${stageId}`);
  }
  return stage;
}

export function getStructuredResultStageByToolName(
  toolName: string,
): StructuredResultStageDefinition | undefined {
  return STRUCTURED_RESULT_STAGES.find((stage) => stage.toolName === toolName);
}

/** Name presented to an OpenCode agent after server-name namespacing. */
export function structuredResultOpenCodeToolName(
  stageId: StructuredResultStageId,
): string {
  return `${STRUCTURED_RESULT_MCP_SERVER_NAME}_${getStructuredResultStage(stageId).toolName}`;
}

export interface StructuredResultPathOptions {
  worktreePath: string;
  prReviewRelativeDir?: string;
}

/**
 * Resolve the worktree-relative path where a successful submit writes the
 * canonical JSON for a stage.
 */
export function resolveStructuredResultRelativePath(
  stageId: StructuredResultStageId,
  options: Pick<StructuredResultPathOptions, "prReviewRelativeDir">,
): string {
  const stage = getStructuredResultStage(stageId);
  if (options.prReviewRelativeDir && stage.prReviewResultFile) {
    return `${options.prReviewRelativeDir}/${stage.prReviewResultFile}`;
  }
  return `${STRUCTURED_RESULT_BASE_DIR}/${stage.backlogResultFile}`;
}
