import type { GitHubIssueRecord } from "./github-issues.mts";
import type { PublishChildDraft, ChildPublicationResult } from "./issue-as-prd-children.mts";
import type { ReadinessBatchResult } from "./subtask-readiness.mts";
import type { SubtaskImprovementResult } from "./subtask-improvement.mts";
import type { PerBranchEngineOutcome } from "./per-branch-engine.mts";
import type { ChildIntegrationInput } from "./issue-as-prd-integration.mts";
import { runVerifiedHostMutation } from "./verified-host-mutation.mts";

export type AggregateGate = "pre_review" | "pre_delivery";

export interface AggregateValidationFailure {
  gate: AggregateGate;
  command: string;
  exitCode: number;
  output: string;
  accumulationSha: string;
}

export interface AggregateValidationDeps {
  parent: GitHubIssueRecord;
  accumulationBranch: string;
  queueLabel: string;
  siblingSummaries: readonly { number: number; title: string; body: string }[];
  listSiblingSummaries?(input: {
    childNumber: number;
  }): Promise<readonly { number: number; title: string; body: string }[]> |
    readonly { number: number; title: string; body: string }[];
  runValidationCommand(input: {
    gate: AggregateGate;
    command: string;
    accumulationSha: string;
  }): Promise<{ ok: true } | { ok: false; exitCode: number; output: string }>;
  publishChildren(input: {
    drafts: readonly PublishChildDraft[];
  }): Promise<ChildPublicationResult>;
  markRepairBudgetUsed(input: {
    gate: AggregateGate;
    childNumber: number;
  }): Promise<void> | void;
  readiness?(input: {
    children: readonly GitHubIssueRecord[];
    siblingSummaries: readonly { number: number; title: string; body: string }[];
    accumulationSha: string;
  }): Promise<ReadinessBatchResult>;
  improveChild?(input: {
    child: GitHubIssueRecord;
    siblingSummaries: readonly { number: number; title: string; body: string }[];
    accumulationSha: string;
  }): Promise<SubtaskImprovementResult>;
  runEngine(input: {
    child: GitHubIssueRecord;
    accumulationSha: string;
    gate: AggregateGate;
  }): Promise<PerBranchEngineOutcome>;
  integrate(input: ChildIntegrationInput): Promise<
    | { ok: true; accumulationHeadSha: string; recoveredFrom: string | null }
    | { ok: false; reason: string; diagnostics: string[] }
  >;
  markChildStuck(input: {
    childNumber: number;
    reason: string;
  }): Promise<void> | void;
  closeChild(input: {
    childNumber: number;
    comment: string;
  }): Promise<void> | void;
  readChild(input: {
    childNumber: number;
  }): Promise<Pick<GitHubIssueRecord, "state">> | Pick<GitHubIssueRecord, "state">;
}

export async function runAggregateValidation(input: {
  gate: AggregateGate;
  commands: readonly string[];
  accumulationSha: string;
  repairAlreadyUsed: boolean;
}, deps: AggregateValidationDeps): Promise<
  | { kind: "green" }
  | { kind: "repaired"; childNumber: number; accumulationSha: string }
  | {
      kind: "repair_child_stuck";
      childNumber: number;
      failure: AggregateValidationFailure;
      diagnostics: string[];
    }
  | { kind: "parent_failure"; failure: AggregateValidationFailure; diagnostics: string[] }
> {
  const firstFailure = await runValidationCommands(input.gate, input.commands, input.accumulationSha, deps);
  if (!firstFailure) return { kind: "green" };

  if (input.repairAlreadyUsed) {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: [`Aggregate validation repair budget already used for gate '${input.gate}'.`],
    };
  }

  const publication = await deps.publishChildren({
    drafts: [buildRepairDraft(input.gate, deps.parent.number, firstFailure)],
  });
  if (!publication.ok) {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: publication.diagnostics,
    };
  }
  const child = publication.children[0];
  if (!child) {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: ["Repair child publication returned no child issue."],
    };
  }
  await deps.markRepairBudgetUsed({ gate: input.gate, childNumber: child.number });

  let childForEngine = child;
  if (deps.improveChild) {
    const currentSiblingSummaries = deps.listSiblingSummaries
      ? await deps.listSiblingSummaries({ childNumber: child.number })
      : deps.siblingSummaries;
    const improved = await deps.improveChild({
      child,
      siblingSummaries: currentSiblingSummaries,
      accumulationSha: input.accumulationSha,
    });
    if (improved.kind === "parent_failure") {
      return { kind: "parent_failure", failure: firstFailure, diagnostics: improved.diagnostics };
    }
    if (improved.kind === "redundant") {
      const rerunFailure = await runValidationCommands(
        input.gate,
        input.commands,
        input.accumulationSha,
        deps,
      );
      if (!rerunFailure) {
        return { kind: "repaired", childNumber: child.number, accumulationSha: input.accumulationSha };
      }
      return {
        kind: "parent_failure",
        failure: rerunFailure,
        diagnostics: ["Repair child was redundant but aggregate validation remains red."],
      };
    }
    childForEngine = improved.child;
  } else {
  if (!deps.readiness) {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: ["Legacy repair readiness workflow has no readiness dependency."],
    };
  }
  const readiness = await deps.readiness({
    children: [child],
    siblingSummaries: deps.siblingSummaries,
    accumulationSha: input.accumulationSha,
  });
  if (readiness.kind === "parent_failure") {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: readiness.diagnostics,
    };
  }
  // Repair child was assessed as not-needed by the readiness agent (closed as
  // not_actionable). This is semantically identical to the engine returning
  // already_satisfied: the validation failure was transient (e.g. a flaky test
  // that passed by the time the fix was committed). Re-run the gate; if it is
  // now green, treat the run as repaired with no code change. If it is still
  // red the parent is genuinely stuck.
  if (readiness.ready.length === 0 && readiness.dropped.length > 0) {
    const rerunFailure = await runValidationCommands(
      input.gate,
      input.commands,
      input.accumulationSha,
      deps,
    );
    if (!rerunFailure) {
      return {
        kind: "repaired",
        childNumber: readiness.dropped[0]!,
        accumulationSha: input.accumulationSha,
      };
    }
    return {
      kind: "parent_failure",
      failure: rerunFailure,
      diagnostics: [
        `Repair child readiness dropped all children (${readiness.dropped.join(",")}) as not-needed but validation gate '${input.gate}' is still red.`,
      ],
    };
  }
  if (readiness.ready.length !== 1 || readiness.dropped.length > 0) {
    return {
      kind: "parent_failure",
      failure: firstFailure,
      diagnostics: [
        `Repair child readiness did not yield exactly one ready child: ready=${readiness.ready.length} dropped=${readiness.dropped.join(",")}`,
      ],
    };
  }

  childForEngine = readiness.ready[0]!;
  }

  const engine = await deps.runEngine({
    child: childForEngine,
    accumulationSha: input.accumulationSha,
    gate: input.gate,
  });
  switch (engine.kind) {
    case "approved": {
      const integrated = await deps.integrate({
        childNumber: childForEngine.number,
        accumulationBranch: deps.accumulationBranch,
        reviewedBaseSha: engine.reviewedBaseSha,
        approvedHeadSha: engine.approvedHeadSha,
      });
      if (!integrated.ok) {
        return markRepairChildStuck({
          childNumber: childForEngine.number,
          failure: firstFailure,
          diagnostics: integrated.diagnostics,
          deps,
        });
      }
      const rerunFailure = await runValidationCommands(
        input.gate,
        input.commands,
        integrated.accumulationHeadSha,
        deps,
      );
      if (rerunFailure) {
        return markRepairChildStuck({
          childNumber: childForEngine.number,
          failure: rerunFailure,
          diagnostics: ["Aggregate validation remained red after repair child integration."],
          deps,
        });
      }
      return {
        kind: "repaired",
        childNumber: childForEngine.number,
        accumulationSha: integrated.accumulationHeadSha,
      };
    }
    case "already_satisfied": {
      const rerunFailure = await runValidationCommands(
        input.gate,
        input.commands,
        input.accumulationSha,
        deps,
      );
      if (rerunFailure) {
        return markRepairChildStuck({
          childNumber: childForEngine.number,
          failure: rerunFailure,
          diagnostics: ["Aggregate validation remained red after already-satisfied repair child."],
          deps,
        });
      }
      const closeVerification = await runVerifiedHostMutation({
        mutate: () =>
          deps.closeChild({
            childNumber: childForEngine.number,
            comment: `Aggregate validation gate '${input.gate}' is now green without additional branch changes.`,
          }),
        readBack: () => deps.readChild({ childNumber: childForEngine.number }),
        verify: (value) => value.state === "CLOSED",
        describe: (value) => `issue state=${value.state}`,
      });
      if (!closeVerification.ok) {
        return {
          kind: "parent_failure",
          failure: firstFailure,
          diagnostics: closeVerification.diagnostics,
        };
      }
      return {
        kind: "repaired",
        childNumber: childForEngine.number,
        accumulationSha: input.accumulationSha,
      };
    }
    case "stuck":
      return markRepairChildStuck({
        childNumber: childForEngine.number,
        failure: firstFailure,
        diagnostics: [engine.lastFeedback],
        deps,
      });
    case "crashed":
      return markRepairChildStuck({
        childNumber: childForEngine.number,
        failure: firstFailure,
        diagnostics: [engine.error],
        deps,
      });
  }
}

async function markRepairChildStuck(input: {
  childNumber: number;
  failure: AggregateValidationFailure;
  diagnostics: string[];
  deps: AggregateValidationDeps;
}): Promise<{
  kind: "repair_child_stuck";
  childNumber: number;
  failure: AggregateValidationFailure;
  diagnostics: string[];
}> {
  await input.deps.markChildStuck({
    childNumber: input.childNumber,
    reason: [
      `Aggregate validation gate '${input.failure.gate}' remained red after this repair child.`,
      ...input.diagnostics,
      `Failing command: ${input.failure.command}`,
      input.failure.output.slice(-2000),
    ].join("\n\n"),
  });
  return {
    kind: "repair_child_stuck",
    childNumber: input.childNumber,
    failure: input.failure,
    diagnostics: input.diagnostics,
  };
}

async function runValidationCommands(
  gate: AggregateGate,
  commands: readonly string[],
  accumulationSha: string,
  deps: AggregateValidationDeps,
): Promise<AggregateValidationFailure | null> {
  for (const command of commands) {
    const result = await deps.runValidationCommand({ gate, command, accumulationSha });
    if (result.ok) continue;
    return {
      gate,
      command,
      exitCode: result.exitCode,
      output: sanitizeValidationOutput(result.output),
      accumulationSha,
    };
  }
  return null;
}

function buildRepairDraft(
  gate: AggregateGate,
  parentNumber: number,
  failure: AggregateValidationFailure,
): PublishChildDraft {
  const gateLabel = gate.replace("_", "-");
  return {
    title: `Repair ${gateLabel} aggregate validation for parent #${parentNumber}`,
    body: [
      `# Repair ${gateLabel} aggregate validation for parent #${parentNumber}`,
      "",
      "## User Story",
      "As a loop operator, I need the accumulation branch green so the parent can continue safely.",
      "",
      "## Context",
      `- Gate: ${failure.gate}`,
      `- Failing command: \`${failure.command}\``,
      `- Accumulation SHA: ${failure.accumulationSha}`,
      "",
      "## Failure Output",
      "```",
      failure.output,
      "```",
      "",
      "## Acceptance Criteria",
      "- the complete configured validation gate passes.",
    ].join("\n"),
    priority: "high",
    files: [],
    dedupeKey: `${gate}:${failure.command}:${failure.accumulationSha}`,
    source: "validation_repair",
  };
}

function sanitizeValidationOutput(output: string): string {
  return output
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+\b/gi, "$1 [REDACTED]")
    .replace(
      /\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)=([^\s\r\n]+)/g,
      (_match, key: string) => `${key}=[REDACTED]`,
    )
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .slice(-4000);
}
