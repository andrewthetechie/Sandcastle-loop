import type { SandcastleLoopConfig } from './sandcastle-loop-config.mts';

export default {
  models: {
    coder: 'spark/Qwen3627B',
    rework: 'spark/Qwen3627B',
    reviewer: 'zai-coding-plan/glm-5.1',
    codeQuality: 'zai-coding-plan/glm-5.2',
    twoAxis: 'zai-coding-plan/glm-5.2',
    issueDecomposer: 'zai-coding-plan/glm-5.2',
  },

  setupCommands: [
    // Frontend (React) deps from the npm workspace lockfile.
    'npm ci',
    // Backend (Python) deps — uv installs Python 3.13 and the dev group
    // (ruff, pytest, alembic, ...) from uv.lock.
    'uv sync --frozen',
    // Local PostgreSQL for the backend test suite (see pg-ensure.sh).
    'bash .sandcastle/pg-ensure.sh',
  ],
  validationCommands: [
    // Frontend: types, lint, unit tests.
    'npm run typecheck',
    'npm run lint',
    'npm test',
    // Backend: lint, then tests against postgres from pg-ensure.sh (Docker
    // container on the host, native cluster in the sandbox). CI=1 makes
    // conftest.py use DATABASE_URL instead of testcontainers; the env vars
    // mirror .github/workflows/test.yml. Port 55432 avoids colliding with any
    // other postgres on 5432 — keep it in sync with PGPORT in pg-ensure.sh.
    //
    // Migrations run as their own step, before pytest, for the same reason
    // .github/workflows/test.yml does: pytest starts 4 xdist workers that all
    // share this one database, and if migrations are left to run lazily
    // inside conftest.py's per-worker schema check, multiple workers can race
    // `alembic upgrade head` against each other (DuplicateObjectError on
    // whichever DDL statement two workers hit at the same moment — see
    // https://github.com/andrewthetechie/lawncare-saas/issues/761#issuecomment-4862791518).
    // Running it once here, synchronously, before pytest exists means every
    // worker's conftest.py check sees `alembic_version` already populated and
    // skips the migration subprocess entirely.
    'uv run ruff check src',
    'bash .sandcastle/pg-ensure.sh && DATABASE_URL=postgresql+asyncpg://test:test@localhost:55432/test CRON_SECRET=test-secret uv run alembic upgrade head && CI=1 DATABASE_URL=postgresql+asyncpg://test:test@localhost:55432/test JWT_ISSUER=lawncare JWT_AUDIENCE=https://lawncare.example.com JWKS_URL=https://lawncare.example.com/.well-known/jwks.json CRON_SECRET=test-secret uv run pytest tests/',
  ],

  cache: {
    mounts: [
      { name: 'npm-cache', sandboxPath: '~/.npm' },
      { name: 'uv-cache', sandboxPath: '~/.cache/uv' },
    ],
    env: {
      npm_config_cache: '~/.npm',
      UV_CACHE_DIR: '~/.cache/uv',
    },
  },
} satisfies SandcastleLoopConfig;
