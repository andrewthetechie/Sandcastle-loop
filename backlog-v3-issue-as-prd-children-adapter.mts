import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import {
  publishIssueAsPrdChildren,
  type ChildPublicationResult,
  type PublishChildDraft,
} from "./issue-as-prd-children.mts";
import { AGENT_STUCK_LABEL } from "./issue-as-prd-queue-state.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export async function publishIssueAsPrdParentChildren(input: {
  parent: GitHubIssueRecord;
  drafts: readonly PublishChildDraft[];
  queueLabel: string;
  client: GitHubIssuesClient;
}): Promise<ChildPublicationResult> {
  return publishIssueAsPrdChildren(input);
}

export function listIssueAsPrdParentChildren(input: {
  parentNumber: number;
  queueLabel: string;
  client: GitHubIssuesClient;
}): GitHubIssueRecord[] {
  return input.client
    .listIssues({
      state: "all",
      labels: [input.queueLabel],
      limit: 1000,
    })
    .filter((issue) => issue.number !== input.parentNumber)
    .sort((left, right) => left.number - right.number);
}

export async function closeIssueAsPrdAlreadySatisfiedChild(input: {
  child: Pick<GitHubIssueRecord, "number">;
  evidence: string;
  client: GitHubIssuesClient;
}): Promise<void> {
  const closeVerification = await runVerifiedHostMutation({
    mutate: () =>
      input.client.closeIssue(
        input.child.number,
        [
          "Closing as already satisfied relative to the current accumulation branch.",
          "",
          "Evidence:",
          input.evidence,
        ].join("\n"),
      ),
    readBack: () => input.client.viewIssue(input.child.number),
    verify: (value) => value.state === "CLOSED",
    describe: (value) => `issue #${value.number} state=${value.state}`,
  });
  if (!closeVerification.ok) {
    throw new Error(closeVerification.diagnostics.join("\n"));
  }
}

export async function markIssueAsPrdChildStuck(input: {
  child: Pick<GitHubIssueRecord, "number">;
  reason: string;
  client: GitHubIssuesClient;
}): Promise<void> {
  input.client.createComment(
    input.child.number,
    [
      "Child issue cannot continue automatically.",
      "",
      "Reason:",
      input.reason,
    ].join("\n"),
  );

  const labelVerification = await runVerifiedHostMutation({
    mutate: () => input.client.addLabel(input.child.number, AGENT_STUCK_LABEL),
    readBack: () => input.client.viewIssue(input.child.number),
    verify: (value) => value.labels.some((label) => label.name === AGENT_STUCK_LABEL),
    describe: (value) =>
      `issue #${value.number} labels=${value.labels.map((label) => label.name).join(",")}`,
  });
  if (!labelVerification.ok) {
    throw new Error(labelVerification.diagnostics.join("\n"));
  }
}
