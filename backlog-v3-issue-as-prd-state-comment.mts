import { renderParentStateComment, type IssueAsPrdParentState } from "./issue-as-prd-state.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export interface PersistParentStateCommentDeps {
  createComment(input: { parentNumber: number; body: string }): Promise<number> | number;
  updateComment(input: { commentId: number; body: string }): Promise<void> | void;
  readComments?(input: {
    parentNumber: number;
  }): Promise<readonly { id: number; body: string }[]> | readonly { id: number; body: string }[];
}

export async function persistIssueAsPrdParentStateComment(input: {
  parentNumber: number;
  commentId: number | null;
  state: IssueAsPrdParentState;
}, deps: PersistParentStateCommentDeps): Promise<{ commentId: number; body: string }> {
  const body = renderParentStateComment(input.state);

  // Frozen runner lineages predate verified state-comment persistence. Keep
  // the dependency optional for them; active backlog v3 always supplies it.
  if (!deps.readComments) {
    if (input.commentId === null) {
      const commentId = await deps.createComment({
        parentNumber: input.parentNumber,
        body,
      });
      return { commentId, body };
    }
    await deps.updateComment({ commentId: input.commentId, body });
    return { commentId: input.commentId, body };
  }

  let commentId = input.commentId;
  const verification = await runVerifiedHostMutation({
    mutate: async () => {
      if (commentId === null) {
        commentId = await deps.createComment({
          parentNumber: input.parentNumber,
          body,
        });
        return;
      }
      await deps.updateComment({ commentId, body });
    },
    readBack: async () => {
      const comments = await deps.readComments!({ parentNumber: input.parentNumber });
      return comments.find((comment) => comment.id === commentId) ?? null;
    },
    verify: (comment) => comment !== null && comment.body === body,
    describe: (comment) =>
      comment === null
        ? `state comment #${commentId ?? "(unassigned)"} missing`
        : `state comment #${comment.id} body_bytes=${Buffer.byteLength(comment.body, "utf8")}`,
  });
  if (!verification.ok || commentId === null) {
    throw new Error(
      `Parent state comment persistence failed: ${verification.diagnostics.join("; ")}`,
    );
  }
  return {
    commentId,
    body,
  };
}
