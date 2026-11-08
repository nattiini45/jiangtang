# Backup and recovery

Three capabilities exist. They are not interchangeable: the first two together are the
everyday backup of a running deployment, and the third is the coherent cold snapshot.

| Capability | Covers | Does not cover |
| --- | --- | --- |
| WAL-G database PITR | PostgreSQL data and WAL, restored into a new empty data directory | uploads/attachments, the encryption key, `.env`, any other volume |
| Daily uploads archive | the encrypted `uploads` volume, archived daily to `uploads/` on the same S3 target while the stack runs | point-in-time precision; uploads newer than the last archive; the encryption key |
| Stopped-stack all-data recovery | PostgreSQL **plus** encrypted uploads, archived together from a cleanly stopped stack | point-in-time precision; WAL-G cannot rewind uploads |

WAL-G archives only the database. Files under `uploads` are encrypted at rest
and are **not** in any WAL-G backup; the daily uploads archive covers them
separately. A database restore and an uploads archive therefore belong to
different moments. Do not advertise or promise attachment PITR or "all data
from WAL-G".

## The minimum you must store elsewhere

- `STORAGE_ENCRYPTION_KEY` (and `STORAGE_KEY_SALT` if a passphrase-derived key
  is used) — without it, restored attachments are unreadable.
- `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD` and the S3 credentials.
- These are **never** placed in the same publicly shareable directory as
  database/volume archives or reports.

`openssl rand -hex 32` **creates** a key. It does not recover one. Restoring a
deployment requires the key it was encrypted with; create a new key only for a
new, empty deployment.

## Restore prerequisites

Every `docker compose` command in this runbook reads the deployment's `.env` (or
the file passed with `--env-file`), so that file must also define `APP_DOMAIN` and
`BETTER_AUTH_URL` (see `.env.production.example`). `docker-compose.yml` requires
both when the file loads, so an env file that lacks them makes every command in
this runbook abort with a "set ... in the environment" error. A recovery host can
hold an older env file that predates these keys: check for them before you start.
The abort happens before any restore step runs, so no data is touched.

## Capability 1 — WAL-G database PITR

WAL-G writes WAL continuously (the postgres `archive_command`) and a base
backup daily (the `backup` sidecar). A restore needs:

1. a **concrete full backup name** (`base_` + 24 uppercase hex) that finished at
   or before the target time;
2. the archived WAL up to that target;
3. a missing or completely empty destination data directory.

A base that finished **after** the target cannot be rewound. If no eligible
base (or the WAL) is missing from the target, recovery is blocked — the restore
fails rather than silently selecting something else.

### Inspect and select a base (read-only)

Run in the deployment directory, with the stack's `.env` in place:

```bash
# All backups with start/finish times (JSON, exact timestamps):
docker compose exec -T postgres wal-g backup-list --json --detail

# The V2 stop sentinel of one candidate:
BACKUP_NAME=base_000000010000000000000002
docker compose exec -T postgres \
  wal-g st cat "basebackups_005/${BACKUP_NAME}_backup_stop_sentinel.json"
```

Requirements for a targeted restore:

- `finish_time` (list) and `FinishTime` (sentinel) are the same instant and are
  **at or before** the target;
- the backup is full: no `_D_` incremental name, no `is_incremental`, no
  `DeltaFrom`;
- the target timestamp is timezone-qualified (up to six fractional digits).

`select-backup.py` enforces all of this. It runs automatically inside
`restore.sh` before any backup data is fetched or extracted; the restore may create an empty
PGDATA directory first, but a rejected selection never writes backup data. To validate a candidate **without**
starting a restore, run the same read-only check in the WAL-G image (the
service mounts `ops/postgres` at `/ops`; nothing is written to the data volume):

```bash
BACKUP_NAME=base_000000010000000000000002 TARGET_TS="2026-10-08 21:00:00+00:00" \
docker compose --profile restore run --rm --no-deps --entrypoint bash restore -c '
  set -euo pipefail
  d="$(mktemp -d)"; chmod 700 "$d"
  trap "rm -f \"$d/list.json\" \"$d/sentinel.json\"; rmdir \"$d\"" EXIT
  wal-g backup-list --json --detail > "$d/list.json"
  wal-g st cat "basebackups_005/${BACKUP_NAME}_backup_stop_sentinel.json" > "$d/sentinel.json"
  python3 /ops/select-backup.py "$BACKUP_NAME" "$TARGET_TS" "$d/list.json" "$d/sentinel.json"
'
```

Success prints exactly two lines (the validated name and the UTC-normalized
target); any rejection exits nonzero before a restore is attempted.

### Restore into a NEW project (never overwrite the source)

The restore service mounts the project's `pgdata` volume and refuses a
nonempty target. Restore under a **separate project name**, which gives you
fresh, empty volumes; the source deployment is untouched.

```bash
set -euo pipefail
: "${PROJECT:?set PROJECT to the verified compose project}"
: "${RECOVERY_PROJECT:?set RECOVERY_PROJECT to a new, unused project name}"
: "${TARGET_TS:?set TARGET_TS (timezone-qualified) or leave the targeted block out}"
: "${BACKUP_NAME:?set BACKUP_NAME to the inspected full base}"

# The S3 target must already be running/reachable; --no-deps never starts it,
# and postgres is never started by the restore step.
RESTORE_CONFIRM=empty-target TARGET_TS="$TARGET_TS" BACKUP_NAME="$BACKUP_NAME" \
  docker compose -p "$RECOVERY_PROJECT" --profile restore \
    run --rm --no-deps restore

# Start ONLY the recovered database in the new project, with archiving OFF.
# WALG_S3_PREFIX stays set so restore_command (written by restore.sh) can fetch
# the archived WAL; the command override stops the promoted timeline from ever
# being pushed back into the SOURCE WAL store.
cat > recovery.override.yml <<'YAML'
services:
  postgres:
    command: ["postgres", "-c", "archive_mode=off"]
YAML

docker compose -p "$RECOVERY_PROJECT" -f docker-compose.yml -f recovery.override.yml \
  up -d postgres
docker compose -p "$RECOVERY_PROJECT" logs -f postgres

# Verify inside the container (credentials stay in the container env):
docker compose -p "$RECOVERY_PROJECT" exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < ops/postgres/verify-invariants.sql
```

A recovered instance deliberately runs with archiving off: it replays from the
source WAL store but never writes its new timeline back. To run it as a new
archiving primary later, restart it with `archive_mode=on` and a **new,
separate** `WALG_S3_PREFIX` — never the source prefix.

Without `TARGET_TS`/`BACKUP_NAME` the documented **latest available** base is
fetched. That path makes no replay-completeness claim: missing later WAL can
still produce a consistent promotion that is not the latest commit. Supplying a
backup name without a target is refused — never silently replaced with
`LATEST`.

## Capability 2 — coherent stopped-stack recovery (database + uploads)

This is the only path that captures PostgreSQL **and** uploads at the same
moment. It is not point-in-time; it is a clean stopped snapshot.

### 1. Verify the project and both volumes

```bash
set -euo pipefail
docker compose ls
docker compose ps

PROJECT="${PROJECT:?set PROJECT from docker compose ls}"
PGDATA_VOLUME="${PGDATA_VOLUME:?set the verified pgdata volume name}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:?set the verified uploads volume name}"

# `inspect` fails for a typo instead of silently creating an empty volume.
docker volume inspect "$PGDATA_VOLUME" >/dev/null
docker volume inspect "$UPLOADS_VOLUME" >/dev/null
docker volume inspect --format \
  '{{ index .Labels "com.docker.compose.project" }} {{ index .Labels "com.docker.compose.volume" }}' \
  "$PGDATA_VOLUME" "$UPLOADS_VOLUME"
```

Both labels must name the intended project and the `pgdata`/`uploads` volumes.
Variables are mandatory: an unset name stops the block at the `${VAR:?...}`
expansion before any container runs.

### 2. Stop every writer cleanly

```bash
docker compose stop app alerting backup postgres
docker compose ps        # everything stopped; migrate is a one-shot job
```

The app stops first so no request writes during the archive; the backup
scheduler and PostgreSQL then stop cleanly (`stop` = SIGTERM, fast shutdown).

### 3. Archive BOTH volumes with numeric ownership

Use a cached helper image (for example `alpine:3.20`), **no network**, a
read-only source mount and a private output directory. Nothing is written back
into the source volumes.

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_DIR="${ARCHIVE_DIR:?set ARCHIVE_DIR to a private path}/$STAMP"
install -d -m 700 "$ARCHIVE_DIR"

docker volume inspect "$PGDATA_VOLUME" >/dev/null   # fails on a typo; never mounts a new empty volume
docker run --rm --network none \
  -v "$PGDATA_VOLUME:/source:ro" -v "$ARCHIVE_DIR:/out" alpine:3.20 \
  sh -c 'tar --numeric-owner -czf /out/pgdata.tar.gz -C /source .'

docker volume inspect "$UPLOADS_VOLUME" >/dev/null
docker run --rm --network none \
  -v "$UPLOADS_VOLUME:/source:ro" -v "$ARCHIVE_DIR:/out" alpine:3.20 \
  sh -c 'tar --numeric-owner -czf /out/uploads.tar.gz -C /source .'

sha256sum "$ARCHIVE_DIR/pgdata.tar.gz" "$ARCHIVE_DIR/uploads.tar.gz" \
  | tee "$ARCHIVE_DIR/SHA256SUMS"
```

Record, next to the archives (never inside a publicly shareable copy):

- the two SHA-256 values;
- the application image digest (`docker compose images`, or
  `docker inspect --format '{{.Image}}'`);
- the PostgreSQL version (`SELECT version();`) and PostgreSQL 18;
- the exact verified volume names and the Compose project;
- the UTC snapshot time (`STAMP`);
- the **ID** of the encryption key and the salt value in use — never the key
  itself.

### 4. Restart the source stack

```bash
docker compose start postgres backup alerting app
docker compose ps
```

### 5. Restore into separately created, empty volumes

Verify the archives before extracting, then extract into **new** volumes under
a different project. Never extract over the running source volumes.

Run these from the deployment directory (the compose calls below resolve
`docker-compose.yml` and `ops/postgres/verify-invariants.sql` relative to it);
the archive check runs in a subshell so the working directory is unchanged.

```bash
( cd "$ARCHIVE_DIR" && sha256sum -c SHA256SUMS )

RECOVERY_PROJECT="${RECOVERY_PROJECT:?set a new, unused recovery project name}"

# Compose names the volumes "${project}_pgdata" and "${project}_uploads".
# `docker volume create` silently reuses an existing volume, so refuse any
# existing name BEFORE creating/extracting: a typo must never overwrite a
# source or previously used recovery volume.
for volume in "${RECOVERY_PROJECT}_pgdata" "${RECOVERY_PROJECT}_uploads"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "refusing to reuse existing volume: $volume" >&2
    exit 1
  fi
done

docker volume create "${RECOVERY_PROJECT}_pgdata"
docker volume create "${RECOVERY_PROJECT}_uploads"

# The database archive is the pgdata VOLUME itself (including 18/docker), not a
# WAL-G base. Extract BOTH archives from the same stopped snapshot.
docker run --rm --network none \
  -v "${RECOVERY_PROJECT}_pgdata:/target" -v "$ARCHIVE_DIR:/backup:ro" alpine:3.20 \
  sh -c 'tar --numeric-owner -xzf /backup/pgdata.tar.gz -C /target'
docker run --rm --network none \
  -v "${RECOVERY_PROJECT}_uploads:/target" -v "$ARCHIVE_DIR:/backup:ro" alpine:3.20 \
  sh -c 'tar --numeric-owner -xzf /backup/uploads.tar.gz -C /target'

# Start the recovered stack with archiving disabled (same override as
# Capability 1). This snapshot needs no WAL replay, and the instance must never
# push its new timeline into the SOURCE WAL store.
cat > recovery.override.yml <<'YAML'
services:
  postgres:
    command: ["postgres", "-c", "archive_mode=off"]
YAML

docker compose -p "$RECOVERY_PROJECT" -f docker-compose.yml -f recovery.override.yml \
  up -d postgres
docker compose -p "$RECOVERY_PROJECT" exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < ops/postgres/verify-invariants.sql
```

The recovered project needs its own copy of the **separately recovered**
`STORAGE_ENCRYPTION_KEY` (and salt); attachments cannot be decrypted without it.

Both volumes now come from the same stopped snapshot. Never combine this database
archive with a later WAL-G PITR database (Capability 1) and call the result
coherent: that would mix two different moments.

## Capability 3 — daily uploads archive (S3)

With `WALG_S3_PREFIX` set, the backup sidecar runs `ops/postgres/uploads-backup.sh` right after
each base backup: at start and then daily. It streams a tar of the `uploads` volume (mounted
read-only) into `wal-g st put`, so the archive lands under `uploads/uploads_<UTC stamp>.tar` in the
same bucket and prefix as the database backups. The files are already AES-256-GCM ciphertext; the
archive is not compressed again and is useless without `STORAGE_ENCRYPTION_KEY`. If WAL-G
encryption is configured, it applies to these objects too.

`UPLOADS_RETENTION_COUNT` (default `14`) archives are kept. Like `WALG_RETENTION_COUNT`, it is a
count, not a number of days, and anything but a positive integer makes the script refuse to archive
or delete.

The stack keeps running while the archive is taken. Stored objects are written once under random
keys and never modified, so an archive holds every object that existed when it started. An upload
in flight at that moment can be missing or truncated in that archive and is complete in the next.
Uploads made after the newest archive are not in any backup; the app answers 404 for an attachment
whose file is missing.

**Which archive goes with which database.** Objects are never rewritten, so a later archive is a
superset of an earlier one, apart from attachments deleted in between. For a database restored to
`TARGET_TS`, take the first archive stamped **at or after** `TARGET_TS`; for a latest-available
restore, take the newest archive. Extra objects in the archive are harmless orphans.

List the archives (read-only):

```bash
docker compose exec -T backup wal-g st ls uploads/
```

Take one now, for example before an update (the same script the schedule runs):

```bash
docker compose exec -T backup bash /ops/uploads-backup.sh
```

### Restore an uploads archive into a NEW project

Run this after the database restore in "Restore into a NEW project" above, with the same
`RECOVERY_PROJECT`. It extracts into that project's own `uploads` volume and refuses a volume that
already holds files.

```bash
set -euo pipefail
: "${RECOVERY_PROJECT:?set RECOVERY_PROJECT to the recovery project used for the database}"
# Optional: UPLOADS_ARCHIVE=uploads_<stamp>.tar picks one; default is the newest.

# Create the recovery project's (empty) volumes without starting anything.
docker compose -p "$RECOVERY_PROJECT" up --no-start app

docker compose -p "$RECOVERY_PROJECT" --profile restore run --rm --no-deps \
  -e UPLOADS_ARCHIVE -v "${RECOVERY_PROJECT}_uploads:/target" --entrypoint bash restore -c '
  set -euo pipefail
  [ -z "$(ls -A /target)" ] || { echo "refusing a non-empty uploads volume" >&2; exit 1; }
  name="${UPLOADS_ARCHIVE:-$(wal-g st ls uploads/ | awk "{print \$NF}" \
    | grep -E "^uploads_[0-9]{8}T[0-9]{6}Z\.tar$" | sort | tail -n 1)}"
  [ -n "$name" ] || { echo "no uploads archive found" >&2; exit 1; }
  echo "restoring uploads/$name"
  wal-g st get --no-decompress "uploads/$name" /tmp/uploads.tar
  tar --numeric-owner -xf /tmp/uploads.tar -C /target
  find /target -type f | wc -l
'
```

Start the recovered app only with the deployment's original `STORAGE_ENCRYPTION_KEY` (and salt).
Then sign in and open an attachment: it must render, and `/healthz` must report `"db":"up"`.

### Rehearsing a restore locally

In the plain-HTTP rehearsal (`docker-compose.rehearsal.yml`), the S3 stand-in runs inside the
source project, so a recovery project cannot reach it by default. Run the recovery project with the
base `docker-compose.yml`, an env file that adds the rehearsal's S3 values
(`WALG_S3_PREFIX=s3://jiangtang-rehearsal`, the `REHEARSAL_S3_*` keys as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT` set to the `minio` service on port 9000 over plain HTTP,
`AWS_S3_FORCE_PATH_STYLE=true`) and an override that joins the source network:

```yaml
services:
  postgres:
    command: ["postgres", "-c", "archive_mode=off"]
    networks: [default, source]
  restore:
    networks: [default, source]
  caddy:
    ports: !override
      - "127.0.0.1:8080:80"
networks:
  source:
    external: true
    name: jiangtang-rehearsal_default
```

Stop the source project's `caddy` first so the recovery project can take port 8080. A real S3
target needs none of this.

## Failure alerts

With `ALERT_WEBHOOK` set, the `alerting` sidecar posts backup problems to the same webhook as
downtime. The `backup` sidecar records them in the shared `backup-status` volume and the alerting
sidecar reads it once a minute (`ops/alerting/backup-alert.sh`):

| Alert | Raised when | Recorded by |
| --- | --- | --- |
| Base backup failed | `backup.sh` exits non-zero, including a refused configuration | `ops/postgres/backup.sh` (`backup.failed`) |
| No recent base backup | the last successful base backup is older than 36 hours (`BACKUP_MAX_AGE_SECONDS`), for example because the sidecar stopped | `backup.sh` stamps `backup.ok` on success |
| Uploads archive failed | `uploads-backup.sh` exits non-zero, including a refused configuration | `ops/postgres/uploads-backup.sh` (`uploads.failed`) |
| WAL archiving failing | `pg_stat_archiver` shows a failed push newer than the last successful one, or cannot be read; checked hourly | `ops/postgres/check-wal-archive.sh` (`wal-archive.failed`) |

Each alert is posted once when it appears or its first line changes, repeated every 6 hours while it
persists (`REALERT_SECONDS`), and followed by a recovery message once it clears. Nothing is
reported before the first backup has run, and an install without `WALG_S3_PREFIX` records no WAL
failures. The details stay in `docker compose logs backup` and `docker compose logs postgres`.

## Monthly automated smoke check (opt-in)

With `RESTORE_DRILL_ENABLED=1`, the backup sidecar runs `ops/postgres/restore-drill.sh` on the
first day of each month. The drill:

- restores a base plus archived WAL through the same guarded `restore.sh` into a **unique
  private temp root** (never the live data volume);
- starts a throwaway PostgreSQL **as `postgres` (via `gosu`)** on `127.0.0.1:<DRILL_PORT>` with
  its own socket directory, archiving off, refusing an occupied port;
- waits until recovery has completed, runs `verify-invariants.sql` with `ON_ERROR_STOP=1`, and
  prints row counts as **diagnostics only**;
- stops only the server it started and removes only its own temp root.

The monthly marker is written **only if the drill exits successfully**; a failed drill leaves
no success marker. Run it manually against the rehearsal S3 target before trusting it:

```bash
# TARGET_TS/BACKUP_NAME are required together for a validated targeted drill;
# omit both for the documented latest-available path.
docker compose exec -T backup bash /ops/restore-drill.sh
TARGET_TS="2026-10-08 21:00:00+00:00" BACKUP_NAME=base_000000010000000000000002 \
  docker compose exec -T -e TARGET_TS -e BACKUP_NAME backup bash /ops/restore-drill.sh
```

It is a smoke check: consistent + queryable + invariant-clean. It does **not** establish
source-data equality, selected-time correctness, or latest-available replay completeness.

## What this does NOT prove

- A successful restore + query + invariants check proves a consistent,
  queryable database — not source-data equality.
- Latest-available replay completeness is **not** established: missing later WAL
  can still permit a consistent promotion.
- The automated monthly drill (see `DEPLOY.md`) is a smoke check, not the
  assertion-based full recovery/PITR proof.

## Windows host notes (local rehearsal only)

The supported production environment is a Linux VPS with Docker and the Compose
plugin. On a Windows host using Git Bash:

- quote every path (`"$PWD/..."`) — spaces are common;
- prefix container-path arguments with `MSYS_NO_PATHCONV=1` so `/var/lib/...`
  is not rewritten into a Windows path;
- `tar --numeric-owner` must run **inside** the Linux helper container, never
  from the Windows host.
