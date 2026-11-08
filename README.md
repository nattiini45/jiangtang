# Jiangtang (讲堂)

Jiangtang means “lecture hall”. It is a self-hosted workspace for an AV or facilities team: rooms
and equipment, stock, event bookings, tickets, projects, tasks, notes and search in one place, with
an append-only audit history.

The interface is available in English and German (`DEFAULT_LOCALE` picks the installation
language, see [Language](#language)). Timestamps are stored in UTC and displayed in the
`Europe/Berlin` time zone.

## Features

See [docs/FEATURES.md](docs/FEATURES.md) for the marketing-style feature page.

- **Tasks** — list and detail views, a kanban board with pointer and keyboard moves, CSV import,
  labels, per-assignee estimates, a dependency graph that refuses cycles, and ticket ⇄ task links.
- **Projects** — overview, board, Gantt and burndown views over the same task data.
- **Notes** — Markdown editor with autosave, pin/archive/tags, `.md` export and folder import.
- **Locations, stock and equipment** — a location tree, stock items with serial/SKU uniqueness,
  CSV importers, warranties, and equipment linked to stock items.
- **Tickets and events** — room and equipment tickets, event bookings with a database-level
  no-double-booking constraint, and a token-gated iCal feed.
- **Search and Ask** — `/search` combines lexical (trigram) retrieval with optional vector search
  and reranking; `Ask` streams a cited answer when a generation provider is configured.
- **Activity** — an append-only, cursor-paginated feed with per-entity history.
- **Timesheet and capacity** — a weekly grid with a running timer and interval-union totals, plus
  demand-versus-capacity per assignee.
- **Mobile** — a `/m` capture view for tickets, tasks and notes with an offline queue that replays exactly
  once, a read-only mobile board and mobile search.
- **Accounts** — invitation-only. The public HTTP sign-up endpoint is disabled; admins create
  one-time invitation links at `/admin/users`.
- **Import/export** — CSV, Markdown and a versioned `jiangtang-workspace` JSON transfer format for
  projects, tasks and notes, applied all-or-nothing.
- **Uploads** — JPEG, PNG and WebP up to 15 MB, magic-byte checked, re-encoded with EXIF/GPS
  removed, stored encrypted, with a 400 px thumbnail.

## Limitations

- **Two languages.** The interface and server-generated text exist in English and German only.
  Another language needs a new catalog under `app/i18n/catalog/` (see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); user-entered data is never translated.
- **Europe/Berlin display.** The database stores UTC, but dates and times are rendered in the
  `Europe/Berlin` zone. There is no per-user time-zone setting.
- **Fresh installations only.** There is no supported upgrade path from a pre-release database,
  uploads directory or browser queue; such an installation has to start from an empty database.
- **Optional external AI.** Search and `Ask` work without any model provider, but then search stays
  lexical and `Ask` answers with cited results instead of generated prose. Vector search, reranking
  and generated answers need an OpenAI-compatible endpoint that the operator configures and pays
  for; no model is bundled or downloaded.
- **Production target: Linux amd64.** The Compose stack builds a local PostgreSQL image that
  carries an amd64 WAL-G binary. ARM hosts are not supported.
- **One workspace per deployment in this release.** Multi-tenancy is designed but not
  implemented yet — see [docs/MULTI-TENANCY-DESIGN.md](docs/MULTI-TENANCY-DESIGN.md) for the
  scoping strategy and rollout. Rooms (bookable spaces) and locations (any place where things are or
  happen) are separate concepts by design; see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#rooms-and-locations).
- **Self-hosted by default.** Nothing is published for you — no telemetry service, no container
  image. The app ships a public landing page at `/welcome`, and
  [docs/HOSTED-DEMO-SPEC.md](docs/HOSTED-DEMO-SPEC.md) is the runbook an operator follows to run
  a hosted read-only demo; this project does not operate one.

## Prerequisites

- **Node 22.12+ or 24+** (`package.json` declares `^22.12 || >=24`, which both Prisma 7 and Sentry 11 accept; the production image and CI both pin Node 22).
- **pnpm 10.26.2** (`packageManager`; `corepack enable` selects it).
- **Docker with the Compose plugin** for the development database and the production stack.
- **PostgreSQL 18 with the `pgvector` and `pg_trgm` extensions** — provided for you by
  `docker-compose.dev.yml` and by the bundled production image. A stock PostgreSQL 18 without
  `pgvector` cannot run the migrations.
- **Git**, and `openssl` (Git Bash on Windows is enough) for the key-generation commands.

## Quick start (development)

Run these from the repository root, in this order:

```bash
git clone https://github.com/nattiini45/jiangtang.git
cd jiangtang
cp .env.example .env                    # only if .env does not exist yet
openssl rand -base64 48                 # paste the output into BETTER_AUTH_SECRET in .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 18 + pgvector on 127.0.0.1:5432
pnpm install --frozen-lockfile
pnpm db:generate                        # Prisma client into app/generated/
pnpm db:deploy                          # apply the migration chain
pnpm dev                                # http://localhost:3000
```

`pnpm dev` reads `.env` at startup. A variable that is already set in your shell takes precedence
over the file.

If `.env` already exists, edit it — do not copy over it. Values you have to look at:

| Variable                                                                                | What to do                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                                                    | Replace the placeholder with the output of `openssl rand -base64 48`.                                                                                                             |
| `DATABASE_URL`                                                                          | Already matches `docker-compose.dev.yml` (`jiangtang:jiangtang` on `localhost:5432`). Change it only if you run your own database.                                                |
| `ICAL_FEED_TOKEN`                                                                       | The example ships a guessable placeholder. Replace it with `openssl rand -hex 32`, or set it empty to disable the iCal feed.                                                      |
| `DEFAULT_LOCALE`                                                                        | `en` (default) or `de`: the installation language. See [Language](#language).                                                                                                     |
| `TZ`                                                                                    | Sets only the process and container clock. Display is always `Europe/Berlin` and is not configurable; the database session runs in UTC.                                           |
| `STORAGE_ENCRYPTION_KEY`                                                                | Development: left empty, the app uses an insecure built-in key and logs a warning. Set `openssl rand -hex 32` if the local uploads matter to you. Production requires a real key. |
| `CALDAV_*`, `EMBEDDING_*`, `RERANK_*`, `GENERATION_*`, `ALERT_WEBHOOK`, `GLITCHTIP_DSN` | Optional integrations. Left empty, each one is simply off.                                                                                                                        |

The development database publishes `127.0.0.1:5432` only. Its password is the example value
`jiangtang`; that is a development convenience, never a production setting.

## Language

The interface is available in English and German. A visitor's choice (the language switcher, stored
in a `locale` cookie) wins, then the browser's `Accept-Language`, then `DEFAULT_LOCALE`
(`en` or `de`, default `en`). `DEFAULT_LOCALE` is the installation's language and also controls
everything that has no request to take a language from:

- the fallback UI language for visitors without a cookie or matching browser preference,
- the demo data set loaded by `pnpm db:seed` and the admin "Load demo workspace" action (English or
  German names, same structure),
- the meta lines written into the search index (for example `Status: In progress`),
- the system prompt and the "no answer" sentence of Ask,
- the name of the iCal feed.

User-entered data is never translated. Set it in `.env` (development) or the production
environment (`.env.production.example`).

## Development-only behaviour

- **Development admin.** With `NODE_ENV=development` (`pnpm dev`) the first boot creates
  `admin@jiangtang.local` with the password `jiangtang-admin` and the `ADMIN` role, then logs
  `[seed] development admin created`. Override the identity with `DEV_ADMIN_EMAIL` and
  `DEV_ADMIN_PASSWORD`. These defaults are unsafe for any public exposure: they are not a fallback
  in production, but they do exist in development.
- **Production starts empty.** The production stack ships no accounts and no data. Set
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` (and optionally `ADMIN_INITIALS`) for the first start. The boot
  creates that admin and logs it, and it acts only while no active admin exists: on a fresh
  installation, or to recover when every admin has been locked out. Later boots do not re-apply the
  role or the active flag. Blank values mean no bootstrap at all. You can remove the two variables
  once the first admin exists.
- **Demo data is explicit.** An empty workspace shows the admin-only button
  "Load demo workspace" ("Demo-Workspace laden" in German); it loads the synthetic demo through the audited mutation path and is
  idempotent. `pnpm db:seed` runs the same seed from the CLI. Nothing is seeded automatically in
  production.
- **Sign-in.** There is no anonymous sign-up. The first admin invites people from `/admin/users`;
  an invitation link creates one account and can be used once.

## Tests

`pnpm test` runs Vitest (unit, database-integration and guard tests). The suite pins
`DEFAULT_LOCALE=de` so that its assertions do not depend on your environment; English behaviour has
its own specs.

- The environment must supply `DATABASE_URL` (or `DATABASE_URL_TEST`). The test setup
  deliberately does **not** read `.env`, and it fails closed with a clear message when neither
  variable is present.
- From that URL it derives a sibling database ending in `_test`. A `DATABASE_URL_TEST` you supply
  yourself must already end in `_test` and must not point at the same database as `DATABASE_URL`.
  The setup creates the target database, applies `prisma migrate deploy` and seeds the demo into
  it, so your development database is not touched — and the connecting role must be allowed to
  create that database.
- `pnpm test:watch` is the interactive form.

`pnpm test:e2e` runs Playwright against a real server and needs prerequisites that the unit suite
does not:

- `DATABASE_URL_E2E`, pointing at a separate database whose name ends in `_e2e` (the run refuses
  anything else). Migrate and seed that database first, for example
  `DATABASE_URL=<e2e-url> pnpm db:deploy && DATABASE_URL=<e2e-url> DEFAULT_LOCALE=de pnpm db:seed`
  (the specs assert the German demo data); an existing
  `DATABASE_URL` in the process environment takes precedence over `.env`.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the bootstrap admin; the run logs in as that account and
  never prints the credentials.
- A free port on a loopback origin: `E2E_BASE_URL` defaults to `http://localhost:3100` and only
  `http` on `localhost`/`127.0.0.1` is accepted. The suite starts its own server and refuses to
  reuse a running one.
- Chromium: `pnpm exec playwright install chromium`.

`pnpm eval:live` is optional and is **not** part of the default checks or CI. It runs the retrieval
evaluation against the providers configured in the environment (`EMBEDDING_BASE_URL` is required)
and therefore sends data to that endpoint; a hosted or paid provider bills you for it.

Additional checks: `pnpm typecheck`, `pnpm lint` and `bash scripts/guards.sh`.

## Deployment and operations

- [docs/DEPLOY.md](docs/DEPLOY.md) — installing a fresh production stack, required variables,
  migrations, readiness and upload checks.
- [docs/BACKUP.md](docs/BACKUP.md) — the recovery runbook: WAL-G database PITR, coherent
  database-plus-uploads recovery and their limits.
- [docs/GDPR.md](docs/GDPR.md) — what data is stored, erasure and retention behaviour, operator
  responsibilities.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the application is built: domain model, route
  trees, migrations and invariants, auth, storage, calendar, search, realtime and i18n.
- [docs/conventions.md](docs/conventions.md) — the code conventions this repository follows.
- [AGENTS.md](AGENTS.md) — the guide for AI coding agents (also useful as a short contributor
  cheat sheet).
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to run the checks and propose changes.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately.
- [LICENSE](LICENSE) — Apache License 2.0.
- [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — attribution and
  third-party licence notices.

## License

Apache-2.0. See [LICENSE](LICENSE). The package is not published to npm; `package.json` stays
`private: true`.
