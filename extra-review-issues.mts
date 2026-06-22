import { createHash } from "node:crypto";
import { REVIEW_FOLLOW_UP_LABEL } from "./extra-review-config.mts";
import type {
  ExtraReviewCreatedIssueRecord,
  ExtraReviewPrdArtifactIdentity,
  ExtraReviewRoundArtifactIdentity,
  ExtraReviewRoundStopReason,
  ExtraReviewSkippedDuplicateIssueRecord,
} from "./extra-review-artifacts.mts";
import type {
  FollowupIssueDraft,
  FollowupIssuesParseResult,
} from "./extra-review-contracts.mts";

export const EXTRA_REVIEW_FOLLOWUP_DUPLICATE_MARKER =
  "sandcastle-extra-review-followup";
export const EXTRA_REVIEW_FOLLOWUP_LABEL_COLOR = "5319e7";
export const EXTRA_REVIEW_FOLLOWUP_LABEL_DESCRIPTION =
  "AI-generated follow-up issues from PRD-level extra review";

export interface ExtraReviewIssuePublicationPrd
  extends Pick<ExtraReviewPrdArtifactIdentity, "path" | "title"> {
  number: number;
  label: string;
}

export interface ExtraReviewIssuePublicationContext {
  prd: ExtraReviewIssuePublicationPrd;
  round: ExtraReviewRoundArtifactIdentity;
  originalReviewBaseArg: string;
  resolvedReviewBaseSha: string;
  reviewedHeadSha: string;
  artifactRefs?: ExtraReviewIssueArtifactRefs;
  reviewFollowUpLabel?: string;
}

export interface ExtraReviewIssueArtifactRefs {
  roundDir?: string;
  codeReviewRaw?: string;
  codeReviewParsed?: string;
  twoAxisReviewRaw?: string;
  twoAxisReviewParsed?: string;
  issueDecomposerRaw?: string;
  issueDecomposerParsed?: string;
  handoff?: string;
}

export interface ExtraReviewIssueListItem {
  number: number;
  title?: string;
  state?: string;
  url?: string;
}

export interface ExtraReviewIssueDetail extends ExtraReviewIssueListItem {
  body?: string | null;
}

export interface ExtraReviewIssueCreateResult {
  number?: number;
  url?: string;
}

export interface ExtraReviewIssueListQuery {
  label: string;
  state: "open" | "closed" | "all";
  limit: number;
}

export interface ExtraReviewIssueCreateInput {
  title: string;
  body: string;
  labels: readonly string[];
}

export interface ExtraReviewIssueClient {
  listIssues(query: ExtraReviewIssueListQuery): readonly ExtraReviewIssueListItem[];
  viewIssue(issueNumber: number): ExtraReviewIssueDetail;
  createIssue(input: ExtraReviewIssueCreateInput): ExtraReviewIssueCreateResult;
  ensureLabel(name: string, description?: string, color?: string): void;
}

export interface ExtraReviewIssueGhClient {
  listIssues(args: readonly string[]): readonly ExtraReviewIssueListItem[];
  viewIssue(args: readonly string[]): ExtraReviewIssueDetail;
  createIssue(args: readonly string[]): ExtraReviewIssueCreateResult;
  ensureLabel(name: string, description?: string, color?: string): void;
}

export interface ExtraReviewIssueLogger {
  warn(message: string): void;
}

export interface ExtraReviewIssueCreateCommand {
  title: string;
  body: string;
  labels: string[];
  duplicateMarker: string;
  sourceFingerprint: string;
}

export interface ExtraReviewPublishedIssueRecord
  extends ExtraReviewCreatedIssueRecord {
  duplicate_marker: string;
  create_args: string[];
}

export interface ExtraReviewPublishedDuplicateRecord
  extends ExtraReviewSkippedDuplicateIssueRecord {
  duplicate_marker: string;
}

export interface PublishExtraReviewIssuesInput {
  decomposition: FollowupIssuesParseResult;
  context: ExtraReviewIssuePublicationContext;
  client?: ExtraReviewIssueClient;
  gh?: ExtraReviewIssueGhClient;
  logger?: ExtraReviewIssueLogger;
}

export interface PublishExtraReviewIssuesResult {
  stopReason: ExtraReviewRoundStopReason;
  createdIssues: ExtraReviewPublishedIssueRecord[];
  skippedDuplicateIssues: ExtraReviewPublishedDuplicateRecord[];
  createCommands: ExtraReviewIssueCreateCommand[];
}

interface DuplicateMatch {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
}

interface DuplicateIssueCandidate extends DuplicateMatch {
  body: string;
}

export function publishExtraReviewIssues(
  input: PublishExtraReviewIssuesInput,
): PublishExtraReviewIssuesResult {
  const { decomposition, context } = input;
  const client = input.client ?? legacyGhClientAdapter(input.gh);
  if (!client) {
    throw new Error("publishExtraReviewIssues requires an issue client");
  }
  const logger = input.logger ?? console;

  if (decomposition.kind !== "followup_issues") {
    return emptyPublication("needs_human_review");
  }
  if (decomposition.status === "no_work") return emptyPublication("no_work");
  if (decomposition.status === "needs_human_review") {
    return emptyPublication("needs_human_review");
  }

  const createdIssues: ExtraReviewPublishedIssueRecord[] = [];
  const skippedDuplicateIssues: ExtraReviewPublishedDuplicateRecord[] = [];
  const createCommands: ExtraReviewIssueCreateCommand[] = [];
  const handledMarkers = new Map<string, DuplicateMatch>();
  const findExistingDuplicate = createDuplicateIssueSearcher(
    client,
    context.prd.label,
  );
  const followUpLabel = context.reviewFollowUpLabel ?? REVIEW_FOLLOW_UP_LABEL;

  client.ensureLabel(
    followUpLabel,
    EXTRA_REVIEW_FOLLOWUP_LABEL_DESCRIPTION,
    EXTRA_REVIEW_FOLLOWUP_LABEL_COLOR,
  );

  for (const draft of decomposition.issues) {
    const command = buildExtraReviewIssueCreateCommand(draft, context);
    const duplicate =
      handledMarkers.get(command.duplicateMarker) ??
      findExistingDuplicate(command.duplicateMarker);

    if (duplicate) {
      const skipped = skippedDuplicateRecord(draft, command, duplicate);
      skippedDuplicateIssues.push(skipped);
      logger.warn(
        [
          `Skipping duplicate extra-review follow-up issue "${draft.title}".`,
          duplicate.number ? `Existing issue: #${duplicate.number}.` : "",
          duplicate.state ? `State: ${duplicate.state}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      handledMarkers.set(command.duplicateMarker, duplicate);
      continue;
    }

    const created = client.createIssue(command);
    const createdRecord = createdIssueRecord(draft, command, created);
    createdIssues.push(createdRecord);
    createCommands.push(command);
    handledMarkers.set(command.duplicateMarker, {
      number: createdRecord.issue_number,
      title: createdRecord.title,
      state: "created",
      url: createdRecord.issue_url,
    });
  }

  return {
    stopReason:
      createdIssues.length > 0
        ? "success"
        : skippedDuplicateIssues.length > 0
          ? "duplicate_only"
          : "no_work",
    createdIssues,
    skippedDuplicateIssues,
    createCommands,
  };
}

export function buildExtraReviewIssueCreateCommand(
  draft: FollowupIssueDraft,
  context: ExtraReviewIssuePublicationContext,
): ExtraReviewIssueCreateCommand {
  const duplicateMarker = buildExtraReviewDuplicateMarker(draft, context);
  const sourceFingerprint = fingerprintFollowupIssue(draft);
  const labels = [
    context.prd.label,
    context.reviewFollowUpLabel ?? REVIEW_FOLLOW_UP_LABEL,
  ];
  const body = renderExtraReviewIssueBody(draft, context, duplicateMarker);

  return {
    title: draft.title,
    body,
    labels,
    duplicateMarker,
    sourceFingerprint,
  };
}

export function buildExtraReviewDuplicateMarker(
  draft: FollowupIssueDraft,
  context: ExtraReviewIssuePublicationContext,
): string {
  return [
    "<!--",
    EXTRA_REVIEW_FOLLOWUP_DUPLICATE_MARKER,
    `prd_number=${context.prd.number}`,
    `prd_label=${context.prd.label}`,
    `review_base_sha=${context.resolvedReviewBaseSha}`,
    `source_fingerprint=sha256:${fingerprintFollowupIssue(draft)}`,
    "-->",
  ].join(" ");
}

export function fingerprintFollowupIssue(draft: FollowupIssueDraft): string {
  const canonical = {
    title: normalizeText(draft.title),
    body: normalizeText(draft.body),
    source_findings: [...draft.source_findings]
      .map((finding) => ({
        reviewer: finding.reviewer,
        axis: finding.axis,
        finding_id: normalizeText(finding.finding_id),
        title: normalizeText(finding.title),
      }))
      .sort((a, b) =>
        [
          a.reviewer.localeCompare(b.reviewer),
          a.axis.localeCompare(b.axis),
          a.finding_id.localeCompare(b.finding_id),
          a.title.localeCompare(b.title),
        ].find((comparison) => comparison !== 0) ?? 0,
      ),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}

function createDuplicateIssueSearcher(
  client: ExtraReviewIssueClient,
  prdLabel: string,
): (marker: string) => DuplicateMatch | null {
  let candidates: DuplicateIssueCandidate[] | undefined;

  return (marker: string): DuplicateMatch | null => {
    candidates ??= loadDuplicateIssueCandidates(client, prdLabel);
    const duplicate = candidates.find((candidate) =>
      candidate.body.includes(marker),
    );
    if (!duplicate) return null;
    return {
      number: duplicate.number,
      title: duplicate.title,
      state: duplicate.state,
      url: duplicate.url,
    };
  };
}

function loadDuplicateIssueCandidates(
  client: ExtraReviewIssueClient,
  prdLabel: string,
): DuplicateIssueCandidate[] {
  const candidates = client.listIssues({
    label: prdLabel,
    state: "all",
    limit: 1000,
  });

  return candidates.map((candidate) => {
    const detail = client.viewIssue(candidate.number);
    return {
      number: detail.number ?? candidate.number,
      title: detail.title ?? candidate.title,
      state: detail.state ?? candidate.state,
      url: detail.url ?? candidate.url,
      body: detail.body ?? "",
    };
  });
}

function renderExtraReviewIssueBody(
  draft: FollowupIssueDraft,
  context: ExtraReviewIssuePublicationContext,
  duplicateMarker: string,
): string {
  return [
    draft.body.trimEnd(),
    "",
    "## Extra Review Provenance",
    `- PRD: #${context.prd.number} (${context.prd.label})`,
    ...optionalLine("PRD file", context.prd.path),
    ...optionalLine("PRD title", context.prd.title),
    `- Extra review round: ${formatRound(context.round)}`,
    `- Source reviewers: ${sourceReviewers(draft).join(", ")}`,
    `- Original review base: ${context.originalReviewBaseArg}`,
    `- Resolved review base SHA: ${context.resolvedReviewBaseSha}`,
    `- Reviewed branch head SHA: ${context.reviewedHeadSha}`,
    "- Source finding refs/excerpts:",
    ...draft.source_findings.map(
      (finding) =>
        `  - ${finding.reviewer}/${finding.axis} ${finding.finding_id}: ${finding.title}`,
    ),
    ...artifactRefLines(context.artifactRefs),
    "",
    duplicateMarker,
  ].join("\n");
}

function createdIssueRecord(
  draft: FollowupIssueDraft,
  command: ExtraReviewIssueCreateCommand,
  created: ExtraReviewIssueCreateResult,
): ExtraReviewPublishedIssueRecord {
  const issueUrl = created.url;
  return {
    status: "created",
    title: draft.title,
    dedupe_key: draft.dedupe_key,
    priority: draft.priority,
    body: command.body,
    files: [...draft.files],
    source_findings: [...draft.source_findings],
    issue_number: created.number ?? issueNumberFromUrl(issueUrl),
    issue_url: issueUrl,
    duplicate_marker: command.duplicateMarker,
    create_args: renderIssueCreateCommandArgs(command),
  };
}

function renderIssueCreateCommandArgs(
  command: ExtraReviewIssueCreateCommand,
): string[] {
  return [
    "issue",
    "create",
    "--title",
    command.title,
    "--body",
    command.body,
    "--labels",
    command.labels.join(","),
  ];
}

function legacyGhClientAdapter(
  gh: ExtraReviewIssueGhClient | undefined,
): ExtraReviewIssueClient | undefined {
  if (!gh) return undefined;
  return {
    listIssues(query) {
      return gh.listIssues([
        "issue",
        "list",
        "--label",
        query.label,
        "--state",
        query.state,
        "--json",
        "number,title,state,url",
        "--limit",
        String(query.limit),
      ]);
    },
    viewIssue(issueNumber) {
      return gh.viewIssue([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "number,title,state,body,url",
      ]);
    },
    createIssue(input) {
      return gh.createIssue(renderLegacyGhIssueCreateCommandArgs(input));
    },
    ensureLabel(name, description, color) {
      gh.ensureLabel(name, description, color);
    },
  };
}

function renderLegacyGhIssueCreateCommandArgs(
  input: ExtraReviewIssueCreateInput,
): string[] {
  return [
    "issue",
    "create",
    "--title",
    input.title,
    "--body",
    input.body,
    ...input.labels.flatMap((label) => ["--label", label]),
  ];
}

function skippedDuplicateRecord(
  draft: FollowupIssueDraft,
  command: ExtraReviewIssueCreateCommand,
  duplicate: DuplicateMatch,
): ExtraReviewPublishedDuplicateRecord {
  return {
    status: "skipped_duplicate",
    title: draft.title,
    dedupe_key: draft.dedupe_key,
    reason: [
      "Matching hidden duplicate marker already exists",
      duplicate.state ? `in ${duplicate.state.toLowerCase()} PRD issue` : "",
      duplicate.number ? `#${duplicate.number}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    priority: draft.priority,
    body: command.body,
    files: [...draft.files],
    source_findings: [...draft.source_findings],
    existing_issue_number: duplicate.number,
    existing_issue_url: duplicate.url,
    duplicate_marker: command.duplicateMarker,
  };
}

function artifactRefLines(
  refs: ExtraReviewIssueArtifactRefs | undefined,
): string[] {
  if (!refs) return [];
  const entries: [string, string | undefined][] = [
    ["Round artifact directory", refs.roundDir],
    ["Code-quality raw output", refs.codeReviewRaw],
    ["Code-quality parsed output", refs.codeReviewParsed],
    ["Two-axis raw output", refs.twoAxisReviewRaw],
    ["Two-axis parsed output", refs.twoAxisReviewParsed],
    ["Issue decomposer raw output", refs.issueDecomposerRaw],
    ["Issue decomposer parsed output", refs.issueDecomposerParsed],
    ["Handoff", refs.handoff],
  ];
  const lines = entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `  - ${label}: ${value}`);
  return lines.length > 0 ? ["- Artifact refs:", ...lines] : [];
}

function formatRound(round: ExtraReviewRoundArtifactIdentity): string {
  const parts = [
    round.number !== undefined ? `#${round.number}` : undefined,
    round.id,
  ].filter(Boolean);
  return parts.join(" / ") || "(unspecified round)";
}

function sourceReviewers(draft: FollowupIssueDraft): string[] {
  return [...new Set(draft.source_findings.map((finding) => finding.reviewer))];
}

function optionalLine(label: string, value: string | undefined): string[] {
  return value ? [`- ${label}: ${value}`] : [];
}

function issueNumberFromUrl(url: string | undefined): number | undefined {
  const raw = url?.match(/\/issues\/(\d+)(?:$|[/?#])/)?.[1];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ");
}

function emptyPublication(
  stopReason: Extract<
    ExtraReviewRoundStopReason,
    "needs_human_review" | "no_work"
  >,
): PublishExtraReviewIssuesResult {
  return {
    stopReason,
    createdIssues: [],
    skippedDuplicateIssues: [],
    createCommands: [],
  };
}
