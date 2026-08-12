import {
  initialNoProgressState,
  observeFailedRoundFingerprint,
  sha1,
  type FailedRoundFingerprint,
  type NoProgressState,
} from "./loop-progress.mts";
import type { StuckTerminalReason } from "./mark-stuck-comment.mts";
import {
  sanitizeReviewerExcerpt,
  type ReviewResult,
  type ReviewerParseFailureCode,
} from "./reviewer-result.mts";

export interface PerBranchTask {
  number: number;
  title: string;
  body: string;
  comments: string;
  branch: string;
  baseRef: string;
}

export interface PerBranchEnginePolicy {
  maxReviewRounds: number;
  coderMaxIterations: number;
  failedRoundRepeatLimit: number;
  maxRecoveryAttempts: number;
  reviewerMaxAttempts: number;
  reviewDiffMaxBytes: number;
  preCoderRebaseGuard: boolean;
  hostOnlyReviewAfterBaseAdvance: boolean;
}

export type PerBranchEngineOutcome =
  | {
      kind: "approved";
      reviewedBaseSha: string;
      approvedHeadSha: string;
      roundsUsed: number;
    }
  | {
      kind: "already_satisfied";
      reviewedBaseSha: string;
      headSha: string;
      evidence: string;
      roundsUsed: number;
    }
  | {
      kind: "stuck";
      reason: StuckTerminalReason;
      headSha: string;
      lastFeedback: string;
      roundsUsed: number;
    }
  | {
      kind: "crashed";
      headSha?: string;
      error: string;
      roundsUsed: number;
    };

export interface EngineSandbox {
  worktreePath: string;
  close(): Promise<void>;
}

export type EngineCoderResult =
  | { kind: "committed"; committedCount: number }
  | { kind: "already_satisfied"; evidence: string }
  | { kind: "blocked"; feedback: string }
  | { kind: "livelock"; feedback: string }
  | { kind: "failed"; feedback: string };

export type EnginePrepResult =
  | { ok: true; reviewedBaseSha: string }
  | {
      ok: false;
      feedback: string;
      recoverable: boolean;
      failureFingerprint?: FailedRoundFingerprint;
    };

export type EngineValidationResult =
  | { ok: true }
  | {
      ok: false;
      command: string;
      exitCode: number;
      feedback: string;
      failureSignature?: string;
    };

export interface EngineReviewContext {
  baseSha: string;
  diff: string;
  diffBytes: number;
  diffStat: string;
  changedFiles: string[];
  reviewAspects: string[];
  ecosystems: string[];
}

interface EngineReviewerAcquisitionBase {
  resultSource: "stdout" | "run_log" | "none";
  logFallbackUsed: boolean;
  logFilePath?: string;
  diagnostics: string[];
  excerpt?: string;
}

export type EngineReviewerAcquisitionResult =
  | (EngineReviewerAcquisitionBase & {
      kind: "verdict";
      review: ReviewResult;
    })
  | (EngineReviewerAcquisitionBase & {
      kind: "parse_failed";
      code: ReviewerParseFailureCode;
    })
  | (EngineReviewerAcquisitionBase & {
      kind: "incomplete";
      code: "missing_tag" | "host_input_limit";
    });

export interface PerBranchEngineDeps {
  createSandbox(task: PerBranchTask): Promise<EngineSandbox>;
  preCoderRebaseGuard(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
  }): Promise<{ ok: true } | { ok: false; feedback: string }>;
  invokeCoder(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    round: number;
    feedback: string;
    isRework: boolean;
    maxIterations: number;
  }): Promise<EngineCoderResult>;
  prepareBranchForReview(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    round: number;
  }): Promise<EnginePrepResult>;
  recoverBranch(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    attempt: number;
    feedback: string;
  }): Promise<{ ok: boolean; feedback: string }>;
  computeReviewContext(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    reviewedBaseSha: string;
  }): Promise<EngineReviewContext>;
  runValidation(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    round: number;
  }): Promise<EngineValidationResult>;
  acquireReviewer(input: {
    task: PerBranchTask;
    sandbox: EngineSandbox;
    round: number;
    attempt: number;
    context: EngineReviewContext;
  }): Promise<EngineReviewerAcquisitionResult>;
  currentHeadSha(sandbox: EngineSandbox): string;
  currentTreeSha(sandbox: EngineSandbox): string;
  onHostStep?(name: string, detail?: string): void;
  /**
   * Optional escalation-ladder hook. Returns the model identity that
   * `invokeCoder` will run for this round. When the identity changes between
   * rounds the engine clears its no-progress fingerprint history.
   *
   * This reset is load-bearing, not cosmetic. `failedRoundRepeatLimit` stops a
   * task once the same fingerprint repeats, which encodes the inference "same
   * model, same input, same failure, therefore further attempts are pointless".
   * A model change invalidates that inference. Without the reset, a task whose
   * cheap model produces an identical failure on rounds 1..N is killed by the
   * repeat limit at exactly the round the ladder would have escalated it —
   * i.e. the ladder would never fire on the tasks that most need it.
   *
   * Callers with a single fixed model omit this and keep the previous
   * behaviour: no resets, one continuous fingerprint history.
   */
  agentModelForRound?(input: { round: number; isRework: boolean }): string;
  /** Notified after the engine resets fingerprint history for a model change. */
  onModelEscalation?(input: {
    round: number;
    fromModel: string;
    toModel: string;
  }): void;
}

export interface PerBranchEngineInput {
  task: PerBranchTask;
  policy: PerBranchEnginePolicy;
  deps: PerBranchEngineDeps;
}

const HOST_ONLY_REVIEW_MAX_ATTEMPTS = 2;

export async function runPerBranchEngine(
  input: PerBranchEngineInput,
): Promise<PerBranchEngineOutcome> {
  const { task, policy, deps } = input;
  const sandbox = await deps.createSandbox(task);
  let roundsUsed = 0;
  let lastFeedback = "";
  let feedback = "";
  let progressState = initialNoProgressState();
  let hostOnlyReview = false;
  let hostOnlyReviewAttempts = 0;
  let lastAgentModel: string | null = null;

  try {
    for (let round = 1; round <= policy.maxReviewRounds; round++) {
      roundsUsed = round;

      if (!hostOnlyReview && round === 1 && policy.preCoderRebaseGuard) {
        deps.onHostStep?.("branch_prep", task.branch);
        const guard = await deps.preCoderRebaseGuard({ task, sandbox });
        if (!guard.ok) {
          // A stale branch that no longer rebases cleanly is agent-resolvable:
          // hand the guard's findings to the coder as round-1 rework feedback
          // instead of declaring the issue stuck before any agent has run.
          feedback = guard.feedback;
          lastFeedback = feedback;
        }
      }

      if (!hostOnlyReview) {
        const isRework = round > 1 || feedback !== "";

        // Escalation ladder: a change of model invalidates the accumulated
        // no-progress history, so clear it before the new model gets its first
        // attempt. See `agentModelForRound` on PerBranchEngineDeps.
        if (deps.agentModelForRound) {
          const agentModel = deps.agentModelForRound({ round, isRework });
          if (lastAgentModel !== null && agentModel !== lastAgentModel) {
            progressState = initialNoProgressState();
            deps.onModelEscalation?.({
              round,
              fromModel: lastAgentModel,
              toModel: agentModel,
            });
          }
          lastAgentModel = agentModel;
        }

        let coderResult: EngineCoderResult;
        try {
          coderResult = await deps.invokeCoder({
            task,
            sandbox,
            round,
            feedback,
            isRework,
            maxIterations: policy.coderMaxIterations,
          });
        } catch (error) {
          const crash = observeAgentInvocationCrash(
            progressState,
            "coder",
            round,
            error,
            policy.failedRoundRepeatLimit,
          );
          progressState = crash.state;
          feedback = crash.feedback;
          lastFeedback = feedback;
          if (crash.stalled) {
            return {
              kind: "crashed",
              headSha: safeHeadSha(deps, sandbox),
              error: crash.error,
              roundsUsed: round,
            };
          }
          continue;
        }
        switch (coderResult.kind) {
          case "already_satisfied":
            return {
              kind: "already_satisfied",
              reviewedBaseSha: "",
              headSha: safeHeadSha(deps, sandbox),
              evidence: coderResult.evidence,
              roundsUsed: round,
            };
          case "blocked":
            return stuckOutcome(
              deps,
              sandbox,
              "blocked",
              coderResult.feedback,
              round,
            );
          case "livelock":
            return stuckOutcome(
              deps,
              sandbox,
              "stuck_livelock",
              coderResult.feedback,
              round,
            );
          case "failed":
            feedback = coderResult.feedback;
            lastFeedback = feedback;
            continue;
          case "committed":
            break;
        }
      } else {
        hostOnlyReview = false;
      }

      deps.onHostStep?.("branch_prep", task.branch);
      const prep = await prepareForReviewWithRecovery(
        deps,
        task,
        sandbox,
        round,
        policy.maxRecoveryAttempts,
      );
      if (!prep.ok) {
        const fingerprint =
          prep.failureFingerprint ?? inferPrepFailureFingerprint(prep.feedback);
        const progress = observeFailedRoundFingerprint(
          progressState,
          fingerprint,
          policy.failedRoundRepeatLimit,
        );
        progressState = progress.state;
        feedback = prep.feedback;
        lastFeedback = feedback;
        if (progress.stalled) {
          return stuckOutcome(
            deps,
            sandbox,
            "stuck_no_progress",
            formatNoProgressFeedback({
              round,
              source: fingerprint.source,
              repeatedCount: progress.state.repeatCount,
              signatureSummary: fingerprint.signatureSummary,
              lastFeedback: feedback,
            }),
            round,
          );
        }
        continue;
      }

      const reviewContext = await deps.computeReviewContext({
        task,
        sandbox,
        reviewedBaseSha: prep.reviewedBaseSha,
      });

      if (reviewContext.diffBytes > policy.reviewDiffMaxBytes) {
        feedback = formatDiffTooLargeFeedback(
          reviewContext,
          policy.reviewDiffMaxBytes,
        );
        lastFeedback = feedback;
        const progress = observeFailedRoundFingerprint(
          progressState,
          {
            diffHash: sha1(normalizeForHash(reviewContext.diff)),
            source: "diff_too_large",
            signatureHash: sha1(String(policy.reviewDiffMaxBytes)),
            signatureSummary: `review diff exceeds ${policy.reviewDiffMaxBytes} bytes`,
          },
          policy.failedRoundRepeatLimit,
        );
        progressState = progress.state;
        if (progress.stalled) {
          return stuckOutcome(
            deps,
            sandbox,
            "stuck_no_progress",
            formatNoProgressFeedback({
              round,
              source: "diff_too_large",
              repeatedCount: progress.state.repeatCount,
              signatureSummary: `review diff exceeds ${policy.reviewDiffMaxBytes} bytes`,
              lastFeedback: feedback,
            }),
            round,
          );
        }
        continue;
      }

      deps.onHostStep?.("validation");
      const validation = await deps.runValidation({ task, sandbox, round });
      if (!validation.ok) {
        const fingerprint = buildValidationFailureFingerprint(
          validation.failureSignature ??
            `${validation.command} :: exit ${validation.exitCode}`,
        );
        const progress = observeFailedRoundFingerprint(
          progressState,
          fingerprint,
          policy.failedRoundRepeatLimit,
        );
        progressState = progress.state;
        feedback = validation.feedback;
        lastFeedback = feedback;
        if (progress.stalled) {
          return stuckOutcome(
            deps,
            sandbox,
            "stuck_no_progress",
            formatNoProgressFeedback({
              round,
              source: fingerprint.source,
              repeatedCount: progress.state.repeatCount,
              signatureSummary: fingerprint.signatureSummary,
              lastFeedback: feedback,
            }),
            round,
          );
        }
        continue;
      }

      let repeatRoundWithoutCoder = false;
      for (let attempt = 1; attempt <= policy.reviewerMaxAttempts; attempt++) {
        let acquisition: EngineReviewerAcquisitionResult;
        try {
          acquisition = await deps.acquireReviewer({
            task,
            sandbox,
            round,
            attempt,
            context: reviewContext,
          });
        } catch (error) {
          const crash = observeAgentInvocationCrash(
            progressState,
            "reviewer",
            round,
            error,
            policy.failedRoundRepeatLimit,
          );
          progressState = crash.state;
          feedback = crash.feedback;
          lastFeedback = feedback;
          if (crash.stalled) {
            return {
              kind: "crashed",
              headSha: safeHeadSha(deps, sandbox),
              error: crash.error,
              roundsUsed: round,
            };
          }
          if (attempt < policy.reviewerMaxAttempts) continue;
          // Attempts exhausted on an infrastructure crash, not a review
          // verdict: repeat the round host-only so the reviewer gets a fresh
          // attempt budget without re-running the coder on unchanged work.
          hostOnlyReview = true;
          repeatRoundWithoutCoder = true;
          break;
        }
        if (acquisition.kind === "verdict") {
          const review = acquisition.review;
          if (review.decision === "approved") {
            if (policy.hostOnlyReviewAfterBaseAdvance) {
              deps.onHostStep?.("branch_prep", task.branch);
              const refreshed = await deps.prepareBranchForReview({
                task,
                sandbox,
                round,
              });
              if (!refreshed.ok) {
                feedback = refreshed.feedback;
                lastFeedback = feedback;
                break;
              }
              if (refreshed.reviewedBaseSha !== reviewContext.baseSha) {
                if (hostOnlyReviewAttempts < HOST_ONLY_REVIEW_MAX_ATTEMPTS) {
                  hostOnlyReviewAttempts++;
                  hostOnlyReview = true;
                  repeatRoundWithoutCoder = true;
                  break;
                }
                feedback = formatBaseAdvanceFeedback(
                  task.baseRef,
                  reviewContext.baseSha,
                  refreshed.reviewedBaseSha,
                );
                lastFeedback = feedback;
                break;
              }
            }
            return {
              kind: "approved",
              reviewedBaseSha: reviewContext.baseSha,
              approvedHeadSha: safeHeadSha(deps, sandbox),
              roundsUsed: round,
            };
          }
          if (review.decision === "needs_human_review") {
            return stuckOutcome(
              deps,
              sandbox,
              "stuck_needs_human_review",
              formatReviewerAcquisitionFeedback({
                header: "## Reviewer requested human review",
                round,
                attempt,
                maxAttempts: policy.reviewerMaxAttempts,
                runName: `reviewer #${task.number} r${round} a${attempt}`,
                reviewBaseSha: reviewContext.baseSha,
                candidateHeadSha: safeHeadSha(deps, sandbox),
                candidateTreeSha: deps.currentTreeSha(sandbox),
                logFilePath: acquisition.logFilePath,
                resultSource: acquisition.resultSource,
                failureCode: "needs_human_review",
                excerpt: sanitizeReviewerExcerpt(JSON.stringify(review)),
                diagnostics: acquisition.diagnostics,
              }),
              round,
            );
          }

          feedback = formatFeedback(review);
          lastFeedback = feedback;
          const fingerprint = buildReviewerFailureFingerprint(
            reviewContext.diff,
            review,
          );
          const progress = observeFailedRoundFingerprint(
            progressState,
            fingerprint,
            policy.failedRoundRepeatLimit,
          );
          progressState = progress.state;
          if (progress.stalled) {
            return stuckOutcome(
              deps,
              sandbox,
              "stuck_no_progress",
              formatNoProgressFeedback({
                round,
                source: fingerprint.source,
                repeatedCount: progress.state.repeatCount,
                signatureSummary: fingerprint.signatureSummary,
                lastFeedback: feedback,
              }),
              round,
            );
          }
          break;
        }

        const terminalFeedback = formatReviewerAcquisitionFeedback({
          header:
            acquisition.kind === "parse_failed"
              ? "## Reviewer parse failure"
              : "## Reviewer incomplete",
          round,
          attempt,
          maxAttempts: policy.reviewerMaxAttempts,
          runName: `reviewer #${task.number} r${round} a${attempt}`,
          reviewBaseSha: reviewContext.baseSha,
          candidateHeadSha: safeHeadSha(deps, sandbox),
          candidateTreeSha: deps.currentTreeSha(sandbox),
          logFilePath: acquisition.logFilePath,
          resultSource: acquisition.resultSource,
          failureCode: acquisition.code,
          excerpt: sanitizeReviewerAcquisitionExcerpt(acquisition),
          diagnostics: acquisition.diagnostics,
        });
        if (acquisition.code === "host_input_limit") {
          const fingerprint = buildReviewerAcquisitionFailureFingerprint(
            reviewContext.diff,
            acquisition,
          );
          const progress = observeFailedRoundFingerprint(
            progressState,
            fingerprint,
            policy.failedRoundRepeatLimit,
          );
          progressState = progress.state;
          feedback = terminalFeedback;
          lastFeedback = feedback;
          if (progress.stalled) {
            return stuckOutcome(
              deps,
              sandbox,
              "stuck_no_progress",
              formatNoProgressFeedback({
                round,
                source: fingerprint.source,
                repeatedCount: progress.state.repeatCount,
                signatureSummary: fingerprint.signatureSummary,
                lastFeedback: feedback,
              }),
              round,
            );
          }
          break;
        }
        if (attempt < policy.reviewerMaxAttempts) {
          lastFeedback = terminalFeedback;
          continue;
        }
        return stuckOutcome(
          deps,
          sandbox,
          acquisition.kind === "parse_failed"
            ? "stuck_reviewer_parse_failure"
            : "stuck_reviewer_incomplete",
          terminalFeedback,
          round,
        );
      }

      if (repeatRoundWithoutCoder) {
        round -= 1;
      }
    }

    return stuckOutcome(
      deps,
      sandbox,
      "stuck_rounds_exhausted",
      lastFeedback || "(no feedback recorded)",
      roundsUsed,
    );
  } catch (error) {
    return {
      kind: "crashed",
      headSha: safeHeadSha(deps, sandbox),
      error: sanitizeCrashError(error),
      roundsUsed,
    };
  } finally {
    await sandbox.close();
  }
}

async function prepareForReviewWithRecovery(
  deps: PerBranchEngineDeps,
  task: PerBranchTask,
  sandbox: EngineSandbox,
  round: number,
  maxRecoveryAttempts: number,
): Promise<EnginePrepResult> {
  let prep = await deps.prepareBranchForReview({ task, sandbox, round });
  let attempt = 0;
  while (!prep.ok && prep.recoverable && attempt < maxRecoveryAttempts) {
    attempt++;
    const recovered = await deps.recoverBranch({
      task,
      sandbox,
      attempt,
      feedback: prep.feedback,
    });
    if (!recovered.ok) {
      return { ok: false, feedback: recovered.feedback, recoverable: false };
    }
    prep = await deps.prepareBranchForReview({ task, sandbox, round });
  }
  return prep;
}

function safeHeadSha(deps: PerBranchEngineDeps, sandbox: EngineSandbox): string {
  try {
    return deps.currentHeadSha(sandbox);
  } catch {
    return "";
  }
}

// A thrown agent invocation (opencode exiting non-zero, an idle timeout, a
// transient provider failure) is usually recoverable by simply running the
// agent again. Track the crash as a failed-round fingerprint so retries stop
// once the identical crash keeps repeating — that is a persistent
// infrastructure failure and genuinely terminal.
function observeAgentInvocationCrash(
  state: NoProgressState,
  stage: "coder" | "reviewer",
  round: number,
  error: unknown,
  repeatLimit: number,
): {
  state: NoProgressState;
  stalled: boolean;
  error: string;
  feedback: string;
} {
  const message = sanitizeCrashError(error);
  const progress = observeFailedRoundFingerprint(
    state,
    {
      diffHash: sha1(`agent-invocation-crash:${stage}`),
      source: "agent_invocation_crash",
      signatureHash: sha1(normalizeForHash(message)),
      signatureSummary: normalizeSignatureSummary(message),
    },
    repeatLimit,
  );
  return {
    state: progress.state,
    stalled: progress.stalled,
    error: message,
    feedback: [
      "## Agent invocation crashed",
      "",
      `The ${stage} agent process failed on round ${round} before completing. This was a host/agent infrastructure failure, not feedback about the code.`,
      "",
      "Error:",
      "```",
      message.slice(0, 2000),
      "```",
      "",
      "No code changes are required in response to this error. Continue the issue from the current branch state.",
    ].join("\n"),
  };
}

function sanitizeCrashError(error: unknown): string {
  const text = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+\b/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|api_key|token|secret|password|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}: [REDACTED]`,
    )
    .slice(0, 4000);
}

function stuckOutcome(
  deps: PerBranchEngineDeps,
  sandbox: EngineSandbox,
  reason: StuckTerminalReason,
  lastFeedback: string,
  roundsUsed: number,
): PerBranchEngineOutcome {
  return {
    kind: "stuck",
    reason,
    headSha: safeHeadSha(deps, sandbox),
    lastFeedback,
    roundsUsed,
  };
}

function normalizeForHash(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeSignatureSummary(value: string): string {
  return value.replace(/\r\n/g, "\n").trim().slice(0, 300);
}

function buildValidationFailureFingerprint(signature: string): FailedRoundFingerprint {
  const normalizedSignature = normalizeForHash(signature);
  return {
    // Validation failures are caused by the host gate, not by the textual
    // review diff. If a reworker keeps changing files but the same gate fails
    // with the same salient signature, that is no progress and should stop
    // before exhausting every review round.
    diffHash: sha1(normalizedSignature),
    source: "validation",
    signatureHash: sha1(normalizedSignature),
    signatureSummary: normalizeSignatureSummary(signature),
  };
}

function buildReviewerFailureFingerprint(
  reviewDiff: string,
  review: ReviewResult,
): FailedRoundFingerprint {
  const canonicalFindings = review.findings.map((finding) => ({
    problem: normalizeForHash(finding.problem),
    remediation: normalizeForHash(finding.remediation),
    file: finding.file ?? "",
    line: finding.line ?? null,
  }));
  return {
    diffHash: sha1(normalizeForHash(reviewDiff)),
    source: "reviewer_changes_requested",
    signatureHash: sha1(JSON.stringify(canonicalFindings)),
    signatureSummary: canonicalFindings
      .slice(0, 2)
      .map((finding) => finding.problem)
      .join(" | ")
      .slice(0, 300),
  };
}

function buildReviewerAcquisitionFailureFingerprint(
  reviewDiff: string,
  acquisition: Extract<
    EngineReviewerAcquisitionResult,
    { kind: "incomplete" | "parse_failed" }
  >,
): FailedRoundFingerprint {
  return {
    diffHash: sha1(normalizeForHash(reviewDiff)),
    source:
      acquisition.code === "host_input_limit"
        ? "review_input_limit"
        : acquisition.kind === "parse_failed"
          ? "reviewer_parse_failure"
          : "reviewer_incomplete",
    signatureHash: sha1(
      normalizeForHash(
        [
          acquisition.kind,
          acquisition.code,
          acquisition.resultSource,
          acquisition.diagnostics.join("\n"),
        ].join("\n"),
      ),
    ),
    signatureSummary:
      acquisition.code === "host_input_limit"
        ? "reviewer prompt exceeded host input/argv limit before the reviewer could run"
        : normalizeSignatureSummary(
            `${acquisition.kind}:${acquisition.code}${
              acquisition.diagnostics.length > 0
                ? ` ${acquisition.diagnostics.join("; ")}`
                : ""
            }`,
          ),
  };
}

function inferPrepFailureFingerprint(feedback: string): FailedRoundFingerprint {
  const normalized = normalizeForHash(feedback);
  let source: FailedRoundFingerprint["source"] = "branch_prep";
  let signatureSummary = feedback.split("\n", 1)[0]?.trim() || "branch prep failed";
  if (feedback.startsWith("## Diff includes workflow-file pollution")) {
    source = "workflow_pollution";
    signatureSummary = "workflow-only files changed outside issue scope";
  } else if (feedback.startsWith("## Diff too large to review")) {
    source = "diff_too_large";
    signatureSummary = "review diff exceeds configured byte limit";
  }
  return {
    diffHash: sha1(normalized),
    source,
    signatureHash: sha1(normalized),
    signatureSummary,
  };
}

function sanitizeReviewerAcquisitionExcerpt(
  acquisition: EngineReviewerAcquisitionResult,
): string {
  return typeof acquisition.excerpt === "string" && acquisition.excerpt.trim()
    ? sanitizeReviewerExcerpt(acquisition.excerpt)
    : "(reviewer output unavailable via shared engine)";
}

function formatFeedback(review: ReviewResult): string {
  const header =
    review.decision === "needs_human_review"
      ? "## Reviewer flagged human review (treat as blocking)"
      : "## Reviewer requested changes";
  const findings =
    review.findings.length === 0
      ? "(reviewer listed no specific findings)"
      : review.findings
          .map((f, i) => {
            const loc = [f.file, f.line ? `line ${f.line}` : null]
              .filter(Boolean)
              .join(" ");
            const meta = [
              f.aspect ? `aspect: ${f.aspect}` : null,
              typeof f.confidence === "number"
                ? `confidence: ${f.confidence}`
                : null,
              f.severity ? `severity: ${f.severity}` : null,
            ]
              .filter(Boolean)
              .join(", ");
            return [
              `### Finding ${i + 1}${loc ? ` (${loc})` : ""}`,
              meta ? `_${meta}_` : "",
              "",
              `**Problem:** ${f.problem}`,
              "",
              `**Fix:** ${f.remediation}`,
            ]
              .filter((line) => line !== "")
              .join("\n");
          })
          .join("\n\n");
  return [header, "", `**Summary:** ${review.summary}`, "", findings].join(
    "\n",
  );
}

function formatNoProgressFeedback(input: {
  round: number;
  source: string;
  repeatedCount: number;
  signatureSummary: string;
  lastFeedback: string;
}): string {
  return [
    "## No progress",
    "",
    `Stopped early after round ${input.round}: the same failed ${input.source} outcome repeated ${input.repeatedCount + 1} times in total.`,
    "",
    `Repeated outcome source: ${input.source}`,
    `Signature summary: ${input.signatureSummary || "(none)"}`,
    `Repeat count: ${input.repeatedCount + 1} total identical failures`,
    "",
    "Last feedback:",
    "",
    input.lastFeedback || "(none recorded)",
  ].join("\n");
}

function formatReviewerAcquisitionFeedback(input: {
  header: string;
  round: number;
  attempt: number;
  maxAttempts: number;
  runName: string;
  reviewBaseSha: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  logFilePath?: string;
  resultSource: "stdout" | "run_log" | "none";
  failureCode: string;
  excerpt: string;
  diagnostics: string[];
}): string {
  return [
    input.header,
    "",
    `Issue round: ${input.round}`,
    `Reviewer attempt: ${input.attempt}/${input.maxAttempts}`,
    `Reviewer run: ${input.runName}`,
    `Review base SHA: ${input.reviewBaseSha}`,
    `Candidate HEAD: ${input.candidateHeadSha}`,
    `Candidate tree: ${input.candidateTreeSha}`,
    `Reviewer log: ${input.logFilePath ?? "(unavailable)"}`,
    `Result source: ${input.resultSource}`,
    `Failure code: ${input.failureCode}`,
    input.diagnostics.length > 0
      ? `Diagnostics: ${input.diagnostics.join("; ")}`
      : null,
    "",
    "Reviewer excerpt:",
    "",
    input.excerpt || "(no assistant excerpt available)",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDiffTooLargeFeedback(
  context: EngineReviewContext,
  reviewDiffMaxBytes: number,
): string {
  return [
    "## Diff too large to review",
    "",
    `The review diff is ${context.diffBytes} bytes, above the ${reviewDiffMaxBytes} byte limit.`,
    "",
    "This exceeds the configured maximum size for a single reviewable branch diff. The host will not invoke the reviewer above this policy limit.",
    "",
    "Remove unrelated or generated changes from the branch. If the work genuinely requires a larger change, split it into smaller reviewable units and keep this branch scoped to what fits.",
    "",
    "Changed files:",
    "```",
    context.changedFiles.join("\n").slice(0, 3000) || "(none)",
    "```",
    "",
    "Diff stat:",
    "```",
    context.diffStat.slice(0, 3000),
    "```",
  ].join("\n");
}

function formatBaseAdvanceFeedback(
  baseRef: string,
  reviewedBaseSha: string,
  currentBaseSha: string,
): string {
  return [
    "## Base branch keeps advancing after review",
    "",
    `${baseRef} advanced from reviewed base ${reviewedBaseSha} to ${currentBaseSha} after validation/review completed.`,
    "",
    "The host already retried re-sync/re-validation/re-review twice. Continue from the current branch and emit `<promise>COMPLETE</promise>` so the host can try again.",
  ].join("\n");
}
