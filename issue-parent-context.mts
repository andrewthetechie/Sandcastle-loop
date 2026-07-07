export const ISSUE_AS_PRD_STATE_MARKER = "sandcastle-issue-as-prd-state";

export interface ParentContextComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface NormalizedParentContext {
  body: string;
  comments: string;
  rendered: string;
  omittedCommentCount: number;
}

export function normalizeParentContext(input: {
  body: string;
  comments: readonly ParentContextComment[];
  maxCommentBytes: number;
}): NormalizedParentContext {
  const body = input.body || "";
  const eligibleComments = input.comments.filter(
    (comment) => !comment.body.includes(ISSUE_AS_PRD_STATE_MARKER),
  );
  const sortedComments = [...eligibleComments].sort(compareCommentsByCreatedAt);
  const selectedNewest: ParentContextComment[] = [];
  let usedBytes = 0;

  for (let index = sortedComments.length - 1; index >= 0; index -= 1) {
    const comment = sortedComments[index]!;
    const renderedComment = renderComment(comment);
    const commentBytes = Buffer.byteLength(renderedComment, "utf8");
    if (commentBytes > input.maxCommentBytes) continue;
    if (usedBytes + commentBytes > input.maxCommentBytes) continue;
    selectedNewest.push(comment);
    usedBytes += commentBytes;
  }

  const selectedChronological = selectedNewest
    .sort(compareCommentsByCreatedAt)
    .map(renderComment);
  const omittedCommentCount =
    eligibleComments.length - selectedChronological.length;
  const omissionNotice =
    omittedCommentCount > 0
      ? `[Older parent comments omitted: ${omittedCommentCount} exceeded the ${input.maxCommentBytes}-byte context cap.]`
      : "";
  const comments = [
    omissionNotice || null,
    ...selectedChronological,
  ]
    .filter(Boolean)
    .join("\n\n");

  const rendered = [
    body,
    comments ? "Parent comments:" : null,
    comments || null,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");

  return {
    body,
    comments,
    rendered,
    omittedCommentCount,
  };
}

function compareCommentsByCreatedAt(
  left: ParentContextComment,
  right: ParentContextComment,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime)) return -1;
  if (Number.isNaN(rightTime)) return 1;
  return leftTime - rightTime;
}

function renderComment(comment: ParentContextComment): string {
  return [
    `Author: ${comment.author.login}`,
    `Timestamp: ${comment.createdAt}`,
    comment.body,
  ].join("\n");
}
