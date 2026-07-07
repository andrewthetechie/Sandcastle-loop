export interface RecoveryQueueIssue {
  number: number;
  state: "OPEN" | "CLOSED";
}

export function splitQueueChildren(input: {
  parentNumber: number;
  queueIssues: readonly RecoveryQueueIssue[];
}): {
  openChildNumbers: number[];
  closedChildNumbers: number[];
} {
  const childIssues = input.queueIssues.filter((issue) => issue.number !== input.parentNumber);

  return {
    openChildNumbers: childIssues
      .filter((issue) => issue.state === "OPEN")
      .map((issue) => issue.number)
      .sort((left, right) => left - right),
    closedChildNumbers: childIssues
      .filter((issue) => issue.state === "CLOSED")
      .map((issue) => issue.number)
      .sort((left, right) => left - right),
  };
}
