# Handoff — Claude Escalation Review Tier

**Date:** 2026-06-15
**Focus for next session:** shepherd the implementation plan through user review, then implement it.

## Where we are

The design for a new "escalation (Claude) review tier" is **fully grilled and locked**. A complete, step-by-step implementation plan is written. **No code has been written yet** — the user is reviewing the plan first and will return with feedback.

Do **not** start implementing until the user approves the plan or says go.

## Primary artifacts (read these, don't re-derive)

- **Implementation plan:** `docs/plans/2026-06-14-claude-escalation-review-tier.md` — 8 tasks, full code, exact paths, run commands. Includes a "Design decisions (locked during grilling)" section and a self-review/risks checklist. This is the source of truth.
- **Glossary:** `CONTEXT.md` → **Escalation review round** entry (already added).
- **Base file being forked:** `run-prd-extra-review-custom-agents-shared-cache.mts` (gh variant).
- **Key modules referenced by the plan:** `extra-review-sessions.mts` (`runSequentialExtraReviewSessions`, `sharedReviewerPromptArgs`), `extra-review-main-loop.mts` (`runBoundedExtraReviewMainLoop`, stop reasons), `extra-review-config.mts`, `sandcastle-loop-config.mts`, `extra-review-issues.mts`, `extra-review-artifacts.mts`, `extra-review-inputs.mts`.
- **Host Claude skills the tier invokes:** `~/.claude/skills/code-review/SKILL.md` (note `disable-model-invocation: true`) and `~/.claude/skills/two-axis-review/SKILL.md`.
- **Full prior conversation transcript:** `/Users/aherrington/.cursor/projects/Users-aherrington-Documents-code-proof-of-concept-sandcastle-loop-context-public-loop/agent-transcripts/4ed8fc21-9fe9-4f3b-b21d-3e6ea65b56ac/4ed8fc21-9fe9-4f3b-b21d-3e6ea65b56ac.jsonl` (search by keyword; don't read linearly).

## What the plan does (one-paragraph gist)

After the existing GLM extra-review loop terminates with a *clean* reason, run **one** Claude review round (`/code-review` + `/two-axis-review` skills) whose output is pinned to the existing `<extra_review>` JSON contract so the existing opencode decomposer is reused unchanged; publish follow-up issues; drain them once by re-invoking the main loop with `maxExtraReviewRounds: 0`; stop. New gh entry file `run-prd-extra-review-custom-agents-shared-cache-claude-escalation.mts`. The 10 locked decisions are enumerated in the plan — do not relitigate them without user direction.

## Open items / load-bearing assumptions to verify (these are the risks)

These are flagged in the plan's Task 8 and self-review; the user was asked to keep them in mind:

1. **Slash-command + JSON-override mechanic** (plan Task 6, Task 8 Step 3): depends on (a) the headless `claude` CLI expanding `/code-review` / `/two-axis-review` when first token of the prompt, and (b) the skills honoring the `<extra_review>` JSON override instead of their native markdown. Verify on the runner host before trusting the whole "reuse decomposer" design. Fallback: harden override wording; worst case revisit the output-contract decision.
2. **Default Claude model string** (plan Task 1 Step 2): `anthropic/claude-sonnet-4-5` is a guess at what this build's `sandcastle.claudeCode()` expects. Confirm format.
3. **Symbol-name verification** (plan Task 7 Step 7): `runEscalationReviewRound` reuses ~15 symbols from the base entry file; names listed but not each re-read against the base. Verify when implementing.

## Suggested skills for the next session

- **`executing-plans`** or **`subagent-driven-development`** — to implement the plan task-by-task once approved (the plan header recommends these).
- **`tdd`** / **`test-driven-development`** — Tasks 4 and 5 are written test-first; follow red-green.
- **`verification-before-completion`** — run `npm run typecheck && npm run test && npm run build` and the Task 8 smoke test before claiming done.
- **`prd-review`** / **`receiving-code-review`** — if the user returns with plan feedback to incorporate.
- **`grill-with-docs`** — only if the user reopens a locked design decision and wants to re-grill it.

## Notes

- Workspace is a *context copy* (no `package.json`/`node_modules` here); the real project + test runner live on the runner host. Validation commands are the loop's defaults: `npm run typecheck`, `npm run test`, `npm run build`.
- No secrets in this doc. The tier authenticates via the host's mounted `~/.claude` subscription creds (writable mount); never embed `ANTHROPIC_API_KEY` or credential contents anywhere.
- An ADR for the trade-offs (one-shot terminal, skills→GLM JSON contract, writable `~/.claude` mount) was offered but deferred by the user; offer again if they want decisions recorded.
