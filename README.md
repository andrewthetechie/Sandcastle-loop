# Sandcastle Loop

This repository contains prototype Sandcastle loop runners, including:

- PRD runners such as `run-prd-v3.mts` and `run-prd-v4.mts`
- the backlog Issue-as-PRD runner `run-backlog-v3.mts`

For the Issue-as-PRD operator contract, use:

- [docs/issue-as-prd-loop-setup.md](docs/issue-as-prd-loop-setup.md)
- [docs/issue-as-prd-loop-acceptance-trace.md](docs/issue-as-prd-loop-acceptance-trace.md)

Validation truth for this repo snapshot on 2026-07-03:

- `npm test`: passes
- `npm run typecheck`: passes
- `npm run build`: passes

That means the context test suite and the default host validation contract are both green in
this snapshot.
