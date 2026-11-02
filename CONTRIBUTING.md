# Contributing to Jiangtang

Jiangtang is a self-hosted AV and facility workspace. The user interface is available in
English and German and displays times in `Europe/Berlin`; code, comments, tests and public
documentation are English. Installations
are fresh installations by design: do not add upgrade or import paths for data from an older
installation.

## What fits the project

The project is in a stabilisation phase. Useful contributions are bug fixes, tests, documentation,
accessibility and small, well-scoped improvements to existing features.

- The supported calendar integration is CalDAV push plus a token-gated iCal feed. There is no
  Exchange/Outlook synchronisation bridge and one is not planned.
- AI features speak to OpenAI-compatible HTTP endpoints. New provider protocols or hosted-service
  dependencies are out of scope.
- Inventory `category` and `unit` are deliberately free text. Do not turn them into an enum as a
  drive-by change.
- Keep both languages in step: every user-visible string goes through the catalogs in
  `app/i18n/catalog/` with a key in both `de` and `en`, and times keep the Berlin display semantics.
- The project is licensed under Apache-2.0 (see `package.json`). Do not add code, fixtures, images or
  other assets that cannot be redistributed under that licence, and preserve third-party notices.

Security reports do not belong in public issues. Follow `SECURITY.md` and report privately with a
synthetic reproduction.

## Set up a development installation

Prerequisites: Node 22, pnpm 10.26.2, Git, Docker with the Compose plugin, and `openssl` (Git Bash on
Windows is sufficient). The development database is PostgreSQL 18 with `pgvector` and `pg_trgm`;
`docker-compose.dev.yml` provides it on `127.0.0.1:5432`.

Run these from the repository root, in a POSIX shell:

```bash
corepack enable
cp .env.example .env                 # only if .env does not exist; never overwrite an existing file
openssl rand -base64 48              # paste the output into BETTER_AUTH_SECRET in .env
docker compose -f docker-compose.dev.yml up -d
pnpm install --frozen-lockfile
pnpm db:generate                     # Prisma client into app/generated/
pnpm db:deploy                       # apply the migration chain
pnpm dev                             # http://localhost:3000
```

`pnpm dev` reads `.env` at startup; a variable already set in your shell takes precedence.

`.env.example` already matches the development database. Replace `BETTER_AUTH_SECRET` and
`ICAL_FEED_TOKEN`; leave the optional integration variables empty unless you are testing that
integration. Development-only admin defaults (`admin@jiangtang.local`) are created on the first
`pnpm dev`, which sets `NODE_ENV=development`. An unset `NODE_ENV` runs as production, so the
defaults are never created there. They are not safe for any public exposure. [`.env.example`](.env.example) lists every
development variable, and [`.env.production.example`](.env.production.example) lists the production
ones; [docs/DEPLOY.md](docs/DEPLOY.md) describes a production installation.

## Tests and test data

Never use production data, a production `.env`, real uploads or a shared database for tests. All
fixtures must be synthetic. The Vitest harness does not read `.env`; supply its values in the process
environment. The Playwright run starts the application server, which loads `.env` for any name the run
does not set, so `playwright.config.ts` sets the outbound integration names itself.

### Vitest (unit, integration and guard tests)

`pnpm test` provisions a separate database whose name is your `DATABASE_URL` database plus `_test`
(or uses `DATABASE_URL_TEST` if you set it). It creates that database, applies
`prisma migrate deploy`, seeds the demo data and redirects the workers at it (pinning `DEFAULT_LOCALE=de`), so your development
database is not touched. The connecting role must be allowed to create a database.

```bash
export DATABASE_URL="postgresql://jiangtang:jiangtang@localhost:5432/jiangtang?schema=public"
pnpm test
```

The URL above is the checked-in development default from `docker-compose.dev.yml` and `.env.example`.
`DATABASE_URL_TEST`, if you provide it, must already end in `_test` and must not name the same
database as `DATABASE_URL`. Run one file or one area with a positional filter:

```bash
pnpm test app/lib/__tests__/retention.test.ts
pnpm test docs/__tests__/doc-links.test.ts
pnpm test:watch
```

### Playwright (browser tests)

The browser suite needs its own database, its own port and an admin account. It refuses to start
without `DATABASE_URL_E2E`, rejects any database name that does not end in `_e2e`, refuses a
non-loopback origin, starts its own server and does not reuse a running one.

Create an empty database whose name ends in `_e2e` (for example `jiangtang_e2e`), then migrate and
seed it before the run. `DATABASE_URL` in the process environment takes precedence over `.env`:

```bash
export DATABASE_URL_E2E="postgresql://jiangtang:jiangtang@localhost:5432/jiangtang_e2e?schema=public"
DATABASE_URL="$DATABASE_URL_E2E" pnpm db:deploy
DATABASE_URL="$DATABASE_URL_E2E" DEFAULT_LOCALE=de pnpm db:seed   # the specs assert the German demo data
export ADMIN_EMAIL="admin@jiangtang.local"
export ADMIN_PASSWORD="jiangtang-admin"
export E2E_BASE_URL="http://localhost:3100"
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e
```

`ADMIN_EMAIL` and `ADMIN_PASSWORD` above are the development seed account; they are not production
credentials. The default gate excludes the screenshot-only `@screens` suite. It is opt-in:

```bash
pnpm test:e2e --grep @screens
```

Teardown deletes only this run's `e2e-<runId>-` prefixed tasks, notes and projects through the
domain delete functions. Audit rows are append-only and stay, which is another reason to use a
disposable database.

### Other checks

```bash
pnpm db:generate                     # once after a fresh install: typecheck reads app/generated/
pnpm typecheck
pnpm lint
bash scripts/guards.sh
bash scripts/guards.sh --self-test   # when changing the guard script itself
pnpm build
```

CI (`.github/workflows/ci.yml`) runs on `main` and pull requests. It runs the guards and their
self-test, the Python backup-selector tests and the in-image WAL-G checks, builds the production
application image without pushing it, generates the client, migrates its own database, then runs
typecheck, lint, Vitest and the production build. It then runs the Playwright E2E browser
gate: it installs Chromium and runs `pnpm test:e2e` against an isolated E2E database. The live
retrieval evaluation (`pnpm eval:live`) is not part of CI.

`pnpm eval:live` is optional and not part of the default checks. It calls the AI endpoints
configured in your environment, so it sends retrieval data there and a hosted provider may bill you.

## Formatting

`pnpm format` runs `prettier --check .` and is expected to pass. Run `pnpm exec prettier --write <paths>`
on the files you changed before you commit.

`prettier` is configured with a 100-column width. `.prettierignore` excludes Markdown (`*.md`),
the generated Prisma client, build output, `pnpm-lock.yaml`, `prisma/migrations/` and `public/`.
Markdown is therefore not checked or enforced by `pnpm format`.

- Check the files you changed with `pnpm exec prettier --check <paths>`.
- Do not reformat unrelated files in a feature pull request. It buries the actual change and
  creates conflicts for everyone else.
- Match the surrounding style. If you reformat a file you are already changing, keep that reformat
  in its own commit and explain it.

## Pull requests

- Keep the change small and about one concern. A bug fix should not also rename unrelated symbols,
  move files or upgrade dependencies.
- Add or update a test that would fail without the change. Database-backed behaviour needs a test
  against the real constraint or transaction, not only a mock.
- Do not weaken an invariant, a guard or a test to make a run green. The booking `EXCLUDE`
  constraints, the append-only audit log and the migration checks are load-bearing.
- Migrations are append-only. Never edit, squash, rename or reorder an applied migration; add a new
  one. Hand-written SQL lives in the same `migration.sql`, beside the Prisma-generated statements.
- Update the documentation when behaviour, configuration or operator responsibilities change.
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/GDPR.md](docs/GDPR.md),
  [docs/conventions.md](docs/conventions.md), [docs/DEPLOY.md](docs/DEPLOY.md) and
  [docs/BACKUP.md](docs/BACKUP.md) are the public references; [AGENTS.md](AGENTS.md) is the short
  checklist for agents.
- Describe what you changed, why, and how you verified it, including the commands you ran and their
  results. Do not claim a check you did not run.

No particular editor, AI tool or agent hook is required to contribute. Use the tools you prefer and
review what they produce.
