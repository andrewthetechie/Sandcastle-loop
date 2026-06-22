# Extra Two-Axis Review - PRD {{PRD_NUMBER}}

Your entire deliverable is exactly one JSON object wrapped in the `extra_review` tag. Do not emit markdown, prose, logs, tool transcripts, tool summaries, or any text outside that tag.

You are reviewing the completed PRD branch on two independent axes:

- Standards axis: whether the implementation follows documented project standards, architectural decisions, local conventions, and operational constraints.
- Spec axis: whether the completed branch satisfies the PRD requirements, issue intent, and acceptance criteria without gaps or contradictory behavior.

This is a PRD-level review, not an implementation session. Your findings become follow-up PRD issues through a separate decomposer; do not fix anything yourself.

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

Think through the evidence privately; emit only the final tagged JSON.

1. Read all file-backed inputs before deciding.
2. Use the metadata to understand review base/head refs, branch scope, and any recorded run context.
3. Use the changed-files list, diff stat, and full diff to identify touched behavior and high-risk areas.
4. Inspect relevant repo-owned docs, tests, surrounding code, and call sites only when needed to verify a standards or spec question.
5. Map each potential finding to exactly one axis unless the same defect creates distinct standards and spec follow-up work.

Keep the axes separate:

- Standards findings are about concrete violations of documented project standards, architectural decisions, local conventions, or operational constraints.
- Spec findings are about missing, incorrect, or contradictory behavior relative to the PRD requirements, issue intent, or acceptance criteria.

Do not invent standards. If repo docs are absent, infer standards only from clear, repeated local conventions in nearby code.

Report only concrete follow-up work that can become a PRD issue. Do not report style preferences, naming nits, formatting, subjective cleanup, or work not tied to documented standards, strong local conventions, or PRD/spec fit. If evidence is weak, omit the finding. Prefer approval over speculative cleanup.

# Severity

- `blocking`: merge likely leaves the PRD branch unsafe to use, materially violates a must-have PRD requirement, or breaks a core project constraint.
- `major`: actionable standards or spec gap that should become follow-up PRD work before the branch is considered complete.
- `minor`: low-risk but concrete follow-up that improves conformance to a documented standard or closes a small PRD/spec gap.

# Failure handling

Use `needs_human_review` only when the file-backed inputs are missing, unreadable, internally inconsistent, or too ambiguous to review safely. In that case, keep both finding arrays empty and explain the blocker in `summary`.

# Output

Emit exactly one `extra_review` tagged JSON block and then stop.

Schema:

```json
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
```

Rules:

- `reviewer` must be `two_axis`.
- `decision` must be `approved` when both finding arrays are empty.
- `decision` must be `followup_recommended` when either finding array contains actionable follow-up work.
- Use `needs_human_review` only when the file-backed inputs are missing, internally inconsistent, or too ambiguous to review safely.
- `confidence` is an integer from 0 to 100.
- `files` may be empty only when the finding is repository-wide or metadata-only.
- Keep standards and spec findings in their separate arrays.
- Use stable ids in order: `STD-001`, `STD-002`, etc. and `SPEC-001`, `SPEC-002`, etc.
- Every finding must name the violated standard, convention, requirement, issue intent, or acceptance criterion in `problem` or `impact` when identifiable.
- Every finding must cite the relevant changed or inspected file paths in `files` unless the issue is repository-wide or metadata-only.
- Keep findings issue-ready and implementation-free.
- Emit valid JSON with no comments, trailing commas, markdown fences, or omitted required fields.

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
