#!/usr/bin/env bash
# Scheduled base backup + WAL retention ("nightly logical dump
# + PITR (WAL archiving)"). Runs as a sidecar container (cron). WAL shipping itself
# is continuous via the postgres `archive_command`; this script takes a periodic
# base backup so PITR recovery has a restore point, then prunes old backups.
set -euo pipefail

# Outcome for the alerting sidecar, which reads BACKUP_STATUS_DIR from a shared
# volume and posts to ALERT_WEBHOOK (ops/alerting/backup-alert.sh). An EXIT trap
# covers every way out, including a `set -e` abort. backup.ok keeps the time of
# the last pushed base backup, so a backup that stops running at all is noticed
# too; a failed prune afterwards is reported as such and does not hold it back.
# The first line of a failure is the alert's identity (backup-alert.sh), so the
# time goes on the next line. Files are replaced with a rename so the reader
# never sees half a message.
BACKUP_PHASE="base backup"

status_write() {
  printf '%s\n' "$2" > "${BACKUP_STATUS_DIR}/.$1.tmp" && mv -f "${BACKUP_STATUS_DIR}/.$1.tmp" "${BACKUP_STATUS_DIR}/$1"
}

status_enabled() {
  [ -n "${BACKUP_STATUS_DIR:-}" ] && [ -d "${BACKUP_STATUS_DIR}" ]
}

record_backup_status() {
  local code=$?
  status_enabled || return 0
  if [ "${code}" -eq 0 ]; then
    rm -f "${BACKUP_STATUS_DIR}/backup.failed"
  else
    status_write backup.failed "Jiangtang ${BACKUP_PHASE} FAILED (exit ${code}).
At $(date -u +%FT%TZ). Details: docker compose logs backup"
  fi
  return 0
}
trap record_backup_status EXIT

# shellcheck source=wal-g/env.sh
source "$(dirname "$0")/wal-g/env.sh"

# Dev/local no-op: env.sh returns (no longer exits) when no S3 target is
# configured, so make the "nothing to back up" decision explicitly here.
if [ -z "${WALG_S3_PREFIX:-}" ]; then
  echo "[backup] WALG_S3_PREFIX unset — nothing to back up (dev/local no-op)."
  exit 0
fi

# Retention is a COUNT of FULL base backups (wal-g `delete retain FULL <n>`), NOT a
# number of days: WALG_RETENTION_COUNT=7 keeps the newest 7 full backups. How many
# days that spans depends on the backup cadence, so it is not a guaranteed window.
# Validate BEFORE any backup-push or delete: anything but a positive integer without
# leading zeros is refused, and no delete command is issued.
if ! [[ "${WALG_RETENTION_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup] FATAL: WALG_RETENTION_COUNT must be a positive integer without leading zeros (got \"${WALG_RETENTION_COUNT}\"); refusing to back up or delete" >&2
  exit 1
fi

# PG18 keeps the real data directory in a versioned subdir under the mounted
# volume (e.g. /var/lib/postgresql/18/docker), not at the mount root — the
# postgres service sets PGDATA explicitly (docker-compose.yml) and the backup
# service is meant to mirror it. Don't silently back up the wrong directory: if
# PGDATA is unset/wrong, discover the real one (the child of the mount that
# contains PG_VERSION) rather than guessing, and fail loudly if none is found.
PG_MOUNT_ROOT="/var/lib/postgresql"

if [ -z "${PGDATA:-}" ] || [ ! -f "${PGDATA}/PG_VERSION" ]; then
  echo "[backup] PGDATA unset or missing PG_VERSION (PGDATA=${PGDATA:-<unset>}); discovering under ${PG_MOUNT_ROOT}"
  # `-print -quit` stops at the first match without a pipe — piping to `head`
  # would let `head` close the pipe early, giving `find` SIGPIPE (exit 141) which,
  # under `set -o pipefail` + `set -e`, would abort this very fallback path.
  discovered="$(find "${PG_MOUNT_ROOT}" -mindepth 1 -maxdepth 3 -name PG_VERSION -print -quit 2>/dev/null)"
  if [ -n "${discovered}" ]; then
    PGDATA="$(dirname "${discovered}")"
    echo "[backup] discovered PGDATA=${PGDATA}"
  fi
fi

if [ -z "${PGDATA:-}" ] || [ ! -f "${PGDATA}/PG_VERSION" ]; then
  echo "[backup] FATAL: no valid PGDATA found (looked for \"\$PGDATA/PG_VERSION\" and searched ${PG_MOUNT_ROOT}); refusing to back up an empty/wrong directory" >&2
  exit 1
fi

echo "[backup] starting base backup at $(date -u +%FT%TZ) (PGDATA=${PGDATA})"
wal-g backup-push "${PGDATA}"
echo "[backup] base backup complete"
if status_enabled; then status_write backup.ok "$(date -u +%FT%TZ)"; fi
BACKUP_PHASE="retention pruning"

echo "[backup] retention: keeping the newest ${WALG_RETENTION_COUNT} FULL backups (a count of full backups, NOT a guaranteed number of days of retention)"
wal-g delete retain FULL "${WALG_RETENTION_COUNT}" --confirm
echo "[backup] done at $(date -u +%FT%TZ)"
