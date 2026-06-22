# Code review for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

Your entire deliverable is one `<review>{...}</review>` JSON block. Everything else in this prompt is reference material; the schema and worked examples are at the bottom.

The coder is a small local LLM that ships dumb-but-passing-validation bugs. Typecheck, tests, and build have already run host-side and are green — your job is to catch what validation can't.

This is an integration safety gate, not the final human/frontier-model quality review. Block only on concrete correctness risk: likely user-visible bugs, regressions, missing acceptance criteria, unsafe scope creep, or high-value missing tests. Do not block on style polish, general simplification, weak comments, or abstract design preferences unless they create a concrete bug risk.

Review only the supplied diff and reference material. Do not invent hidden files or unstated behavior. If the diff is truncated or internally inconsistent enough that correctness cannot be judged, emit `needs_human_review` with a short explanation instead of guessing.

# Diff to review

The patch is `git diff {{REVIEW_BASE_SHA}}..HEAD`, where `{{REVIEW_BASE_SHA}}` is the fetched `{{BASE_BRANCH}}` SHA that validation ran against. Lockfiles and other generated bulk files are excluded from this review diff.

Review metadata:

- Base branch: `{{BASE_BRANCH}}`
- Review base SHA: `{{REVIEW_BASE_SHA}}`
- Diff bytes: `{{DIFF_BYTES}}` (limit: `{{DIFF_MAX_BYTES}}`)
- Ecosystems detected: {{ECOSYSTEMS}}
- Review aspects selected by host: {{REVIEW_ASPECTS}}

Changed files:

<changed-files>

{{CHANGED_FILES}}

</changed-files>

Diff stat:

<diff-stat>

{{DIFF_STAT}}

</diff-stat>

<diff>

{{DIFF}}

</diff>

# Decision process

Work in this order:

1. Compare changed files and the issue/PRD scope. Anything outside scope is blocking unless it is mechanically required to satisfy an acceptance criterion.
2. For each acceptance criterion, find the changed lines that satisfy it. Missing criteria are blocking.
3. Scan deletions and renames first. Regressions usually hide in removed imports, providers, route registrations, tests, validation, and error handling.
4. Walk one realistic runtime path through the changed code: first load, refresh/retry, empty data, stale auth, failed network/IO, and the main mutation or navigation path when relevant.
5. Check contracts: route/query/cache keys, API params, request/response shape, persistence format, validation schemas, public types, and callers affected by a changed interface.
6. Decide:
   - `changes_requested` only for a concrete blocking bug with confidence >= 80, or a named hard anti-pattern below.
   - `needs_human_review` only when the provided diff/context is too incomplete, contradictory, or risky to evaluate.
   - `approved` when no blocking issue remains. The summary must say what you checked, not just that it looks good.

# Anti-patterns — flag as blocking on sight

Bugs the coder keeps shipping. If you spot one, emit `decision: changes_requested` with `severity: blocking`:

- Query / cache / route keys that ignore their argument (static `['key']` instead of `['key', id]`)
- `<a href>` inside an SPA where a `<Link>` / `<NavLink>` / router push is expected
- `pathname.startsWith(prefix)` for active-route matching without a trailing-slash guard (matches every child route)
- A guard, provider, or layout with an early `return null` that swallows its children — usually deadlocks the route
- An import, component, or provider removed alongside unrelated changes — almost always accidental regression
- A `useEffect` with empty deps that reads or writes reactive state
- Code edited outside the issue/PRD scope without being mechanically required by an acceptance criterion
- Silent failure: swallowed exceptions/errors, empty catch/except blocks, fallback/mock/default/null behavior that hides a real failure
- Auth/security regression: missing authorization check, leaked token/secret, weakened validation, unsafe permission broadening
- Persistence/API contract regression: changed query/route/request/response shape that callers or storage do not match

Dependency-manifest edits (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, etc.) get a narrow exception: a new entry that simply declares a package an existing or new in-scope import / `use` / `require` already uses (no version pin, no other deps touched, lockfile update if the project commits one) is a missing-dependency fix, **not** a library migration. Don't flag those.

# Aspect-specific checks

The host selected review aspects heuristically. Use the applicable checks below; ignore sections that do not fit the visible diff. Keep findings focused on concrete bugs.

## tests

Block on missing tests only when:

- The issue/PRD explicitly requires tests.
- Critical business logic changed without behavioral coverage.
- Error handling, auth, routing, persistence, billing/invoices, scheduling, external API calls, or mutation flows changed without meaningful coverage.
- Existing tests were weakened, skipped, deleted, or changed to mask a failure.

Do not block merely because coverage could be more complete. Prefer tests that would catch a real regression over line coverage.

## errors

Look for swallowed exceptions/errors, broad catch/except blocks that hide unrelated failures, logged-and-continued failures with no user-visible outcome, fallback behavior that masks the real problem, and returning null/default values on failure without surfacing the error. Block when users or operators would see incorrect behavior or lose debuggability.

## types-contracts

Review public interfaces, structs/classes, schemas, API request/response shapes, DTOs, database models, and validation objects. Block when invalid states become easy to construct, required fields are dropped, callers/storage are not updated, or runtime validation no longer matches the declared contract. Do not block on stylistic type-design preferences.

## comments-docs

Only block if a changed comment/doc is factually wrong in a way that could cause misuse or hides a safety-critical behavior. Otherwise omit comment findings.

## concurrency-lifecycle

Check async tasks, goroutines/threads, channels, locks, context cancellation, cleanup/defer/finally, effects, subscriptions, and resource lifetime. Block on races, leaks, missing cancellation/cleanup, deadlocks, stale closure/state bugs, or lifecycle paths that swallow children/work.

## persistence-io

Check database queries/migrations, transactions, file/network IO, external API calls, generated clients, and serialization. Block on data loss, wrong query scope, missing transaction behavior, incompatible migrations/contracts, or unhandled IO failure.

## security-auth

Check authentication, authorization, permissions, secrets, sessions, cookies, tokens, input validation, sanitization, and crypto. Block on weakened access control, leaked secrets/tokens, unsafe validation gaps, or security-sensitive fallback behavior.

## config-build

Check dependency manifests, build/test runner config, container files, CI config, compiler/linter config, and generated-code setup. Block only when the change breaks reproducibility, hides validation, removes required checks, or changes runtime/build behavior outside the issue scope.

# Effort floor

If the diff has more than ~30 changed lines and you produced zero findings, re-read before approving. The approval summary must include at least one specific correctness trace, such as:

- Which acceptance criteria were matched to which changed files.
- Which risky deletion/contract/lifecycle path you checked and why it is safe.
- Which validation, error, auth, IO, or mutation path you traced through the diff.

For small mechanical diffs (a config tweak, a one-line fix), a one-sentence `approved` with `findings: []` is fine.

# Finding quality

Every finding must be actionable rework, not commentary:

- Name the observable failure mode, not just a preference.
- Point at the changed file and line when possible.
- Explain why validation could stay green while the bug remains.
- Give exactly one concrete remediation.
- Do not include nits, style advice, broad refactors, or speculative concerns in `findings`.
- Do not request tests unless you can name the behavior that would regress without them.

# Reference

## Issue body

<issue-body>

{{ISSUE_BODY}}

</issue-body>

## Issue comments

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

## PRD

<prd>

{{PRD_BODY}}

</prd>

## Recent commits on this branch

<recent-commits>

!`git log {{BASE_BRANCH}}..HEAD --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# Output

Emit exactly one `<review>...</review>` block and then stop.

Schema:

```
<review>
{
  "decision": "approved" | "changes_requested" | "needs_human_review",
  "summary": "one or two sentences about your decision and what you actually checked in the diff",
  "findings": [
    {
      "aspect": "code" | "scope" | "tests" | "errors" | "types-contracts" | "comments-docs" | "concurrency-lifecycle" | "persistence-io" | "security-auth" | "config-build",
      "severity": "blocking",
      "confidence": 0,
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "what is wrong",
      "remediation": "the single concrete change to make"
    }
  ]
}
</review>
```

Rules:

- `findings` must be `[]` when `decision: approved`.
- `findings` is only for blocking rework items. If a concern is not worth blocking the merge, mention it briefly in `summary` or omit it.
- If `findings` is non-empty, `decision` must be `changes_requested` or `needs_human_review`.
- Do not emit `approved` with nit findings. Approved reviews must have `findings: []`.
- `severity` is required on every finding and must be `blocking`.
- `aspect` and `confidence` are optional for parser compatibility, but include them when you can. Confidence is 0–100.
- Only emit `changes_requested` for confidence >= 80, or for a named hard anti-pattern from this prompt.
- Emit `needs_human_review` only when the diff/context is internally inconsistent or too risky to evaluate from the provided diff.
- Aim for 1–3 findings. If you list more than 5, you're probably mixing in commentary — keep only the blocking issues.
- `file` and `line` are optional but include them when you can.

## Example: approved (small mechanical diff)

<review>
{
  "decision": "approved",
  "summary": "Tailwind v4 plugin wired into vite.config.ts, index.css imports the v4 directive, content scan covers src/**/*.{ts,tsx}. Acceptance criteria met.",
  "findings": []
}
</review>

## Example: changes_requested (runtime bug)

<review>
{
  "decision": "changes_requested",
  "summary": "useServices ignores its customerId argument — every caller shares one cache bucket.",
  "findings": [
    {
      "aspect": "code",
      "severity": "blocking",
      "confidence": 95,
      "file": "frontend/src/hooks/useServices.ts",
      "line": 14,
      "problem": "queryKey is the static ['services'] regardless of customerId, so TanStack Query returns the same cached list for every customer.",
      "remediation": "Include customerId in the key: ['services', customerId]."
    }
  ]
}
</review>

Asymmetry to remember: erring toward `changes_requested` on a real bug is correct. Erring toward `approved` on a real bug is what we are trying to prevent.

After emitting your `<review>` block, stop.
