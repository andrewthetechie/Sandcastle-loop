import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import type {
  SubtaskImprovementAcquisition,
  SubtaskImprovementEvidence,
} from "./issue-as-prd-contracts.mts";
import { SUBTASK_READINESS_MARKER } from "./subtask-readiness.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export const SUBTASK_IMPROVEMENT_MARKER = "sandcastle-subtask-improvement";
export const SUBTASK_IMPROVEMENT_CONTRACT_VERSION = 1;

export type SubtaskImprovementResult =
  | { kind: "actionable"; child: GitHubIssueRecord; reused: boolean }
  | { kind: "redundant"; childNumber: number; reused: boolean }
  | { kind: "parent_failure"; diagnostics: string[] };

export async function improveSubtaskJustInTime(input: {
  child: GitHubIssueRecord;
  accumulationSha: string;
  acquire(currentChild: GitHubIssueRecord): Promise<SubtaskImprovementAcquisition>;
  client: GitHubIssuesClient;
}): Promise<SubtaskImprovementResult> {
  // Selection is based on a queue listing that can race with a human edit.
  // The issue handed to the coder must always be the persisted tracker value,
  // including when a matching marker lets us reuse an earlier improvement.
  const currentChild = input.client.viewIssue(input.child.number);
  if (currentChild.state !== "OPEN") {
    return {
      kind: "parent_failure",
      diagnostics: [`Selected child #${currentChild.number} is ${currentChild.state}; expected OPEN.`],
    };
  }
  if (hasValidSubtaskImprovementMarker(currentChild.body, input.accumulationSha)) {
    return { kind: "actionable", child: currentChild, reused: true };
  }

  const semanticCurrentChild = {
    ...currentChild,
    body: stripSubtaskImprovementMarkers(currentChild.body),
  };
  const acquisition = await input.acquire(semanticCurrentChild);
  if (!acquisition.ok) {
    return { kind: "parent_failure", diagnostics: acquisition.diagnostics };
  }

  const result = acquisition.result;
  const contractDiagnostics = validateImprovementForCurrentIssue({
    current: semanticCurrentChild,
    result,
  });
  if (contractDiagnostics.length > 0) {
    return { kind: "parent_failure", diagnostics: contractDiagnostics };
  }

  if (result.outcome === "redundant") {
    const closureComment = formatRedundantClosureComment(result);
    const closeVerification = await runVerifiedHostMutation({
      mutate: () => {
        if (input.client.viewIssue(currentChild.number).state === "CLOSED") return;
        input.client.closeIssue(currentChild.number, closureComment);
      },
      readBack: () => input.client.viewIssue(currentChild.number),
      verify: (value) => value.state === "CLOSED",
      describe: (value) => `issue #${value.number} state=${value.state}`,
    });
    return closeVerification.ok
      ? { kind: "redundant", childNumber: currentChild.number, reused: false }
      : { kind: "parent_failure", diagnostics: closeVerification.diagnostics };
  }

  const persistedBody = appendSubtaskImprovementMarker(
    stripSubtaskImprovementMarkers(result.proposed_body),
    input.accumulationSha,
  );
  const editVerification = await runVerifiedHostMutation({
    mutate: () => input.client.editIssueTitleAndBody({
      issueNumber: currentChild.number,
      title: result.proposed_title,
      body: persistedBody,
    }),
    readBack: () => input.client.viewIssue(currentChild.number),
    verify: (value) =>
      value.state === "OPEN" &&
      value.title === result.proposed_title &&
      value.body === persistedBody,
    describe: (value) =>
      `issue #${value.number} state=${value.state} title_bytes=${Buffer.byteLength(value.title, "utf8")} body_bytes=${Buffer.byteLength(value.body, "utf8")}`,
  });
  return editVerification.ok
    ? { kind: "actionable", child: editVerification.value, reused: false }
    : { kind: "parent_failure", diagnostics: editVerification.diagnostics };
}

export function appendSubtaskImprovementMarker(body: string, accumulationSha: string): string {
  return [
    body.trimEnd(),
    "",
    `<!-- ${SUBTASK_IMPROVEMENT_MARKER} contract=${SUBTASK_IMPROVEMENT_CONTRACT_VERSION} accumulation=${accumulationSha} -->`,
  ].join("\n");
}

export function hasValidSubtaskImprovementMarker(body: string, accumulationSha: string): boolean {
  const expression = new RegExp(
    `<!-- ${SUBTASK_IMPROVEMENT_MARKER} contract=${SUBTASK_IMPROVEMENT_CONTRACT_VERSION} accumulation=${escapeRegExp(accumulationSha)} -->`,
    "u",
  );
  return expression.test(body);
}

export function stripSubtaskImprovementMarkers(body: string): string {
  return body
    .replace(
      new RegExp(`\\n?<!--\\s*${SUBTASK_IMPROVEMENT_MARKER}\\s+contract=\\d+\\s+accumulation=[^\\s>]+\\s*-->`, "gu"),
      "",
    )
    .replace(
      new RegExp(`\\n?<!--\\s*${SUBTASK_READINESS_MARKER}\\s+disposition=[^\\s>]+\\s*-->`, "gu"),
      "",
    )
    .trimEnd();
}

export function validateImprovementForCurrentIssue(input: {
  current: Pick<GitHubIssueRecord, "title" | "body">;
  result: {
    outcome: "improved" | "unchanged" | "redundant";
    proposed_title: string;
    proposed_body: string;
    changes: string[];
    evidence: SubtaskImprovementEvidence[];
    close_reason: string;
  };
}): string[] {
  const diagnostics: string[] = [];
  const titleChanged = input.current.title !== input.result.proposed_title;
  const bodyChanged = input.current.body !== input.result.proposed_body;
  const hasVerifiedEvidence = input.result.evidence.some(
    (entry) => entry.classification === "Verified",
  );

  if (input.result.outcome === "improved" && !titleChanged && !bodyChanged) {
    diagnostics.push("Improved result did not change the child title or body.");
  }
  if (input.result.outcome === "unchanged" && (titleChanged || bodyChanged)) {
    diagnostics.push("Unchanged result must return the current child title and body exactly.");
  }
  if (input.result.outcome === "unchanged" && !hasVerifiedEvidence) {
    diagnostics.push("Unchanged result requires evidence that the issue is implementation-ready.");
  }
  if (input.result.outcome === "redundant" && !hasVerifiedEvidence) {
    diagnostics.push("Redundant result requires verified current-accumulation evidence.");
  }
  if (input.result.outcome !== "redundant" && input.result.close_reason !== "") {
    diagnostics.push("Actionable improvement result must have an empty close_reason.");
  }
  return diagnostics;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatRedundantClosureComment(result: {
  summary: string;
  close_reason: string;
  evidence: SubtaskImprovementEvidence[];
}): string {
  return [
    result.close_reason,
    "",
    result.summary,
    "",
    "Evidence:",
    ...result.evidence.map(
      (entry) => `- [${entry.classification}] ${entry.claim} — ${entry.source}`,
    ),
  ].join("\n");
}
