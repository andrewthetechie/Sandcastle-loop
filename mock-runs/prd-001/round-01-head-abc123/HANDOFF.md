# Extra Review Round Handoff

## Round
- PRD: prd-001 / #1
- Round: round-01-head-abc123 / #1
- Review base: base-sha
- Reviewed head: head-sha
- Stop reason: parse-failure
- Artifact directory: mock-runs/prd-001/round-01-head-abc123
- PRD label: prd-001

## Outcome
Round stopped because at least one extra-review output could not be parsed.

## Created Issues
No created issue records.

## Skipped Duplicates
No skipped duplicate records.

## Parse Failures
- Code-review output could not be parsed: Missing <extra_review>...</extra_review> block.
  - Parser: code_quality_extra_review
  - Code: missing_tag
  - Details: $ Expected exactly one <extra_review>...</extra_review> block.

## Needs Human Review
No needs-human-review details recorded.

## Raw Artifacts
- Raw code-review output: mock-runs/prd-001/round-01-head-abc123/code-review.raw.txt
- Parsed code-review JSON: mock-runs/prd-001/round-01-head-abc123/code-review.parsed.json
- Raw two-axis-review output: mock-runs/prd-001/round-01-head-abc123/two-axis-review.raw.txt
- Parsed two-axis-review JSON: mock-runs/prd-001/round-01-head-abc123/two-axis-review.parsed.json
- Raw issue-decomposer output: mock-runs/prd-001/round-01-head-abc123/issue-decomposer.raw.txt
- Parsed issue-decomposer JSON: mock-runs/prd-001/round-01-head-abc123/issue-decomposer.parsed.json

## Artifact Index
- Created issue records: mock-runs/prd-001/round-01-head-abc123/created-issues.json
- Skipped duplicate records: mock-runs/prd-001/round-01-head-abc123/skipped-duplicate-issues.json
- Handoff: mock-runs/prd-001/round-01-head-abc123/HANDOFF.md
