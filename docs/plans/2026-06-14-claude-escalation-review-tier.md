# Claude Escalation Review Tier — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green (typecheck + tests) before moving on.

**Goal:** Add a one-shot, terminal "escalation" review tier that runs two Claude-driven reviews (`/code-review` + `/two-axis-review` skills) after the GLM extra-review loop cleanly exhausts, decomposes their findings into follow-up issues via the existing opencode decomposer, drains those issues once with the normal loop, then stops.

**Architecture:** A new gh entry file (`run-prd-extra-review-custom-agents-shared-cache-with-claude.mts`) forks the existing shared-cache loop. After `runBoundedExtraReviewMainLoop` returns a *clean* terminal reason, it runs one escalation round that reuses `runSequentialExtraReviewSessions` (minimally generalized to accept per-session definition overrides). The two reviewer sessions use `sandcastle.claudeCode(ESCALATION_REVIEW_MODEL)` with new prompt files that invoke the host Claude review skills and pin output to the existing `<extra_review>` JSON contract; the decomposer session is unchanged (opencode, GLM model). Follow-up issues are published exactly like GLM, then drained by re-invoking the main loop with `maxExtraReviewRounds: 0`. Claude sessions get the host `~/.claude` mounted writable for subscription auth.

**Tech Stack:** TypeScript `.mts` (Node ESM), `@ai-hero/sandcastle` (`opencode`, `claudeCode`, `createSandbox`, `docker`), `node:test` + `node:assert/strict`, `gh` CLI.

---

## Design decisions (locked during grilling)

- **Placement:** one-shot terminal tier. Never re-runs itself.
- **Trigger:** only on clean exhaustion reasons `max_extra_review_rounds`, `no_work`, `duplicate_only`. Skip on every other reason.
- **Orchestration:** minimally generalize `runSequentialExtraReviewSessions` with per-session definition overrides (defaults preserve the GLM path byte-for-byte).
- **Output contract:** Claude invokes the skills but emits the same `<extra_review>` tagged-JSON the GLM reviewers emit → parsers + decomposer reused unchanged.
- **Mount/auth:** whole host `~/.claude` mounted writable; subscription OAuth (no API key env).
- **Model config:** single new role `models.escalationReview`; decomposer stays on GLM `issueDecomposer`.
- **Diff source:** Claude runs read-only git in the worktree; `{commit}` = resolved review-base SHA (new `REVIEW_BASE_SHA` prompt arg); `{prd path}` = synced PRD body file.
- **Drain:** re-invoke `runBoundedExtraReviewMainLoop` with `maxExtraReviewRounds: 0`.
- **Invocation:** explicit slash for both (`/code-review`, `/two-axis-review`); operator ensures `/code-review` resolves to the skill (official code-review plugin disabled / skill wins) in the mounted `~/.claude`.

See `CONTEXT.md` → **Escalation review round** for the canonical glossary entry.

---

## File structure

**Modify:**
- `sandcastle-loop-config.mts` — add `escalationReview` role to `SandcastleLoopRoleModels` + `DEFAULT_MODELS`.
- `extra-review-config.mts` — add escalation prompt-file + max-iteration constants.
- `extra-review-sessions.mts` — extend `sharedReviewerPromptArgs` with review-base/head SHAs; add optional `sessionDefinitions` override to `runSequentialExtraReviewSessions`.

**Create:**
- `escalation-review-trigger.mts` — pure `shouldRunEscalationReview(reason)` predicate + clean-reason set.
- `escalation-review-trigger.test.mts` — unit tests for the predicate.
- `escalation-review-sessions.test.mts` — tests for `sessionDefinitions` override + extended prompt args.
- `.sandcastle/escalation-code-review-prompt-prd.md` — Claude code-quality prompt (invokes `/code-review`, pins `<extra_review>` JSON).
- `.sandcastle/escalation-two-axis-review-prompt-prd.md` — Claude two-axis prompt (invokes `/two-axis-review`, pins `<extra_review>` JSON).
- `run-prd-extra-review-custom-agents-shared-cache-with-claude.mts` — new entry file.

---

## Task 1: Add the `escalationReview` model role

**Files:**
- Modify: `sandcastle-loop-config.mts:7-14` (`SandcastleLoopRoleModels`)
- Modify: `sandcastle-loop-config.mts:57-64` (`DEFAULT_MODELS`)

- [ ] **Step 1: Add the role to the interface**

In `SandcastleLoopRoleModels`, add the field after `issueDecomposer`:

```ts
export interface SandcastleLoopRoleModels {
  coder: string;
  rework: string;
  reviewer: string;
  codeQuality: string;
  twoAxis: string;
  issueDecomposer: string;
  escalationReview: string;
}
```

- [ ] **Step 2: Add the default value**

In `DEFAULT_MODELS`, add a default Claude model id (operator overrides via `.sandcastle/config.mts`):

```ts
const DEFAULT_MODELS: SandcastleLoopRoleModels = {
  coder: "strix/qwen3.6-35b-a3b-8bit",
  rework: "strix/qwen3.6-35b-a3b-8bit",
  reviewer: "zai-coding-plan/glm-5.1",
  codeQuality: "zai-coding-plan/glm-5.1",
  twoAxis: "zai-coding-plan/glm-5.1",
  issueDecomposer: "zai-coding-plan/glm-5.1",
  escalationReview: "anthropic/claude-sonnet-4-5",
};
```

> Note: confirm the exact `claudeCode` model string your sandcastle build expects during the Task 8 smoke test; adjust the default if needed. The merge in `loadSandcastleLoopConfig` (`{ ...DEFAULT_MODELS, ...userConfig.models }`) already covers the new key.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add sandcastle-loop-config.mts
git commit -m "feat(config): add escalationReview model role"
```

---

## Task 2: Add escalation constants

**Files:**
- Modify: `extra-review-config.mts`

- [ ] **Step 1: Append escalation constants**

Add to the end of `extra-review-config.mts`:

```ts
export const ESCALATION_REVIEWER_MAX_ITERATIONS = 40;

export const ESCALATION_CODE_REVIEW_PROMPT_FILE =
  "./.sandcastle/escalation-code-review-prompt-prd.md";
export const ESCALATION_TWO_AXIS_REVIEW_PROMPT_FILE =
  "./.sandcastle/escalation-two-axis-review-prompt-prd.md";
```

> Rationale for 40: the skills spawn parallel sub-agents and run their own `git diff`, so reviewers need more turns than the GLM `EXTRA_REVIEWER_MAX_ITERATIONS` (20); the `</extra_review>` completion signal still stops them early.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extra-review-config.mts
git commit -m "feat(config): add escalation reviewer prompt + iteration constants"
```

---

## Task 3: Extend `sharedReviewerPromptArgs` with review-base/head SHAs

**Files:**
- Modify: `extra-review-sessions.mts:358-369` (`sharedReviewerPromptArgs`)
- Test: `escalation-review-sessions.test.mts` (created in Task 4 step 1; the assertion lives there)

- [ ] **Step 1: Add the new args**

Replace the body of `sharedReviewerPromptArgs`:

```ts
export function sharedReviewerPromptArgs(
  metadata: ExtraReviewInputMetadata,
): Record<string, string> {
  return {
    PRD_NUMBER: String(metadata.prd_number),
    PRD_BODY_PATH: metadata.input_files.prd_body,
    REVIEW_METADATA_PATH: metadata.input_files.metadata,
    CHANGED_FILES_PATH: metadata.input_files.changed_files,
    DIFF_STAT_PATH: metadata.input_files.diff_stat,
    DIFF_PATH: metadata.input_files.diff,
    REVIEW_BASE_SHA: metadata.resolved_review_base_sha,
    REVIEWED_HEAD_SHA: metadata.reviewed_head_sha,
    ORIGINAL_REVIEW_BASE: metadata.original_review_base,
  };
}
```

> These are extra keys only. The GLM reviewer prompts never reference `{{REVIEW_BASE_SHA}}` etc., and prompt-arg templating only substitutes placeholders that appear in the prompt file, so the GLM path is unaffected.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit** (with Task 4 — keep the session-runner changes together)

---

## Task 4: Add `sessionDefinitions` override to `runSequentialExtraReviewSessions`

**Files:**
- Modify: `extra-review-sessions.mts:150-173` (`RunSequentialExtraReviewSessionsInput`)
- Modify: `extra-review-sessions.mts:207-356` (`runSequentialExtraReviewSessions` + the three `runXxx` helpers)
- Test: `escalation-review-sessions.test.mts` (create)

- [ ] **Step 1: Add the input field**

In `RunSequentialExtraReviewSessionsInput`, add after `createAgent`:

```ts
  createAgent: ExtraReviewAgentFactory;
  /**
   * Per-session definition overrides. Any kind omitted falls back to the GLM
   * default (EXTRA_CODE_REVIEW_SESSION / EXTRA_TWO_AXIS_REVIEW_SESSION /
   * EXTRA_ISSUE_DECOMPOSER_SESSION), so existing callers are unaffected.
   */
  sessionDefinitions?: Partial<
    Record<ExtraReviewSessionKind, ExtraReviewSessionDefinition>
  >;
```

- [ ] **Step 2: Resolve effective definitions at the top of `runSequentialExtraReviewSessions`**

Immediately after the existing `const logger = input.logger ?? console;` line (≈line 218), add:

```ts
  const definitions: Record<ExtraReviewSessionKind, ExtraReviewSessionDefinition> = {
    code_quality:
      input.sessionDefinitions?.code_quality ?? EXTRA_CODE_REVIEW_SESSION,
    two_axis:
      input.sessionDefinitions?.two_axis ?? EXTRA_TWO_AXIS_REVIEW_SESSION,
    issue_decomposer:
      input.sessionDefinitions?.issue_decomposer ??
      EXTRA_ISSUE_DECOMPOSER_SESSION,
  };
```

- [ ] **Step 3: Pass the resolved definition into each `runXxx` call**

In the `code_quality` block, change the `runCodeQualityReview({...})` call to include `definition: definitions.code_quality`:

```ts
      const codeReview = await runCodeQualityReview({
        prd: input.prd,
        round: input.round,
        sandbox,
        createAgent: input.createAgent,
        session: "code_quality",
        agentEntry: input.sessionAgents?.code_quality,
        writeAgentDefinition: input.writeAgentDefinition,
        idleTimeoutSeconds,
        promptArgs: sharedReviewerPromptArgs(input.reviewInputs.metadata),
        definition: definitions.code_quality,
      });
```

In the `two_axis` block, add `definition: definitions.two_axis` to the `runTwoAxisReview({...})` call (same shape).

In the `issue_decomposer` block, add `definition: definitions.issue_decomposer` to the `runIssueDecomposer({...})` call (same shape).

- [ ] **Step 4: Accept and use `definition` in the three helpers**

For each of `runCodeQualityReview`, `runTwoAxisReview`, `runIssueDecomposer`, add `definition: ExtraReviewSessionDefinition;` to the input param type, and replace the hardcoded constant in the `runSession(input, ...)` call with `input.definition`. Example for `runCodeQualityReview`:

```ts
async function runCodeQualityReview(input: {
  prd: ExtraReviewPrdArtifactIdentity;
  round: ExtraReviewRoundArtifactIdentity;
  sandbox: ExtraReviewSandbox;
  createAgent: ExtraReviewAgentFactory;
  session: ExtraReviewSessionKind;
  agentEntry?: ExtraReviewSessionAgentEntry;
  writeAgentDefinition?: (input: {
    worktreePath: string;
    session: ExtraReviewSessionKind;
    agentName: string;
  }) => void;
  idleTimeoutSeconds: number;
  promptArgs: Record<string, string>;
  definition: ExtraReviewSessionDefinition;
}): Promise<CodeReviewOutput> {
  const raw = await runSession(input, input.definition);
  return {
    raw,
    parsed: parseCodeQualityExtraReview(raw),
  };
}
```

Apply the identical edit to `runTwoAxisReview` (return `parseTwoAxisExtraReview(raw)`) and `runIssueDecomposer` (return `parseFollowupIssues(raw)`): add the `definition` field and call `runSession(input, input.definition)`.

> The default-preserving guarantee: existing callers pass no `sessionDefinitions`, so `definitions.*` resolve to the same `EXTRA_*_SESSION` constants the helpers used before.

- [ ] **Step 5: Write the failing test**

Create `escalation-review-sessions.test.mts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTRA_ISSUE_DECOMPOSER_SESSION,
  resolveSequentialExtraReviewArtifactPaths,
  runSequentialExtraReviewSessions,
  sharedReviewerPromptArgs,
  type ExtraReviewSandbox,
  type ExtraReviewSandboxRunInput,
  type ExtraReviewSessionDefinition,
  type ExtraReviewSessionInputBundle,
} from "./extra-review-sessions.mts";
import type { ExtraReviewInputMetadata } from "./extra-review-inputs.mts";

const ESCALATION_MODEL = "anthropic/claude-sonnet-4-5";

function metadata(): ExtraReviewInputMetadata {
  return {
    kind: "extra_review_inputs",
    prd_number: 7,
    prd_label: "prd-007",
    prd_branch: "prd-007",
    prd_path: "docs/prd/007.md",
    original_review_base: "main",
    resolved_review_base_sha: "abcdef1234567890",
    reviewed_head_sha: "1234567890abcdef",
    timestamp: "2026-06-14T00:00:00.000Z",
    round: { id: "escalation-head-1234567", number: 3, artifact_dir: "d" },
    diff_excludes: [],
    diff_bytes: 10,
    changed_file_count: 1,
    input_files: {
      prd_body: ".sandcastle/runs/prd-007/input-prd-body.md",
      metadata: ".sandcastle/runs/prd-007/input-metadata.json",
      changed_files: ".sandcastle/runs/prd-007/input-changed-files.txt",
      diff_stat: ".sandcastle/runs/prd-007/input-diff-stat.txt",
      diff: ".sandcastle/runs/prd-007/input-diff.patch",
    },
  };
}

function reviewInputs(): ExtraReviewSessionInputBundle {
  const meta = metadata();
  return {
    metadata: meta,
    writtenFiles: [
      meta.input_files.prd_body,
      meta.input_files.metadata,
      meta.input_files.changed_files,
      meta.input_files.diff_stat,
      meta.input_files.diff,
    ],
    // Only the ExtraReviewRoundPathInput subset ({ runsRootDir?, prd, round })
    // is accepted here. Passing reviewBase/reviewedHead/stopReason/outputs as an
    // object literal trips TS2353 excess-property checking — those belong to the
    // wider ExtraReviewRoundArtifactInput, not the path resolver.
    paths: resolveSequentialExtraReviewArtifactPaths({
      runsRootDir: ".sandcastle/runs",
      prd: { number: 7, label: "prd-007" },
      round: { id: "escalation-head-1234567", number: 3 },
    }),
  };
}

function mockSandbox(opts: {
  worktreePath: string;
  runCalls: ExtraReviewSandboxRunInput[];
  stdout: string[];
}): ExtraReviewSandbox {
  return {
    worktreePath: opts.worktreePath,
    async run(input) {
      opts.runCalls.push(input);
      return { stdout: opts.stdout.shift() ?? "" };
    },
    close() {},
  };
}

test("sharedReviewerPromptArgs exposes the review-base and head SHAs", () => {
  const args = sharedReviewerPromptArgs(metadata());
  assert.equal(args.REVIEW_BASE_SHA, "abcdef1234567890");
  assert.equal(args.REVIEWED_HEAD_SHA, "1234567890abcdef");
  assert.equal(args.ORIGINAL_REVIEW_BASE, "main");
});

test("sessionDefinitions override reviewer model + prompt; decomposer keeps default", async () => {
  const runCalls: ExtraReviewSandboxRunInput[] = [];
  const builtAgents: unknown[] = [];
  const stdout = [
    "<extra_review>\n" +
      JSON.stringify({
        reviewer: "code_quality",
        decision: "approved",
        summary: "ok",
        findings: [],
      }) +
      "\n</extra_review>",
    "<extra_review>\n" +
      JSON.stringify({
        reviewer: "two_axis",
        decision: "approved",
        summary: "ok",
        standards_findings: [],
        spec_findings: [],
      }) +
      "\n</extra_review>",
    "<followup_issues>\n" +
      JSON.stringify({
        status: "no_work",
        summary: "nothing",
        issues: [],
        needs_human_review_reason: "",
      }) +
      "\n</followup_issues>",
  ];

  const escalationReviewer = (
    promptFile: string,
    kind: "code_quality" | "two_axis",
  ): ExtraReviewSessionDefinition => ({
    kind,
    runName: `escalation ${kind}`,
    model: ESCALATION_MODEL,
    promptFile,
    maxIterations: 40,
    completionSignal: "</extra_review>",
  });

  await runSequentialExtraReviewSessions({
    prd: { number: 7, label: "prd-007" },
    round: { id: "escalation-head-1234567", number: 3 },
    reviewInputs: reviewInputs(),
    completedPrdBranch: "prd-007",
    sandboxBaseBranch: "origin/prd-007",
    createAgent: (model) => {
      const agent = { model };
      builtAgents.push(agent);
      return agent;
    },
    createSandbox: () =>
      mockSandbox({ worktreePath: "/wt", runCalls, stdout }),
    readDirtyStatus: () => "",
    writeArtifacts: (input) => ({
      paths: resolveSequentialExtraReviewArtifactPaths(input),
      writtenFiles: [],
      handoff: "",
    }),
    sessionDefinitions: {
      code_quality: escalationReviewer(
        "./.sandcastle/escalation-code-review-prompt-prd.md",
        "code_quality",
      ),
      two_axis: escalationReviewer(
        "./.sandcastle/escalation-two-axis-review-prompt-prd.md",
        "two_axis",
      ),
    },
  });

  // Reviewer prompt files came from the overrides.
  assert.equal(
    runCalls[0].promptFile,
    "./.sandcastle/escalation-code-review-prompt-prd.md",
  );
  assert.equal(
    runCalls[1].promptFile,
    "./.sandcastle/escalation-two-axis-review-prompt-prd.md",
  );
  // Decomposer fell back to the GLM default prompt.
  assert.equal(runCalls[2].promptFile, EXTRA_ISSUE_DECOMPOSER_SESSION.promptFile);
  // Reviewer prompts carry the review-base SHA.
  assert.equal(runCalls[0].promptArgs.REVIEW_BASE_SHA, "abcdef1234567890");
  // Reviewer agents were built on the Claude model.
  assert.deepEqual(builtAgents[0], { model: ESCALATION_MODEL });
});
```

- [ ] **Step 6: Run the new tests to verify they fail then pass**

Run: `npm run test` (or the project's single-file runner against `escalation-review-sessions.test.mts`)
Expected: after Steps 1–4 are in place, both tests PASS. If you run the tests before the implementation edits, they FAIL with a missing `REVIEW_BASE_SHA`/wrong `promptFile`.

- [ ] **Step 7: Run the existing session tests (regression)**

Run: `npm run test`
Expected: `extra-review-sessions.test.mts` still PASS (defaults preserved).

- [ ] **Step 8: Commit**

```bash
git add extra-review-sessions.mts escalation-review-sessions.test.mts
git commit -m "feat(extra-review): support per-session definition overrides + review-base prompt args"
```

---

## Task 5: Escalation trigger predicate

**Files:**
- Create: `escalation-review-trigger.mts`
- Create: `escalation-review-trigger.test.mts`

- [ ] **Step 1: Write the failing test**

Create `escalation-review-trigger.test.mts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRunEscalationReview } from "./escalation-review-trigger.mts";

test("runs escalation only on clean-exhaustion reasons", () => {
  for (const reason of ["max_extra_review_rounds", "no_work", "duplicate_only"] as const) {
    assert.equal(shouldRunEscalationReview(reason), true, reason);
  }
});

test("skips escalation on every non-clean reason", () => {
  for (const reason of [
    "iteration_cap_exhausted",
    "stuck_issues",
    "open_non_stuck_issues",
    "base_validation_failed",
    "parse_failure",
    "needs_human_review",
    "failure",
    "skipped",
    "success",
  ] as const) {
    assert.equal(shouldRunEscalationReview(reason), false, reason);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test`
Expected: FAIL — `Cannot find module './escalation-review-trigger.mts'`.

- [ ] **Step 3: Implement the predicate**

Create `escalation-review-trigger.mts`:

```ts
import type { ExtraReviewMainLoopStopReason } from "./extra-review-main-loop.mts";

/**
 * Terminal reasons that mean the completed PRD branch is green and the issue
 * queue is fully drained — the only states where the escalation tier runs.
 *
 * Note: a round that returns "success" only does so with zero created issues
 * (the loop keeps going when success + created > 0). We deliberately exclude
 * "success" so escalation engages on the explicit clean-exhaustion reasons.
 */
export const ESCALATION_CLEAN_REASONS: ReadonlySet<ExtraReviewMainLoopStopReason> =
  new Set(["max_extra_review_rounds", "no_work", "duplicate_only"]);

export function shouldRunEscalationReview(
  reason: ExtraReviewMainLoopStopReason,
): boolean {
  return ESCALATION_CLEAN_REASONS.has(reason);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add escalation-review-trigger.mts escalation-review-trigger.test.mts
git commit -m "feat(extra-review): add escalation trigger predicate"
```

---

## Task 6: Escalation prompt files

**Files:**
- Create: `.sandcastle/escalation-code-review-prompt-prd.md`
- Create: `.sandcastle/escalation-two-axis-review-prompt-prd.md`

> Mechanic: Claude Code recognizes a slash command only when it is the **first token** of the message. So each file MUST begin with the `/code-review` (or `/two-axis-review`) line; the rest of the file is the command argument (the review brief + the strict output override). Placeholders are substituted by sandcastle before the message is sent.

- [ ] **Step 1: Create the code-review prompt**

Create `.sandcastle/escalation-code-review-prompt-prd.md`:

```markdown
/code-review Review the code in this branch since {{REVIEW_BASE_SHA}} against the PRD it is supposed to complete.

You are running as a strict, terminal escalation maintainability + code-quality gate over the completed PRD branch (PRD {{PRD_NUMBER}}). This is a PRD-level review, not an implementation session. Findings become follow-up PRD issues through a separate decomposer; do not fix anything.

Inputs:
- Review the branch diff: `git diff {{REVIEW_BASE_SHA}}...HEAD` in this worktree (read-only git is allowed).
- The originating spec is the PRD body file at `{{PRD_BODY_PATH}}`. Do not consult an external issue tracker.

Read-only rules:
- Do not edit, create, delete, format, or patch files.
- Do not write any review file to disk. Output only to stdout.
- Do not install dependencies, commit, push, merge, rebase, or change branches.
- Do not call GitHub, issue trackers, or external publishing tools.

CRITICAL OUTPUT OVERRIDE — this supersedes the skill's normal markdown report format:
Your entire deliverable is exactly one JSON block wrapped in the `extra_review` tag, and nothing else — no markdown, prose, headings, logs, or tool transcripts outside that block. Map every maintainability finding into the schema below.

Schema:

\`\`\`json
{
  "reviewer": "code_quality",
  "decision": "approved" | "followup_recommended" | "needs_human_review",
  "summary": "one or two sentences describing what you reviewed and the decision",
  "findings": [
    {
      "id": "stable short id such as CQ-001",
      "severity": "blocking" | "major" | "minor",
      "confidence": 0,
      "title": "short issue-ready title",
      "problem": "specific maintainability or code-quality problem",
      "impact": "why this matters for the PRD branch",
      "recommendation": "the concrete follow-up work to issue",
      "files": ["path/to/file.ts"],
      "source": "code_quality"
    }
  ]
}
\`\`\`

Rules:
- `reviewer` must be `code_quality`.
- `decision` must be `approved` when `findings` is empty.
- `decision` must be `followup_recommended` when `findings` contains actionable follow-up work.
- Use `needs_human_review` only when the branch or PRD body is missing, internally inconsistent, or too ambiguous to review safely.
- `confidence` is an integer from 0 to 100.
- `files` may be empty only when the finding is repository-wide or metadata-only.
- Keep findings issue-ready and implementation-free.

Minimal valid example:

<extra_review>
{
  "reviewer": "code_quality",
  "decision": "approved",
  "summary": "Reviewed the completed PRD branch diff and found no maintainability follow-up work.",
  "findings": []
}
</extra_review>
```

- [ ] **Step 2: Create the two-axis prompt**

Create `.sandcastle/escalation-two-axis-review-prompt-prd.md`:

```markdown
/two-axis-review Review the code in this branch since {{REVIEW_BASE_SHA}} on two independent axes against the PRD it is supposed to complete.

You are running as a terminal escalation review over the completed PRD branch (PRD {{PRD_NUMBER}}) on two axes:
- Standards: does the implementation follow documented project standards, architectural decisions, and local conventions?
- Spec: does the completed branch satisfy the PRD requirements and acceptance criteria without gaps or contradictions?

This is a PRD-level review, not an implementation session. Findings become follow-up PRD issues through a separate decomposer; do not fix anything.

Inputs:
- Review the branch diff: `git diff {{REVIEW_BASE_SHA}}...HEAD` in this worktree (read-only git is allowed).
- The originating spec is the PRD body file at `{{PRD_BODY_PATH}}`. Do not consult an external issue tracker; pass the PRD body file as the spec to the Spec axis.

Read-only rules:
- Do not edit, create, delete, format, or patch files.
- Do not write any review file to disk. Output only to stdout.
- Do not install dependencies, commit, push, merge, rebase, or change branches.
- Do not call GitHub, issue trackers, or external publishing tools.

CRITICAL OUTPUT OVERRIDE — this supersedes the skill's normal markdown report format:
Your entire deliverable is exactly one JSON block wrapped in the `extra_review` tag, and nothing else — no markdown, prose, headings, logs, or tool transcripts outside that block. Keep standards and spec findings in their separate arrays.

Schema:

\`\`\`json
{
  "reviewer": "two_axis",
  "decision": "approved" | "followup_recommended" | "needs_human_review",
  "summary": "one or two sentences describing both review axes and the decision",
  "standards_findings": [
    {
      "id": "stable short id such as STD-001",
      "severity": "blocking" | "major" | "minor",
      "confidence": 0,
      "title": "short issue-ready title",
      "problem": "specific standards or architecture problem",
      "impact": "why this matters for the PRD branch",
      "recommendation": "the concrete follow-up work to issue",
      "files": ["path/to/file.ts"],
      "source": "standards"
    }
  ],
  "spec_findings": [
    {
      "id": "stable short id such as SPEC-001",
      "severity": "blocking" | "major" | "minor",
      "confidence": 0,
      "title": "short issue-ready title",
      "problem": "specific PRD/spec mismatch",
      "impact": "which requirement or user flow is affected",
      "recommendation": "the concrete follow-up work to issue",
      "files": ["path/to/file.ts"],
      "source": "spec"
    }
  ]
}
\`\`\`

Rules:
- `reviewer` must be `two_axis`.
- `decision` must be `approved` when both finding arrays are empty.
- `decision` must be `followup_recommended` when either finding array contains actionable follow-up work.
- Use `needs_human_review` only when the branch or PRD body is missing, internally inconsistent, or too ambiguous to review safely.
- `confidence` is an integer from 0 to 100.
- `files` may be empty only when the finding is repository-wide or metadata-only.

Minimal valid example:

<extra_review>
{
  "reviewer": "two_axis",
  "decision": "approved",
  "summary": "Reviewed standards and PRD/spec fit for the completed branch and found no follow-up work.",
  "standards_findings": [],
  "spec_findings": []
}
</extra_review>
```

- [ ] **Step 3: Commit**

```bash
git add .sandcastle/escalation-code-review-prompt-prd.md .sandcastle/escalation-two-axis-review-prompt-prd.md
git commit -m "feat(extra-review): add Claude escalation reviewer prompts"
```

---

## Task 7: New entry file

**Files:**
- Create: `run-prd-extra-review-custom-agents-shared-cache-with-claude.mts` (fork of `run-prd-extra-review-custom-agents-shared-cache.mts`)

- [ ] **Step 1: Copy the base entry file**

```bash
cp run-prd-extra-review-custom-agents-shared-cache.mts run-prd-extra-review-custom-agents-shared-cache-with-claude.mts
```

- [ ] **Step 2: Extend imports**

In the new file, update the `extra-review-config.mts` import to add the escalation constants, and add imports for the trigger + sessions input type:

```ts
import {
  ESCALATION_CODE_REVIEW_PROMPT_FILE,
  ESCALATION_REVIEWER_MAX_ITERATIONS,
  ESCALATION_TWO_AXIS_REVIEW_PROMPT_FILE,
  EXTRA_DECOMPOSER_MAX_ITERATIONS,
  EXTRA_REVIEWER_MAX_ITERATIONS,
  MAX_EXTRA_REVIEW_ROUNDS,
  REVIEW_FOLLOW_UP_LABEL,
} from "./extra-review-config.mts";
```

Add to the `extra-review-sessions.mts` import (alongside `runSequentialExtraReviewSessions`):

```ts
import {
  runSequentialExtraReviewSessions,
  type ExtraReviewSessionDefinition,
} from "./extra-review-sessions.mts";
```

Add the trigger import near the other local imports:

```ts
import { shouldRunEscalationReview } from "./escalation-review-trigger.mts";
```

- [ ] **Step 3: Add the escalation model + Claude mounts**

After the existing model constants (`ISSUE_DECOMPOSER_MODEL = LOOP_CONFIG.models.issueDecomposer;`, ≈line 68), add:

```ts
const ESCALATION_REVIEW_MODEL = LOOP_CONFIG.models.escalationReview;
```

After `OPENCODE_MOUNTS` (≈line 147), add:

```ts
// Whole ~/.claude mounted writable: subscription OAuth creds may rotate and
// Claude session/transcript capture writes back here. The escalation round runs
// its Claude sessions sequentially, so there are no concurrent-write conflicts.
const CLAUDE_MOUNTS = [
  {
    hostPath: "~/.claude",
    sandboxPath: "~/.claude",
  },
];
```

- [ ] **Step 4: Update the USAGE string**

Replace the `USAGE` constant value:

```ts
const USAGE =
  "Usage: tsx run-prd-extra-review-custom-agents-shared-cache-with-claude.mts --prd <N> --review-base <commit-ish> [--idle-timeout <seconds>]";
```

- [ ] **Step 5: Add the Claude-aware sandbox provider**

After `dockerSandboxProvider()` (≈line 2305), add:

```ts
function claudeEscalationSandboxProvider() {
  return docker({
    mounts: [...OPENCODE_MOUNTS, ...CACHE_MOUNTS, ...CLAUDE_MOUNTS],
    env: LOOP_CONFIG.cache.sandboxEnv,
  });
}
```

- [ ] **Step 6: Add the escalation round identity helper**

After `extraReviewRoundIdentity(...)` (≈line 2290), add:

```ts
function escalationRoundIdentity(
  reviewedHeadSha: string,
): ExtraReviewRoundArtifactIdentity & { number: number } {
  return {
    number: MAX_EXTRA_REVIEW_ROUNDS + 1,
    id: `escalation-head-${reviewedHeadSha.slice(0, 7)}`,
  };
}
```

- [ ] **Step 7: Add `runEscalationReviewRound`**

After the existing `runExtraReviewRound` function (it ends ≈line 2250), add the escalation sibling. It mirrors `runExtraReviewRound` but: builds the escalation round identity, uses `claudeEscalationSandboxProvider()`, dispatches the Claude agent for reviewer sessions, overrides the two reviewer session definitions, and keeps the decomposer on the custom opencode agent (identical to the GLM round):

```ts
async function runEscalationReviewRound(): Promise<ExtraReviewRoundResult> {
  const reviewedHeadSha = currentReviewedPrdHeadSha();
  const round = escalationRoundIdentity(reviewedHeadSha);
  const prd = prdArtifactIdentity();

  try {
    console.log("\n=== Escalation (Claude) review round ===\n");
    console.log(
      `Reviewing ${extraReviewBaseSha.slice(0, 7)}..${reviewedHeadSha.slice(0, 7)} on ${prdBranch}`,
    );

    const reviewInputs = writeCompletedBranchReviewInputs({
      prd: {
        number: prdNumber,
        label: prdLabel,
        branch: prdBranch,
        path: prdPath,
        title: prd.title,
        body: prdBody,
      },
      round,
      originalReviewBaseArg: extraReviewBaseArg,
      resolvedReviewBaseSha: extraReviewBaseSha,
      reviewedHeadSha,
    });

    const escalationReviewerDefinition = (
      kind: "code_quality" | "two_axis",
      runName: string,
      promptFile: string,
    ): ExtraReviewSessionDefinition => ({
      kind,
      runName,
      model: ESCALATION_REVIEW_MODEL,
      promptFile,
      maxIterations: ESCALATION_REVIEWER_MAX_ITERATIONS,
      completionSignal: "</extra_review>",
    });

    const sessions = await runSequentialExtraReviewSessions({
      prd,
      round,
      reviewInputs,
      completedPrdBranch: prdBranch,
      sandboxBaseBranch: originPrdRef(),
      idleTimeoutSeconds,
      copyToWorktree: COPY_TO_WORKTREE,
      hooks: sandboxReadyHooks(),
      createSandbox: (sandboxInput) =>
        sandcastle.createSandbox({
          sandbox: claudeEscalationSandboxProvider(),
          branch: sandboxInput.branch,
          baseBranch: sandboxInput.baseBranch,
          copyToWorktree: sandboxInput.copyToWorktree,
          hooks: sandboxInput.hooks,
        }),
      createAgent: (model, agentName) => {
        if (model === ESCALATION_REVIEW_MODEL) {
          return sandcastle.claudeCode(model);
        }
        const roleModel = extraReviewModelForAgent(agentName) ?? model;
        return agentName
          ? sandcastle.opencode(roleModel, { agent: agentName })
          : sandcastle.opencode(roleModel);
      },
      sessionDefinitions: {
        code_quality: escalationReviewerDefinition(
          "code_quality",
          "escalation code-review (claude)",
          ESCALATION_CODE_REVIEW_PROMPT_FILE,
        ),
        two_axis: escalationReviewerDefinition(
          "two_axis",
          "escalation two-axis review (claude)",
          ESCALATION_TWO_AXIS_REVIEW_PROMPT_FILE,
        ),
        // issue_decomposer omitted → defaults to the GLM decomposer session.
      },
      sessionAgents: {
        issue_decomposer: {
          agentName: DECOMPOSER_AGENT_CONFIG.name,
          promptFile: DECOMPOSER_USER_PROMPT_FILE,
        },
      },
      writeAgentDefinition: ({ worktreePath, session, agentName }) => {
        // Only the decomposer is an opencode custom agent; reviewer sessions
        // run Claude directly and have no agentEntry, so this is never called
        // for them.
        if (session !== "issue_decomposer") return;
        ensureOpencodeGitExclude(worktreePath);
        writeAgentDefinitionFile(
          worktreePath,
          agentName,
          buildAgentDefinition(
            DECOMPOSER_AGENT_CONFIG,
            ISSUE_DECOMPOSER_MODEL,
            readFileSync(
              DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE.replace(/^\.\//, ""),
              "utf8",
            ),
          ),
        );
      },
    });

    if (sessions.stopReason !== "success") {
      console.log(
        `Escalation review stopped with ${sessions.stopReason}. Handoff: ${sessions.artifactWrite.paths.files.handoff}`,
      );
      return {
        stopReason: sessions.stopReason,
        createdIssueCount: 0,
        skippedDuplicateIssueCount: 0,
        artifactWrite: sessions.artifactWrite,
      };
    }

    const decomposition = sessions.outputs.issueDecomposer?.parsed;
    if (!decomposition) {
      const artifactWrite = writeExtraReviewRoundArtifacts({
        runsRootDir: reviewInputs.paths.runsRootDir,
        prd,
        round,
        reviewBase: extraReviewBaseSha,
        reviewedHead: reviewedHeadSha,
        stopReason: "failure",
        stopDetails: [
          "Issue decomposer output was missing after a success escalation round.",
        ],
        outputs: sessions.outputs,
      });
      return {
        stopReason: "failure",
        createdIssueCount: 0,
        skippedDuplicateIssueCount: 0,
        artifactWrite,
      };
    }

    const publication = publishExtraReviewIssues({
      decomposition,
      context: {
        prd: {
          number: prdNumber,
          label: prdLabel,
          path: prdPath,
          title: prd.title,
        },
        round,
        originalReviewBaseArg: extraReviewBaseArg,
        resolvedReviewBaseSha: extraReviewBaseSha,
        reviewedHeadSha,
        artifactRefs: artifactRefsFromRound(sessions.artifactWrite.paths),
        reviewFollowUpLabel: REVIEW_FOLLOW_UP_LABEL,
      },
      gh: extraReviewGhClient(),
    });

    const artifactWrite = writeExtraReviewRoundArtifacts({
      runsRootDir: reviewInputs.paths.runsRootDir,
      prd,
      round,
      reviewBase: extraReviewBaseSha,
      reviewedHead: reviewedHeadSha,
      stopReason: publication.stopReason,
      outputs: sessions.outputs,
      createdIssues: publication.createdIssues,
      skippedDuplicateIssues: publication.skippedDuplicateIssues,
    });

    console.log(
      [
        `Escalation review publication: ${publication.stopReason}.`,
        `Created: ${publication.createdIssues.length}.`,
        `Skipped duplicates: ${publication.skippedDuplicateIssues.length}.`,
        `Handoff: ${artifactWrite.paths.files.handoff}`,
      ].join(" "),
    );

    return {
      stopReason: publication.stopReason,
      createdIssueCount: publication.createdIssues.length,
      skippedDuplicateIssueCount: publication.skippedDuplicateIssues.length,
      artifactWrite,
    };
  } catch (error) {
    console.error(
      `Escalation review round failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      stopReason: "failure",
      createdIssueCount: 0,
      skippedDuplicateIssueCount: 0,
    };
  }
}
```

> Verify against the base file that the symbols used here exist with these names: `DECOMPOSER_AGENT_CONFIG`, `DECOMPOSER_USER_PROMPT_FILE`, `DECOMPOSER_AGENT_SYSTEM_PROMPT_FILE`, `ISSUE_DECOMPOSER_MODEL`, `ensureOpencodeGitExclude`, `writeAgentDefinitionFile`, `buildAgentDefinition`, `originPrdRef`, `currentReviewedPrdHeadSha`, `prdArtifactIdentity`, `artifactRefsFromRound`, `extraReviewGhClient`, `extraReviewModelForAgent`, `writeCompletedBranchReviewInputs`, `publishExtraReviewIssues`, `writeExtraReviewRoundArtifacts`. They are all already imported/defined in the base entry file. If `runExtraReviewRound` wraps the `catch`/return differently, match its exact `ExtraReviewRoundResult` shape.

- [ ] **Step 8: Refactor the main-loop call into a reusable input, then wire the escalation phase**

Replace the single `const mainLoopResult = await runBoundedExtraReviewMainLoop({...});` block (≈lines 2370-2380) with a factory + the terminal escalation phase:

```ts
function buildMainLoopInput(maxExtraReviewRounds: number) {
  return {
    prd: prdArtifactIdentity(),
    reviewBase: extraReviewBaseSha,
    maxIterations: MAX_ITERATIONS,
    maxExtraReviewRounds,
    listOpenIssues: listOpenPrdIssuesForExtraReview,
    validateBase: validateBaseForExtraReview,
    getReviewedHead: currentReviewedPrdHeadSha,
    runNormalIssueIteration: processNormalIssueIteration,
    runExtraReviewRound,
  };
}

const mainLoopResult = await runBoundedExtraReviewMainLoop(
  buildMainLoopInput(MAX_EXTRA_REVIEW_ROUNDS),
);

console.log(
  [
    "\nLoop stopped.",
    `Reason: ${mainLoopResult.reason}`,
    `Normal issue iterations: ${mainLoopResult.completedIterations}/${MAX_ITERATIONS}`,
    `Extra review rounds: ${mainLoopResult.completedExtraReviewRounds}/${MAX_EXTRA_REVIEW_ROUNDS}`,
    `Created follow-up issues: ${mainLoopResult.createdIssueCount}`,
    `Skipped duplicate follow-up issues: ${mainLoopResult.skippedDuplicateIssueCount}`,
    mainLoopResult.artifactWrite
      ? `Handoff: ${mainLoopResult.artifactWrite.paths.files.handoff}`
      : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

if (shouldRunEscalationReview(mainLoopResult.reason)) {
  const escalation = await runEscalationReviewRound();

  if (escalation.createdIssueCount > 0) {
    console.log(
      `\nEscalation created ${escalation.createdIssueCount} follow-up issue(s); draining once with no further review rounds...\n`,
    );
    const drainResult = await runBoundedExtraReviewMainLoop(
      buildMainLoopInput(0),
    );
    console.log(
      [
        "\nEscalation drain stopped.",
        `Reason: ${drainResult.reason}`,
        `Normal issue iterations: ${drainResult.completedIterations}/${MAX_ITERATIONS}`,
        drainResult.artifactWrite
          ? `Handoff: ${drainResult.artifactWrite.paths.files.handoff}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else {
    console.log(
      `\nEscalation review produced no follow-up issues (${escalation.stopReason}); nothing to drain.`,
    );
  }
} else {
  console.log(
    `\nEscalation review skipped: loop reason '${mainLoopResult.reason}' is not a clean exhaustion.`,
  );
}

console.log("\nAll done.");
```

> Remove the now-duplicated trailing `console.log("\nAll done.")` from the original tail so it appears once.

- [ ] **Step 9: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. Fix any symbol-name mismatches surfaced against the base file.

- [ ] **Step 10: Commit**

```bash
git add run-prd-extra-review-custom-agents-shared-cache-with-claude.mts
git commit -m "feat: add Claude escalation review entry (run-prd ... -with-claude)"
```

---

## Task 8: Validation, prerequisites, and smoke test

**Files:** none (verification only)

> **Operator decisions (2026-06-15):**
> - **Step 1 is the only landing gate.** `typecheck + test + build` green = code is mergeable. Steps 3–4 are runner-host runtime confirmations, not blockers for committing Tasks 1–7.
> - **Slash-command → `<extra_review>` JSON mechanic is an accepted risk** (Risk #1). Proceed as if it works; the whole tier depends on it. Step 3 is a confirmation, not a gate — if it fails, escalate to the operator rather than reworking the output-contract design.
> - **Model config is operator-owned** (Risk #2). The `DEFAULT_MODELS.escalationReview = "anthropic/claude-sonnet-4-5"` default stands; the operator sets/overrides `models.escalationReview` in `.sandcastle/config.mts`. No code change needed.

- [ ] **Step 1: Full validation suite (landing gate)**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all PASS. Existing `extra-review-*.test.mts` unaffected; new `escalation-review-*.test.mts` PASS.

- [ ] **Step 2: Confirm host prerequisites (operator/runner host that mounts `~/.claude`)**

- `claude` CLI authenticated via subscription (so mounted `~/.claude/.credentials.json` works).
- `/code-review` resolves to the intended **skill** (disable the official `code-review` plugin in `~/.claude` so it does not shadow the skill), and `/two-axis-review` is present at `~/.claude/skills/two-axis-review/`.
- `.sandcastle/config.mts` sets `models.escalationReview` to the desired Claude model (or rely on the `DEFAULT_MODELS` value).

- [ ] **Step 3: Smoke test the slash-command mechanic (confirmation, accepted risk)**

On the runner host, verify a headless Claude invocation expands the slash command and emits a single `<extra_review>` block. Manually run the `claude` CLI in print mode against a small repo with the first line of `.sandcastle/escalation-code-review-prompt-prd.md` (placeholders substituted). Expected: output ends with `</extra_review>` and contains valid `code_quality` JSON, no markdown report. If the skill's markdown output wins, strengthen the OUTPUT OVERRIDE wording (move it to the very first sentence after the slash invocation) and re-test.

- [ ] **Step 4: End-to-end dry run**

Run the new entry against a PRD whose normal + GLM extra-review work is already complete:

```bash
tsx run-prd-extra-review-custom-agents-shared-cache-with-claude.mts --prd <N> --review-base <commit-ish>
```

Expected log sequence: GLM loop stops with a clean reason → `=== Escalation (Claude) review round ===` → publication summary → (if issues created) escalation drain → `All done.` Confirm escalation artifacts land under a `escalation-head-<sha>` round dir and any follow-up issues carry the `ai-review-followup` label.

- [ ] **Step 5: Commit any prompt/wording fixes from the smoke test**

```bash
git add .sandcastle/escalation-*-prompt-prd.md
git commit -m "fix(extra-review): harden escalation prompt output override"
```

---

## Self-review checklist (run before handoff)

- **Spec coverage:** new model role (T1), constants (T2), review-base args (T3), session-definition override + reuse (T4), one-shot clean-only trigger (T5), slash-skill prompts pinned to `<extra_review>` (T6), entry file with writable `~/.claude` mount + Claude agent + budget-0 drain (T7), validation/prereqs/smoke (T8). All locked decisions covered.
- **Type consistency:** `ESCALATION_REVIEW_MODEL`, `ESCALATION_CODE_REVIEW_PROMPT_FILE`, `ESCALATION_TWO_AXIS_REVIEW_PROMPT_FILE`, `ESCALATION_REVIEWER_MAX_ITERATIONS`, `shouldRunEscalationReview`, `ESCALATION_CLEAN_REASONS`, `runEscalationReviewRound`, `escalationRoundIdentity`, `claudeEscalationSandboxProvider`, `CLAUDE_MOUNTS`, `sessionDefinitions`, `sharedReviewerPromptArgs` (+`REVIEW_BASE_SHA`/`REVIEWED_HEAD_SHA`/`ORIGINAL_REVIEW_BASE`) are used consistently across tasks.
- **Risks:** (a) slash-command expansion + markdown→JSON coercion in headless mode — **accepted risk** per operator (2026-06-15); proceed as if working, confirm (not gate) in T8 Step 3; (b) `claudeCode` model-string format — operator-owned, sonnet default stands (T8 note); (c) `/code-review` name collision — handled by T8 Step 2 prerequisite.
```
