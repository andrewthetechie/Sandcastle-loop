import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import type {
  SubtaskReadinessAcquisition,
  SubtaskReadinessDisposition,
} from "./issue-as-prd-contracts.mts";
import type { NormalizedParentContext } from "./issue-parent-context.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export const SUBTASK_READINESS_MARKER = "sandcastle-subtask-readiness";

export type ReadinessBatchResult =
  | { kind: "ready"; ready: GitHubIssueRecord[]; dropped: number[] }
  | {
      kind: "parent_failure";
      ready: GitHubIssueRecord[];
      dropped: number[];
      diagnostics: string[];
    };

export async function runSubtaskReadinessBatch(input: {
  parentContext: NormalizedParentContext;
  children: readonly GitHubIssueRecord[];
  siblingSummaries: readonly { number: number; title: string; body: string }[];
  accumulationSha: string;
  acquire(
    child: GitHubIssueRecord,
    activeSiblings: readonly { number: number; title: string; body: string }[],
  ): Promise<SubtaskReadinessAcquisition>;
  client: GitHubIssuesClient;
}): Promise<ReadinessBatchResult> {
  void input.parentContext;
  void input.accumulationSha;

  const ready: GitHubIssueRecord[] = [];
  const dropped: number[] = [];
  const orderedChildren = [...input.children].sort((left, right) => left.number - right.number);

  for (const child of orderedChildren) {
    if (hasValidSubtaskReadinessMarker(child.body)) {
      ready.push(child);
      continue;
    }

    // Exclude the child under evaluation from its own sibling list. Otherwise a
    // single-child decomposition (child scope == whole parent) shows the child
    // its own body as an "active sibling" and the readiness agent closes it as a
    // self-duplicate, draining the queue to empty and stranding the parent.
    const activeSiblings = input.siblingSummaries.filter(
      (sibling) => sibling.number !== child.number,
    );
    const acquisition = await input.acquire(child, activeSiblings);
    if (!acquisition.ok) {
      return {
        kind: "parent_failure",
        ready,
        dropped,
        diagnostics: acquisition.diagnostics,
      };
    }

    const result = acquisition.result;
    if (result.disposition === "not_actionable") {
      const closeVerification = await runVerifiedHostMutation({
        mutate: () => input.client.closeIssue(child.number, result.close_reason),
        readBack: () => input.client.viewIssue(child.number),
        verify: (value) => value.state === "CLOSED",
        describe: (value) => `issue #${value.number} state=${value.state}`,
      });
      if (!closeVerification.ok) {
        return {
          kind: "parent_failure",
          ready,
          dropped,
          diagnostics: closeVerification.diagnostics,
        };
      }
      dropped.push(child.number);
      continue;
    }

    const updatedBody = appendSubtaskReadinessMarker(
      result.proposed_body,
      result.disposition,
    );
    const editVerification = await runVerifiedHostMutation({
      mutate: () => input.client.editIssueBody(child.number, updatedBody),
      readBack: () => input.client.viewIssue(child.number),
      verify: (value) => value.body === updatedBody,
      describe: (value) => `issue #${value.number} body_bytes=${Buffer.byteLength(value.body, "utf8")}`,
    });
    if (!editVerification.ok) {
      return {
        kind: "parent_failure",
        ready,
        dropped,
        diagnostics: editVerification.diagnostics,
      };
    }
    ready.push(editVerification.value);
  }

  return { kind: "ready", ready, dropped };
}

export function appendSubtaskReadinessMarker(
  body: string,
  disposition: Extract<SubtaskReadinessDisposition, "fixed" | "assumed">,
): string {
  return [
    body.trimEnd(),
    "",
    `<!-- ${SUBTASK_READINESS_MARKER} disposition=${disposition} -->`,
  ].join("\n");
}

export function hasValidSubtaskReadinessMarker(body: string): boolean {
  return new RegExp(
    `<!-- ${SUBTASK_READINESS_MARKER} disposition=(fixed|assumed) -->`,
    "u",
  ).test(body);
}
