import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./run-backlog-v3.mts", import.meta.url), "utf8");
const prdV4Path = new URL("./run-prd-v4.mts", import.meta.url);
const prdV4 = existsSync(prdV4Path) ? readFileSync(prdV4Path, "utf8") : undefined;
const backlogV2 = readFileSync(new URL("./run-backlog-v2.mts", import.meta.url), "utf8");

test("backlog-v3 routes the outer loop through Issue-as-PRD acquisition and orchestrator processing", () => {
  assert.match(source, /async function acquireNextIssueAsPrdParentForLoop\(/);
  assert.match(source, /async function processIssueAsPrdParent\(/);
  assert.match(source, /const skippedAmbiguousParentNumbers = new Set<number>\(\);/);
  assert.match(source, /parent = await acquireNextIssueAsPrdParentForLoop\(\);/);
  assert.match(source, /processed = await processIssueAsPrdParent\(parent\);/);
  // One parent's host-side crash must not kill the whole loop: the iteration
  // body is guarded and the crashed parent is quarantined for the run.
  assert.match(source, /Processing parent #\$\{parentNumber\} crashed; skipping it for this run\./);
  assert.match(source, /skippedAmbiguousParentNumbers\.add\(parentNumber\);/);
  assert.doesNotMatch(source, /const handledIssues = new Set<number>\(\)/);
});

test("backlog-v3 accepts coder and rework model CLI overrides", () => {
  assert.match(source, /--model-coder/);
  assert.match(source, /--model-rework/);
  assert.match(source, /const CODER_MODEL = modelCoderOverride \?\? LOOP_CONFIG\.models\.coder/);
  assert.match(source, /const REWORK_MODEL = modelReworkOverride \?\? LOOP_CONFIG\.models\.rework/);
});

test("backlog-v3 reads Issue-as-PRD parent comments through the REST issue client", () => {
  assert.match(
    source,
    /viewParent: \(parentNumber\) =>\s*issueClient\(\)\.viewIssue\(parentNumber\)/s,
  );
});

test("backlog-v3 runs the canonical PostgreSQL reset script without dirtying task worktrees", () => {
  assert.match(source, /import \{ resolveHostValidationCommand \} from "\.\/host-validation-command\.mts";/);
  assert.match(source, /const COPY_TO_WORKTREE: string\[\] = \[\];/);
  assert.match(source, /spawnSync\(\s*resolveHostValidationCommand\(input\.command, REPO_ROOT\)/s);
  assert.match(source, /spawnSync\(resolveHostValidationCommand\(cmd, REPO_ROOT\)/);
});

test("backlog-v3 prepares each aggregate-validation worktree before running its gate", () => {
  assert.match(source, /createAggregateValidationCommandRunner/);
  assert.match(source, /aggregateDependencySetupCommands/);
  assert.match(source, /aggregateValidationRunner\.close\(\)/);
});

test("backlog-v3 preserves the user-local tool path for host validation", () => {
  assert.match(source, /import \{ createHostCommandEnv \} from "\.\/host-command-env\.mts"/);
  assert.match(source, /const HOST_COMMAND_ENV = createHostCommandEnv\(\{/);
});

test("backlog-v3 pins child branch preparation to the accumulation base", () => {
  const start = source.indexOf("function rebaseStaleIssueBranchBeforeCoder(");
  const end = source.indexOf("function looksLikeWorkflowPollution(");
  assert.ok(start >= 0 && end > start, "expected shared-engine branch-preparation helpers");
  const helpers = source.slice(start, end);

  assert.match(source, /function countCommitsAheadOfBase\(worktreePath: string, baseRef: string\)/);
  assert.match(source, /rebaseStaleIssueBranchBeforeCoder\(\s*sandbox\.worktreePath,\s*issueBranch,\s*taskBaseRef,/s);
  assert.match(source, /prepareBranchForReview\(\s*sandbox\.worktreePath,\s*issueBranch,\s*taskBaseRef,/s);
  assert.match(source, /recoverFreshBranch\(\s*sandbox\.worktreePath,\s*issueBranch,\s*taskBaseRef,/s);
  assert.doesNotMatch(helpers, /originBaseRef\(\)/);
});

test("backlog-v3 wires the Task 17 terminal verification helpers", () => {
  assert.match(source, /function verifyTerminalChildren\(/);
  assert.match(source, /async function applyVerifiedParentTerminalLabels\(/);
  assert.match(source, /async function appendVerifiedParentComment\(/);
  assert.match(source, /if \(!childVerification\.ok\) \{/);
  assert.match(source, /if \(!labelVerification\.ok\) \{/);
  assert.match(source, /if \(!commentVerification\.ok\) \{/);
  assert.match(source, /return \{ stopLoop: true \};/);
});

test("backlog-v3 uses the Task 17 child and parent TUI host steps", () => {
  for (const step of [
    "parent_claim",
    "child_publication",
    "readiness_apply",
    "child_integration",
    "pre_review_refresh",
    "aggregate_validation",
    "full_parent_review",
    "deliver_review_ready",
  ]) {
    assert.match(source, new RegExp(`beginHostStep\\("${step}"`));
  }

  assert.match(
    source,
    /measuredRunDeps:\s*\{\s*beginAgentStep: \(agentStep\) => \{\s*tuiEmitter\.setTicket\(\{\s*number: child\.number,/s,
  );
  assert.match(source, /tuiEmitter\.setPhase\("extra_review"\)/);
  assert.match(source, /tuiEmitter\.setPhase\("normal_issue"\)/);
});

test("backlog-v3 wires Issue-as-PRD TUI agent stages and working logs", () => {
  assert.match(source, /stage: "initial_issue_decomposer"/);
  assert.match(source, /stage: "subtask_readiness"/);
  assert.match(source, /sessionAgents:\s*\{\s*code_quality:/s);
  assert.match(source, /sessionAgents:\s*\{[\s\S]*two_axis:/);
  assert.match(source, /sessionAgents:\s*\{[\s\S]*issue_decomposer:/);
  assert.match(source, /activeLogPath = tuiWorkingLogPath\(runName\)/);
  assert.match(source, /onAgentStreamEvent: tuiEmitter\.workingLogSink\(activeLogPath\)/);
  assert.match(source, /onStreamEvent: tuiEmitter\.workingLogSink\(coderActiveLogPath\)/);
  assert.match(source, /onStreamEvent: tuiEmitter\.workingLogSink\(reworkActiveLogPath\)/);
  assert.match(source, /tuiEmitter\.workingLogSink\(reviewerActiveLogPath\)/);
});

test("backlog-v3 runs decomposition and readiness through their strict agent definitions", () => {
  assert.match(source, /INITIAL_ISSUE_DECOMPOSER_AGENT_CONFIG/);
  assert.match(source, /SUBTASK_READINESS_AGENT_CONFIG/);
  assert.match(source, /INITIAL_ISSUE_DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE/);
  assert.match(source, /SUBTASK_READINESS_AGENT_SYSTEM_PROMPT_FILE/);
  assert.match(source, /writeAgentDefinitionFile\(\s*sandbox\.worktreePath,\s*agentDefinition\.config\.name,/s);
  assert.match(source, /agent: sandcastle\.opencode\(input\.model,\s*\{\s*agent: agentDefinition\.config\.name,/s);
});

test("backlog-v3 recovers a canonical tagged result from the current agent log", () => {
  assert.match(source, /extractSingleTaggedOutput/);
  assert.match(source, /const sessionLogPath = agentRunLogPath\(input\.branch, input\.runName\);/);
  assert.match(source, /extractSingleTaggedOutput\(readFileSync\(sessionLogPath, "utf8"\), outputTag\)/);
  assert.match(source, /if \(recoveredOutput\) return \{ stdout: recoveredOutput \};/);
});

test("backlog-v3 switches the TUI ticket between parent and child work", () => {
  assert.match(
    source,
    /tuiEmitter\.setTicket\(\{\s*number: parent\.number,\s*title: parent\.title,\s*branch: input\.state\.accumulationBranch,\s*\}\);\s*tuiEmitter\.beginHostStep\("parent_claim"/s,
  );
  assert.match(
    source,
    /measuredRunDeps:\s*\{\s*beginAgentStep: \(agentStep\) => \{\s*tuiEmitter\.setTicket\(\{\s*number: child\.number,\s*title: child\.title,\s*branch: childBranchName\(parent\.number, child\.number\),\s*\}\);\s*tuiEmitter\.beginAgentStep\(agentStep\);/s,
  );
  assert.match(
    source,
    /const childRecord = client\.viewIssue\(integration\.childNumber\);\s*tuiEmitter\.setTicket\(\{\s*number: childRecord\.number,\s*title: childRecord\.title,\s*branch: childBranchName\(parent\.number, childRecord\.number\),\s*\}\);\s*tuiEmitter\.beginHostStep\("child_integration"/s,
  );
  assert.match(
    source,
    /tuiEmitter\.setTicket\(\{\s*number: parent\.number,\s*title: parent\.title,\s*branch: currentState\.accumulationBranch,\s*\}\);\s*tuiEmitter\.beginHostStep\("pre_review_refresh"/s,
  );
  assert.match(
    source,
    /tuiEmitter\.setPhase\("normal_issue"\);\s*tuiEmitter\.setTicket\(\{\s*number: parent\.number,\s*title: parent\.title,\s*branch: currentState\.accumulationBranch,\s*\}\);\s*[\s\S]*?tuiEmitter\.beginHostStep\("deliver_review_ready"/,
  );
});

test("backlog-v3 keeps loop stop reasons separate from parent terminal outcomes", () => {
  assert.match(
    source,
    /let stopReason:\s*\|\s*"no_eligible_issue"\s*\|\s*"max_iterations"\s*=\s*"no_eligible_issue"/s,
  );
  assert.match(source, /const terminal = terminalActionForParentResult\(result\);/);
  assert.match(source, /if \(terminal\.kind === "deliver"\) \{/);
  assert.match(source, /const commentBody = \[\s*`Parent issue cannot continue automatically: \$\{terminal\.reason\}`/s);
});

test("backlog-v3 quarantines ownership-ambiguous parents for the current run and continues the queue", () => {
  assert.match(
    source,
    /"number,state,labels",\s*"--limit",\s*"200",\s*\]\)\.filter\(\(issue\) => !skippedAmbiguousParentNumbers\.has\(issue\.number\)\)/s,
  );
  assert.match(source, /if \(processed\.skippedParentNumber !== undefined\) \{/);
  assert.match(source, /skippedAmbiguousParentNumbers\.add\(processed\.skippedParentNumber\);/);
  assert.match(source, /tuiEmitter\.clearTicket\(\);/);
  assert.match(source, /continue;/);
});

test("backlog-v3 direct-parent work now targets the accumulation branch", () => {
  assert.match(source, /issueBranch: input\.accumulationBranch,/);
  assert.match(source, /sandboxBaseBranch: input\.accumulationBranch,/);
  assert.match(source, /taskBaseRef: input\.accumulationSha,/);
  assert.doesNotMatch(source, /issue-\$\{input\.parent\.number\}-direct-parent/);
});

test("older runners remain outside the Issue-as-PRD outer-loop wiring", () => {
  if (prdV4) {
    assert.doesNotMatch(prdV4, /runIssueAsPrdParent\(/);
    assert.doesNotMatch(prdV4, /acquireNextIssueAsPrdParentForLoop\(/);
  }
  assert.doesNotMatch(backlogV2, /runIssueAsPrdParent\(/);
  assert.doesNotMatch(backlogV2, /acquireNextIssueAsPrdParentForLoop\(/);
});
