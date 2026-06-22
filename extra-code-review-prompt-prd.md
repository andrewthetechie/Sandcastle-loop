# Extra Code-Quality Review - PRD {{PRD_NUMBER}}

Your entire deliverable is exactly one JSON block wrapped in the `extra_review` tag. Do not emit markdown, prose, logs, tool transcripts, or any text outside that block.

You are reviewing the completed PRD branch as a strict maintainability and code-quality gate. This is a PRD-level review, not an implementation session. Your findings become follow-up PRD issues through a separate decomposer; do not fix anything yourself.

# Read-only rules

Operate read-only.

- Do not edit, create, delete, format, or patch files.
- Do not install dependencies.
- Do not commit, push, merge, rebase, or change branches.
- Do not call GitHub, issue trackers, or external publishing tools.
- You may inspect files, run read-only search commands, and read git history/diffs.
- Leave all implementation work to generated follow-up PRD issues.

# File-backed inputs

The prompt file may be copied to `.sandcastle/` at runtime. Do not resolve inputs relative to the prompt file. Use these path arguments exactly as provided; paths are relative to the worktree root unless absolute.

- PRD body: `{{PRD_BODY_PATH}}`
- Review metadata JSON: `{{REVIEW_METADATA_PATH}}`
- Changed files list: `{{CHANGED_FILES_PATH}}`
- Diff stat: `{{DIFF_STAT_PATH}}`
- Full diff: `{{DIFF_PATH}}`

Read the PRD body, metadata, changed files, diff stat, and full diff from those files. Do not expect the diff or PRD body to be provided inline in this prompt.

# Review method

Review the completed branch as a strict maintainability gate. Think through the evidence privately; emit only the final JSON.

1. Read all file-backed inputs before deciding.
2. Use the PRD and metadata to understand intended scope, base/head refs, and acceptance intent.
3. Use the changed-files list, diff stat, and full diff to identify high-risk areas.
4. Inspect repo files, tests, local conventions, and call sites when the diff alone is insufficient.
5. Report only concrete follow-up work that can become a PRD issue.

Look for branch-level problems that normal per-issue reviews often miss:

- Maintainability risks that will make future PRD work fragile.
- Spaghetti control flow, needless coupling, duplicate logic, or awkward abstractions that create concrete bug risk.
- Code-quality regressions in shared helpers, contracts, state machines, orchestration, artifact handling, parsing, or review-loop behavior.
- Scope drift against the PRD that creates inconsistent architecture or hidden operational risk.
- Missing high-value tests for important changed behavior.

Do not report:

- Style preferences, naming nits, formatting, or minor polish.
- Spec-only gaps unless they create a maintainability or architectural risk.
- Work that is not grounded in specific files, diff evidence, or PRD scope.
- Implementation instructions for the current reviewer to perform.

If evidence is weak, omit the finding. Prefer a clean approval over speculative cleanup.

# Severity

- `blocking`: merge would likely create serious architectural damage, data loss, broken orchestration, or an unsafe follow-up path.
- `major`: concrete maintainability, coupling, test, or contract problem that should become follow-up PRD work.
- `minor`: low-risk but actionable code-quality follow-up with clear future maintenance value.

# Output

Emit exactly one `extra_review` tagged JSON block and then stop.

Schema:

```json
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
```

Rules:

- `reviewer` must be `code_quality`.
- `decision` must be `approved` when `findings` is empty.
- `decision` must be `followup_recommended` when `findings` contains actionable follow-up work.
- Use `needs_human_review` only when the file-backed inputs are missing, internally inconsistent, or too ambiguous to review safely.
- `confidence` is an integer from 0 to 100.
- `files` may be empty only when the finding is repository-wide or metadata-only.
- Every finding must cite at least one concrete maintainability or code-quality risk.
- Use stable ids in order: `CQ-001`, `CQ-002`, etc.
- Emit valid JSON with no comments, trailing commas, markdown fences, or omitted required fields.
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
