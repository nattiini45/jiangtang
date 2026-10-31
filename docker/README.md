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
- `migrate` — runs `pnpm db:deploy` (`prisma migrate deploy`) once the database is healthy, then
  the read-only `ops/postgres/verify-invariants.sql`. A failed check fails the job and the app never
  starts. Never `migrate dev` or `db push` here.
- `backup` — the same WAL-G image; mounts the data directory read-only; daily base backup and
  retention.
- `restore` — profile-gated (`--profile restore`), data directory writable, runs
  `ops/postgres/restore.sh`: the rehearsed, destructive restore path (see DEPLOY.md).
- `alerting` — sidecar that polls `/healthz` and posts to `ALERT_WEBHOOK`; it idles when the webhook
  is empty.
- `app` — `NODE_ENV=production pnpm start` → `tsx server.ts`. Starts only after `migrate` has
  completed successfully. Serves on `:3000` (internal). The uploads volume is at `/data/uploads`.
- `caddy` — terminates 80/443 and reverse-proxies to `app:3000` with `flush_interval -1`
  (event-stream and streaming passthrough). There is no compression: gzip would break
  `text/event-stream`.

## Required environment (Compose reads a local `.env`; a platform injects secrets)

- `BETTER_AUTH_SECRET` (required) — `openssl rand -base64 32`.
- `POSTGRES_PASSWORD` (required) — the database password.
- `APP_DOMAIN` — for example `jiangtang.example.org` for automatic TLS; defaults to `:80` (HTTP).
- `BETTER_AUTH_URL` — the public base URL (for example `https://$APP_DOMAIN`).
- `POSTGRES_USER` / `POSTGRES_DB` — both default to `jiangtang`.
- `GLITCHTIP_DSN` (optional) — a Sentry-compatible error-reporting DSN for an externally hosted
  service.

See `.env.production.example` for the complete list.

## Run

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
