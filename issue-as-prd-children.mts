import { createHash } from "node:crypto";
import type { GitHubIssueRecord, GitHubIssuesClient } from "./github-issues.mts";
import { ISSUE_AS_PRD_LABELS } from "./issue-as-prd-queue-state.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export const ISSUE_AS_PRD_CHILD_MARKER = "sandcastle-issue-as-prd-child";

export type ChildSource = "initial" | "review_followup" | "validation_repair";
export type PublishChildPriority = "high" | "medium" | "low";

export interface PublishChildDraft {
  title: string;
  body: string;
  priority: PublishChildPriority;
  files: string[];
  dedupeKey: string;
  source: ChildSource;
}

export type ChildPublicationResult =
  | { ok: true; children: GitHubIssueRecord[]; duplicateNumbers: number[] }
  | { ok: false; diagnostics: string[]; orphanNumbers: number[] };

export async function publishIssueAsPrdChildren(input: {
  parent: GitHubIssueRecord;
  drafts: readonly PublishChildDraft[];
  queueLabel: string;
  client: GitHubIssuesClient;
}): Promise<ChildPublicationResult> {
  const description = ISSUE_AS_PRD_LABELS.parentQueue.description.replace("#N", `#${input.parent.number}`);
  try {
    input.client.ensureLabel(
      input.queueLabel,
      description,
      ISSUE_AS_PRD_LABELS.parentQueue.color,
    );
  } catch (err) {
    return publicationFailure(
      `queue label setup failed for '${input.queueLabel}': ${errorMessage(err)}`,
    );
  }

  if (input.drafts.length === 0) {
    return { ok: true, children: [], duplicateNumbers: [] };
  }

  const duplicateSearcher = createDuplicateSearcher(input.client, input.queueLabel);
  const handledMarkers = new Map<string, GitHubIssueRecord>();
  const children: GitHubIssueRecord[] = [];
  const duplicateNumbers: number[] = [];
  const diagnostics: string[] = [];
  const orphanNumbers: number[] = [];

  for (const draft of input.drafts) {
    const marker = buildIssueAsPrdChildMarker({
      parentNumber: input.parent.number,
      source: draft.source,
      title: draft.title,
      body: draft.body,
      dedupeKey: draft.dedupeKey,
    });

    let issue = handledMarkers.get(marker);
    if (!issue) {
      try {
        issue = duplicateSearcher(marker);
      } catch (err) {
        return publicationFailure(
          `duplicate search failed before creating child '${draft.title}': ${errorMessage(err)}`,
          orphanNumbers,
        );
      }
    }

    const reusedExisting = Boolean(issue);
    if (!issue) {
      try {
        const created = input.client.createIssue({
          title: draft.title,
          body: renderIssueAsPrdChildBody({
            parentNumber: input.parent.number,
            queueLabel: input.queueLabel,
            draft,
            marker,
          }),
          labels: [input.queueLabel],
        });
        issue = input.client.viewIssue(created.number);
      } catch (err) {
        diagnostics.push(
          `create failed for child '${draft.title}': ${errorMessage(err)}`,
        );
        return { ok: false, diagnostics, orphanNumbers };
      }
    }

    const currentIssue = issue;
    handledMarkers.set(marker, currentIssue);
    if (reusedExisting) duplicateNumbers.push(currentIssue.number);

    const labelVerification = await runVerifiedHostMutation({
      mutate: () => input.client.addLabel(currentIssue.number, input.queueLabel),
      readBack: () => input.client.viewIssue(currentIssue.number),
      verify: (value) => value.labels.some((label) => label.name === input.queueLabel),
      describe: (value) =>
        `issue #${value.number} labels=${value.labels.map((label) => label.name).join(",")}`,
    });
    if (!labelVerification.ok) {
      diagnostics.push(
        ...labelVerification.diagnostics.map(
          (line) => `queue label verification failed for child #${currentIssue.number}: ${line}`,
        ),
      );
      orphanNumbers.push(currentIssue.number);
      return { ok: false, diagnostics, orphanNumbers: uniqueNumbers(orphanNumbers) };
    }

    issue = labelVerification.value;
    const linkedIssue = issue;
    const linkVerification = await runVerifiedHostMutation({
      mutate: () => input.client.addSubIssue(input.parent.number, linkedIssue.id),
      readBack: () => input.client.listSubIssues(input.parent.number),
      verify: (value) => value.some((child) => child.id === linkedIssue.id),
      describe: (value) =>
        `parent #${input.parent.number} sub_issues=${value.map((child) => child.number).join(",")}`,
    });
    if (!linkVerification.ok) {
      diagnostics.push(
        ...linkVerification.diagnostics.map(
          (line) => `sub-issue verification failed for child #${linkedIssue.number}: ${line}`,
        ),
      );
      orphanNumbers.push(linkedIssue.number);
      return { ok: false, diagnostics, orphanNumbers: uniqueNumbers(orphanNumbers) };
    }

    children.push(linkedIssue);
  }

  return {
    ok: true,
    children,
    duplicateNumbers: uniqueNumbers(duplicateNumbers),
  };
}

export function buildIssueAsPrdChildMarker(input: {
  parentNumber: number;
  source: ChildSource;
  title: string;
  body: string;
  dedupeKey: string;
}): string {
  return [
    "<!--",
    ISSUE_AS_PRD_CHILD_MARKER,
    `parent_number=${input.parentNumber}`,
    `source=${input.source}`,
    `source_fingerprint=sha256:${fingerprintIssueAsPrdChild(input)}`,
    "-->",
  ].join(" ");
}

export function fingerprintIssueAsPrdChild(input: {
  parentNumber: number;
  source: ChildSource;
  title: string;
  body: string;
  dedupeKey: string;
}): string {
  const canonical = {
    parentNumber: input.parentNumber,
    source: input.source,
    title: normalizeText(input.title),
    body: normalizeText(input.body),
    dedupeKey: normalizeText(input.dedupeKey),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}

export function renderIssueAsPrdChildBody(input: {
  parentNumber: number;
  queueLabel: string;
  draft: PublishChildDraft;
  marker: string;
}): string {
  return [
    input.draft.body.trimEnd(),
    "",
    "## Issue-as-PRD Provenance",
    `- Parent issue: #${input.parentNumber}`,
    `- Source: ${input.draft.source}`,
    `- Queue label: ${input.queueLabel}`,
    "- Files:",
    ...input.draft.files.map((file) => `  - ${file}`),
    "",
    input.marker,
  ].join("\n");
}

function createDuplicateSearcher(
  client: GitHubIssuesClient,
  queueLabel: string,
): (marker: string) => GitHubIssueRecord | null {
  let candidates: GitHubIssueRecord[] | undefined;
  return (marker: string) => {
    candidates ??= client.listIssues({
      state: "all",
      labels: [queueLabel],
      limit: 1000,
    });
    return candidates.find((candidate) => candidate.body.includes(marker)) ?? null;
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ");
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function publicationFailure(
  diagnostic: string,
  orphanNumbers: readonly number[] = [],
): ChildPublicationResult {
  return {
    ok: false,
    diagnostics: [diagnostic],
    orphanNumbers: uniqueNumbers(orphanNumbers),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
