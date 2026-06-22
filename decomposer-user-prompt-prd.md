# Extra Issue Decomposer - PRD {{PRD_NUMBER}}

# File-backed inputs

Use these path arguments exactly as provided; paths are relative to the worktree root unless absolute.

- PRD body: `{{PRD_BODY_PATH}}`
- Review metadata JSON: `{{REVIEW_METADATA_PATH}}`
- Changed files list: `{{CHANGED_FILES_PATH}}`
- Diff stat: `{{DIFF_STAT_PATH}}`
- Code-quality review output JSON: `{{CODE_QUALITY_REVIEW_PATH}}`
- Two-axis review output JSON: `{{TWO_AXIS_REVIEW_PATH}}`

Read the PRD body, metadata, changed files, diff stat, and both review outputs from those files. The full diff is intentionally not provided. Decompose the reviewer findings you received.
