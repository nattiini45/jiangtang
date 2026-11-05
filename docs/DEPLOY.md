# Deploying Jiangtang

This is the operator runbook for a fresh production installation. It assumes a Linux amd64 host
with Docker and the Compose plugin, a DNS name you control, and nobody else's data on the machine.

**Fresh installations only.** There is no supported upgrade path from a pre-release database,
uploads directory, browser queue or export. Do not point this stack at an existing Jiangtang
database, and do not replay the migrations against one.

## Versions and support

| Component  | Pinned version                                                   | Where                                                  |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Node.js    | 22.12+ or 24+ (the image and CI track the latest 22.x)           | `Dockerfile` base image, CI                            |
| pnpm       | 10.26.2                                                          | `package.json` `packageManager`, `Dockerfile` corepack |
| PostgreSQL | 18 with `pgvector` 0.8.7 (`pgvector/pgvector:0.8.7-pg18-trixie`) | `docker-compose.yml`, CI                               |
| WAL-G      | v3.0.9, amd64 build, checksum pinned                             | `ops/postgres/Dockerfile.walg`                         |

Production is supported on **Linux amd64 only**: the WAL-G release binary baked into the database
image is an amd64 build.

## What has and has not been verified

- The Compose stack builds its images locally from this repository. The application image contains
  the generated Prisma client; nobody runs `pnpm db:generate` on the server.
- A **plain-HTTP** local rehearsal is possible with the override described at the end of this
  document. It runs the same `docker-compose.yml` with Caddy on `localhost:8080`.
- A real, internet-facing **HTTPS deployment behind DNS** is outside what the repository's checks
  verify. Issuing a certificate depends on your DNS, your firewall and Let's Encrypt's reachability;
  a local rehearsal proves none of that.
- The backup and recovery procedures are described in [BACKUP.md](BACKUP.md). Their claims are
  limited to what that document states; nothing here makes a deployment recoverable by default.

## 1. DNS and HTTPS

- Create an **A** (and, if you use it, **AAAA**) record for the hostname you will serve, pointing at
  the host.
- Open **80** and **443**. Caddy answers the ACME HTTP challenge on port 80 and redirects to HTTPS
  once it has a certificate.
- Set `APP_DOMAIN` to that hostname, exactly as the certificate should name it. Caddy obtains and
  renews the certificate itself and stores it in the `caddy_data` volume.
- Set `BETTER_AUTH_URL=https://<APP_DOMAIN>`. It is the public origin used for cookies and
  invitation links; if it disagrees with `APP_DOMAIN`, sign-in breaks.
- `APP_DOMAIN=:80` turns TLS off (plain HTTP on port 80). That is for the local rehearsal only,
  never for a reachable host.

## 2. Environment

Copy the template and fill it in. The template has no sample secrets: every value you must supply
is blank.

```bash
cp .env.production.example .env
chmod 600 .env
```

Compose refuses to render the stack without these three:

| Variable                 | Notes                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`     | `openssl rand -base64 48`. Session signing key: at least 32 characters, not starting with `change-me`. |
| `POSTGRES_PASSWORD`      | `openssl rand -hex 24` — hex keeps it safe inside the interpolated database URL.                       |
| `STORAGE_ENCRYPTION_KEY` | `openssl rand -hex 32`. Encrypts every stored upload.                                                  |

Needed for a reachable deployment and a usable first login:

| Variable                        | Notes                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_DOMAIN`                    | The hostname Caddy serves.                                                                                                                 |
| `BETTER_AUTH_URL`               | `https://<APP_DOMAIN>`.                                                                                                                    |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, created at boot while no active admin exists. `ADMIN_INITIALS` is optional. Without them the stack starts but has no account, and nobody can sign in. |

`POSTGRES_USER` and `POSTGRES_DB` default to `jiangtang`; change them only on a fresh install.

Compose checks only that the required values are set. The app checks their strength at boot and
refuses to start in production when a rule is broken:

- `BETTER_AUTH_SECRET` must be at least 32 characters and must not start with `change-me`.
- `ICAL_FEED_TOKEN`, when set, must be at least 32 characters and must not be the `.env.example`
  placeholder (`generate-a-long-random-token-here`).
- `ADMIN_PASSWORD`, when set, must be at least 8 characters and must not start with `change-me`.

The reason is written to the log: run `docker compose logs app`. Migrations have already run by
then, because `app` starts only after `migrate` succeeds, so a rejected value leaves the database
migrated and the app stopped. The container restarts and fails again until the value is fixed.
Correct the value in `.env` and recreate the container with `docker compose up -d app`.

Custody rules that the template cannot enforce for you:

- Keep a durable offline copy of `STORAGE_ENCRYPTION_KEY`. `openssl rand -hex 32` **creates** a key;
  it never recovers one. Without the original key, restored uploads are unreadable, and a different
  key cannot decrypt existing objects.
- `STORAGE_KEY_SALT` is optional and only affects a passphrase-style key. Set it on a fresh install
  or not at all; changing it later makes existing uploads undecryptable.
- Never commit `.env`, and never copy it into a backup archive that you share.

Everything else in the template is optional. Blank means off:

| Group                                     | Blank behaviour                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `WALG_S3_PREFIX`, `AWS_*`                 | No WAL archiving, no base backups; the sidecar logs that it has nothing to back up. |
| `EMBEDDING_*`, `RERANK_*`, `GENERATION_*` | Search stays lexical; `Ask` answers with cited results instead of generated prose.  |
| `CALDAV_*`                                | Calendar push publisher idle.                                                       |
| `ICAL_FEED_TOKEN`                         | The token-gated iCal feed is unavailable.                                           |
| `ALERT_WEBHOOK`                           | The alerting sidecar idles instead of polling.                                      |
| `GLITCHTIP_DSN`                           | No error reporting.                                                                 |
| `RESTORE_DRILL_ENABLED`                   | The monthly restore smoke check does not run.                                       |

The stack ships no AI provider, no hosted service and no telemetry endpoint. Every external
provider above is something you configure, point somewhere and pay for.

## 3. Build and start

```bash
docker compose up -d --build
```

This builds the application image from `Dockerfile` (Compose tags it once for `app` and once for
the `migrate` job; the content is identical) and the PostgreSQL+WAL-G image from
`ops/postgres/Dockerfile.walg` (shared by `postgres`, `backup` and `restore`). Jiangtang publishes
no image of its own: all of these are built here. In this production stack only the `caddy` and
`alerting` services run a prebuilt upstream image. The local rehearsal override adds two more:
`rustfs/rustfs` (the S3 stand-in behind `minio`) and `amazon/aws-cli` (the one-shot `minio-init`
bucket setup) — four prebuilt images in the rehearsal.

The startup order is enforced by Compose: `postgres` becomes healthy, the one-shot `migrate` job
runs to completion, and only then does `app` start. `caddy`, `backup` and `alerting` follow.

If you change the Prisma schema later, rebuild the image (`docker compose build app migrate`);
the generated client is part of the image, not something to regenerate by hand on the server.

## 4. Migrations and the invariant gate

```bash
docker compose logs migrate
```

The job runs `prisma migrate deploy` and then the read-only `ops/postgres/verify-invariants.sql`.
On success that script raises a `NOTICE` that begins with `Jiangtang invariants OK`; the rest of the
line lists the invariants it checked and changes with the schema.

If an invariant is missing the script raises an exception instead, the job exits non-zero, and
`app` never starts — that is the point of the gate. It verifies; it never repairs.

The authoritative success signal is the `migrate` service exiting 0 and `app` starting (see
`docker compose ps`); whether the NOTICE itself is echoed into `docker compose logs migrate`
depends on how the Prisma CLI prints statement output, so do not treat a missing line as a failed
check on its own.

**Migration approval.** In a real deployment, treat every migration as its own approved change:
review the SQL, take a backup you can restore, then run the stack update during a maintenance
window. Never use `prisma migrate dev` or `prisma db push` against a production database.

## 5. Readiness

```bash
docker compose ps                       # app should report healthy
curl -fsS https://<APP_DOMAIN>/healthz  # {"status":"ok","db":"up"}
```

`/healthz` is public and cheap: it runs `SELECT 1` and returns HTTP 200 with
`{"status":"ok","db":"up"}` when the database is reachable, or HTTP 503 with
`{"status":"degraded","db":"down"}` otherwise. In production the failure detail is logged in the
container, not returned to the caller.

The container's own healthcheck polls `/login`; Compose marks `app` healthy only once the server
answers. The alerting sidecar polls `/healthz` every 60 seconds when `ALERT_WEBHOOK` is set, and
posts failed base backups and failing WAL archiving too (see [BACKUP.md](BACKUP.md#failure-alerts)).

## 6. First login

1. Open `https://<APP_DOMAIN>` and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you configured.
   The boot created that account on the first start; the log line records the bootstrap without the
   password.
2. The workspace is empty. There is no anonymous sign-up: the public HTTP sign-up endpoint is
   disabled by design.
3. Invite the rest of the team from `/admin/users`. Each invitation produces a one-time link you
   pass on out-of-band; accepting it creates the account with the role you chose.
4. Once the first admin exists, remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` and recreate
   the app container (`docker compose up -d app`, not `restart`, which would keep the old
   environment). The bootstrap acts only while no active admin exists, so the values have no effect
   while an admin is active. Without an active admin, the next boot creates the account named by
   `ADMIN_EMAIL` when no such account exists. When that account already exists, as after a full
   lockout, the boot re-elevates it only if `ADMIN_PASSWORD` matches the account's current password.
   A mismatch, or an account with no password credential, logs an error and changes nothing.
   Removing the values is still advisable: a later recovery should be a deliberate step, not a
   side effect of an old environment file. A set
   `ADMIN_PASSWORD` that starts with `change-me` stops production boot, even after the first admin
   exists. Delete the line from `.env`, or replace the value, rather than keeping the `.env.example`
   placeholder. A set `ADMIN_PASSWORD` shorter than 8 characters is refused the same way.

### Forgotten passwords

Signed-in users change their own password on `/account`. When someone has forgotten theirs, issue a
one-time reset link; the person opens it, chooses a new password and is signed out of every session.
A link is valid for one day and for one use, a newer link for the same account replaces the older
one, and only a hash of it is stored. Deactivated accounts get no link: activate them first.

- **An admin can sign in:** open the user in `/admin/users`, choose „Link zum Zurücksetzen
  erstellen" (Create reset link) and pass the link on out-of-band, as with an invitation.
- **No admin can sign in** (for example the only admin forgot their password): run the operator
  command in the app container. It prints a link built from `BETTER_AUTH_URL`:

  ```sh
  docker compose exec app node --import tsx scripts/admin-reset-password.ts admin@example.org
  ```

  In a checkout with `.env` filled in, `pnpm admin:reset-password admin@example.org` does the same.
  An unknown or deactivated email exits with status 1 and changes nothing.

Both paths write an audit row (`PasswordResetIssued`, then `PasswordReset` when the link is used);
the operator command is recorded as „Operator (admin:reset-password)". The `ADMIN_EMAIL` bootstrap
above is only for an installation with no active admin at all.

## 7. Optional demo data

An empty workspace shows an admin-only „Demo-Workspace laden“ button on the dashboard. It loads the
synthetic demo through the audited mutation path, is idempotent, and never runs automatically.
Production is never seeded at boot.

The CLI seed (`pnpm db:seed`) uses the same implementation but needs the source checkout, because
the runtime image ships the app, the generated client and the Prisma schema and migrations, but not
`scripts/`. Run it from a clone against the production database only if you deliberately want it:

```bash
DATABASE_URL='postgresql://…' pnpm db:seed
```

## 8. Verify uploads

Uploads live in the `uploads` volume mounted at `/data/uploads`, encrypted at rest
(AES-256-GCM). Verify the path end to end once, after the first deployment:

1. Sign in and attach a JPEG or PNG to a task, note or ticket.
2. Open the original and its thumbnail.
3. `docker compose restart app`, then reload both. They must still render — the key reached the
   container and the volume survives a restart.
4. Confirm the stored bytes are not a plain image:
   `docker compose exec app sh -c 'find /data/uploads -type f | head'` lists the objects. The
   delivered image is re-encoded with EXIF/GPS stripped, and the stored object is ciphertext.

If step 3 fails, check that `STORAGE_ENCRYPTION_KEY` is set in the running container's environment
without printing it (`docker compose exec app sh -c 'test -n "$STORAGE_ENCRYPTION_KEY" && echo set'`).

Uploads are capped at 15 MB per file and limited to JPEG, PNG and WebP.

## 9. Backups

Backups are **off** until you supply a target. With `WALG_S3_PREFIX` and the `AWS_*` values empty,
the PostgreSQL container's `archive_command` is a no-op and the `backup` sidecar logs
`WALG_S3_PREFIX unset — nothing to back up (dev/local no-op).`

With a target configured, WAL-G ships WAL continuously from inside the PostgreSQL container and the
sidecar takes a base backup at start and then daily. `WALG_RETENTION_COUNT` (default `7`) is a count
of **full base backups**, not a number of days: at a daily cadence it spans roughly a week, and the
window is not guaranteed, because a failed or delayed run changes it. Any value that is not a
positive integer makes the backup script refuse to back up or delete.

What this does **not** give you:

- WAL-G covers PostgreSQL only. Encrypted uploads are outside every WAL-G backup.
- Configuring a backup target does not by itself make the deployment recoverable. Recovery also
  needs the storage key, the S3 credentials and a procedure you have actually run.
- A point-in-time restore needs a concrete full base backup whose recorded finish is at or before
  your target. A newer base cannot be rewound, and missing WAL blocks replay.

[BACKUP.md](BACKUP.md) is the authority for both capabilities, the exact commands and their limits.
Do not improvise a recovery from this section alone.

## 10. Restore safely

Never restore into the live project. Restore under a **new, unused Compose project name**, so the
`pgdata` volume it creates is new and empty and the source volumes are untouched. Stop the source
writers first if it is still serving. A new project also has no `uploads` data; recovering the
encrypted uploads is the second capability in [BACKUP.md](BACKUP.md), not part of a database
restore.

```bash
# on the source stack, if it is still running:
docker compose stop app alerting backup postgres

# restore into a NEW project: fresh volumes, no dependencies started, no PostgreSQL start
RESTORE_CONFIRM=empty-target \
  docker compose -p <recovery-project> --profile restore run --rm --no-deps restore
```

`restore.sh` refuses to run without the literal `RESTORE_CONFIRM=empty-target`, and refuses any
destination that is not empty (dotfiles count as content). It never deletes a populated directory.

A time-targeted restore additionally requires both `TARGET_TS` and a concrete full `BACKUP_NAME`
(`base_` plus 24 uppercase hex digits) whose recorded finish is at or before the target:

```bash
RESTORE_CONFIRM=empty-target TARGET_TS='2026-01-01 00:00:00+00:00' BACKUP_NAME=base_<24 hex> \
  docker compose -p <recovery-project> --profile restore run --rm --no-deps restore
```

The selection is validated by `ops/postgres/select-backup.py` before anything is written; an
unprovable target or name is refused rather than silently replaced with `LATEST`. Starting the
recovered database with archiving off, letting it replay archived WAL and then checking the
invariants is the block "Restore into a NEW project (never overwrite the source)" in
[BACKUP.md](BACKUP.md) — follow it there rather than reconstructing it here.

`RESTORE_DRILL_ENABLED=1` adds a monthly automated restore drill inside the backup sidecar. It is a
restore/query/invariant **smoke check**, not a source-equality or selected-time proof, and its
success marker is written only after a successful drill.

## 11. Diagnostics

```bash
docker compose ps                  # what is up, healthy, restarting or exited
docker compose logs migrate        # migration + invariant gate result
docker compose logs app            # application errors and boot logs
docker compose logs postgres       # WAL archiving failures appear here
docker compose logs backup         # base backup progress / retention / "nothing to back up"
docker compose logs alerting       # "alerting disabled; idling" or poll failures
curl -fsS https://<APP_DOMAIN>/healthz
```

The application logs `[calendar] CALDAV_* not set — outbox drain idle` when calendar push is
unconfigured, and `/admin/index` shows the resolved status of each AI capability. The alerting
sidecar logs `alerting disabled; idling` when `ALERT_WEBHOOK` is empty. The bootstrap log lines
record that an admin was created, never the password. Still, treat logs as sensitive and redact
request paths, e-mail addresses and IDs before sharing them. `docker compose config` renders every
value, including secrets, so do not paste its output anywhere.

## 12. Local plain-HTTP rehearsal

`docker-compose.rehearsal.yml` is an override for a local, throwaway run of the same production
file: its own Compose project (`jiangtang-rehearsal`), its own volumes, Caddy published on host
port 8080, and a local S3-compatible stand-in for the backup target. It requires
`REHEARSAL_S3_ACCESS_KEY` and `REHEARSAL_S3_SECRET_KEY` in the environment (synthetic values, never
production ones), plus the same `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `STORAGE_ENCRYPTION_KEY`
and `ADMIN_*` values as a real deployment. CalDAV, AI and GlitchTip are blanked by the override.

The command examples below use that default project, `jiangtang-rehearsal`. For a release or
recovery rehearsal, pass an explicit unique project and a private environment file instead:
`-p <project>` and `--env-file <path>`. Volume and network names follow the project, so the
explicit project keeps that rehearsal's state separate from every other stack.

The base file requires `APP_DOMAIN` and `BETTER_AUTH_URL`, and compose checks them before the
override applies, so export the rehearsal values first, in the shell that runs the commands below:

```bash
export APP_DOMAIN=:80 BETTER_AUTH_URL=http://localhost:8080
```

```bash
docker compose -f docker-compose.yml -f docker-compose.rehearsal.yml up -d --build
# exercise: migrate gate, health, first admin login, empty workspace, demo load, invite,
#           search, an upload, backup and restore
# throwaway rehearsal only: delete this project's containers and volumes
docker compose -f docker-compose.yml -f docker-compose.rehearsal.yml down -v
```

That override sets `APP_DOMAIN=:80`, so Caddy serves plain HTTP inside the container, and the
override publishes container port 80 as host port 8080 (`http://localhost:8080`). The published
port is bound to 127.0.0.1 only, so the rehearsal is reachable from the host itself and no other
machine. That is a wiring check, not evidence about TLS, DNS or a real certificate.

Teardown depends on what the stack is for. A throwaway wiring rehearsal can be deleted with
`down -v`: every volume belongs to the rehearsal project, so it cannot touch a production project
or the development database. A recovery or PITR rehearsal is not throwaway; it holds the source
whose restore you are verifying. `stop` it and preserve the project, its volumes and its images,
and never run `down -v` on a project that is the source for a restore check.
