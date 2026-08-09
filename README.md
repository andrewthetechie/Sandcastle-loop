# Sandcastle Loop

Autonomous coding loops built on [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle).
Each loop drives sandboxed agents (opencode in Docker) against a **target** repository,
using GitHub issues or PRs as the work queue and git branches as the unit of delivery.

The three live entrypoints:

| Runner | What it does |
| --- | --- |
| `run-backlog-v3.mts` | **Issue-as-PRD backlog loop.** Claims a triaged parent issue, decomposes it into child issues, drives each through coder↔reviewer, accumulates approved work on a durable branch, reviews the whole thing once, delivers review-ready. |
| `run-pr-review-v1.mts` | **PR review loop.** Polls open PRs, runs a review agent that fans out to Standards and Spec sub-agents, applies the fixes, pushes, labels `ai-review-complete`. |
| `tui-companion.mts` | **Companion TUI.** Read-only second-terminal view of a running loop. |

Older `run-prd-*` and `run-backlog-*` versions are kept as frozen snapshots — see
[docs/runners.md](docs/runners.md).

## Documentation

**Working on this repo?** Start with [AGENTS.md](AGENTS.md).

| Doc | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Contributors and coding agents: commands, invariants, house rules. |
| [docs/architecture.md](docs/architecture.md) | How a loop iteration executes, module layering, durable state, the TUI contract. |
| [docs/runners.md](docs/runners.md) | Every entrypoint: flags, flow, coverage, and what is frozen. |
| [docs/conventions.md](docs/conventions.md) | Recipes: change a prompt, add a TUI field, add a config knob, cut a runner version. |
| [CONTEXT.md](CONTEXT.md) | Ubiquitous language — the naming authority for this domain. |
| [docs/issue-as-prd-loop-setup.md](docs/issue-as-prd-loop-setup.md) | **Operators:** the `run-backlog-v3.mts` runbook — labels, terminal states, manual recovery. |
| [docs/issue-as-prd-loop-acceptance-trace.md](docs/issue-as-prd-loop-acceptance-trace.md) | Requirement-to-evidence mapping for that loop. |
| [docs/adr/](docs/adr/) | Decisions that look like bugs until you read them. |

## Checks

```bash
npm test        # tsx --test *.test.mts
npm run typecheck
npm run build
```

This snapshot is **not** fully green. As of `d6f6acd`: one failing test
(`issue-as-prd-validation.test.mts:96`) and one typecheck error
(`issue-as-prd-children.mts:66`); the build is clean. See
[AGENTS.md § known-red baseline](AGENTS.md#known-red-baseline) before assuming you broke
something.
