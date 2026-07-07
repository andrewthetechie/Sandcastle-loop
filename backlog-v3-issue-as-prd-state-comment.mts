import { renderParentStateComment, type IssueAsPrdParentState } from "./issue-as-prd-state.mts";

export interface PersistParentStateCommentDeps {
  createComment(input: { parentNumber: number; body: string }): Promise<number> | number;
  updateComment(input: { commentId: number; body: string }): Promise<void> | void;
}

export async function persistIssueAsPrdParentStateComment(input: {
  parentNumber: number;
  commentId: number | null;
  state: IssueAsPrdParentState;
}, deps: PersistParentStateCommentDeps): Promise<{ commentId: number; body: string }> {
  const body = renderParentStateComment(input.state);

  if (input.commentId === null) {
    const commentId = await deps.createComment({
      parentNumber: input.parentNumber,
      body,
    });
    return { commentId, body };
  }

  await deps.updateComment({
    commentId: input.commentId,
    body,
  });
  return {
    commentId: input.commentId,
    body,
  };
}
