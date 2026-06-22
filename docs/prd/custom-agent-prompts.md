# PRD: Custom-Agent Prompting for the Extra-Review Loop

## Problem Statement

Today the extra-review loop prompts every agent the same way: it renders a large
markdown prompt file and passes the whole thing as the single positional message
to `opencode run`. There are two problems with this from the operator's point of
view.

First, the agents run under opencode's **default `build` system prompt** — the
loop never sets a custom system prompt. The behavior we actually want (a coder
that only makes scoped edits, a reviewer that only emits a verdict, read-only
extra reviewers) lives entirely in a giant user message that has to re-establish
the agent's role on every single run.

Second, that user message is bloated and slow. The whole PRD body is injected
into **every** coder run and into the inline reviewer, regardless of how small
the issue is. The coder doesn't need the PRD to implement one self-contained
issue, and the inline reviewer doesn't need it to review one small diff. The PRD
text inflates the message, slows the run, and (because opencode passes the prompt
as a single command-line argument) pushes the loop toward the argv size limit
with no friendly error.

The operator wants each stage to be a real, named agent whose role is a system
prompt, with a small message that carries only the work in front of it.

## Solution

Add a new runner, `run-prd-extra-review-custom-agents.mts`, that is a copy of the
existing `run-prd-extra-reviews.mts` with the prompting rewired. The existing
runner is left untouched so the current behavior remains available.

For each stage of the loop the new runner defines a **custom opencode agent**:
the static role, scope rules, process, anti-patterns, and output contract become
the agent's **system prompt**, and the dynamic work (the issue, the diff, file
paths) becomes a small **user message**. The runner writes a per-stage agent
definition file into each sandbox worktree before the agent runs, selects it with
opencode's `--agent` flag, and renders a slimmed-down user message from a small
template.

Each agent gets the model the loop already selects for that stage, a temperature
chosen for its task, `mode: primary`, and permissions that match its job — the
coder can edit and run commands, the reviewers cannot edit. The PRD is dropped
entirely from the coder, the rework agent, and the inline reviewer; the three
PRD-level quality-gate sessions keep the PRD exactly as today, by file path.

## User Stories

1. As a loop operator, I want each stage to run as a named opencode agent, so that an agent's role is defined once as a system prompt instead of being re-stated in every message.
2. As a loop maintainer, I want each agent's role/scope/process/output contract to live in a markdown system prompt, so that I can edit agent behavior by editing prose, not by editing a giant positional message.
3. As a loop operator, I want the coder's message to contain only its issue, so that small issues run fast and are not slowed by unrelated context.
4. As a loop operator, I want the PRD removed from the coder and rework agents, so that implementing one self-contained issue does not drag the whole PRD through every run.
5. As a loop operator, I want the PRD removed from the inline issue reviewer, so that reviewing one small diff does not require the whole PRD.
6. As a human reviewer, I want the three PRD-level quality-gate sessions to keep the PRD, so that the spec axis, the code-quality scope check, and the issue decomposer still have the full PRD to work against.
7. As a loop operator, I want the PRD delivered to the quality-gate sessions by file path as it is today, so that keeping it costs nothing in message size.
8. As a loop operator, I want the round-1 coder and the rework agent to be two separate agents, so that each has a tight system prompt for its situation and neither message has to carry the other's framing.
9. As a loop maintainer, I want each agent's model to come from the loop's existing model selection, so that model tuning stays in one place.
10. As a loop maintainer, I want each agent to carry a temperature chosen for its task, so that deterministic reviewers and a slightly more exploratory coder/decomposer each behave appropriately.
11. As a loop operator, I want the coder and rework agents to be allowed to edit files and run commands, so that they can implement and commit work.
12. As a loop operator, I want the reviewers to be denied edit access, so that the only code changes flow through the normal implement/validate/review/merge path.
13. As a loop operator, I want the code-quality and two-axis reviewers to have a read-only command subset (git history and search), so that they can inspect the branch without being able to change it.
14. As a loop operator, I want every agent denied sub-agent delegation, so that the prompts' "no sub-agents / no hidden helpers" rule is enforced by permission, not just by instruction.
15. As a loop operator, I want every agent denied interactive questions, so that a non-interactive sandbox run cannot hang until the idle timeout waiting for human input.
16. As a loop operator, I want every agent denied web fetch and web search, so that runs stay focused and offline.
17. As a loop operator, I want the loop to write each agent definition into the worktree before the agent starts, so that the agent is configured for that exact run.
18. As a loop operator, I want agent definition files to be invisible to git inside the worktree, so that they never appear as uncommitted changes, never block the coder's commit checks, and never enter the review diff or the merge.
19. As a loop operator, I want the existing `run-prd-extra-reviews.mts` runner to keep working unchanged, so that adopting custom agents is opt-in.
20. As a loop maintainer, I want the shared review-session module extended additively, so that the new runner can use custom agents while the old runner's behavior stays identical.
21. As a loop maintainer, I want the slim user messages rendered from small markdown templates, so that the dynamic side of each prompt is also editable prose.
22. As a loop operator, I want the coder and inline reviewer to still receive issue comments, so that human triage clarifications are not lost.
23. As a loop operator, I want the rework agent's message to carry the reviewer findings as its scope, so that rework stays focused on what was flagged.
24. As a loop operator, I want a friendly error when a rendered message would exceed the command-line size limit, so that an oversized issue produces actionable feedback instead of a cryptic spawn failure.
25. As a loop operator, I want an oversized coder/rework/reviewer message routed into the existing stuck/feedback handling, so that the loop degrades gracefully rather than crashing.
26. As a loop maintainer, I want the new prompt sources split into a system file and a user file per stage, so that the static and dynamic parts are independently editable.
27. As a loop maintainer, I want agent frontmatter generated by the runner from a per-stage config, so that model, temperature, and permissions live next to the model constants and the markdown stays clean prose.
28. As a human reviewer, I want the coder, rework, and reviewer agents to work from a single self-contained issue, so that dropping the PRD does not cost them their acceptance criteria.

## Implementation Decisions

- A new runner `run-prd-extra-review-custom-agents.mts` is added as a copy of `run-prd-extra-reviews.mts` with prompting rewired. The original runner is not modified.
- The loop defines six custom agents, one per stage: a round-1 coder, a rework coder, the inline issue reviewer, the code-quality reviewer, the two-axis reviewer, and the issue decomposer.
- Each agent is a per-project opencode agent written to `.opencode/agents/<name>.md` inside the worktree before that agent runs, and selected via opencode's `--agent` flag (Sandcastle's opencode provider already supports an `agent` option that maps to `--agent`).
- Agent names are `coder`, `rework`, `reviewer`, `code-quality`, `two-axis`, and `decomposer`. The opencode agent name is the definition file's name.
- The round-1 coder and the rework coder are separate agents with separate system prompts; the runner selects `coder` on the first round and `rework` on subsequent rounds, mirroring the existing first-attempt/rework split.
- Each agent definition's body is the static system prompt for that stage. Its frontmatter is generated by the runner and sets `description`, `mode: primary`, the loop-selected `model`, the stage `temperature`, and the stage `permission` block.
- The model written into an agent's frontmatter is the same model the loop passes when constructing the provider. (opencode's `--model` flag overrides the frontmatter model, so the two always match; both are present because the provider requires a model argument and the operator wants the model recorded in the agent file.)
- Temperatures by stage: coder 0.3, rework 0.2, inline reviewer 0.1, code-quality 0.1, two-axis 0.1, decomposer 0.3. The coder stays moderate rather than near-zero because its model is a local Qwen whose output degrades when pinned too low; the reviewers are pinned low for deterministic verdicts and strict tagged output.
- Permissions by stage:
  - coder and rework: edit allowed, command execution allowed, read/search allowed.
  - inline reviewer: edit denied, command execution denied, read/search allowed.
  - code-quality and two-axis: edit denied, read-only command subset allowed (read-only git history/inspection and search; all other commands denied), read/search allowed.
  - decomposer: edit denied, command execution denied, read/search allowed.
  - all six agents: sub-agent delegation denied, interactive questions denied, web fetch denied, web search denied, and access outside the worktree denied.
- The PRD is removed entirely from the coder, the rework agent, and the inline reviewer. The code-quality, two-axis, and decomposer sessions keep the PRD exactly as today: provided as a file path and read with the read tool, never inlined.
- The slimmed user messages carry only:
  - coder: issue number, title, body, and comments.
  - rework: issue number, title, body, and the reviewer findings.
  - inline reviewer: issue number, title, body, comments, the review diff, changed-files list, diff stat, review metadata, and the existing recent-commits command substitution.
  - code-quality, two-axis, decomposer: the same file-path payloads they receive today, unchanged.
- Issue comments are kept for the coder and the inline reviewer (they can carry human triage clarifications) and omitted from rework (where the findings are the scope).
- The recent-commits command substitution stays in the inline reviewer's user message, because it is a prompt-render-time substitution rather than a tool call and is therefore unaffected by denying that agent command execution.
- Before writing any agent definition, the runner idempotently adds `.opencode/` to the worktree's local git exclude, so agent files never appear in git status, the review diff, or the merge, and never trip the coder loop's "uncommitted changes" checks. Nothing is committed and no operator setup is required.
- The shared review-session module is extended additively so the new runner can drive custom agents: each session definition can carry an agent name that is threaded to the provider factory, and the module accepts an optional hook to write the per-session agent definition into the session worktree. The existing runner supplies neither, so it continues to run with no `--agent` and no agent file, which falls back to opencode's default agent exactly as before.
- The runner enforces a command-line argument size guard (around 120 KB, matching the guards on Sandcastle's other argv-based providers) on each rendered coder/rework/reviewer user message. An oversized message fails with a clear, actionable error and is routed through the existing stuck/feedback handling instead of producing a raw spawn failure.
- Prompt sources are split per stage into a system file and a user file (for example a system prompt source and a user-message template per stage, named per agent for a one-to-one mapping). The system files are authored by copying the existing prompts' static portions; the dynamic sections become the user templates.
- Example of a generated agent definition (frontmatter generated, body copied from the stage's system prompt source):

```markdown
---
description: Implements one scoped PRD issue and commits it
mode: primary
model: strix/qwen3.6-35b-a3b-8bit
temperature: 0.3
permission:
  edit: allow
  bash: allow
  task: deny
  question: deny
  webfetch: deny
  websearch: deny
---

<static coder system prompt: scope rules, anti-patterns, process, completion>
```

## Testing Decisions

- Tests verify externally observable behavior, not implementation details, consistent with the existing `*.test.mts` suites next to each helper module.
- The agent-definition generator is a pure function and should be tested: given a stage config (name, model, temperature, permissions, description) and a system-prompt body, it produces a valid opencode agent markdown document with the expected frontmatter and body, for each of the six stages.
- The argv-size guard is a pure function and should be tested: messages under the limit pass, messages over the limit produce the friendly error, and the boundary is covered.
- The git-exclude helper should be tested for idempotency: appending the ignore entry twice does not duplicate it, and an already-present entry is left alone.
- The slim user-message rendering should be tested to confirm each stage's template includes exactly the intended fields and, for the coder/rework/reviewer, that the PRD is absent.
- The additive extension to the shared review-session module should be tested both ways: with the agent name and write-agent hook supplied (custom-agent path) and without them (legacy path), asserting the legacy path produces the same provider invocation and worktree state as before.
- The existing tagged-JSON parsers, artifact writer, duplicate detection, and queue-state tests remain unchanged and must continue to pass; the output contracts of the three quality-gate sessions are not changed by this work.
- Prompt content is reviewed against fixtures rather than tested for model quality.

## Out of Scope

- Converting the simpler `run-prd.mts` runner to custom agents. It shares the prompt files and pattern and can be a fast follow once this is proven.
- Defining the agents globally in the host opencode config instead of per-worktree. The per-worktree approach was chosen deliberately.
- Changing the output contracts or parsers of the code-quality, two-axis, or decomposer sessions.
- Changing the normal coder/validate/inline-review/merge/stuck workflow except where required to write agent files, slim messages, and add the argv guard.
- Removing the PRD from the three PRD-level quality-gate sessions.
- Parallelizing any sessions, or otherwise changing the Sandcastle execution model.
- Building any human approval UI for the generated agents or issues.

## Further Notes

- This PRD uses the existing glossary terms PRD-level quality gate, extra review round, independent review session, follow-up PRD issue, review base, and completed PRD branch. The agent names (`coder`, `reviewer`, `code-quality`, etc.) are implementation identifiers and are intentionally not added to the domain glossary.
- The decision to model the loop's prompting as opencode custom agents — system-prompt-as-agent, written at runtime into git-excluded per-worktree directories, chosen over global host agents and over inline prompts — is the one architectural choice here that a future reader may find surprising. If this becomes the loop's primary prompting model, it is worth recording as an ADR.
- The agents read their static behavior from system prompts and their work from small messages; the design's main risk is that a dropped-PRD coder or reviewer must be able to work from a single self-contained issue, which the issue decomposer is already required to produce.
