Your previous attempt was rejected. The findings in your message are your entire scope. Apply the smallest fix for each finding, commit, and stop.

Do not write narration before your first tool call. Begin with `read` or `edit`.

## Scope

In-scope files = the set cited in the findings' `file` fields.

For each finding:
- Open the cited file and line, read ~10 lines of context.
- Apply the smallest change that satisfies the finding's `remediation`.
- If `remediation` is unclear, implement only what the `problem` description directly requires.

Do not:
- Inspect or edit files outside the in-scope set.
- Refactor, rename, or restructure beyond what a finding explicitly requires.
- Fix related issues noticed while addressing a finding.
- Rewrite the feature instead of applying the reviewer-requested fix.
- Add tests unless a finding asks for them.
- Delegate to sub-agents or start hidden helpers.
- Change dependency manifests except for the missing-dependency rule below.
- Delete or rewrite an existing import to silence an unresolved-module error.

## Output

- Edit only the files cited in findings.
- Run targeted validation only when a cheap confirmation command is obvious.
- `git add <files>` then `git commit -m "<message>"` — mandatory; the host only sees committed history.
- Verify: `git log -1 --stat` must show your fix; `git status -s` must be empty.

## Missing dependency

If validation shows an unresolved import, install the missing package. Do not delete or rewrite the import.

1. Detect the package manager from manifest files; use its native add command.
2. Use the exact package name from the error.
3. Dev dependency if the importer is test code; runtime otherwise.
4. Do not pin a version.
5. Install one package at a time; re-run the failing command before committing.

## Host-only database validation

Full PostgreSQL validation runs on the host, not here. Never run `pg-ensure`, `pg_ctl`, `postgres`, `docker`, `sudo`, `su`, or `alembic upgrade`. Make only the source or test change the feedback indicates; the host reruns the full gate after your commit.

## Completion

When `git log -1 --stat` shows your fix and `git status -s` is empty, emit:

<promise>COMPLETE</promise>

If a finding cannot be addressed without editing outside scope, leave it unaddressed, commit any in-scope fixes, and emit `<promise>COMPLETE</promise>`. The reviewer sees the remaining issue next round.

If every finding requires out-of-scope edits, or findings are mutually contradictory:
1. Commit any partial in-scope fixes (or nothing).
2. `<blocked>one or two sentences explaining why progress is impossible in scope</blocked>`
3. `<promise>COMPLETE</promise>`

Expanding scope to satisfy a finding is worse than leaving it unfixed.

If the cited findings are already satisfied on the current branch:
1. Commit nothing.
2. `<already_satisfied>one or two sentences citing existing files or behavior</already_satisfied>`
3. `<promise>COMPLETE</promise>`
