# PRD: Structured output MCP tools for loop reliability

## Problem Statement

Both the backlog Issue-as-PRD loop and the PRD loop rely on LLMs producing structured JSON output wrapped in XML tags for 6 different contracts. The host-side parsers extract the tagged block from stdout, parse the JSON, and validate against the expected schema. When the LLM produces malformed JSON, the wrong shape, missing tags, multiple tags, or semantically inconsistent output (e.g., `approved` with non-empty findings), the parser rejects the output and the loop must retry or fail the round.

From the operator's perspective, a round that could have succeeded burns extra sandbox time for retries, creates misleading stuck-issue comments when reviewer parse failures get misrouted into rework/no-progress handling, and forces humans to inspect logs to decide whether the failure was a genuine code problem or a formatting issue.

This is distinct from agent invocation livelock or issue-level no-progress. Agent invocation livelock is a single coder or rework run repeating tool calls while active. Issue-level no-progress is repeated identical failed outcomes across completed rounds. This PRD is about eliminating the root cause: the LLM's free-form text output at the end of a long session is the least reliable place to generate valid structured data.

Note: The extra-review agents already mitigate post-output drift by using completion signals (`</extra_review>`, `</followup_issues>`) that terminate the sandbox run as soon as the closing tag is emitted. The reviewer verdict acquisition also scans stdout and tolerates trailing text. The remaining risk addressed here is JSON malformation within the tag, not unbounded post-output drift.

## Solution

Replace prompt-generated tagged JSON with MCP produce tools that the agent calls with typed arguments. Each tool validates the arguments against the contract schema, writes the validated output as JSON to a known file path in the worktree, and returns validation errors to the agent when the arguments don't satisfy the contract. The agent iterates until the tool accepts, then emits a lightweight `<done>` completion signal. The host reads the structured output from the file path.

A dual-reader approach in the host-side acquisition functions checks the file path first; if the file doesn't exist (backward compatibility during incremental migration), the host falls back to stdout parsing.

## User Stories

1. As a loop operator, I want the reviewer agent to call a typed tool instead of generating `<review>` XML-tagged JSON, so that malformed JSON and missing-tag parse failures are eliminated from the reviewer output path.

2. As a loop operator, I want the code-quality extra-review agent to call a typed tool instead of generating `<extra_review>` XML-tagged JSON, so that extra-review contract violations are caught by the tool's argument validation, not by a post-hoc parser.

3. As a loop operator, I want the two-axis extra-review agent to call a typed tool instead of generating `<extra_review>` XML-tagged JSON, so that two-axis review findings with wrong shapes or missing required fields return structured errors the agent can fix before completing.

4. As a loop operator, I want the decomposer agent to call a typed tool instead of generating `<followup_issues>` XML-tagged JSON, so that follow-up issue drafts with missing acceptance criteria or provenance are rejected with specific field-level error messages the decomposer can act on.

5. As a loop operator, I want the initial issue decomposer agent to call a typed tool instead of generating `<initial_issue_decomposition>` XML-tagged JSON, so that initial subtask drafts with inconsistent status or invalid priorities are caught early.

6. As a loop operator, I want the subtask readiness agent to call a typed tool instead of generating `<subtask_readiness>` XML-tagged JSON, so that readiness dispositions with missing assumptions sections or invalid close reasons are returned as corrective error messages.

7. As a loop operator, I want the MCP tool to return typed validation errors back to the agent, so that the agent can self-correct by adjusting arguments and retrying the tool call before emitting the completion signal.

8. As a loop operator, I want the agent to emit a lightweight `<done>` completion signal after the MCP tool succeeds, so that the host knows the structured output file is ready and the sandbox run can stop deterministically.

9. As a loop operator, I want the host to read the structured output from a known file path in the worktree after the sandbox closes, so that the host never parses free-form LLM text output for structured data.

10. As a loop operator, I want the host dual-reader to fall back to stdout parsing when the expected output file does not exist, so that prompts and agents can be migrated one contract at a time without breaking the whole loop.

11. As a loop operator, I want each MCP tool call to validate semantic invariants (e.g., `approved` with zero findings, `status: issues` with at least one issue, `disposition: assumed` with an Assumptions section), so that the same consistency rules enforced by current parsers are enforced by the tool.

12. As a loop operator, I want the MCP tool to write each structured output to a fixed path per contract inside `.sandcastle/outputs/`, so that the host reader always knows where to look without needing a dynamic identifier.

13. As a loop operator, I want the migration to add the MCP entry into the target project's `.opencode/opencode.json` without destroying any existing project MCP configuration, so that projects that already use opencode tools are not disrupted.

14. As a loop operator, I want coder and rework agents to continue using their existing `<promise>COMPLETE</promise>` completion signal unchanged, so that the code-generation pipeline is unaffected by this change.

15. As a loop maintainer, I want the MCP server to be a self-contained Node.js executable with zero runtime dependencies inside the sandbox beyond Node itself, so that no `npm install` or bundling step is needed inside the sandbox. Build-time dependencies (the MCP SDK) are bundled into the single `.mjs` file by esbuild at deploy time.

16. As a loop maintainer, I want the MCP server binary to be copied into the target project worktree via the existing `COPY_TO_WORKTREE` mechanism, so that no additional Docker image configuration or sandbox mount configuration is required.

17. As a loop maintainer, I want the opencode config writer to be a host-side helper that merges the MCP entry into the target project's `.opencode/opencode.json`, so that the target project's own opencode configuration is preserved.

18. As a loop maintainer, I want each loop variant to be migrated independently via the dual-reader fallback path, so that the fix can be rolled out incrementally across the active runners.

## Implementation Decisions

**MCP server binary**. A single self-contained `.mjs` file implementing the stdio MCP transport. The TypeScript source file lives at `.sandcastle/mcp/structured-output-server.ts` in this repository. The bundled `.mjs` output is produced at deploy time by a separate `build:mcp` npm script (distinct from the existing `build` script that bundles the runners). The `.sandcastle/mcp/` directory does not currently exist in the repo and must be created as a source directory before the server files are added.

**Worktree root resolution**. At startup, the server resolves the worktree root by running `git rev-parse --show-toplevel` and caches the result. All output paths (`.sandcastle/outputs/{contract}.json`) are relative to this root. The worktree is always a valid git repo, so no fallback is needed.

**MCP protocol**. The server implements the standard MCP protocol over stdio using the `@modelcontextprotocol/sdk` package. The SDK is added to `devDependencies` in `package.json` (build-time only — esbuild inlines it). Exposes `tools/list` and `tools/call` handlers via the SDK's `Server` class. An additional npm script `build:mcp` is added to `package.json` that uses esbuild to bundle the server TypeScript source and the SDK into a single `.mjs` output file at `.sandcastle/mcp/structured-output-server.mjs`. The `build:mcp` script must NOT mark `@modelcontextprotocol/sdk` as external — it must be inlined. The existing `build` script for the runners is not modified. The sandbox receives the single bundled file with zero runtime `npm install` requirements.

**Output paths**. Each contract writes to a fixed path inside the sandbox worktree. The server creates `.sandcastle/outputs/` relative to the worktree root if it does not exist. The directory is inside the sandbox container and is discarded when the sandbox closes.

**Atomic writes**. The server writes to a temporary file in `.sandcastle/outputs/` and then renames it to the final path (atomic on POSIX). This prevents partial writes from producing corrupt JSON. The dual-reader truncates the output file at the start of each acquisition attempt to avoid stale data from a previous attempt within the same sandbox session. If the file is missing after a run (server crash, write failure), the dual-reader falls back to stdout parsing.

| Contract | Tool name | Output path |
|---|---|---|
| Reviewer verdict | `submit_review` | `.sandcastle/outputs/review.json` |
| Code quality extra review | `submit_code_quality_review` | `.sandcastle/outputs/code-quality-review.json` |
| Two-axis extra review | `submit_two_axis_review` | `.sandcastle/outputs/two-axis-review.json` |
| Followup issues | `submit_followup_issues` | `.sandcastle/outputs/followup-issues.json` |
| Initial decomposition | `submit_initial_decomposition` | `.sandcastle/outputs/initial-decomposition.json` |
| Subtask readiness | `submit_subtask_readiness` | `.sandcastle/outputs/subtask-readiness.json` |

**Tool signatures**. Each tool accepts typed arguments matching the existing TypeScript contracts in `extra-review-contracts.mts`, `issue-as-prd-contracts.mts`, and `reviewer-result.mts`. JSON Schema parameter definitions are embedded in the server. The two-axis review tool (`submit_two_axis_review`) accepts `standards_findings` and `spec_findings` as two separate arrays — matching the `TwoAxisExtraReview` type — not a single `findings` array.

**Validation rules**. The server enforces the same semantic invariants that the current parsers enforce:

**Reviewer verdict** (`submit_review`):
- `decision: "approved"` requires empty `findings`
- `decision: "changes_requested"` / `"needs_human_review"` requires non-empty `findings`

**Extra review** (`submit_code_quality_review`, `submit_two_axis_review`):
- `decision: "approved"` requires zero findings (for `two_axis`: both `standards_findings` and `spec_findings` must be empty, checked independently)
- `decision: "followup_recommended"` requires one or more findings total (for `two_axis`: combined length of `standards_findings` + `spec_findings`)

**Followup issues** (`submit_followup_issues`):
- `status: "issues"` requires non-empty `issues` array and empty `needs_human_review_reason`
- `status: "no_work"` requires empty `issues` and empty `needs_human_review_reason`
- `status: "needs_human_review"` requires empty `issues` and non-empty `needs_human_review_reason`
- Each `FollowupIssueDraft` must have at least one `source_findings` entry
- `FollowupIssueSourceFinding.axis` must match the originating reviewer: `code_quality` reviewer → `axis: "code_quality"`; `two_axis` reviewer → `axis: "standards"` or `"spec"`

**Initial decomposition** (`submit_initial_decomposition`):
- `status: "issues"` requires non-empty `issues` array and empty `needs_human_review_reason`
- `status: "no_work"` requires empty `issues` and empty `needs_human_review_reason`
- `status: "needs_human_review"` requires empty `issues` and non-empty `needs_human_review_reason`

**Subtask readiness** (`submit_subtask_readiness`):
- `disposition: "assumed"` requires `## Assumptions` section in `proposed_body` and empty `close_reason`
- `disposition: "fixed"` requires empty `close_reason`
- `disposition: "not_actionable"` requires non-empty `close_reason`

**Tool return shape**. Each tool returns `{ ok: true }` on success. On validation failure, returns `{ ok: false, errors: [{ code, path, message, expected?, actual? }] }` — matching the existing `ParseFailureDetail` shape exactly. The LLM sees the errors inline and can retry the tool call with corrected arguments.

Note: Two isomorphic parse-failure detail types exist in the codebase — `ParseFailureDetail` (`extra-review-contracts.mts:110`) and `IssueAsPrdParseFailureDetail` (`issue-as-prd-contracts.mts:76`) — with identical `{ code, path, message, expected?, actual? }` shapes. The MCP server should define its own standalone error type with the same shape to preserve machine-readable `code` categorization for downstream metrics and diagnostics, without coupling to either contract type.

**Completion signal**. All agents that currently produce structured output switch to `<done>` as their completion signal. Coder and rework agents retain `<promise>COMPLETE</promise>`.

Each agent session definition and runner call site that sets a `completionSignal` must be updated:
- Extra-review sessions: `extra-review-sessions.mts:72,81,90` — change `"</extra_review>"` and `"</followup_issues>"` to `"<done>"`.
- Reviewer sessions in runners: `run-backlog-v3.mts`, `run-backlog-v2.mts`, `run-backlog.mts`, `run-prd-v4.mts` — change `completionSignal: "</review>"` to `completionSignal: "<done>"`.
- Issue-as-PRD sessions: The completion signal is set by `runIssueAsPrdPromptSession` in `run-backlog-v3.mts:950` (not by `issue-as-prd-sessions.mts`). Change from `"</initial_issue_decomposition>"` / `"</subtask_readiness>"` to `"<done>"` when those contracts are migrated. The coder/rework agents in these sessions already use `<promise>COMPLETE</promise>` and are unchanged per out-of-scope.

The completion signal is the single point where the sandbox runner knows to stop. The LLM emits `<done>` after the MCP tool succeeds, replacing the earlier pattern where the closing XML tag served double duty as both the output delimiter and the stop signal.

**issue-as-prd-extra-review migration**. `issue-as-prd-extra-review.mts` parses structured output during the full-parent review step in the Issue-as-PRD loop. It uses the same extra-review and followup-issues contracts as the PRD loop's extra review. It is in scope for MCP migration and should be migrated when its corresponding contracts (code quality, two-axis, followup issues) are switched over.

**Project-level opencode config**. A host-side helper function writes or merges the MCP entry into the target project's `.opencode/opencode.json`. The entry:

```json
{
  "mcp": {
    "sandcastle-structured-output": {
      "type": "local",
      "command": ["node", ".sandcastle/mcp/structured-output-server.mjs"]
    }
  }
}
```

The helper reads the existing config if present, adds or replaces the `sandcastle-structured-output` key under `mcp`, and writes the result. If `.opencode/opencode.json` does not exist (as is the case for this repo and any project not yet configured for opencode MCP), the helper creates the file with the correct structure. The initial-creation path must create the parent `.opencode/` directory with `mkdirSync` and `recursive: true` (following the pattern established in `custom-agent-worktree.mts:36`).

The helper is called inline in each runner after `createSandbox`, right alongside `ensureOpencodeGitExclude`. It lives in a shared module (e.g., `mcp-config.mts`) so it's DRY across runners. This follows the existing pattern in `runIssueAsPrdPromptSession` (`run-backlog-v3.mts:940-945`) where `ensureOpencodeGitExclude` is called before the first `sandbox.run`.

**COPY_TO_WORKTREE update**. The bundled output file `".sandcastle/mcp/structured-output-server.mjs"` is added to every loop variant's `COPY_TO_WORKTREE` array. The deploy pipeline must run `npm run build:mcp` before the loop starts so the bundled file exists at the expected path. The source `.ts` file is not copied into the worktree.

**Migration order**. Migrate contracts in order of production impact:
1. **Reviewer verdict** — called on every issue round in every runner; highest exposure to parse failures.
2. **Code quality extra review** — first session in every extra review round; catches the most issues.
3. **Two-axis extra review** — runs alongside code quality in the same round.
4. **Followup issues** — depends on both review sessions having run.
5. **Initial decomposition** — Issue-as-PRD only.
6. **Subtask readiness** — Issue-as-PRD only, simplest shape.

**Dual-reader host-side plumbing**. Each structured-output acquisition function gains an optional worktree path parameter. The worktree path is threaded from the sandbox object (which exposes `sandbox.worktreePath`) through the session runner down to the parse call site.

The existing patterns already provide a channel:
- `issue-as-prd-sessions.mts:199` — `acquireWithRetries` accepts `worktreePath?: string` (currently unused for file reading; use it as the file-read path).
- `extra-review-sessions.mts` — `runSession` is called with `input.sandbox.worktreePath` at `:758`. This path can be passed into the acquisition function.
- `reviewer-result.mts:88` — `acquireReviewerResult` receives a plain `stdout` string. The function gains an optional `worktreePath` parameter. When provided and the expected output file exists at `.sandcastle/outputs/review.json` relative to it, the function reads the file and parses the JSON directly instead of scanning `stdout`. The existing `stdout` → run-log fallback chain is preserved when the file is absent.

The fallback logic: if the worktree path is provided and `.sandcastle/outputs/{contract}.json` exists relative to it, read and parse that file; otherwise pass `result.stdout` through the existing parser. This keeps the existing parser functions as the fallback.

**Prompt updates**. Each prompt file that currently instructs the LLM to produce XML-tagged JSON will be updated to instruct the LLM to call the corresponding MCP tool with typed arguments, then emit `<done>`. The prompt explicitly names the tool to call (e.g., "Call `submit_code_quality_review` with your findings"). The existing argument descriptions (what `decision` values are valid, what `findings` looks like, etc.) remain relevant as documentation for what values to pass.

**Per-agent tool scoping**. In addition to the prompt naming the tool, the opencode agent definition for each session should scope the agent to only its relevant MCP tool. This is a defense-in-depth measure — if opencode supports per-agent tool filtering, use it; if not, the prompt-driven approach alone is sufficient and tool scoping can be added later when opencode supports it.

## Testing Decisions

- Tests should exercise externally observable behavior: given a valid MCP tool call, does the expected file appear at the expected path with the expected content? Given an invalid tool call, does the tool return the expected error shape?
- The MCP server should be tested in isolation via direct function calls (not through the stdio transport). Export the handler functions and test argument validation, semantic rule enforcement, and file writing.
- The opencode config helper should be tested against a temp directory: given an existing config with other MCP entries, verify the merge preserves them; given no existing config, verify the helper creates the file with the correct structure.
- The dual-reader host-side functions should be tested with both paths: a file that exists triggers file reading; a file that does not exist falls back to stdout parsing.
- Use the same testing infrastructure as the existing `extra-review-parsers.test.mts`, `issue-as-prd-parsers.test.mts`, and `reviewer-result.test.mts` files: synthetic inputs, no real Sandcastle or opencode launches, no GitHub dependencies.
- Do not launch real Docker containers or opencode agents in unit tests.

## Out of Scope

- Changing the coder or rework agent prompt or completion signal.
- Changing sandcastle, opencode, or the @ai-hero/sandcastle library.
- Migrating every loop variant simultaneously (dual-reader enables incremental migration).
- Adding a sandbox-side validation tool that validates without writing (the produce tool's error return covers this use case).
- Changing the provider-level structured output mode (e.g., OpenAI response_format or Anthropic tool strict mode) as an alternative to MCP.
- Removing the existing parsers. They remain as the stdout fallback path.
- Migrating older loop variants (run-backlog.mts, run-prd.mts, run-prd-v3.mts, etc.) unless they share extracted helper modules.
- Adding a human review gate before MCP tool migration.
- Fixing unrelated LLM judgment quality issues (the tool validates format, not content).

## Further Notes

The motivating observation is that the LLM's final response after a long multi-turn session is the least reliable point for structured output. By moving the structured output production to a typed MCP tool call, we shift the reliability burden from "LLM generates correct JSON from a natural-language description" to "LLM selects correct argument values for a typed function call." The latter is a significantly easier problem for current LLMs and is the same mechanism used internally for all other tool calls.

The dual-reader approach is essential for incremental migration. Each contract can be migrated independently by updating its prompt and completion signal while leaving the other contracts on the old XML-tag path. The host-side acquisition function for each contract checks for the file first, so the prompt change is the single point of activation.

This PRD depends on the glossary distinction between agent invocation livelock (a single active agent run repeating tool calls), issue-level no-progress (repeated identical failed outcomes across completed rounds), and structured output parse failure (the LLM produces output that does not match the required contract). The failure addressed here is a structured output parse failure at the root, which manifests downstream as wasted retries, no-progress detection, or stuck issues depending on which contract failed.
