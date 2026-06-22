export type ExtraReviewDecision =
  | "approved"
  | "followup_recommended"
  | "needs_human_review";

export type ExtraReviewSeverity = "blocking" | "major" | "minor";
export type ExtraReviewReviewer = "code_quality" | "two_axis";
export type ExtraReviewAxis = "code_quality" | "standards" | "spec";
export type FollowupIssueStatus =
  | "issues"
  | "no_work"
  | "needs_human_review";
export type FollowupIssuePriority = "high" | "medium" | "low";

export interface ExtraReviewFinding<Source extends ExtraReviewAxis> {
  id: string;
  severity: ExtraReviewSeverity;
  confidence: number;
  title: string;
  problem: string;
  impact: string;
  recommendation: string;
  files: string[];
  source: Source;
}

export type CodeQualityFinding = ExtraReviewFinding<"code_quality">;
export type StandardsFinding = ExtraReviewFinding<"standards">;
export type SpecFinding = ExtraReviewFinding<"spec">;

export interface CodeQualityExtraReview {
  kind: "extra_review";
  reviewer: "code_quality";
  decision: ExtraReviewDecision;
  summary: string;
  findings: CodeQualityFinding[];
}

export interface TwoAxisExtraReview {
  kind: "extra_review";
  reviewer: "two_axis";
  decision: ExtraReviewDecision;
  summary: string;
  standards_findings: StandardsFinding[];
  spec_findings: SpecFinding[];
}

export interface FollowupIssueSourceFinding {
  reviewer: ExtraReviewReviewer;
  finding_id: string;
  axis: ExtraReviewAxis;
  title: string;
}

export interface FollowupIssueDraft {
  title: string;
  body: string;
  priority: FollowupIssuePriority;
  source_findings: FollowupIssueSourceFinding[];
  files: string[];
  dedupe_key: string;
}

export type FollowupIssues =
  | {
      kind: "followup_issues";
      status: "issues";
      summary: string;
      issues: FollowupIssueDraft[];
      needs_human_review_reason: "";
    }
  | {
      kind: "followup_issues";
      status: "no_work";
      summary: string;
      issues: [];
      needs_human_review_reason: "";
    }
  | {
      kind: "followup_issues";
      status: "needs_human_review";
      summary: string;
      issues: [];
      needs_human_review_reason: string;
    };

export type ExtraReviewParserName =
  | "code_quality_extra_review"
  | "two_axis_extra_review"
  | "followup_issues";

export type ExtraReviewTag = "extra_review" | "followup_issues";

export type ParseFailureCode =
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
  | "inconsistent_decision"
  | "inconsistent_status"
  | "inconsistent_provenance";

export interface ParseFailureDetail {
  code: ParseFailureCode;
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ExtraReviewParseFailure {
  parser: ExtraReviewParserName;
  expected_tag: ExtraReviewTag;
  code: ParseFailureCode;
  summary: string;
  details: ParseFailureDetail[];
  stdout_preview: string;
  json_preview?: string;
}

export interface CodeQualityExtraReviewParseFailure {
  kind: "parse_failure";
  reviewer: "code_quality";
  decision: "needs_human_review";
  summary: string;
  findings: [];
  parse_failure: ExtraReviewParseFailure;
}

export interface TwoAxisExtraReviewParseFailure {
  kind: "parse_failure";
  reviewer: "two_axis";
  decision: "needs_human_review";
  summary: string;
  standards_findings: [];
  spec_findings: [];
  parse_failure: ExtraReviewParseFailure;
}

export interface FollowupIssuesParseFailure {
  kind: "parse_failure";
  status: "needs_human_review";
  summary: string;
  issues: [];
  needs_human_review_reason: string;
  parse_failure: ExtraReviewParseFailure;
}

export type CodeQualityExtraReviewParseResult =
  | CodeQualityExtraReview
  | CodeQualityExtraReviewParseFailure;

export type TwoAxisExtraReviewParseResult =
  | TwoAxisExtraReview
  | TwoAxisExtraReviewParseFailure;

export type FollowupIssuesParseResult =
  | FollowupIssues
  | FollowupIssuesParseFailure;

export const REVIEW_DECISIONS: readonly ExtraReviewDecision[] = [
  "approved",
  "followup_recommended",
  "needs_human_review",
];

export const SEVERITIES: readonly ExtraReviewSeverity[] = [
  "blocking",
  "major",
  "minor",
];

export const FOLLOWUP_STATUSES: readonly FollowupIssueStatus[] = [
  "issues",
  "no_work",
  "needs_human_review",
];

export const ISSUE_PRIORITIES: readonly FollowupIssuePriority[] = [
  "high",
  "medium",
  "low",
];

export const REVIEWERS: readonly ExtraReviewReviewer[] = [
  "code_quality",
  "two_axis",
];

export const AXES: readonly ExtraReviewAxis[] = [
  "code_quality",
  "standards",
  "spec",
];
