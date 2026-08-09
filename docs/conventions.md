# Conventions and recipes

Worked procedures for the changes that come up most. Rules live in
[AGENTS.md](../AGENTS.md); mechanism lives in [architecture.md](architecture.md). This file
is the "how do I actually do it" layer.

Every recipe ends the same way:

```bash
npm test && npm run typecheck && npm run build
```

against the [known-red baseline](../AGENTS.md#known-red-baseline).

---

## Change an agent prompt

The single most common change, and the one with the sharpest trap: prompts are asserted
character-for-character.

1. Edit the `.md` (e.g. `coder-agent-system-prompt-prd.md`).
2. Open the paired test (`coder-prompt.test.mts`) and update the `EXPECTED_SYSTEM_PROMPT` /
   `EXPECTED_USER_PROMPT` array to match **exactly** — it is a `string[]` joined with `\n`,
   so blank lines are `""` entries and the trailing newline matters.
3. Keep the structural assertions honest. If you removed a `## Scope` section, remove its
   `assert.match`; if you added a placeholder, add a matching assertion. Do not delete
   assertions to make a test pass.
4. `npm test`.

Rules that hold across all prompts:

- **System prompts contain no `{{PLACEHOLDER}}`.** Several tests assert
  `assert.doesNotMatch(systemPrompt, /\{\{/)`. Anything dynamic goes in the user prompt.
- **User prompts are the template.** Placeholders are `{{UPPER_SNAKE}}` and every one must
  be supplied in the runner's `promptArgs`, because `renderSlimMessage` does a literal
  substitution and an unsupplied placeholder ships to the model verbatim.
- **Prompts travel through argv.** After rendering, runners call `enforceArgvSizeLimit`. A
  prompt that grows a large inlined section can start silently skipping tickets with
  `prompt_too_large`. Large inputs are **file-backed** instead — written into the worktree
  with only the path passed in `promptArgs`, the way `extra-review-inputs.mts` does for the
  PRD-level gates and `pr-review-inputs.mts` does for PR review. Never inline a diff.
- **The completion signal is part of the contract.** If a prompt tells the agent to emit
  `<promise>COMPLETE</promise>` or `</pr_review_complete>`, the runner's `completionSignal`
  must match that string exactly, or the run burns its whole iteration budget before
  stopping. The full mapping is in
  [architecture.md](architecture.md#agent-invocation).

Which prompt drives which agent is listed in
[AGENTS.md § 2](../AGENTS.md#2-prompt-md-files-are-literal-asserted--edit-both-sides).

---

## Add a field to the TUI status snapshot

The snapshot is a shared contract — one type, imported by both the writer and the reader, so
they cannot drift ([ADR 0002](adr/0002-companion-tui-reads-loop-emitted-status-snapshot.md)).

1. **`tui-status.mts`** — add the field to `TuiStatus` (or `TuiStep` / `TuiTicket`) and
   populate it in `buildTuiStatus`. Make it optional unless every loop can supply it; a
   reader may encounter a snapshot written by an older loop binary.
2. **`tui-emitter.mts`** — add the setter or thread it through the existing context, if the
   loop needs to supply it.
3. **`tui-view.mts`** — derive the display value in `deriveStatusView`, returning it on
   `StatusView`. This is where the logic goes.
4. **`tui-companion.mts`** — render the already-derived value. No computation here.
5. Tests: `tui-status.test.mts` for the contract, `tui-view.test.mts` for the derivation.

Bump `TUI_STATUS_SCHEMA_VERSION` only if the payload shape changes incompatibly. Adding an
optional field does not; renaming or retyping one does. (ADR 0004 kept the version at 1
precisely because only the *filename* changed.)

---

## Add or rename a loop step

Steps are what the TUI displays and times. An **agent step** is one sandboxed agent
invocation and owns a working log; a **host step** is host-side work and freezes the log
pane.

1. Call `tuiEmitter.beginHostStep("<name>", detail?)` or
   `tuiEmitter.beginAgentStep({ stage, agent, model, worktreePath, activeLogPath })` at the
   transition point in the runner.
2. Add the name to the documenting comment on `TuiStep` in `tui-status.mts` — that comment
   is the canonical list of step names.
3. If the TUI should show it as something other than the raw name, add the mapping in
   `tui-view.mts`.

Emitter calls are on the observability plane: side-effect-only, and a throw inside one can
never reach loop control flow. Add them freely.

---

## Add a config knob

`.sandcastle/config.mts` lives in the target repo and is optional, so every knob needs a
default.

1. **`sandcastle-loop-config.mts`**: add the field to `SandcastleLoopConfig` (all-optional,
   user-facing) *and* to `ResolvedSandcastleLoopConfig` (fully resolved, what runners read).
2. Add a `DEFAULT_*` constant and apply it in `loadSandcastleLoopConfig`.
3. Add a shape check in `validateConfig` — it throws with `${configPath}: …` on a bad type,
   so an operator gets a real message instead of a downstream `undefined`.
4. Read it in the runner. If it should also be overridable per run, add a CLI flag via
   `readCliStringFlag` and resolve as `flagOverride ?? LOOP_CONFIG.<field>`.
5. Add it to the startup summary the runner logs — operators debug from that block.
6. Test in `sandcastle-loop-config.test.mts`: default applied, user value honored, bad value
   rejected.

---

## Add logic to a runner

The house rule is **thin runner, deep pure module**. Before adding an `if` to
`run-backlog-v3.mts`, ask whether the decision belongs in `issue-as-prd-orchestrator.mts`,
`issue-as-prd-state.mts`, or `per-branch-engine.mts`.

When it genuinely is runner work:

1. Put the decision in a pure module: explicit input type, explicit output type, no
   `node:child_process` import. Return a discriminated union for outcomes
   (`{ kind: "approved" | "stuck" | … }`), matching `PerBranchEngineOutcome`.
2. Inject side effects through a `deps` object the runner builds and a test can fake. The
   large object `run-backlog-v3.mts` passes to `runIssueAsPrdParent` is the reference
   example; `createDeps` in `issue-as-prd-validation.test.mts` is the reference fake.
3. Wire it in the runner, inside the existing per-ticket try/catch.
4. Unit-test the module. If the wiring itself is load-bearing, add an assertion to
   `run-backlog-v3-static.test.mts` — that file is the only coverage the runner body has.
5. Add the module to the `typecheck` allowlist in `package.json` if a glob doesn't already
   catch it.

Anything that mutates GitHub or git state goes through `runVerifiedHostMutation`
(mutate → read back → verify → retry). Anything that can end a ticket should record both a
failure diagnostic (`recordLoopFailureDiagnostic`) and an outcome (`recordIssueOutcome`).

---

## Cut a new runner version

Only when a behavior change would break loops already deployed against the current version.

1. Copy `run-backlog-v3.mts` → `run-backlog-v5.mts` (or the next PRD number).
2. Rewrite the header comment. Look at `run-backlog-v4.mts`'s header for the bar: it states
   what changed versus the previous version, the measurement that motivated it, and the
   configuration surface. A version bump without that rationale is not reviewable.
3. Add a policy entry in `per-branch-policy.mts` rather than inlining constants.
4. Add the file to the `typecheck` allowlist, and to `build` if it is a shipping entrypoint.
5. Add a static test, or extend `run-backlog-v3-static.test.mts`. Note that file's shape:
   `assert.doesNotMatch(backlogV2, /runIssueAsPrdParent\(/)` exists to prove older runners
   have **not** adopted newer behavior. Add the equivalent guard for whatever your version
   introduces.
6. Leave every older runner untouched.

---

## Add an issue-forge operation

Issue operations go through an interface with two implementations: `github-issues.mts`
(`gh api`, the default) and `forgejo-tea.mts` (the `tea` CLI).

Add the method to the interface and implement it in both. Do not shell `gh` from a call
site that already has a client — that is how the abstraction rotted before.

`run-pr-review-v1.mts` is the deliberate exception: it shells `gh pr` directly and has no
forge abstraction.

---

## Investigate a loop failure

You will usually be handed artifacts rather than a live loop. In the **target** repo:

| Question | Look at |
| --- | --- |
| Why did a run stop? | The loop's final stdout block (`Reason: …`), then `.sandcastle/diagnostics/`. |
| Why did this parent wedge? | The parent's state comment, its labels, and whether `issue-<N>-accumulation` agrees local vs remote. Disagreement = ownership ambiguity. |
| What did the agent actually do? | `.sandcastle/tui/logs/<run-name>.log` (loop-formatted) and `.sandcastle/logs/*.log` (raw). |
| Why did a review round stop? | `.sandcastle/extra-review-runs/<prd>/<round>/HANDOFF.md`, then the `*.raw.txt` alongside it. |
| Is this a pattern or a one-off? | `.sandcastle/metrics/runs.jsonl` via `metrics.py --detail`. |

`parse_failure` means an agent emitted off-schema JSON — read the `.raw.txt`, then either
tighten the prompt or fix the parser in `extra-review-parsers.mts`. Changing a prompt's
output shape without updating the parser turns every round into `parse_failure`.

Recovery procedures for wedged parents are in
[issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md#manual-recovery); the tool is
`recover-backlog-v3-issues.mts` (dry-run by default).

---

## Naming

Use `CONTEXT.md` terms exactly. It is not a glossary of nice-to-haves — each entry carries
an `_Avoid_` list of the terms that get conflated with it, and those conflations are the
ones that have actually caused bugs here:

| Use | Not |
| --- | --- |
| *agent invocation livelock* (one run repeating tool calls) | *issue-level no-progress* (identical results across rounds) |
| *extra review round* (one PRD-level gate cycle) | *review round* (one coder↔reviewer attempt) |
| *sub-task child issue* (under a parent, `parent-<N>`) | *follow-up PRD issue* (from a PRD-level gate) |
| *agent step* (one agent invocation, has a log) | *host step* (host-side work, no log) |
| *accumulation branch* (`issue-<N>-accumulation`) | *issue branch*, *work branch* |
| *Issue-as-PRD loop* | *PRD loop*, *backlog-clearer loop* |

When you introduce a new concept, add it to `CONTEXT.md` **before** naming things after it.
The vocabulary is supposed to drive the code, not trail it.

---

## Writing documentation

Match the existing register: direct, present tense, no hedging, tables over prose when the
content is a mapping. Existing docs state what the system does and why, and are explicit
about what is forbidden — see the "Forbidden behavior checklist" in
[issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md).

Pick the right home ([AGENTS.md § documentation map](../AGENTS.md#documentation-map)):

- **ADR** when a decision would otherwise be "fixed" by a future reader. Format: title as
  the decision, `## Context`, `## Decision`, `## Consequences`, with the rejected options
  and why. Number sequentially.
- **PRD** (`docs/prd/NNN-*.md`) for a capability: `## Problem Statement`, `## Solution`,
  then requirements. Written from the operator's point of view.
- **Plan** (`docs/plans/YYYY-MM-DD-*.md`) for implementation: checkbox tasks, each ending
  green on typecheck + tests, addressed to the agent that will execute it.
- **Runbook** (`docs/*-setup.md`) for anything an operator does by hand.

Date-stamp plans with the real date and convert relative dates to absolute — these documents
outlive the conversation that produced them.
