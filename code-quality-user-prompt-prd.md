# Extra Code-Quality Review - PRD {{PRD_NUMBER}}

# File-backed inputs

Use these path arguments exactly as provided; paths are relative to the worktree root unless absolute.

- PRD body: `{{PRD_BODY_PATH}}`
- Review metadata JSON: `{{REVIEW_METADATA_PATH}}`
- Changed files list: `{{CHANGED_FILES_PATH}}`
- Diff stat: `{{DIFF_STAT_PATH}}`
- Full diff: `{{DIFF_PATH}}`

Read the PRD body, metadata, changed files, diff stat, and full diff from those files. Do not expect the diff or PRD body to be provided inline in this message.
