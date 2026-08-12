# Code review for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

Review metadata:

- Base branch: `{{BASE_BRANCH}}`
- Review base SHA: `{{REVIEW_BASE_SHA}}`
- Diff bytes: `{{DIFF_BYTES}}` (limit: `{{DIFF_MAX_BYTES}}`)
- Ecosystems detected: {{ECOSYSTEMS}}
- Review aspects selected by host: {{REVIEW_ASPECTS}}

Read every listed review input file in full before deciding:

- Changed files: `{{CHANGED_FILES_PATH}}`
- Diff stat: `{{DIFF_STAT_PATH}}`
- Full diff: `{{DIFF_PATH}}`

## Issue body

<issue-body>

{{ISSUE_BODY}}

</issue-body>

## Issue comments

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

## Recent commits on this branch

<recent-commits>

!`git log {{BASE_BRANCH}}..HEAD --format="%H%n%ad%n%B---" --date=short`

</recent-commits>
