# Jiangtang — agent guide

Self-hosted workspace for an AV or facilities team: rooms and equipment, stock, events with
bookings, tickets, projects, tasks, notes and search, with an append-only audit history. The
interface is available in English and German. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
before changing the data model, the migrations or a server seam, and
[docs/conventions.md](docs/conventions.md) for the code rules in detail.

## Stack (do not drift onto betas)

TypeScript on Node 22 (ESM), React Router v7 (Vite, framework mode) behind a small Express server,
React 19, Tailwind v4, shadcn/ui, PostgreSQL 18 with `btree_gist`, `pgvector` and `pg_trgm`, Prisma 7
(Rust-free, `@prisma/adapter-pg`), Better Auth, `sharp`. One application, two route trees: the
desktop surface (pathless `_desktop` layout, renders at `/`) and the mobile PWA (`/m`).

## Commands

Run from the repository root. Use pnpm 10.26.2 (`corepack enable`).

- `pnpm dev` — dev server (reads `.env`; a variable already set in the shell wins). `pnpm build` /
  `pnpm start` — production build / serve.
- `pnpm typecheck` — `react-router typegen` plus `tsc`. `pnpm lint` — ESLint.
- `pnpm format` — `prettier --check .`. `pnpm format:fix` rewrites; run it only on files you changed.
- `pnpm test` — Vitest against an isolated `<dbname>_test` database derived from `DATABASE_URL` (or
  `DATABASE_URL_TEST`). The setup creates it, runs `db:deploy` and the demo seed, and never touches
  the development database. It pins `DEFAULT_LOCALE=de`.
- `pnpm test:e2e` — Playwright against its own `_e2e` database and loopback port (see
  [CONTRIBUTING.md](CONTRIBUTING.md)).
- `bash scripts/guards.sh` (and `--self-test` when editing the guard) — architectural guards.
- `pnpm db:generate` — Prisma client into `app/generated/` (run once after a fresh install, before
  `pnpm typecheck`). `pnpm db:deploy` — apply migrations.
  `pnpm db:seed` — demo data in the installation language. `pnpm db:studio` — Prisma Studio.
- `pnpm eval:live` — optional retrieval evaluation against real AI endpoints; not part of the checks.

Before handing work over: `pnpm typecheck`, `pnpm lint`, `pnpm format` on changed files, the
guards, the relevant Vitest files, and `pnpm test` for anything touching the database.

## Golden rules

- **The no-double-booking invariant lives in the database.** GiST `EXCLUDE` constraints over a
  generated `during` range column on `EventRoomBooking` and `EquipmentAllocation`, plus tests that
  assert they exist and reject overlaps. Never weaken either. Wrap inserts in `insertOrConflict`.
- **The audit log is append-only**, written in the same transaction as each mutation with
  `txWithAudit` (`app/lib/audit.server.ts`). Never `UPDATE` or `DELETE` it. Raw `db.$transaction` in
  `app/domains/` is banned.
- **Strip EXIF/GPS from every uploaded image** and store only the object key in PostgreSQL.
- **Store instants as `timestamptz`** (`@db.Timestamptz(3)` on every `DateTime`), display them on
  `Europe/Berlin`, and embed a `VTIMEZONE` in every `.ics`. Database sessions run in UTC.
- **Emit `NOTIFY` after commit** with `emitChange`. Clients refetch; live updates are not the
  source of truth.
- **Optional integrations stay optional.** CalDAV, embeddings, reranking, generation and error
  reporting are off unless configured; nothing may require an external service to start.
- Prefer mainstream, documented tools. Keep the change small and about one concern.

## Conventions

- Import app code through `~/*`. Import the Prisma client and model types from
  `~/generated/prisma/client`, never `@prisma/client`. The shared client is `db` from
  `~/lib/db.server`.
- Server-only modules end in `.server.ts`. Background jobs and middleware are boot modules
  (`*.boot.server.ts` exporting `register(app, ctx)`, contract in `app/server/boot.ts`); do not edit
  `server.ts` for them. Unref timers and clear them in `ctx.onShutdown`.
- Routing is filesystem based (`flatRoutes()` in `app/routes.ts`): add route folders, do not edit
  that file. Desktop: `app/routes/_desktop.<feature>/route.tsx`. Mobile:
  `app/routes/m.<feature>/route.tsx`. Both layouts require sign-in by default.
- Domain code lives in `app/domains/<area>/` (`*.queries.server.ts`, `*.mutations.server.ts`,
  `*.schema.ts`, `__tests__`). Routes call domain functions, not Prisma.
- Validate with `parseForm` / `safeParseForm` and map errors with `toErrorResponse`
  (`app/lib/validation.server.ts`, `app/lib/errors.server.ts`).
- Comments explain a non-obvious reason, never what the code does. Do not reference tickets,
  slices, people or planning documents in code or comments.
- Tests use synthetic data only. Database tests exercise the real constraint or transaction.

### i18n keys

- Every user-visible string goes through `useT()` (components) or `t(locale, key)` / `tr(key)`
  (server code). Do not hard-code UI text.
- Keys are dot paths grouped by area, for example `rooms.list.empty`. Add each key to **both**
  `app/i18n/catalog/de/<area>.ts` and `app/i18n/catalog/en/<area>.ts`; register a new area file in
  `app/i18n/index.ts`.
- English copy is natural product English, not a literal translation. Leave existing German wording
  alone unless the task is about it.
- Use `{placeholder}` parameters instead of concatenating fragments; use `tRich` for React-node
  placeholders. The parity test (`app/i18n/__tests__/messages.test.ts`) fails on differing key sets
  or placeholders.
- User-entered data is never translated. `DEFAULT_LOCALE` (`en` or `de`) sets the installation
  language for anything without a request: demo data, search-index lines, the Ask prompt, the iCal
  name. Visitors override it with the `locale` cookie or `Accept-Language`.

## Migrations

Prisma cannot model `EXCLUDE` constraints, triggers, functions, generated columns or views, so
hand-written SQL lives inside the migration files in `prisma/migrations/`, next to the generated
statements.

1. Edit `prisma/schema.prisma`, then `pnpm db:generate`.
2. Draft: `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`.
3. Put the draft in a new `prisma/migrations/<UTC timestamp>_<name>/migration.sql`.
4. Hand-edit it: remove proposed `DROP COLUMN "during"` and drops of other objects Prisma cannot
   see; add any `CHECK`, `EXCLUDE`, trigger or view the change needs.
5. Apply with `pnpm db:deploy`, then restart the dev server (`tsx watch` does not reload
   `app/generated/`).
6. Add a catalog check to `ops/postgres/verify-invariants.sql` for any new unmodelled invariant.

Never use `prisma db push` (it reconciles hand-written objects away) and never apply a draft with
`migrate dev`. Never edit, rename, squash or reorder an applied migration. `prisma.config.ts` uses a
separate shadow database; it must never equal `DATABASE_URL`.

## Guards

`scripts/guards.sh` runs in CI and fails on: direct `@prisma/client` imports under `app/`, raw
`db.$transaction` in `app/domains/`, `session_replication_role` outside the audit migration, and any
migration that drops the `during` column. Do not add local exemptions; fix the code or review the
rule. Commits are small, one logical change each, with messages like `area: what changed`. Never
commit `.env` or real credentials.
