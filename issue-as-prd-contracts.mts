export type InitialIssueDecompositionStatus =
  | "issues"
  | "no_work"
  | "needs_human_review";

export type InitialSubtaskPriority = "high" | "medium" | "low";

export type SubtaskReadinessDisposition =
  | "fixed"
  | "assumed"
  | "not_actionable";

export interface InitialSubtaskDraft {
  title: string;
  body: string;
  priority: InitialSubtaskPriority;
  files: string[];
  dedupe_key: string;
}

export type InitialIssueDecomposition =
  | {
      kind: "initial_issue_decomposition";
      status: "issues";
      summary: string;
      issues: InitialSubtaskDraft[];
      needs_human_review_reason: "";
    }
  | {
      kind: "initial_issue_decomposition";
      status: "no_work";
      summary: string;
      issues: [];
      needs_human_review_reason: "";
    }
  | {
      kind: "initial_issue_decomposition";
      status: "needs_human_review";
      summary: string;
      issues: [];
      needs_human_review_reason: string;
    };

export interface SubtaskReadinessResult {
  kind: "subtask_readiness";
  disposition: SubtaskReadinessDisposition;
  summary: string;
  evidence: string[];
  proposed_body: string;
  close_reason: string;
}

export type SubtaskImprovementOutcome = "improved" | "unchanged" | "redundant";

export type SubtaskImprovementEvidenceClassification =
  | "Verified"
  | "Contradicted"
  | "Unsupported"
  | "Ambiguous"
  | "Outdated/Risky";

export interface SubtaskImprovementEvidence {
  claim: string;
  classification: SubtaskImprovementEvidenceClassification;
  source: string;
}

// This is deliberately a separate contract from the legacy batch readiness
// result. Backlog v3 binds an improvement to one accumulation SHA immediately
// before coding; older runners retain the readiness contract unchanged.
export interface SubtaskImprovementResult {
  kind: "subtask_improvement";
  outcome: SubtaskImprovementOutcome;
  summary: string;
  proposed_title: string;
  proposed_body: string;
  changes: string[];
  evidence: SubtaskImprovementEvidence[];
  close_reason: string;
}

export type IssueAsPrdParserName =
  | "initial_issue_decomposition"
  | "subtask_readiness"
  | "subtask_improvement";

export type IssueAsPrdTag =
  | "initial_issue_decomposition"
  | "subtask_readiness"
  | "subtask_improvement";

export type IssueAsPrdParseFailureCode =
  | "missing_tag"
  | "multiple_tags"
  | "unexpected_text"
  | "empty_tag"
  | "malformed_json"
  | "wrong_top_level_shape"
  | "missing_required_field"
  | "unexpected_field"
  | "empty_required_field"
  | "invalid_field_type"
  | "invalid_field_value"
  | "inconsistent_status"
  | "inconsistent_disposition";

export interface IssueAsPrdParseFailureDetail {
  code: IssueAsPrdParseFailureCode;
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface IssueAsPrdParseFailure {
  parser: IssueAsPrdParserName;
  expected_tag: IssueAsPrdTag;
  code: IssueAsPrdParseFailureCode;
  summary: string;
  details: IssueAsPrdParseFailureDetail[];
  stdout_preview: string;
  json_preview?: string;
}

export interface InitialIssueDecompositionParseFailure {
  kind: "parse_failure";
  parse_failure: IssueAsPrdParseFailure;
}

export interface SubtaskReadinessParseFailure {
  kind: "parse_failure";
  parse_failure: IssueAsPrdParseFailure;
}

export interface SubtaskImprovementParseFailure {
  kind: "parse_failure";
  parse_failure: IssueAsPrdParseFailure;
}

export type InitialIssueDecompositionParseResult =
  | InitialIssueDecomposition
  | InitialIssueDecompositionParseFailure;

export type SubtaskReadinessParseResult =
  | SubtaskReadinessResult
  | SubtaskReadinessParseFailure;

export type SubtaskImprovementParseResult =
  | SubtaskImprovementResult
  | SubtaskImprovementParseFailure;

export interface AgentAttemptArtifact {
  attempt: 1 | 2;
  stdout: string;
  diagnostics: string[];
  logFilePath?: string;
}

export interface SuccessfulAcquisition<Result> {
  ok: true;
  result: Result;
  attemptsUsed: 1 | 2;
  artifacts: [AgentAttemptArtifact] | [AgentAttemptArtifact, AgentAttemptArtifact];
  diagnostics: string[];
}

export interface ExhaustedAcquisitionFailure {
  ok: false;
  attemptsUsed: 2;
  artifacts: [AgentAttemptArtifact, AgentAttemptArtifact];
  diagnostics: string[];
}

export type InitialDecompositionAcquisition =
  | SuccessfulAcquisition<InitialIssueDecomposition>
  | ExhaustedAcquisitionFailure;

export type SubtaskReadinessAcquisition =
  | SuccessfulAcquisition<SubtaskReadinessResult>
  | ExhaustedAcquisitionFailure;

export type SubtaskImprovementAcquisition =
  | SuccessfulAcquisition<SubtaskImprovementResult>
  | ExhaustedAcquisitionFailure;

export const INITIAL_ISSUE_DECOMPOSITION_STATUSES: readonly InitialIssueDecompositionStatus[] =
  ["issues", "no_work", "needs_human_review"];

export const INITIAL_SUBTASK_PRIORITIES: readonly InitialSubtaskPriority[] = [
  "high",
  "medium",
  "low",
];

export const SUBTASK_READINESS_DISPOSITIONS: readonly SubtaskReadinessDisposition[] =
  ["fixed", "assumed", "not_actionable"];

export const SUBTASK_IMPROVEMENT_OUTCOMES: readonly SubtaskImprovementOutcome[] = [
  "improved",
  "unchanged",
  "redundant",
];

export const SUBTASK_IMPROVEMENT_EVIDENCE_CLASSIFICATIONS: readonly SubtaskImprovementEvidenceClassification[] = [
  "Verified",
  "Contradicted",
  "Unsupported",
  "Ambiguous",
  "Outdated/Risky",
];
