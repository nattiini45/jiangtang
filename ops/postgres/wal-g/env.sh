#!/usr/bin/env bash
# WAL-G environment for the Jiangtang Postgres backup sidecar.
# Source this in the backup/restore container. All values come from the environment
# (compose interpolates from the environment or the host's secret store) — nothing is committed.
#
# WAL-G is FOSS, S3-compatible (the deployment's storage backend target). The backend is
# env-parametrized so it works against any S3-compatible target (Garage, RustFS,
# SeaweedFS, AWS S3, MinIO…).
#
# Required env (set in the compose service or the secret store):
#   WALG_S3_PREFIX            e.g. s3://jiangtang-backups/postgres
#   AWS_ACCESS_KEY_ID
#   AWS_SECRET_ACCESS_KEY
#   AWS_ENDPOINT              (for non-AWS S3-compatible backends)
#   AWS_REGION
#
# Postgres archive_command + the backup sidecar both read these. See:
#   - ops/postgres/backup.sh   (scheduled base backup)
#   - ops/postgres/restore-drill.sh  (PITR restore verification)

# Archiving is intentionally a no-op in dev/local when these are unset (see the
# compose comment on the postgres service's archive_command). Hard-requiring them
# here would abort the backup/restore-drill sidecar on every run in dev.
#
# This file is *sourced*, so we `return` (never `exit`) — `exit` here would
# terminate the CALLING script, and a caller like restore-drill.sh would then
# stop BEFORE doing any restore work yet still report success. Returning control
# lets each caller decide what an unconfigured target means (backup.sh: dev
# no-op; restore-drill.sh: hard error — a drill that restores nothing must never
# pass). Creds are only required once we know a real target is configured.
if [ -z "${WALG_S3_PREFIX:-}" ]; then
  echo "[wal-g/env] WALG_S3_PREFIX is unset — S3 target not configured (dev/local); skipping exports." >&2
  return 0
fi

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set (WALG_S3_PREFIX is set, so a real S3 target is expected)}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set (WALG_S3_PREFIX is set, so a real S3 target is expected)}"

# WAL-G S3 settings (the lib nominally also supports file/gpg/azure, but S3 is the
# self-hosted target this deployment calls for).
export WALG_S3_PREFIX
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export AWS_ENDPOINT="${AWS_ENDPOINT:-}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

# Retention is a COUNT of FULL base backups kept by `wal-g delete retain FULL`, NOT a
# number of days. The default 7 keeps the newest 7 full backups; days of coverage
# follow from the backup cadence and are not guaranteed. backup.sh validates the
# value (^[1-9][0-9]*$) before any delete. `-` (not `:-`) so an explicitly empty
# value stays empty and is rejected, instead of silently becoming 7.
export WALG_RETENTION_COUNT="${WALG_RETENTION_COUNT-7}"
export WALG_SAVE_WAL_FILES="true"

# Disk threshold for WAL push (avoid filling the local archive).
export WALG_DISK_CAPACITY="${WALG_DISK_CAPACITY:-10GB}"
