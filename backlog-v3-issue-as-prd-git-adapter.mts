import {
  integrateApprovedChild,
  type ChildIntegrationDeps,
  type ChildIntegrationInput,
} from "./issue-as-prd-integration.mts";
import {
  observeTerminalMainline,
  refreshAccumulationBeforeReview,
  type RefreshGitDeps,
} from "./issue-as-prd-refresh.mts";

export async function integrateIssueAsPrdChild(
  input: ChildIntegrationInput,
  deps: ChildIntegrationDeps,
) {
  return integrateApprovedChild(input, deps);
}

export async function refreshIssueAsPrdAccumulationBeforeReview(
  input: Parameters<typeof refreshAccumulationBeforeReview>[0],
  deps: RefreshGitDeps,
) {
  return refreshAccumulationBeforeReview(input, deps);
}

export async function observeIssueAsPrdTerminalMainline(
  input: Parameters<typeof observeTerminalMainline>[0],
  deps: Pick<RefreshGitDeps, "fetchMainline" | "revParse">,
) {
  return observeTerminalMainline(input, deps);
}
