// recover-backlog-v3-issues.mts
//
// Recovers Issue-as-PRD parents that run-backlog-v3.mts reports as
// "Ownership ambiguous" (or silently skips). The loop keeps parent state in
// three places — GitHub labels, a durable JSON state comment, and git
// branches — and older loop versions could leave them disagreeing (crash
// between writes, terminal phases never persisted, interrupted claims). This
// script classifies each candidate and either:
//
//   repair-in-place  — labels/branches are made to agree with the recorded
//                      state comment so the loop resumes mid-flight
//                      (preserves the accumulation branch and children), or
//   full reset       — the loop's artifacts are removed so the parent is
//                      claimed completely fresh: the local accumulation
//                      branch is quarantined to diagnostic/<branch>-recovered-<ts>,
//                      the remote branch and state comments are deleted, open
//                      loop-generated children are closed, and the parent-N
//                      queue label is deleted.
//
// Dry run by default; pass --apply to execute.
//
// Usage:
//   tsx recover-backlog-v3-issues.mts --label <name[,name2]> [--apply]
//     [--issue <n[,n2]>] [--include-stuck] [--unstick-children]
//
//   --label            Candidate issues must carry ALL these labels (same
//                      value you pass to run-backlog-v3.mts).
//   --issue            Recover only these issue numbers (skips the label
//                      scan; also unlocks Review/agent-stuck issues).
//   --include-stuck    Also recover issues still labelled agent-stuck
//                      (removes the label so the loop retries them).
//   --unstick-children On repair-in-place, remove agent-stuck from open
//                      children so the loop retries them too.

import { execFileSync, spawnSync } from "node:child_process";
import {
  GitHubIssuesClient,
  type GitHubIssueRecord,
  type GitHubRepoRef,
} from "./github-issues.mts";
import {
  parseParentStateComment,
  reconcileParentState,
  type IssueAsPrdParentState,
} from "./issue-as-prd-state.mts";
import type { ObservedParentRecoveryState } from "./issue-as-prd-state-contracts.mts";
import { ISSUE_AS_PRD_STATE_MARKER } from "./issue-parent-context.mts";
import {
  AGENT_STUCK_LABEL,
  ISSUE_AS_PRD_LABELS,
  REVIEW_LABEL,
} from "./issue-as-prd-queue-state.mts";
import {
  accumulationBranchName,
  queueLabelName,
} from "./backlog-v3-issue-as-prd-adapter.mts";
import { splitQueueChildren } from "./backlog-v3-issue-as-prd-recovery-state.mts";
import { ISSUE_AS_PRD_CHILD_MARKER } from "./issue-as-prd-children.mts";
import { readCliStringFlag } from "./cli-string-flag.mts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: tsx recover-backlog-v3-issues.mts --label <name[,name2]> [--apply] [--issue <n[,n2]>] [--include-stuck] [--unstick-children]";

const labelArg = readCliStringFlag(process.argv, "--label");
const issueArg = readCliStringFlag(process.argv, "--issue");
const apply = process.argv.includes("--apply");
const includeStuck = process.argv.includes("--include-stuck");
const unstickChildren = process.argv.includes("--unstick-children");

if (!labelArg && !issueArg) {
  throw new Error(`${USAGE}\n\nProvide --label and/or --issue.`);
}
const backlogLabels = (labelArg ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const explicitIssueNumbers = new Set(
  (issueArg ?? "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8" });

function gitOk(args: string[]): boolean {
  return spawnSync("git", args, { encoding: "utf8" }).status === 0;
}

function localBranchSha(branch: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteBranchSha(branch: string): string | null {
  const result = spawnSync("git", ["ls-remote", "--heads", "origin", branch], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? "").split("\n").map((v) => v.trim()).find(Boolean);
  return line ? line.split(/\s+/u)[0] ?? null : null;
}

function repoOwnerAndName(): string {
  const remote = git(["remote", "get-url", "origin"]).trim();
  const match =
    remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/u) ??
    remote.match(/([^/:]+\/[^/]+?)(?:\.git)?$/u);
  if (!match?.[1]) {
    throw new Error(`Could not parse owner/repo from origin remote: ${remote}`);
  }
  return match[1];
}

function repoRef(): GitHubRepoRef {
  const [owner, repo] = repoOwnerAndName().split("/");
  if (!owner || !repo) throw new Error(`Could not split owner/repo from ${repoOwnerAndName()}`);
  return { owner, repo };
}

const REPO = repoRef();
const client = new GitHubIssuesClient(REPO);

function deleteIssueComment(commentId: number): void {
  execFileSync("gh", [
    "api",
    "--method",
    "DELETE",
    `repos/${REPO.owner}/${REPO.repo}/issues/comments/${commentId}`,
  ]);
}

function labelNames(issue: Pick<GitHubIssueRecord, "labels">): Set<string> {
  return new Set(issue.labels.map((label) => label.name));
}

function observeParent(parent: GitHubIssueRecord): {
  observed: ObservedParentRecoveryState;
  queueIssues: GitHubIssueRecord[];
} {
  const accumulationBranch = accumulationBranchName(parent.number);
  const queueLabel = queueLabelName(parent.number);
  const queueIssues = client
    .listIssues({ state: "all", labels: [queueLabel], limit: 1000 })
    .sort((left, right) => left.number - right.number);
  const childNumbers = splitQueueChildren({
    parentNumber: parent.number,
    queueIssues: queueIssues.map((issue) => ({
      number: issue.number,
      state: issue.state,
    })),
  });
  const localSha = localBranchSha(accumulationBranch);
  return {
    observed: {
      accumulationBranchExists: localSha !== null,
      localAccumulationHeadSha: localSha,
      remoteAccumulationHeadSha: remoteBranchSha(accumulationBranch),
      parentLabels: parent.labels.map((label) => label.name),
      openChildNumbers: childNumbers.openChildNumbers,
      closedChildNumbers: childNumbers.closedChildNumbers,
    },
    queueIssues,
  };
}

function markedStateComments(
  parent: GitHubIssueRecord,
): { id: number; body: string }[] {
  return parent.comments
    .filter((comment) => comment.body.includes(ISSUE_AS_PRD_STATE_MARKER))
    .map((comment) => ({ id: comment.id, body: comment.body }));
}

function isTerminalPhase(phase: IssueAsPrdParentState["phase"]): boolean {
  return phase === "delivered" || phase === "failed";
}

interface PlannedAction {
  description: string;
  run(): void;
}

// ---------------------------------------------------------------------------
// Branch reconciliation
// ---------------------------------------------------------------------------

type BranchResolution =
  | { kind: "ok"; sha: string; actions: PlannedAction[] }
  | { kind: "unresolvable"; reason: string };

// Decide how to make the local and remote accumulation branches agree.
// Fast-forward-only: if the histories diverged we refuse and force a reset.
function resolveBranch(branch: string, localSha: string | null, remoteSha: string | null): BranchResolution {
  if (localSha === null && remoteSha === null) {
    return { kind: "unresolvable", reason: "accumulation branch missing locally and on origin" };
  }
  if (localSha !== null && remoteSha === null) {
    return {
      kind: "ok",
      sha: localSha,
      actions: [
        {
          description: `push local ${branch} (${localSha.slice(0, 12)}) to origin`,
          run: () =>
            void execFileSync("git", ["push", "origin", `${localSha}:refs/heads/${branch}`], {
              stdio: "inherit",
            }),
        },
      ],
    };
  }
  if (localSha === null && remoteSha !== null) {
    return {
      kind: "ok",
      sha: remoteSha,
      actions: [
        {
          description: `create local ${branch} from origin (${remoteSha.slice(0, 12)})`,
          run: () =>
            void execFileSync(
              "git",
              ["fetch", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
              { stdio: "inherit" },
            ),
        },
      ],
    };
  }
  if (localSha === remoteSha) return { kind: "ok", sha: localSha!, actions: [] };

  // Both exist but differ; fetch so ancestry checks have the remote objects.
  spawnSync("git", ["fetch", "origin", branch], { encoding: "utf8" });
  if (gitOk(["merge-base", "--is-ancestor", remoteSha!, localSha!])) {
    return {
      kind: "ok",
      sha: localSha!,
      actions: [
        {
          description: `fast-forward origin ${branch} ${remoteSha!.slice(0, 12)} -> ${localSha!.slice(0, 12)}`,
          run: () =>
            void execFileSync(
              "git",
              [
                "push",
                `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
                "origin",
                `${localSha}:refs/heads/${branch}`,
              ],
              { stdio: "inherit" },
            ),
        },
      ],
    };
  }
  if (gitOk(["merge-base", "--is-ancestor", localSha!, remoteSha!])) {
    return {
      kind: "ok",
      sha: remoteSha!,
      actions: [
        {
          description: `fast-forward local ${branch} ${localSha!.slice(0, 12)} -> ${remoteSha!.slice(0, 12)}`,
          run: () => void git(["branch", "-f", branch, remoteSha!]),
        },
      ],
    };
  }
  return {
    kind: "unresolvable",
    reason: `local (${localSha!.slice(0, 12)}) and origin (${remoteSha!.slice(0, 12)}) ${branch} have diverged`,
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function repairInPlacePlan(input: {
  parent: GitHubIssueRecord;
  state: IssueAsPrdParentState;
  observed: ObservedParentRecoveryState;
  queueIssues: GitHubIssueRecord[];
  branchActions: PlannedAction[];
}): PlannedAction[] {
  const labels = labelNames(input.parent);
  const actions: PlannedAction[] = [...input.branchActions];
  const queueLabel = input.state.queueLabel;

  if (!labels.has(ISSUE_AS_PRD_LABELS.inProgress.name)) {
    actions.push({
      description: `re-add ${ISSUE_AS_PRD_LABELS.inProgress.name} to parent #${input.parent.number}`,
      run: () => {
        client.ensureLabel(
          ISSUE_AS_PRD_LABELS.inProgress.name,
          ISSUE_AS_PRD_LABELS.inProgress.description,
          ISSUE_AS_PRD_LABELS.inProgress.color,
        );
        client.addLabel(input.parent.number, ISSUE_AS_PRD_LABELS.inProgress.name);
      },
    });
  }
  if (!labels.has(queueLabel)) {
    actions.push({
      description: `re-add queue label ${queueLabel} to parent #${input.parent.number}`,
      run: () => {
        client.ensureLabel(
          queueLabel,
          ISSUE_AS_PRD_LABELS.parentQueue.description.replace("#N", `#${input.parent.number}`),
          ISSUE_AS_PRD_LABELS.parentQueue.color,
        );
        client.addLabel(input.parent.number, queueLabel);
      },
    });
  }
  for (const label of labels) {
    if (/^parent-\d+$/u.test(label) && label !== queueLabel) {
      actions.push({
        description: `remove stray queue label ${label} from parent #${input.parent.number}`,
        run: () => client.removeLabel(input.parent.number, label),
      });
    }
  }
  if (labels.has(AGENT_STUCK_LABEL)) {
    actions.push({
      description: `remove ${AGENT_STUCK_LABEL} from parent #${input.parent.number}`,
      run: () => client.removeLabel(input.parent.number, AGENT_STUCK_LABEL),
    });
  }
  if (unstickChildren) {
    for (const child of input.queueIssues) {
      if (child.number === input.parent.number || child.state !== "OPEN") continue;
      if (!child.labels.some((label) => label.name === AGENT_STUCK_LABEL)) continue;
      actions.push({
        description: `remove ${AGENT_STUCK_LABEL} from open child #${child.number}`,
        run: () => client.removeLabel(child.number, AGENT_STUCK_LABEL),
      });
    }
  }
  actions.push(auditCommentAction(input.parent.number, "repair-in-place"));
  return actions;
}

function fullResetPlan(input: {
  parent: GitHubIssueRecord;
  queueIssues: GitHubIssueRecord[];
  localSha: string | null;
  remoteSha: string | null;
}): PlannedAction[] {
  const parentNumber = input.parent.number;
  const branch = accumulationBranchName(parentNumber);
  const queueLabel = queueLabelName(parentNumber);
  const labels = labelNames(input.parent);
  const actions: PlannedAction[] = [];
  const quarantine = `diagnostic/${branch}-recovered-${Date.now()}`;

  if (input.localSha !== null) {
    actions.push({
      description: `quarantine local ${branch} to ${quarantine} and delete it`,
      run: () => {
        git(["branch", "-f", quarantine, branch]);
        git(["branch", "-D", branch]);
      },
    });
  } else if (input.remoteSha !== null) {
    actions.push({
      description: `quarantine origin ${branch} to local ${quarantine}`,
      run: () =>
        void execFileSync(
          "git",
          ["fetch", "origin", `refs/heads/${branch}:refs/heads/${quarantine}`],
          { stdio: "inherit" },
        ),
    });
  }
  if (input.remoteSha !== null) {
    actions.push({
      description: `delete origin ${branch}`,
      run: () => {
        const result = spawnSync("git", ["push", "origin", "--delete", branch], {
          encoding: "utf8",
        });
        if (result.status !== 0) {
          console.warn(`  warning: could not delete origin ${branch}: ${(result.stderr ?? "").trim()}`);
        }
      },
    });
  }

  for (const comment of markedStateComments(input.parent)) {
    actions.push({
      description: `delete stale state comment ${comment.id} on parent #${parentNumber}`,
      run: () => deleteIssueComment(comment.id),
    });
  }

  for (const child of input.queueIssues) {
    if (child.number === parentNumber || child.state !== "OPEN") continue;
    if (!child.body.includes(ISSUE_AS_PRD_CHILD_MARKER)) continue;
    actions.push({
      description: `close loop-generated child #${child.number} ("${child.title}")`,
      run: () =>
        client.closeIssue(
          child.number,
          `Superseded: parent #${parentNumber} was reset for re-processing by the backlog loop (recover-backlog-v3-issues).`,
        ),
    });
  }

  actions.push({
    description: `delete queue label ${queueLabel} (detaches any remaining issues)`,
    run: () => {
      try {
        client.deleteLabel(queueLabel);
      } catch {
        // Label may not exist; nothing to detach.
      }
    },
  });

  const removable = [
    ISSUE_AS_PRD_LABELS.inProgress.name,
    ISSUE_AS_PRD_LABELS.partial.name,
    ISSUE_AS_PRD_LABELS.rebaseNeeded.name,
    AGENT_STUCK_LABEL,
    ...(explicitIssueNumbers.has(parentNumber) ? [REVIEW_LABEL] : []),
  ].filter((label) => labels.has(label));
  for (const label of removable) {
    actions.push({
      description: `remove ${label} from parent #${parentNumber}`,
      run: () => client.removeLabel(parentNumber, label),
    });
  }

  actions.push(auditCommentAction(parentNumber, "full reset"));
  return actions;
}

function auditCommentAction(parentNumber: number, mode: string): PlannedAction {
  return {
    description: `leave audit comment on parent #${parentNumber}`,
    run: () =>
      void client.createComment(
        parentNumber,
        [
          `recover-backlog-v3-issues: applied **${mode}** so the backlog loop can pick this issue up again.`,
          "",
          mode === "full reset"
            ? "The previous accumulation branch (if any) was quarantined under `diagnostic/` locally; state comments and loop-generated open children were removed. The loop will claim this issue fresh."
            : "Labels/branches were realigned with the recorded state comment. The loop will resume from the recorded phase.",
        ].join("\n"),
      ),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Classified {
  verdict: string;
  actions: PlannedAction[];
}

function classify(parent: GitHubIssueRecord): Classified {
  const { observed, queueIssues } = observeParent(parent);
  const labels = labelNames(parent);
  const branch = accumulationBranchName(parent.number);
  const marked = markedStateComments(parent);
  const reconciled = reconcileParentState({
    parentNumber: parent.number,
    comments: parent.comments.map((comment) => ({ id: comment.id, body: comment.body })),
    observed,
  });
  const resetPlan = () =>
    fullResetPlan({
      parent,
      queueIssues,
      localSha: observed.localAccumulationHeadSha,
      remoteSha: observed.remoteAccumulationHeadSha,
    });

  if (reconciled.kind === "resume") {
    if (isTerminalPhase(reconciled.state.phase)) {
      // Terminal state recorded, terminal labels already stripped by a human:
      // this is a requeue request.
      return { verdict: "terminal phase recorded — requeue via full reset", actions: resetPlan() };
    }
    if (labels.has(ISSUE_AS_PRD_LABELS.inProgress.name)) {
      return { verdict: "healthy — loop will resume it", actions: [] };
    }
    return { verdict: "healthy state but not resume-selectable — repairing labels", actions: repairInPlacePlan({ parent, state: reconciled.state, observed, queueIssues, branchActions: [] }) };
  }

  if (reconciled.kind === "create") {
    if (labels.has(ISSUE_AS_PRD_LABELS.inProgress.name)) {
      return {
        verdict: "interrupted claim — the fixed loop completes it automatically; no action",
        actions: [],
      };
    }
    const strayArtifacts =
      observed.accumulationBranchExists ||
      observed.remoteAccumulationHeadSha !== null ||
      observed.openChildNumbers.length > 0 ||
      observed.closedChildNumbers.length > 0;
    if (strayArtifacts) {
      return { verdict: "no state comment but stray loop artifacts — full reset", actions: resetPlan() };
    }
    return { verdict: "clean — nothing to recover", actions: [] };
  }

  // Disagreement.
  if (marked.length !== 1) {
    return {
      verdict: `${marked.length} marked state comments — full reset`,
      actions: resetPlan(),
    };
  }
  const parsed = parseParentStateComment(marked[0]!.body);
  if (!parsed.ok) {
    return { verdict: "unparseable state comment — full reset", actions: resetPlan() };
  }
  const state = parsed.state;

  if (isTerminalPhase(state.phase)) {
    if (labels.has(ISSUE_AS_PRD_LABELS.inProgress.name)) {
      return {
        verdict: `terminal phase '${state.phase}' with in-progress labels — the fixed loop repairs this automatically; no action`,
        actions: [],
      };
    }
    return { verdict: `terminal phase '${state.phase}' recorded — requeue via full reset`, actions: resetPlan() };
  }

  const resolution = resolveBranch(
    branch,
    observed.localAccumulationHeadSha,
    observed.remoteAccumulationHeadSha,
  );
  if (resolution.kind === "unresolvable") {
    return { verdict: `${resolution.reason} — full reset`, actions: resetPlan() };
  }

  // Simulate the post-repair world; only repair in place if the loop would
  // then reconcile it as resumable.
  const simulatedLabels = new Set(observed.parentLabels);
  simulatedLabels.add(ISSUE_AS_PRD_LABELS.inProgress.name);
  simulatedLabels.add(state.queueLabel);
  simulatedLabels.delete(AGENT_STUCK_LABEL);
  for (const label of [...simulatedLabels]) {
    if (/^parent-\d+$/u.test(label) && label !== state.queueLabel) simulatedLabels.delete(label);
  }
  const simulated = reconcileParentState({
    parentNumber: parent.number,
    comments: [{ id: marked[0]!.id, body: marked[0]!.body }],
    observed: {
      ...observed,
      accumulationBranchExists: true,
      localAccumulationHeadSha: resolution.sha,
      remoteAccumulationHeadSha: resolution.sha,
      parentLabels: [...simulatedLabels],
    },
  });
  if (simulated.kind !== "resume") {
    const reason =
      simulated.kind === "disagreement" ? simulated.diagnostics.join("; ") : simulated.kind;
    return {
      verdict: `not repairable in place (${reason}) — full reset`,
      actions: resetPlan(),
    };
  }
  return {
    verdict: `repair in place — loop will resume at phase '${state.phase}'`,
    actions: repairInPlacePlan({
      parent,
      state,
      observed,
      queueIssues,
      branchActions: resolution.actions,
    }),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function candidateParents(): GitHubIssueRecord[] {
  if (explicitIssueNumbers.size > 0) {
    return [...explicitIssueNumbers].sort((a, b) => a - b).map((n) => client.viewIssue(n));
  }
  return client
    .listIssues({ state: "open", limit: 1000 })
    .filter((issue) => {
      const names = labelNames(issue);
      return backlogLabels.every((label) => names.has(label));
    })
    .sort((left, right) => left.number - right.number)
    .map((issue) => client.viewIssue(issue.number));
}

console.log(
  [
    `Repo: ${REPO.owner}/${REPO.repo}`,
    `Mode: ${apply ? "APPLY" : "dry run (pass --apply to execute)"}`,
    backlogLabels.length > 0 ? `Labels: ${backlogLabels.join(", ")}` : null,
    explicitIssueNumbers.size > 0 ? `Issues: ${[...explicitIssueNumbers].join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n"),
);

let repaired = 0;
let skipped = 0;
let clean = 0;

for (const parent of candidateParents()) {
  const labels = labelNames(parent);
  const explicit = explicitIssueNumbers.has(parent.number);
  console.log(`\n#${parent.number} ${parent.title}`);
  console.log(`  labels: ${[...labels].sort().join(", ") || "(none)"}`);

  if (parent.state === "CLOSED" && !explicit) {
    console.log("  skip: issue is closed");
    skipped += 1;
    continue;
  }
  if (labels.has(REVIEW_LABEL) && !explicit) {
    console.log(`  skip: labelled ${REVIEW_LABEL} (delivered, awaiting human); pass --issue ${parent.number} to recover anyway`);
    skipped += 1;
    continue;
  }
  if (labels.has(AGENT_STUCK_LABEL) && !includeStuck && !explicit) {
    console.log(`  skip: labelled ${AGENT_STUCK_LABEL}; pass --include-stuck (or --issue ${parent.number}) to requeue it`);
    skipped += 1;
    continue;
  }

  const classified = classify(parent);
  console.log(`  verdict: ${classified.verdict}`);
  if (classified.actions.length === 0) {
    clean += 1;
    continue;
  }
  for (const action of classified.actions) {
    console.log(`    ${apply ? "->" : "would:"} ${action.description}`);
    if (apply) action.run();
  }
  if (apply) {
    // Read back and confirm the loop would now accept the issue.
    const refreshed = client.viewIssue(parent.number);
    const { observed } = observeParent(refreshed);
    const after = reconcileParentState({
      parentNumber: refreshed.number,
      comments: refreshed.comments.map((comment) => ({ id: comment.id, body: comment.body })),
      observed,
    });
    const ok =
      after.kind === "create" ||
      (after.kind === "resume" && !isTerminalPhase(after.state.phase));
    console.log(
      ok
        ? `  ✓ verified: loop will ${after.kind === "create" ? "claim it fresh" : `resume at phase '${after.kind === "resume" ? after.state.phase : ""}'`}`
        : `  ✗ still inconsistent after repair: ${after.kind === "disagreement" ? after.diagnostics.join("; ") : after.kind}`,
    );
  }
  repaired += 1;
}

console.log(
  `\nDone. ${repaired} issue(s) ${apply ? "repaired" : "with planned repairs"}, ${clean} already fine, ${skipped} skipped.`,
);
