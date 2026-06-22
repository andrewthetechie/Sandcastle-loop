# Plan: Compose infra bootstrap, host setup hooks, and sandbox network

**Status:** Ready  
**Scope:** Generic loop infrastructure (`sandcastle-loop-config.mts`, `sandcastle-loop-compose.mts`, loop entrypoints)  
**Motivation:** Repos like spaarc run validation on the host and agents in Docker sandboxes. Integration tests need (1) compose services running, (2) host-side worktree provisioning, and (3) sandbox network access to those services — without project-specific logic in the loop.

## Problem

Three environments are involved, and today they are not wired together:

| Concern | Runs where | Current support |
|---------|------------|-----------------|
| Postgres / Redis / etc. | Host via compose | Operator must `make up` manually ✗ |
| `pnpm install`, package builds | Sandbox | `setupCommands` ✓ |
| `provision-worktree.sh`, migrations | Host worktree | ✗ (no `hostSetupCommands`) |
| `pnpm run typecheck` / `test` | Host worktree | `validationCommands` ✓ |
| `DATABASE_URL` for validation | Host env | Only cache-path remapping ✗ |
| Agent running integration tests | Sandbox | Default bridge; `localhost` ≠ host ✗ |

Sandcastle supports host and sandbox hooks at two points: `hooks.host.onWorktreeReady` (sequential, before the container starts) and `hooks.host.onSandboxReady` ∥ `hooks.sandbox.onSandboxReady` (parallel, after the container is up). The loop only wires `setupCommands` → sandbox `onSandboxReady`.

Agents inside sandboxes waste time on failed `docker compose up` (no socket). Host validation fails if compose is down. Even with compose up, sandboxes on the default bridge cannot reach `localhost:5432` on the host.

## Goals

1. **Compose bootstrap** — config-driven `make` target or `docker compose up`, with health wait, at loop-start or per-issue.
2. **Host worktree setup** — config-driven commands on the host worktree after `copyToWorktree`, before the sandbox container starts (`onWorktreeReady`).
3. **Validation env** — config-driven env merged into `HOST_COMMAND_ENV` for the validation gate.
4. **Sandbox Docker options** — config-driven `network` and `env` passed to `docker()`, with optional auto-derive of `${project}_default` from compose config.
5. Backward compatible: missing new fields → current behavior.

## Non-goals

- Starting app servers (`pnpm dev`, API, worker) in the loop.
- `compose down` on loop exit (shared dev stack outlives the loop).
- Docker-in-Docker / socket mounting.
- Running validation inside the sandbox.
- Testcontainers or per-issue ephemeral compose stacks (spaarc uses shared Postgres + per-worktree DB via `provision-worktree.sh`).

## End-to-end flow (target)

```
loop-start:
  compose.ensureUp          → postgres/redis/temporal/minio on spaarc_default

per-issue sandbox create (Sandcastle order):
  copyToWorktree
  hostSetupCommands         → hooks.host.onWorktreeReady (sequential)
                              provision-worktree.sh (per-worktree DB + .env.worktree)
  [sandbox container starts on spaarc_default network]
  setupCommands (sandbox)   → hooks.sandbox.onSandboxReady (parallel with host onSandboxReady — unused)
                              pnpm install + package builds
  sandbox.network           → spaarc_default (explicit or compose.attachSandbox)
  sandbox.env               → compose-internal URLs (postgres:5432, redis:6379)

validation (host):
  validationEnv             → localhost URLs and/or dotenv -e .env.worktree
  validationCommands        → typecheck, unit test, integration test

extra-review sandbox create (read-only PRD branch review):
  setupCommands (sandbox)   → pnpm install only (same as normal)
  hostSetupCommands         → skipped (no per-worktree DB / .env.worktree)
  sandbox.network + env     → same as normal when configured
```

Compose bootstrap does **not** replace `provision-worktree.sh`; it ensures the shared stack exists so provisioning can create DBs and run migrations.

## Config schema

Extend `SandcastleLoopConfig` in `sandcastle-loop-config.mts`:

```typescript
export interface SandcastleLoopComposeConfig {
  /** docker compose -f path relative to repo root (default: docker-compose.yml) */
  file?: string;
  /** docker compose -p value (default: basename of repo root) */
  project?: string;
  /** --env-file path relative to repo root (optional) */
  envFile?: string;
  /** Subset of services to start; omit for all services in file */
  services?: string[];
  /** Alternative to raw compose: run `make <target>` from repo root */
  makeTarget?: string;
  /** When to ensure infra is up (default: never when compose block omitted) */
  ensureUp?: 'loop-start' | 'per-issue' | 'never';
  /** Wait up to N seconds for healthchecks after up (default: 60) */
  waitSeconds?: number;
  /**
   * When true, set sandbox.network to `${project}_default` unless
   * sandbox.network is explicitly set.
   */
  attachSandbox?: boolean;
}

export interface SandcastleLoopSandboxConfig {
  /** Passed to sandcastle docker({ network }) — e.g. "spaarc_default" */
  network?: string | readonly string[];
  /** Extra env injected into sandbox (merged with cache.sandboxEnv) */
  env?: Record<string, string>;
}

export interface SandcastleLoopConfig {
  // existing: models, setupCommands, validationCommands, cache
  compose?: SandcastleLoopComposeConfig;
  /**
   * Commands run on the HOST in the worktree after copyToWorktree, before the
   * sandbox container starts. Wired to hooks.host.onWorktreeReady (sequential).
   */
  hostSetupCommands?: string[];
  /** Env vars for host-side validation gate (spawnSync in worktree) */
  validationEnv?: Record<string, string>;
  sandbox?: SandcastleLoopSandboxConfig;
}
```

Resolved config adds:

```typescript
compose: ResolvedSandcastleLoopComposeConfig | null; // null when omitted
hostSetupCommands: string[];
validationEnv: Record<string, string>;
sandbox: { network?: string | readonly string[]; env: Record<string, string> };
```

`validateConfig()` rules:

- `hostSetupCommands`: string array (same as `setupCommands`).
- `validationEnv`, `sandbox.env`: string maps (same as `cache.env`).
- `sandbox.network`: string or string array.
- `compose`: object; validate nested fields when present.

## Implementation

### Module: `sandcastle-loop-compose.mts` (new)

| Export | Responsibility |
|--------|----------------|
| `resolveComposeConfig(repoRoot, compose?)` | Defaults: `file=docker-compose.yml`, `project=basename(repoRoot)`, `waitSeconds=60`, `ensureUp=never` |
| `buildComposeCliArgs(repoRoot, resolved)` | Shared `-f`, `-p`, optional `--env-file` flags for all compose subprocesses |
| `ensureComposeUp(repoRoot, resolved)` | Idempotent bring-up via `make -s <target>` or `docker compose … up -d [services]` |
| `waitForComposeHealthy(repoRoot, resolved)` | Poll `docker compose … ps --format json` until targeted services are `healthy` or `running` (no healthcheck), or timeout |
| `deriveSandboxNetwork(resolvedCompose, explicitNetwork?)` | Returns `${project}_default` when `attachSandbox` and no explicit `sandbox.network` |

Use host `process.env` for subprocesses. Do not require docker inside sandboxes.

**Bring-up vs health wait:** When `makeTarget` is set, `ensureComposeUp` runs `make -s <target>` from repo root; it does **not** skip health polling. `waitForComposeHealthy` always uses `buildComposeCliArgs` (`-f`, `-p`, optional `--env-file`) so `docker compose ps` observes the same project the config names. The Makefile target must leave that project running under `compose.project`; if `makeTarget` starts a different project name, health wait will time out — document that operators must keep them aligned.

### Module: `sandcastle-loop-runtime.mts` (new, recommended)

Extract shared wiring used by all `run-prd*` entrypoints:

```typescript
export function buildHostCommandEnv(config: ResolvedSandcastleLoopConfig): NodeJS.ProcessEnv;
export function sandboxLifecycleHooks(
  config: ResolvedSandcastleLoopConfig,
  options?: { includeHostWorktreeSetup?: boolean },
): SandboxHooks;
export function dockerSandboxProvider(
  config: ResolvedSandcastleLoopConfig,
  opencodeMounts: MountConfig[],
): SandboxProvider;
export async function bootstrapComposeIfNeeded(
  repoRoot: string,
  config: ResolvedSandcastleLoopConfig,
  when: 'loop-start' | 'per-issue',
): Promise<void>;
```

### Loop wiring

**1. Compose bootstrap**

| Hook | Action |
|------|--------|
| After `loadSandcastleLoopConfig`, before main loop | `bootstrapComposeIfNeeded(..., 'loop-start')` when `compose.ensureUp === 'loop-start'` |
| Start of `processNormalIssueIteration` | `bootstrapComposeIfNeeded(..., 'per-issue')` when `compose.ensureUp === 'per-issue'` |

Log:

```
Compose bootstrap: make stack-ready (project=spaarc)
Compose healthy after 4s: postgres, redis, temporal, minio
```

Failure: non-zero `make`/`compose up` or health timeout → abort loop with `docker compose … ps` snippet (same CLI args as health wait).

**2. `hostSetupCommands` → `hooks.host.onWorktreeReady`**

Sandcastle runs `onWorktreeReady` sequentially after `copyToWorktree` and **before** the container starts. That ordering matters for spaarc: `provision-worktree.sh` must finish (`.env.worktree`, per-worktree DB) before sandbox `setupCommands` run, and it does not need the container.

Do **not** map `hostSetupCommands` to `onSandboxReady` — that hook runs in parallel with sandbox setup and would race `pnpm install`.

```typescript
function sandboxLifecycleHooks(
  config,
  { includeHostWorktreeSetup = true } = {},
) {
  return {
    ...(includeHostWorktreeSetup && config.hostSetupCommands.length > 0
      ? {
          host: {
            onWorktreeReady: config.hostSetupCommands.map((command) => ({
              command,
            })),
          },
        }
      : {}),
    sandbox: {
      onSandboxReady: config.setupCommands.map((command) => ({ command })),
    },
  };
}
```

**Call sites**

| Loop phase | `includeHostWorktreeSetup` | Rationale |
|------------|----------------------------|-----------|
| Normal issue iteration (`processNormalIssueIteration`) | `true` (default) | Coder + validation need per-worktree DB / `.env.worktree`. |
| Extra-review sessions (`runExtraReviewRound` → `runSequentialExtraReviewSessions`) | `false` | Read-only review on completed PRD branch; no coder, no validation gate, no provisioning. |

```typescript
// normal issue
hooks: sandboxLifecycleHooks(LOOP_CONFIG),

// extra review
hooks: sandboxLifecycleHooks(LOOP_CONFIG, { includeHostWorktreeSetup: false }),
```

Failure: any `onWorktreeReady` command exits non-zero → Sandcastle rejects `createSandbox`. The loop must not invoke the coder.

**Issue iteration on setup failure:** Match v2's existing `try/catch` around the issue body — log the error, record outcome `crashed` via `recordIssueOutcome`, continue to the next issue. Do **not** auto-apply `agent-stuck` (provisioning/compose failures are infra/config, not coder failure). The same issue remains eligible on the next loop run once infra is repaired.

**3. `validationEnv` → `HOST_COMMAND_ENV`**

Single env object for all host-side validation (`buildHostCommandEnv`). Used by both:

| Gate | Working directory | Notes |
|------|-------------------|-------|
| Base (`ensureBaseBranchIsGreen`) | Host repo root (`process.cwd()` on `prd-<NNN>`) | Must not depend on per-worktree files. |
| Issue (`runValidationGate` in worktree) | Issue sandbox worktree path | May use worktree artifacts via `validationCommands` (e.g. `dotenv -e .env.worktree`). |

```typescript
const HOST_COMMAND_ENV = buildHostCommandEnv(LOOP_CONFIG);
// { ...process.env, ...config.cache.hostEnv, ...config.validationEnv }
```

Put only **shared** host URLs/vars in `validationEnv`. Per-worktree values belong in commands that read worktree-local files after `hostSetupCommands` — not in static `validationEnv`.

**4. `sandbox` + compose network → `dockerSandboxProvider()`**

```typescript
const network =
  config.sandbox.network ??
  deriveSandboxNetwork(config.compose, undefined);

return docker({
  mounts: [...OPENCODE_MOUNTS, ...config.cache.mounts],
  env: { ...config.cache.sandboxEnv, ...config.sandbox.env },
  ...(network ? { network } : {}),
});
```

**5. Startup logging**

```
compose=spaarc/stack-ready/loop-start hostSetupCommands=1 validationEnv=REDIS_URL sandboxNetwork=spaarc_default
```

## spaarc config (after implementation)

Prerequisites on host (done on 10.10.0.32): `apps/api/.env` from example, compose stack can be brought up by loop.

```typescript
import type { SandcastleLoopConfig } from './sandcastle-loop-config.mts';

export default {
  models: { /* existing */ },

  compose: {
    file: 'docker-compose.yml',
    project: 'spaarc',
    envFile: 'compose.env',
    makeTarget: 'stack-ready',
    ensureUp: 'loop-start',
    attachSandbox: true,
  },

  hostSetupCommands: ['bash .claude/scripts/provision-worktree.sh --strict'],

  setupCommands: [
    'pnpm install --frozen-lockfile',
    'pnpm --filter @medspa/db --filter @medspa/temporal --filter @medspa/platform-billing build',
  ],

  // Static localhost URLs for typecheck/unit tests. Per-worktree DB URLs come
  // from .env.worktree (written by hostSetupCommands) via dotenv below.
  validationEnv: {
    REDIS_URL: 'redis://localhost:6380',
  },

  validationCommands: [
    'pnpm run typecheck',
    'pnpm run test',
    'dotenv -e .env.worktree -- pnpm --filter @medspa/api test:integration',
  ],

  sandbox: {
    env: {
      DATABASE_URL: 'postgresql://medspa:medspa_dev_password@postgres:5432/medspa',
      REDIS_URL: 'redis://redis:6379',
    },
    // network omitted — derived as spaarc_default via compose.attachSandbox
  },

  cache: { /* existing */ },
} satisfies SandcastleLoopConfig;
```

## Files to touch

| File | Change |
|------|--------|
| `sandcastle-loop-config.mts` | Full schema, validation, resolution |
| `sandcastle-loop-config.test.mts` | Config loading tests (add if missing) |
| `sandcastle-loop-compose.mts` | New: ensure up, health wait, network derive |
| `sandcastle-loop-compose.test.mts` | New: mocked spawnSync / health polling |
| `sandcastle-loop-runtime.mts` | New: shared hooks, env, docker provider, bootstrap |
| `run-prd-extra-review-custom-agents-shared-cache-v2.mts` | Use runtime module; bootstrap at loop-start; `includeHostWorktreeSetup: false` for extra-review |
| Other `run-prd*` entrypoints | Follow-up PR: import runtime module (not first PR) |
| `docs/extra-review-loop-setup.md` | Operator docs |
| `~/spaarc/.sandcastle/config.mts` (remote) | Add compose, hostSetup, validationEnv, sandbox.env |

## Test plan

### Unit tests

**`sandcastle-loop-config`**

- Loads all new fields from fixture config; defaults when omitted.
- Rejects invalid shapes.

**`sandcastle-loop-runtime`** (or config integration)

- `sandboxLifecycleHooks`: `hostSetupCommands` → `host.onWorktreeReady` when `includeHostWorktreeSetup: true`; omits host hooks when `false`.
- `buildHostCommandEnv` merges `validationEnv` after `cache.hostEnv`.

**`sandcastle-loop-compose`**

- Default resolution (`project` from repo basename).
- `makeTarget` vs `docker compose` command construction.
- `makeTarget` bring-up still runs `waitForComposeHealthy` via `buildComposeCliArgs`.
- `deriveSandboxNetwork` with `attachSandbox` true/false and explicit override.
- Health polling: healthy, running-without-healthcheck, timeout.

### Manual (10.10.0.32 / spaarc)

1. `docker compose -p spaarc down` → start loop → stack comes up, first issue proceeds.
2. Stack already up → bootstrap is fast (idempotent).
3. Worktree gets `.env.worktree` during `onWorktreeReady`, before the sandbox container starts (`provision-worktree.sh`).
4. Sandbox on `spaarc_default` reaches `postgres:5432` (node TCP probe).
5. Validation gate passes with integration tests when configured.
6. Legacy config (no new fields) behaves identically to today.

## Rollout

1. Implement schema + compose module + runtime module + tests.
2. Wire **v2 entrypoint only** (`run-prd-extra-review-custom-agents-shared-cache-v2.mts`) — first PR.
3. Update spaarc `config.mts` on 10.10.0.32.
4. **Follow-up PR:** port runtime module to the other six `run-prd*` entrypoints.
5. Update `docs/extra-review-loop-setup.md`.

## Risks

| Risk | Mitigation |
|------|------------|
| Host worktree setup fails mid-loop | Sandcastle rejects `createSandbox`; iteration records `crashed`, continues (no `agent-stuck`) |
| `make stack-ready` tears old `medspa` project | Document; offer `makeTarget: 'up'` for gentler bring-up |
| `makeTarget` project ≠ `compose.project` | Health wait times out; document that Makefile must start the configured project |
| Wrong network name | Document: `docker compose -p <project>` → `<project>_default`; `attachSandbox` auto-derives |
| Per-worktree `DATABASE_URL` not in static `validationEnv` | Base gate runs on host PRD branch, not worktree — use `dotenv -e .env.worktree` in issue `validationCommands` only |
| Concurrent loops on same host | Document single-loop-per-host or distinct `project` names |
| Healthcheck differences across compose files | Configurable `waitSeconds`; accept `running` when no healthcheck |
| Six duplicated entrypoints | Extract `sandcastle-loop-runtime.mts` in first PR; port callers in follow-up PR |

## Decisions

| Decision | Resolution |
|----------|------------|
| Which Sandcastle host hook for `hostSetupCommands`? | **`hooks.host.onWorktreeReady`** — sequential, before container; avoids race with sandbox `setupCommands`. |
| Extra-review sandboxes run `hostSetupCommands`? | **No** — `sandboxLifecycleHooks(config, { includeHostWorktreeSetup: false })` for extra-review; default `true` for normal issues. |
| `makeTarget` + health wait | **Always poll** via `docker compose … ps` using shared `-f`/`-p`/`--env-file`; `makeTarget` only affects bring-up, not health observation. |
| `createSandbox` setup failure (incl. `onWorktreeReady`) | **Continue loop** — record `crashed`, do not mark `agent-stuck`; issue stays eligible for retry after infra fix. |
| `validationEnv` scope | **Same env for base + issue gates**; base runs on host PRD checkout — no worktree-only files; per-worktree vars via `validationCommands` + `dotenv`. |
| First PR scope | **v2 entrypoint only**; other six `run-prd*` files in immediate follow-up PR. |
| Load `validationEnv` from `compose.env`? | **No** — spaarc uses static localhost URLs for unit/typecheck + `dotenv -e .env.worktree` for integration. |
| Expand `~` in `validationEnv`? | **No** unless a repo needs it; use literal paths or `cache.env` mount remapping. |
| `ensureUp: 'never'` in CI when job provides services | Document in `extra-review-loop-setup.md`: omit `compose` block or set `ensureUp: 'never'`. |

## Open questions

(none)

## Effort estimate

~1.5–2 focused sessions: schema + compose module + runtime module + tests + v2 wiring + spaarc config + docs.
