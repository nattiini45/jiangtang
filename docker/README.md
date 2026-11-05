# Jiangtang Docker stack

Production deployment: **Caddy v2** (automatic TLS) → **app** (the Express server, started with
`tsx`), **postgres:18** and a one-shot **migrate** job. The same Compose file runs under any Docker
host and under platforms that read Compose files (for example Coolify). The full installation guide
is [docs/DEPLOY.md](../docs/DEPLOY.md); the recovery runbook is [docs/BACKUP.md](../docs/BACKUP.md).

## Services

- `postgres` — PostgreSQL 18 on the locally built `jiangtang-postgres-walg` image
  (`ops/postgres/Dockerfile.walg`: the pgvector PostgreSQL 18 image plus the WAL-G binary, because
  the container's `archive_command` runs `wal-g wal-push` and the upstream image carries no WAL-G).
  The volume is mounted at `/var/lib/postgresql`, the parent directory, because PostgreSQL 18
  manages version subdirectories itself; a `.../data` mount makes the container exit.
- `migrate` — once the database is healthy, runs `./node_modules/.bin/prisma migrate deploy` (the
  Prisma CLI in the image), then `prisma db execute --file /ops/verify-invariants.sql`, the read-only
  invariant check. A failed check fails the job and the app never starts. Never `migrate dev` or
  `db push` here.
- `backup` — the same WAL-G image; mounts the data directory read-only; daily base backup and
  retention.
- `restore` — profile-gated (`--profile restore`), data directory writable, runs
  `ops/postgres/restore.sh`: the rehearsed, destructive restore path (see DEPLOY.md).
- `alerting` — sidecar that polls `/healthz`, reads backup and WAL-archive failures from the
  `backup-status` volume and posts to `ALERT_WEBHOOK`; it idles when the webhook
  is empty.
- `app` — `node --import tsx server.ts`, started directly by Node, not through pnpm or cross-env. It
  sets `NODE_ENV=production`. Starts only after `migrate` has completed successfully. Serves on
  `:3000` (internal). The uploads volume is at `/data/uploads`.
- `caddy` — terminates 80/443, sets baseline security headers (`nosniff`, a referrer policy,
  `X-Frame-Options: DENY` and HSTS), and reverse-proxies to `app:3000` with `flush_interval -1`
  (event-stream and streaming passthrough). There is no compression: gzip would break
  `text/event-stream`.

## Required environment (Compose reads a local `.env`; a platform injects secrets)

- `BETTER_AUTH_SECRET` (required) — `openssl rand -base64 48`. At least 32 characters and not
  starting with `change-me`; the app refuses to boot otherwise (see docs/DEPLOY.md, section 2).
- `POSTGRES_PASSWORD` (required) — the database password, for example `openssl rand -hex 24`.
- `STORAGE_ENCRYPTION_KEY` (required) — `openssl rand -hex 32`. Keep a durable copy: a different key
  cannot read existing uploads.
- `APP_DOMAIN` (required) — the hostname Caddy serves, for example `jiangtang.example.org`, for
  automatic TLS. `:80` serves plain HTTP and is for local or rehearsal runs only.
- `BETTER_AUTH_URL` (required) — the public origin, for example `https://jiangtang.example.org`. It
  must match `APP_DOMAIN`.
- `POSTGRES_USER` / `POSTGRES_DB` — both default to `jiangtang`.
- `GLITCHTIP_DSN` (optional) — a Sentry-compatible error-reporting DSN for an externally hosted
  service.

Compose stops with a message when a required variable is unset. See `.env.production.example` for
the complete list.

### First admin

`ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_INITIALS` create the first administrator. The bootstrap
acts only while no active ADMIN exists (first install, or recovery after a full lockout). Once an
active admin exists, these values are ignored. Without an active admin, the next boot creates the
account named by `ADMIN_EMAIL` when none exists. When that account already exists, the boot
re-elevates it only if `ADMIN_PASSWORD` matches the account's current password; a mismatch logs an
error and changes nothing. A missing password credential on that account is refused the same way.
Remove the values once the first admin exists, because a later recovery
should be a deliberate step. A set `ADMIN_PASSWORD` that starts with `change-me` stops production
boot, even after the first admin exists, so delete the placeholder line rather than keeping it. A set
`ADMIN_PASSWORD` shorter than 8 characters stops production boot the same way. See
[docs/DEPLOY.md](../docs/DEPLOY.md), section 6. Leave them blank to skip the bootstrap.

## Run

Copy `.env.production.example` to `.env`, fill in the required values, then:

```bash
docker compose up -d --build
```

From a clean checkout this builds the image (pnpm install → `db:generate` → `react-router build`),
brings PostgreSQL up, applies migrations, then starts the app behind Caddy.

## Notes

- The image carries the full `node_modules` so that the same image runs both the app and the
  migrate job (the Prisma CLI is a devDependency). Correctness over image size.
- Node is pinned to **22** in all stages, whatever the local version is.
- Backups, point-in-time recovery, the restore drill and structured logging live in `ops/`.
