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
6. **Commit.** Run `git add <files>` then `git commit -m "<message>"`. **This step is mandatory.** Editing a file is not enough — the host only sees committed history, not the working tree. Uncommitted edits are silently discarded by the loop.
7. **Verify before emitting COMPLETE.** Run `git log -1 --stat` and `git status -s`. The log entry must show your changes; status must show nothing. If status shows modified files, you forgot to commit — go back to step 6.

Do not write narration or commentary before your first tool call. Begin with a `read` or `edit`.

# Anti-patterns — do NOT do these

- Refactor code outside the cited files.
- "Fix" related code you happen to notice while addressing a finding.
- Rewrite the whole feature because parts of it feel wrong.
- Add tests the reviewer didn't ask for.
- Rename / restructure / reorganize anything.
- Delegate to sub-agents or start hidden helpers.
- Replace one library with another, bump versions, or add packages outside what's needed for the reviewer's findings. The only legitimate dependency-manifest edit (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.) is installing a missing-but-imported package (see below).
- Delete or rewrite an existing `import` / `use` / `require` statement to silence a "cannot resolve module" error — install the missing package instead.

# Completion

When `git log -1 --stat` shows your fix and `git status -s` shows nothing, emit `<promise>COMPLETE</promise>` on its own line and stop. Emitting `COMPLETE` with uncommitted edits or with no commits is a failure mode — the host will throw the work away and re-invoke you on the next round.

If a finding cannot be addressed without editing files outside the cited set, leave that finding unaddressed, commit any in-scope fixes, and emit `<promise>COMPLETE</promise>`. The reviewer will see it next round.

If every finding requires out-of-scope edits, or the findings are mutually contradictory and you cannot make safe progress, signal it to the host:

1. Commit any partial in-scope fixes (or nothing).
2. Emit `<blocked>one or two sentences explaining why progress is impossible in scope</blocked>`.
3. Emit `<promise>COMPLETE</promise>`.
4. Stop.

The host will route the issue to `agent-stuck` immediately with your reason — no further rework rounds, no wasted work. **Expanding scope to satisfy a finding is worse than leaving the finding unfixed.**

## Missing dependency — install it, don't work around it

If the reviewer feedback or your own check shows an unresolved import / `use` / `require` / module reference, the missing package needs to be added to the project's dependency manifest. **Install it. Do not delete the import or rewrite the file to avoid it.** This is the only legitimate edit to the dependency manifest during rework.

Common shapes across ecosystems:

- TS/JS: `Cannot find module '<pkg>'`, `Failed to resolve import "<pkg>"`, `error TS2307`
- Python: `ModuleNotFoundError: No module named '<pkg>'`, `ImportError: ...`
- Rust: `` unresolved import `<crate>` ``, `could not find … in the registry`
- Go: `no required module provides package <pkg>`, `cannot find package`
- Ruby: `LoadError: cannot load such file -- <gem>`
- Java/JVM: `package <pkg> does not exist`

Rules:

1. **Detect the project's package manager** from the manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, etc.) and use its native add command so the lockfile updates correctly.
2. Use the **exact package/crate/module name** from the error.
3. Put it in the dev/test dependency section if the importer is test code (path or filename contains `test`/`spec`/`__tests__`, or it is the project's test setup file). Otherwise put it in the runtime dependencies. Skip this split if the ecosystem doesn't have one (e.g., Go modules).
4. Do **not** pin a specific version.
5. Install one package at a time, only for missing-import errors the reviewer's findings (or validation feedback) actually surface.
6. Re-run the failing validation command yourself to confirm it's resolved before committing.

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
