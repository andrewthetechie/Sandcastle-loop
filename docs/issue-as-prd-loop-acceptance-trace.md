# PRD 005 Acceptance Trace

Snapshot date: 2026-07-03

This trace records where PRD 005 requirements are implemented, tested, or documented in the
current repository state. It also records the current validation truth for this public-loop
context repo.

## Validation snapshot

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS | `tsx --test *.test.mts`; observed 362 passing tests, 0 failures |
| `npm run typecheck` | PASS | `package.json` defines `typecheck`; command exits 0 |
| `npm run build` | PASS | `package.json` defines `build`; command exits 0 |

Implication: the context suite and the default host validation contract described by PRD 005
are both green in this repo snapshot.

Testing mode note for this execution: on 2026-07-03 the user explicitly waived disposable-repo
smoke testing for this context repo and accepted unit/static coverage instead. The acceptance
matrix below therefore records the authoritative test evidence used to close Tasks 17 and 18.

## Task 17/18 acceptance matrix via unit/static tests

| Scenario | Evidence |
| --- | --- |
| clean child delivery | `issue-as-prd-orchestrator.test.mts` — `two approved initial children drain sequentially and second base equals first integration head` |
| zero-draft direct work | `issue-as-prd-orchestrator.test.mts` — `zero-draft direct parent approval still gets one full review and clean delivery` |
| dropped child | `subtask-readiness.test.mts` — `not_actionable child is closed and dropped without becoming ready` |
| partial delivery | `issue-as-prd-orchestrator.test.mts` — `later initial child stuck yields partial delivery after one full review` |
| rebase-conflict delivery | `issue-as-prd-refresh.test.mts` — `conflict aborts, verifies restored head, avoids force push, and returns diagnostics`; `issue-as-prd-refresh.test.mts` — `terminal observe reports rebase needed when pre-review conflicted or mainline advanced`; `backlog-v3-issue-as-prd-adapter.test.mts` — rebase-needed terminal label-plan cases |
| repair child | `issue-as-prd-validation.test.mts` — `approved repair child reruns the full gate from the beginning`; `issue-as-prd-validation.test.mts` — `already satisfied closes the repair child only when rerun is green` |
| acquisition exhaustion | `issue-as-prd-extra-review.test.mts` — `invalid required output after retries returns acquisition_failed with preserved artifacts`; `issue-as-prd-orchestrator.test.mts` — `full-parent review acquisition failure becomes parent_stuck even after integrated work` |
| restart after checkpoint | `backlog-v3-issue-as-prd-resume.test.mts` — resume/disagreement coverage; `backlog-v3-issue-as-prd-ownership.test.mts` — ownership verification over persisted state |
| terminal mainline movement | `issue-as-prd-refresh.test.mts` — `terminal observe reports rebase needed when pre-review conflicted or mainline advanced` |

## User stories

| Story | Trace |
| --- | --- |
| 1 | `issue-as-prd-orchestrator.mts`, `issue-as-prd-orchestrator.test.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| 2 | `issue-parent-context.mts`, `issue-parent-context.test.mts`, `run-backlog-v3.mts` |
| 3 | `issue-as-prd-orchestrator.mts`, `backlog-v3-issue-as-prd-adapter.mts` |
| 4 | `run-backlog-v3.mts`, `backlog-v3-issue-as-prd-acquire.mts`, `backlog-v3-issue-as-prd-acquire.test.mts` |
| 5 | `issue-as-prd-sessions.mts`, `issue-as-prd-sessions.test.mts` |
| 6 | `issue-as-prd-parsers.mts`, `issue-as-prd-prompt.test.mts`, `initial-issue-decomposer-*.md` prompt files referenced by tests |
| 7 | `issue-as-prd-children.mts`, `github-issues.mts`, `issue-as-prd-children.test.mts` |
| 8 | `issue-as-prd-queue-state.mts`, `issue-as-prd-queue-state.test.mts` |
| 9 | `issue-as-prd-children.mts`, `issue-as-prd-children.test.mts` |
| 10 | `backlog-v3-issue-as-prd-claim.mts`, `backlog-v3-issue-as-prd-resume.mts`, `backlog-v3-issue-as-prd-state-comment.mts`, related `*.test.mts` |
| 11 | `backlog-v3-issue-as-prd-claim.mts`, `backlog-v3-issue-as-prd-git-adapter.mts`, `backlog-v3-issue-as-prd-claim.test.mts` |
| 12 | `issue-as-prd-integration.mts`, `issue-as-prd-integration.test.mts` |
| 13 | `issue-as-prd-integration.mts`, `issue-as-prd-integration.test.mts`, `backlog-v3-issue-as-prd-children-adapter.mts` |
| 14 | `per-branch-engine.mts`, `per-branch-engine.test.mts` |
| 15 | `backlog-v3-issue-as-prd-children-adapter.mts`, `issue-as-prd-integration.mts`, `issue-as-prd-integration.test.mts` |
| 16 | `issue-as-prd-queue-state.mts`, `issue-as-prd-orchestrator.test.mts` |
| 17 | `issue-as-prd-parsers.mts`, `issue-as-prd-children.mts`, `issue-as-prd-orchestrator.test.mts` |
| 18 | `issue-as-prd-extra-review.mts`, `issue-as-prd-extra-review.test.mts`, `issue-as-prd-orchestrator.test.mts` |
| 19 | `issue-as-prd-extra-review.mts`, `extra-review-main-loop.mts`, `issue-as-prd-extra-review.test.mts` |
| 20 | `issue-as-prd-refresh.mts`, `issue-as-prd-refresh.test.mts`, `issue-as-prd-state-contracts.mts` |
| 21 | `issue-as-prd-children.mts`, `issue-as-prd-extra-review.mts`, `issue-as-prd-children.test.mts` |
| 22 | `issue-as-prd-extra-review.mts`, `issue-as-prd-extra-review.test.mts` |
| 23 | `issue-as-prd-extra-review.test.mts`, `issue-as-prd-orchestrator.test.mts` |
| 24 | `backlog-v3-issue-as-prd-adapter.mts`, `backlog-v3-issue-as-prd-adapter.test.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| 25 | `run-backlog-v3.mts`, `backlog-v3-issue-as-prd-adapter.test.mts`, [README.md](../README.md) |
| 26 | `issue-as-prd-orchestrator.mts`, `issue-as-prd-orchestrator.test.mts` |
| 27 | `issue-as-prd-queue-state.mts`, `backlog-v3-issue-as-prd-adapter.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| 28 | `run-backlog-v3.mts`, `backlog-v3-issue-as-prd-adapter.test.mts` |
| 29 | `subtask-readiness.mts`, `subtask-readiness.test.mts` |
| 30 | `subtask-readiness.mts`, `subtask-readiness.test.mts`, `issue-as-prd-orchestrator.test.mts` |
| 31 | `sandcastle-loop-config.mts`, `sandcastle-loop-config.test.mts`, `subtask-readiness-agent-system-prompt-prd.md` |
| 32 | `subtask-readiness.mts`, `subtask-readiness.test.mts` |
| 33 | `issue-parent-context.mts`, `subtask-readiness.mts`, `subtask-readiness-user-prompt-prd.md` |
| 34 | `subtask-readiness.mts`, `issue-as-prd-parsers.mts`, `subtask-readiness.test.mts` |
| 35 | `subtask-readiness.mts`, `verified-host-mutation.mts`, `verified-host-mutation.test.mts` |
| 36 | `issue-as-prd-parsers.mts`, `subtask-readiness.test.mts` |
| 37 | `subtask-readiness.mts`, `issue-as-prd-queue-state.mts`, `subtask-readiness.test.mts` |
| 38 | `subtask-readiness.mts`, `subtask-readiness.test.mts` |
| 39 | `subtask-readiness.mts`, `verified-host-mutation.mts`, `verified-host-mutation.test.mts` |
| 40 | `issue-as-prd-parsers.mts`, `issue-as-prd-parsers.test.mts` |
| 41 | `per-branch-engine.mts`, `per-branch-policy.mts`, `run-backlog-v3.mts`, `run-prd-v4.mts` |
| 42 | `per-branch-engine.test.mts`, `per-branch-policy.test.mts` |
| 43 | [CONTEXT.md](../CONTEXT.md), [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md), [README.md](../README.md) |

## Resolved design decisions

| Decision | Trace |
| --- | --- |
| 1. Parent claim and crash recovery | `backlog-v3-issue-as-prd-acquire.mts`, `backlog-v3-issue-as-prd-claim.mts`, `backlog-v3-issue-as-prd-resume.mts`, related tests |
| 2. Sub-task tracker identity | `github-issues.mts`, `issue-as-prd-children.mts`, `issue-as-prd-children.test.mts` |
| 3. Sub-task integration mechanism | `issue-as-prd-integration.mts`, `issue-as-prd-integration.test.mts` |
| 4. Initial-decomposition failure | `issue-as-prd-sessions.mts`, `issue-as-prd-sessions.test.mts` |
| 5. Readiness failure | `subtask-readiness.mts`, `verified-host-mutation.mts`, related tests |
| 6. Decomposition fallback threshold | `issue-as-prd-orchestrator.mts`, `issue-as-prd-orchestrator.test.mts` |
| 7. PRD-runner scope | `run-backlog-v3.mts`, `run-prd-v4.mts`, [README.md](../README.md) |
| 8. Parent input | `issue-parent-context.mts`, `issue-parent-context.test.mts`, [CONTEXT.md](../CONTEXT.md) |
| 9a. Partial versus stuck labels | `issue-as-prd-queue-state.mts`, `backlog-v3-issue-as-prd-adapter.mts`, related tests |
| 9b. Per-parent label retention | `issue-as-prd-queue-state.mts`, `backlog-v3-issue-as-prd-adapter.mts`, related tests |
| 9c. Label provisioning | `issue-as-prd-queue-state.mts`, `issue-as-prd-queue-state.test.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| 10. Durable parent phase state | `issue-as-prd-state-contracts.mts`, `issue-as-prd-state.mts`, `issue-as-prd-state.test.mts` |
| 11. Pre-review mainline refresh | `issue-as-prd-refresh.mts`, `issue-as-prd-refresh.test.mts` |
| 12. Pre-review rebase conflict | `issue-as-prd-refresh.mts`, `issue-as-prd-refresh.test.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| 13. Rebase-needed delivery | `backlog-v3-issue-as-prd-adapter.mts`, `issue-as-prd-refresh.mts`, related tests |
| 14. Full-parent review acquisition failure | `issue-as-prd-extra-review.mts`, `issue-as-prd-extra-review.test.mts` |
| 15. Partial-delivery quality gate | `issue-as-prd-orchestrator.mts`, `issue-as-prd-validation.mts`, `issue-as-prd-orchestrator.test.mts` |
| 16. Follow-up readiness | `subtask-readiness.mts`, `issue-as-prd-extra-review.mts`, related tests |
| 17. Aggregate validation repair | `issue-as-prd-validation.mts`, `issue-as-prd-validation.test.mts` |
| 18. Mainline movement after review starts | `issue-as-prd-refresh.mts`, `backlog-v3-issue-as-prd-adapter.mts`, related tests |
| 19. Already-satisfied outcomes | `per-branch-engine.mts`, `issue-as-prd-orchestrator.mts`, `issue-as-prd-validation.mts`, related tests |

## Testing decisions

| Decision | Trace |
| --- | --- |
| Externally observable behavior over runner internals | `per-branch-engine.test.mts`, `issue-as-prd-orchestrator.test.mts`, PRD testing section |
| Initial-decomposition parser and acquisition coverage | `issue-as-prd-parsers.test.mts`, `issue-as-prd-sessions.test.mts` |
| Readiness parser, acquisition, and mutation coverage | `issue-as-prd-parsers.test.mts`, `subtask-readiness.test.mts`, `verified-host-mutation.test.mts` |
| Readiness orchestration parity for initial and follow-up children | `subtask-readiness.test.mts`, `issue-as-prd-orchestrator.test.mts` |
| Already-satisfied routing by source | `per-branch-engine.test.mts`, `issue-as-prd-orchestrator.test.mts`, `issue-as-prd-validation.test.mts` |
| Child publication at pure command-builder / host-decision seam | `issue-as-prd-children.test.mts`, `github-issues.test.mts` |
| Parent and child queue selection and label lifecycle | `issue-as-prd-queue-state.test.mts`, `backlog-v3-issue-as-prd-acquire.test.mts` |
| Partial-delivery decision at queue seam | `issue-as-prd-queue-state.test.mts`, `issue-as-prd-orchestrator.test.mts` |
| Sub-task integration recovery coverage | `issue-as-prd-integration.test.mts` |
| Pre-review refresh and conflict coverage | `issue-as-prd-refresh.test.mts` |
| Terminal-mainline coverage | `issue-as-prd-refresh.test.mts`, `backlog-v3-issue-as-prd-adapter.test.mts` |
| Aggregate-validation coverage | `issue-as-prd-validation.test.mts` |
| Decomposition fallback coverage | `issue-as-prd-orchestrator.test.mts` |
| Shared-engine characterization and policy coverage | `per-branch-engine.test.mts`, `per-branch-policy.test.mts` |
| Parent-context coverage | `issue-parent-context.test.mts` |
| Parent-state coverage | `issue-as-prd-state.test.mts`, `backlog-v3-issue-as-prd-state-comment.test.mts` |
| Host-mutation coverage | `verified-host-mutation.test.mts` |
| One-round extra-review reuse coverage | `issue-as-prd-extra-review.test.mts`, `extra-review-main-loop.test.mts` |
| Full-parent review acquisition coverage | `issue-as-prd-extra-review.test.mts` |
| Prompt contracts via fixtures and strict tagged shapes | `issue-as-prd-prompt.test.mts`, `issue-as-prd-parsers.test.mts` |
| Validation commands remain the primary gate | `per-branch-engine.mts`, `issue-as-prd-validation.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| TUI emission coverage | `tui-emitter.test.mts`, `tui-status.test.mts`, `tui-view.test.mts`, `tui-working-log.test.mts` |

## Out-of-scope constraints

| Constraint | Trace |
| --- | --- |
| Older PRD/backlog runners stay out of scope | [README.md](../README.md), [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md), `run-prd-v4.mts` |
| No parallel sub-task execution | `issue-as-prd-queue-state.mts`, `issue-as-prd-orchestrator.test.mts` |
| No parallel readiness runs | `subtask-readiness.mts`, `subtask-readiness.test.mts` |
| No more than one extra review round per parent | `issue-as-prd-extra-review.mts`, `issue-as-prd-extra-review.test.mts` |
| No auto-merge or auto-close of parent | `run-backlog-v3.mts`, `backlog-v3-issue-as-prd-adapter.test.mts`, [README.md](../README.md) |
| No local markdown or side store for child tracking | `github-issues.mts`, `issue-as-prd-children.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |
| Readiness does not mark children stuck or block on humans | `subtask-readiness.test.mts`, [CONTEXT.md](../CONTEXT.md) |
| No human approval gate for generated child issues | `issue-as-prd-children.mts`, `issue-as-prd-children.test.mts` |
| No cross-parent child sharing | `issue-as-prd-queue-state.mts`, [issue-as-prd-loop-setup.md](issue-as-prd-loop-setup.md) |

## Forbidden-behavior inspection record

The current docs and tests were inspected for the Task 18 forbidden behaviors:

- parent auto-close or auto-merge: not part of the documented Issue-as-PRD contract
- second full-parent review: prohibited in the runbook and covered by `issue-as-prd-extra-review.test.mts`
- parallel drain/readiness: excluded by queue/readiness docs and orchestration tests
- local child store: child tracking remains GitHub child issues plus `parent-N`
- readiness child-stuck: explicitly forbidden in glossary/runbook and covered by `subtask-readiness.test.mts`
- older runners changed silently: README and plan keep scope limited to `run-backlog-v3.mts` and `run-prd-v4.mts`
