import type { StructuredResultStageId } from "./structured-result-contracts.mts";
import {
  validateCodeQualityExtraReview,
  validateFollowupIssues,
  validateInitialIssueDecomposition,
  validatePrReviewFixResult,
  validateRebaseAgentResult,
  validateReviewResult,
  validateSpecReview,
  validateStandardsReview,
  validateSubtaskImprovement,
  validateSubtaskReadiness,
  validateTwoAxisExtraReview,
  type StructuredResultValidation,
} from "./structured-result-validators.mts";

type StageValidator = (value: unknown) => StructuredResultValidation<unknown>;

const STAGE_VALIDATORS: Record<StructuredResultStageId, StageValidator> = {
  review: validateReviewResult,
  initial_issue_decomposition: validateInitialIssueDecomposition,
  subtask_improvement: validateSubtaskImprovement,
  subtask_readiness: validateSubtaskReadiness,
  code_quality_extra_review: validateCodeQualityExtraReview,
  two_axis_extra_review: validateTwoAxisExtraReview,
  followup_issues: validateFollowupIssues,
  rebase_result: validateRebaseAgentResult,
  standards_findings: validateStandardsReview,
  spec_findings: validateSpecReview,
  pr_review_fix: validatePrReviewFixResult,
};

/** Single stage-to-validator registry shared by MCP submit and host acquisition. */
export function validateStructuredResultStage<T>(
  stageId: StructuredResultStageId,
  value: unknown,
): StructuredResultValidation<T> {
  return STAGE_VALIDATORS[stageId](value) as StructuredResultValidation<T>;
}
