export interface ObservedParentRecoveryState {
  accumulationBranchExists: boolean;
  localAccumulationHeadSha: string | null;
  remoteAccumulationHeadSha: string | null;
  parentLabels: string[];
  openChildNumbers: number[];
  closedChildNumbers: number[];
}

export type ParentStateReconciliation<State> =
  | { kind: "create" }
  | { kind: "resume"; commentId: number; state: State }
  | { kind: "disagreement"; diagnostics: string[] };
