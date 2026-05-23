# Rework — issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

Your previous attempt was rejected. **The findings below ARE your scope.** Make the smallest change that addresses each finding. Touch only the files cited. Do not refactor, do not "improve" surrounding code, do not "while you're here" anything — that is what got you here.

# Findings to address

{{REVIEW_FEEDBACK}}

# Process

1. For each finding, open the exact `file` and `line` cited. Read ~10 lines of context. Apply the smallest possible change that implements the finding's `remediation`.
2. **If a remediation is unclear**, do the minimum the `problem` description implies. Do not extrapolate or rewrite.
3. **Avoid inspection loops.** Don't browse files unrelated to the findings.
4. **Soft cap.** If the reviewer cited 2 files, you should edit ~2 files. Editing files outside the cited set is what got you rejected last time.
5. **Self-check before commit.** Run `git status` and `git diff --stat`. Any file outside the reviewer's findings → revert it.
6. **Commit** with a clear message.

Do not write narration or commentary before your first tool call. Begin with a `read` or `edit`.

# Anti-patterns — do NOT do these

- Refactor code outside the cited files.
- "Fix" related code you happen to notice while addressing a finding.
- Rewrite the whole feature because parts of it feel wrong.
- Add tests the reviewer didn't ask for.
- Rename / restructure / reorganize anything.
- Delegate to sub-agents or start hidden helpers.

# Completion

When fixes are committed and `git status` confirms no files outside the reviewer's findings were changed, emit `<promise>COMPLETE</promise>` on its own line and stop.

If a finding cannot be addressed without editing files outside the cited set, leave that finding unaddressed, commit any in-scope fixes, and emit `<promise>COMPLETE</promise>`. The reviewer will see it next round.

If every finding requires out-of-scope edits, or the findings are mutually contradictory and you cannot make safe progress, signal it to the host:

1. Commit any partial in-scope fixes (or nothing).
2. Emit `<blocked>one or two sentences explaining why progress is impossible in scope</blocked>`.
3. Emit `<promise>COMPLETE</promise>`.
4. Stop.

The host will route the issue to `agent-stuck` immediately with your reason — no further rework rounds, no wasted work. **Expanding scope to satisfy a finding is worse than leaving the finding unfixed.**

# Reference: issue body

<issue-body>

{{ISSUE_BODY}}

</issue-body>

# Reference: issue comments

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

# Reference: PRD

<prd>

{{PRD_BODY}}

</prd>
