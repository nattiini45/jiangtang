# Architecture

Jiangtang (讲堂, "lecture hall") is a self-hosted workspace for an AV or facilities team. One
installation serves one team. This document describes how the code is organised and which
guarantees the database and the application keep. For installation see [DEPLOY.md](DEPLOY.md), for
recovery [BACKUP.md](BACKUP.md), for personal data [GDPR.md](GDPR.md) and for day-to-day code rules
[conventions.md](conventions.md).

## Purpose and shape

- One TypeScript application: **React Router v7** in framework mode on **Vite**, served by a small
  **Express** server (`server.ts`). There is no separate API service and no separate SPA.
- **PostgreSQL 18** with the `btree_gist`, `vector` (pgvector) and `pg_trgm` extensions, accessed
  through **Prisma 7** (Rust-free, `@prisma/adapter-pg`). The Prisma client is generated into
  `app/generated/prisma/` and imported from `~/generated/prisma/client`, never from
  `@prisma/client`.
- UI: React 19, Tailwind v4 and shadcn/ui primitives in `app/components/ui/`.
- Language: English and German (see [Internationalisation](#internationalisation)).
- Production: Docker Compose with Caddy (TLS), the app, a one-shot migrate job and PostgreSQL with
  WAL-G archiving. See [Operations](#operations).

## Domain model

The schema lives in `prisma/schema.prisma`. The main families:

| Family                 | Models                                                                         | Notes                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Places for AV work     | `Campus` → `Building` → `Room`                                                 | A `Room` carries capabilities (projector, microphones, recording), a status and external links.               |
| Location spine         | `Location` (self-referencing tree, `LocationKind`: site, building, room, storage, rack, vehicle, …) | Generic places for stock, tasks and notes. A subtree must be reparented before a parent is deleted. |
| Equipment              | `EquipmentModel` (catalog), `Equipment` (instances)                            | Fixed or pooled mobility, spare/substitute links, per-type attributes (network, microphone, lamp).            |
| Stock                  | `InventoryItem`, `Vendor`                                                      | Optional SKU and serial, unique in the database; quantity, warranty, supplier. May link to an `Equipment`.    |
| Tickets                | `Ticket`                                                                       | Incident, request or repair. A repair may be created already resolved ("born resolved").                     |
| Events                 | `Event`, `EventRoomBooking`, `EquipmentAllocation`, `ServiceWindow`            | Multi-room events, pooled equipment allocations, setup/standby/teardown windows.                              |
| Work                   | `Project`, `Task`, `TaskAssignees`, `TaskDependency`, `TimeEntry`              | Projects nest. Tasks have lanes, fractional ordering, dependencies (a DAG), per-assignee estimates, timers.   |
| Notes                  | `Note`                                                                         | Markdown text, tags, pinning, archiving; attachable to a project or a location.                               |
| People                 | `User`, `Session`, `Account`, `Verification`                                   | Better Auth tables plus the domain fields `role` (`ADMIN` or `MEMBER`), `initials`, `isActive`.               |
| Files                  | `Attachment`                                                                   | Metadata and an object key only; the bytes live in the storage provider.                                      |
| History                | `ActivityLog`                                                                  | Append-only audit trail, one row per meaningful mutation.                                                     |
| Calendar output        | `CalendarOutbox`                                                               | Transactional outbox for CalDAV publishing.                                                                   |
| Search                 | `Chunk`, `SearchIndexJob`                                                      | Derived index rows, rebuilt from the domain rows; never a source of truth.                                    |

Tickets and tasks are linked in both directions (`Ticket.taskId`, `Task.ticketId`) with
`ON DELETE SET NULL`, so deleting one never deletes the other. The `workitem` view in the database
lists tasks and tickets through one shared lane vocabulary (see the migrations below).

Foreign keys carry explicit referential actions. The rule is: rows that are never hard-deleted
(rooms, events, equipment with allocations, notes' authors) use `RESTRICT`; rows that merely point
at a user or a container use `SET NULL` so that deleting a user or retiring a project does not
delete work.

## Code layout

```
app/
  routes/        filesystem routes (flatRoutes), one folder per route
  domains/       business logic per area: queries, mutations, schemas, tests
  components/    React components; components/ui/ holds the primitives
  lib/           shared server and client helpers (auth, audit, storage, search, calendar, realtime, ai)
  i18n/          message catalogs, locale resolution, formatting
  server/        boot-module contract
  generated/     generated Prisma client (not committed)
prisma/          schema.prisma, migrations/, seed.ts
scripts/         guards.sh, demo seed data, live retrieval eval
ops/             backup, restore, alerting and the invariant check for PostgreSQL
docker/          notes for the production stack; compose files are in the repository root
test/            cross-cutting Vitest suites (database, migrations, ops, search)
e2e/             Playwright specs
docs/            this documentation
```

Domain code in `app/domains/<area>/` follows one naming scheme: `*.queries.server.ts` (reads),
`*.mutations.server.ts` (writes), `*.schema.ts` (zod schemas) and a `__tests__` folder. Routes
call domain functions; they do not talk to Prisma directly.

### Route trees

Routing is file based through `flatRoutes()` in `app/routes.ts`, which is never edited. Parentheses
are optional segments in `flatRoutes`, so the two surfaces are:

- **Desktop**: the pathless `_desktop` layout renders at `/`. Examples: `app/routes/_desktop._index`
  (dashboard), `_desktop.tasks.*`, `_desktop.board`, `_desktop.projects.*`, `_desktop.notes.*`,
  `_desktop.rooms.*`, `_desktop.locations.*`, `_desktop.inventory.*` (equipment, models, stock),
  `_desktop.events.*`, `_desktop.tickets.*`, `_desktop.search`, `_desktop.activity`,
  `_desktop.timesheet`, `_desktop.capacity`, `_desktop.analytics._index`, `_desktop.import` and
  `_desktop.admin.*` (users, invitations, erasure).
- **Mobile PWA**: the `m` prefix (`/m`), for example `app/routes/m._index`, `m.tasks.*`,
  `m.notes.new`, `m.board`, `m.rooms.*`, `m.tickets.*`, `m.search` and `m.offline`. It has its own
  shell, a web manifest and a service worker (`app/lib/pwa/`), and an offline queue that replays
  captured tasks and notes exactly once.
- **Public or machine routes**: `login`, `logout`, `accept-invite.$token`, `healthz`,
  `calendar.$token.ics` (token-gated iCal feed), `export.workspace[.]json`, `notes.$id.export`,
  `attachments.upload`, `attachments.$key`, `api.search`, `api.ask`, `api.events.check-conflict`
  and `prefs.locale`.

Both layouts redirect anonymous visitors to `/login`, but they are not the guard: every loader and
action calls `requireUser` or `requireRole` itself (see [Authentication and roles](#authentication-and-roles)).
A new public route goes on the `PUBLIC` list in `test/routes/route-auth-guard.test.ts`, with its
reason.

### Server entry and boot modules

`server.ts` builds the Express app, mounts Vite (development) or the static build (production),
then runs every boot module before the React Router catch-all. A boot module is any file named
`app/**/*.boot.server.ts` that exports `register(app, ctx)` and, optionally, `order` (lower runs
first; middleware uses negative values). The contract is in `app/server/boot.ts`. Boot modules
register routes (SSE, auth), middleware (locale, logging) and background jobs (calendar drain,
search indexer, retention, warranty sweep). Timers must be `unref()`'d and cleared through
`ctx.onShutdown`. Add a boot module rather than editing `server.ts`.

## Data layer and migrations

`app/lib/db.server.ts` creates the single `db` client and the `Tx` type. Its pool sets
`TimeZone=UTC` for every session; the adapter serialises dates as offset-less UTC strings, which is
only correct under a UTC session. All `DateTime` columns are `@db.Timestamptz(3)`.

The migration chain in `prisma/migrations/` is a fresh-install baseline of seven files. Prisma
cannot model range types, exclusion constraints, triggers, functions, generated columns or views, so
the hand-written SQL sits inside these migrations, next to the Prisma-generated statements:

| Migration                                      | Contents                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `20261023000000_extensions`                    | `btree_gist`, `vector`, `pg_trgm`.                                                                                                        |
| `20261023000100_core_schema`                   | Enums, tables, foreign keys and the indexes Prisma models.                                                                                |
| `20261023000200_booking_constraints`           | Generated `during tstzrange` columns and the two GiST `EXCLUDE` constraints (rooms, pooled equipment); the room renewal-order `CHECK`.    |
| `20261023000300_audit_privacy`                 | The append-only guard trigger on `ActivityLog`, and the privileged `pseudonymize_actor` and `prune_activity_log` functions.              |
| `20261023000400_search_indexes`                | The generated weighted `tsvector` column on `Chunk`, the cosine HNSW index and the trigram and lexeme GIN indexes.                       |
| `20261023000500_workitem_view`                 | The `workitem_lane` mapping table (reference data) and the `UNION ALL` view over tasks and tickets.                                      |
| `20261023000600_time_tracking_constraints`     | `CHECK (endsAt IS NULL OR endsAt > startsAt)` and a partial unique index allowing one running timer per user.                            |

Later migrations follow the baseline in timestamp order (`20261105000000_note_version` adds the
`Note.version` concurrency token). `test/migration-baseline.test.ts` checks the seven baseline files
and requires every later directory to sort after them with a `<UTC timestamp>_<name>` name.

Rules for the chain:

- Migrations are append-only. Never edit, rename, squash or reorder one that has been applied.
- `pnpm db:deploy` (`prisma migrate deploy`) is the only way a migration is applied outside local
  authoring. Never use `prisma db push`: it would reconcile the hand-written objects away.
- `prisma.config.ts` derives a shadow database name (`jiangtang_shadow`) so that `migrate dev` and
  `migrate diff --from-migrations` never reset the development database.

### Adding a migration

1. Edit `prisma/schema.prisma` and run `pnpm db:generate`.
2. Draft the SQL:
   `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`.
3. Create `prisma/migrations/<UTC timestamp>_<name>/migration.sql` and paste the draft.
4. Hand-edit it. The draft will propose `DROP COLUMN "during"` and drop the generated `tsv` column
   and other objects Prisma cannot see; remove those statements. Add any `CHECK`, `EXCLUDE`,
   trigger, function, view or generated column your change needs, in the same file.
5. Apply with `pnpm db:deploy` and restart the dev server (`tsx watch` does not reload
   `app/generated/`).
6. Extend `ops/postgres/verify-invariants.sql` if the migration adds an invariant the schema cannot
   express, and add a test that exercises the constraint.

`scripts/guards.sh` fails a migration whose executable SQL drops `during`, and
`test/migration-baseline.test.ts` pins the shape of the chain.

## Invariants

These hold regardless of which UI path writes the data. Each is enforced in the database or by a
test, and weakening one needs a deliberate review.

- **No double booking.** `EventRoomBooking` and `EquipmentAllocation` each have a generated
  `during` range column (`[start, end)`, half-open) and a GiST `EXCLUDE` constraint over
  `(resource, during)` where `cancelled = false`. A conflict raises SQLSTATE `23P01`;
  `insertOrConflict` in `app/lib/booking.server.ts` turns it into `BookingConflictError` (HTTP 409).
  UI pre-checks (`api.events.check-conflict`) are only an accelerator.
- **Append-only audit.** `ActivityLog` is written in the same transaction as each mutation through
  `txWithAudit` in `app/lib/audit.server.ts`. A trigger (`ENABLE ALWAYS`) rejects `UPDATE` and
  `DELETE` unless a transaction-local setting, `jiangtang.audit_bypass`, is on. Only the two
  `SECURITY DEFINER` functions set it. Raw `db.$transaction` in `app/domains/` is banned by
  `scripts/guards.sh`.
- **EXIF and GPS stripped.** Uploaded images are decoded and re-encoded with `sharp`; only the
  object key is stored in the database.
- **Berlin time, UTC storage.** Instants are `timestamptz`; display and `datetime-local` conversion
  use `Europe/Berlin` (`app/lib/time.server.ts`, `app/i18n/format.ts`). Every `.ics` object embeds
  a `VTIMEZONE`.
- **Change notifications after commit.** `emitChange` issues a PostgreSQL `NOTIFY` once the
  transaction has resolved. Clients treat events as a hint to refetch.
- **One running timer per user, positive intervals.** Enforced by the time tracking migration.
- **Unique stock identifiers.** `InventoryItem.sku` and `serial` are unique in the database; both
  are nullable, so items with neither coexist.

`ops/postgres/verify-invariants.sql` checks these catalog objects after every deploy; the migrate
job fails, and the app never starts, if one is missing.

## Authentication and roles

Better Auth (`app/lib/auth.server.ts`) provides email and password sign-in with cookie sessions.
Access is invitation-only: the public `/sign-up/email` path is disabled, and admins create one-time
invitation links in `/admin/users` (`accept-invite.$token`). The two roles are `ADMIN` (also
manages accounts) and `MEMBER`; `app/lib/rbac.server.ts` holds the permission matrix (`can`, `roleRequiredFor`); `requireUser` and
`requireRole` in `app/lib/auth.server.ts` guard loaders and actions. Every protected route's loader
and action calls one of them itself rather than relying on its layout, because a single-fetch `.data`
request with `?_routes=` runs only the named loaders. `test/routes/route-auth-guard.test.ts` calls
every handler anonymously and fails unless it redirects to `/login` without touching the database
client first; the public routes (sign-in, sign-out, invitation acceptance, the token-gated iCal
feed, the health check, the language switch and the 404 catch-all) are on its explicit list.
Failed sign-ins are throttled per email (10) and per client address (30; an IPv6 client counts per
/64) within 15 minutes by `app/lib/login-throttle.server.ts`; it runs as a Better Auth hook, so the
login form and `/api/auth/sign-in/email` share it. The client address is the right-most
`X-Forwarded-For` entry, which assumes exactly one proxy (Caddy) in front of the app. While an
email is over its limit even the right password is refused, so anyone who knows an address can keep
that account locked by repeating failed attempts. The state is in memory for the single app
process: restarting the app container clears every lock.
`sanitizeNext` restricts
post-login redirects to local paths. The first admin of a production installation comes from
`ADMIN_EMAIL` and `ADMIN_PASSWORD` (`app/lib/auth-bootstrap.server.ts`), and the bootstrap acts only
while no active admin exists, so a fresh installation and a full lockout can both be recovered from
the environment (recovering an existing account needs `ADMIN_PASSWORD` to match its current
password); in development a seeded admin is created. Erasing a user pseudonymizes the account instead of deleting history; see
[GDPR.md](GDPR.md) and `app/domains/auth/gdpr.server.ts`.

## Storage

Uploads go through the `StorageProvider` seam (`app/lib/storage/storage.server.ts`). The shipped
provider (`app/lib/storage/fs-provider.ts`) writes to a local directory (`STORAGE_DIR`), accepts
JPEG, PNG and WebP up to 15 MB after a magic-byte check, strips metadata by re-encoding, creates a
thumbnail and encrypts the object with AES-256-GCM (`STORAGE_ENCRYPTION_KEY`). Objects are served
through `attachments.$key`, which checks the session. A different backend (for example S3) plugs in
behind the same interface.

## Calendar output

Event mutations enqueue a `CalendarOutbox` row in the same transaction (one row per event UID and
iCal `SEQUENCE`, unique in the database), so calendar downtime never blocks a write. A drain worker
(`app/lib/calendar/calendar.boot.server.ts`, `app/lib/calendar/outbox.server.ts`) publishes pending rows in
sequence order through a `CalendarPublisher`, with exponential backoff and a retry cap. The real
publisher is a zero-dependency CalDAV client (`app/lib/calendar/caldav.server.ts`) configured with
`CALDAV_URL`, `CALDAV_USERNAME` and `CALDAV_PASSWORD`; without them a no-op publisher is used and
the worker stays idle. The token-gated iCal feed (`calendar.$token.ics`, `ICAL_FEED_TOKEN`) renders
live events with the same builder (`app/lib/calendar/ical.server.ts`). Publishing is output-only.

## Search and AI (optional)

- **Index.** `Chunk` rows are derived from tasks, tickets, notes, projects, stock, equipment,
  events, locations, rooms and vendors (`app/lib/search/sources.server.ts`). The indexer
  (`app/lib/search/indexer.server.ts`, started by `app/lib/search/index.boot.server.ts`) reconciles on boot and
  every minute, and also reacts to realtime events with a short debounce. It writes without audit
  rows. `SEARCH_INDEXER=off` disables it.
- **Retrieval.** `app/lib/search/query.server.ts` runs lexical arms (`simple` and `german` text
  search, trigram similarity for typos) and, when an embedding provider is configured, a dense
  pgvector arm. Results are fused with reciprocal rank fusion and optionally reranked.
- **Ask.** `app/lib/search/ask.server.ts` and `api.ask` stream an answer with citations when a
  generation provider is configured; otherwise they return the cited results.
- **Providers.** `app/lib/ai/` resolves each capability (embedding, rerank, generation) from
  environment variables (`EMBEDDING_*`, `RERANK_*`, `GENERATION_*`) and speaks OpenAI-compatible
  HTTP. Each is off when unset. The dense column is `vector(1024)` for the life of the database.
  Nothing is bundled or downloaded, and nothing calls an external service unless the operator
  configures one.

## Realtime

`emitChange` (`app/lib/realtime/emit.server.ts`) sends a `NOTIFY` on the `jiangtang_changes`
channel with `{ entityType, id, op, ts }`. One shared `pg` client (`app/lib/realtime/listener.server.ts`, not part
of the Prisma pool) listens and fans events out to per-session Server-Sent Events streams mounted at
`/api/realtime` (`app/lib/realtime/realtime.boot.server.ts`, session-gated). A short ring buffer supports
`Last-Event-ID` resume. Browsers use `app/lib/realtime/use-live-refetch.ts` to refetch affected data; live updates
are an accelerator, and a reconnect refetches everything. An open stream is re-checked on each
heartbeat and ends once its account is deactivated or erased, so revocation does not wait for a
reconnect.

## Internationalisation

- **Catalogs.** Typed in-house catalogs, no runtime dependency: `app/i18n/catalog/en/<area>.ts` and
  `app/i18n/catalog/de/<area>.ts`, merged in `app/i18n/index.ts`. Keys are dot paths such as
  `rooms.list.empty`. The German catalog defines `MessageKey`; a parity test keeps both languages
  identical in keys and `{placeholders}`.
- **Use.** Components call `useT()` (`app/i18n/use-t.ts`); server code calls `t(locale, key)` or
  `tr(key)`. `tr` reads the locale of the current request from an `AsyncLocalStorage` scope opened
  by `app/i18n/locale.boot.server.ts`, so domain and validation errors come out in the visitor's
  language. Schemas mark keys with `msgKey` and translate at the edge with `localizeMessage`.
- **Resolution.** The `locale` cookie (set by the switcher through `prefs.locale`), then the
  `Accept-Language` header, then `DEFAULT_LOCALE`, then English (`app/i18n/locale.server.ts`).
- **`DEFAULT_LOCALE`** (`en` or `de`, default `en`) is the installation language. It also decides
  everything that has no request: the demo data set (`scripts/seed/localized.ts`), the meta lines
  in the search index, the Ask system prompt and the iCal feed name.
- **Formatting.** `app/i18n/format.ts` formats dates and numbers for the locale and always on the
  Europe/Berlin wall clock.
- User-entered data is never translated. Imports accept enum labels in any supported language
  (`app/i18n/aliases.ts`).

## Operations

- **Compose stack.** `docker-compose.yml` defines `postgres` (a local image with pgvector and the
  WAL-G binary, `ops/postgres/Dockerfile.walg`), `migrate` (applies migrations, then runs
  `ops/postgres/verify-invariants.sql`), `app`, `caddy` (`Caddyfile`; no response compression, which would break
  the event stream), a `backup` job, a profile-gated `restore` job and an `alerting` sidecar that
  idles without a webhook. `docker-compose.dev.yml` is the development database only; `docker-compose.rehearsal.yml`
  supports a local plain-HTTP rehearsal. See `docker/README.md` and [DEPLOY.md](DEPLOY.md).
- **Backups.** WAL-G base backups and WAL archiving for point-in-time recovery, plus a coherent
  database-and-uploads recovery path. `ops/postgres/backup.sh`, `ops/postgres/restore.sh`,
  `ops/postgres/restore-drill.sh` and `ops/postgres/select-backup.py` implement them; [BACKUP.md](BACKUP.md) is the runbook and states what is
  not proven.
- **Health and errors.** `healthz` reports readiness; structured logs come from
  `app/lib/observability/`; `GLITCHTIP_DSN` enables Sentry-compatible error reporting; the
  optional alerting job posts to `ALERT_WEBHOOK`.
- **Background jobs** run inside the app process: calendar drain, search reconcile, audit
  retention (`ACTIVITY_RETENTION_DAYS`, default 2555 days) and a daily warranty-expiry count.

## Testing and guards

- `pnpm test` runs Vitest against an isolated `<database>_test` database that the global setup
  creates, migrates and seeds. It pins `DEFAULT_LOCALE=de`; English is covered by dedicated specs.
- `pnpm test:e2e` runs Playwright against a separate `_e2e` database on a loopback port.
- `bash scripts/guards.sh` bans direct `@prisma/client` imports, raw `db.$transaction` in
  `app/domains/`, `session_replication_role` outside the audit migration and any migration that
  drops `during`; `--self-test` proves the guard can fail.
- Doc links are checked by `docs/__tests__/doc-links.test.ts`.
