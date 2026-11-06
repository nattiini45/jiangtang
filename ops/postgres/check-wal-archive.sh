#!/usr/bin/env bash
# WAL archiving check, run hourly by the backup sidecar. PostgreSQL retries a
# failing archive_command forever and logs nothing a person sees, while WAL
# piles up in pg_wal and point-in-time recovery silently stops at the last
# pushed segment. pg_stat_archiver records the last failure and the last
# success, so a failure newer than the last success means archiving is broken.
#
# The result goes to BACKUP_STATUS_DIR/wal-archive.failed (present = failing),
# which the alerting sidecar posts to ALERT_WEBHOOK (ops/alerting/backup-alert.sh).
# Connection settings come from the standard PG* variables of the backup service.
set -euo pipefail

STATUS_DIR="${BACKUP_STATUS_DIR:?BACKUP_STATUS_DIR must point at the shared status volume}"
FAILED="${STATUS_DIR}/wal-archive.failed"

write_failed() {
  printf '%s\n' "$1" > "${STATUS_DIR}/.wal-archive.failed.tmp"
  mv -f "${STATUS_DIR}/.wal-archive.failed.tmp" "${FAILED}"
}

# Archiving is a no-op without an S3 target (see the archive_command in
# docker-compose.yml), so there is nothing to check.
if [ -z "${WALG_S3_PREFIX:-}" ]; then
  rm -f "${FAILED}"
  exit 0
fi

query="SELECT failed_count,
              coalesce(last_failed_wal, ''),
              coalesce(to_char(last_failed_time AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), ''),
              coalesce(to_char(last_archived_time AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'never'),
              (last_failed_time IS NOT NULL
               AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))
         FROM pg_stat_archiver"

if ! row="$(psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -c "${query}" 2>&1)"; then
  write_failed "Jiangtang WAL archive check could not read pg_stat_archiver.
At $(date -u +%FT%TZ): ${row}"
  exit 1
fi

IFS='|' read -r failed_count last_failed_wal last_failed_time last_archived_time failing <<< "${row}"

# The first line is the alert's identity (backup-alert.sh); the counters and
# times change on every check, so they go below it.
if [ "${failing}" = "t" ]; then
  write_failed "Jiangtang WAL archiving is FAILING.
${failed_count} failed pushes so far, latest ${last_failed_wal} at ${last_failed_time}; last successful push ${last_archived_time}. Details: docker compose logs postgres"
  echo "[wal-check] archiving failing (last failed ${last_failed_wal} at ${last_failed_time})" >&2
elif [ "${last_archived_time}" = "never" ] && [ -z "${last_failed_time}" ]; then
  # A restart resets pg_stat_archiver. No push since then says nothing either
  # way, so a recorded failure stays until a push succeeds or fails again.
  echo "[wal-check] no archive activity since the statistics were reset"
else
  rm -f "${FAILED}"
  echo "[wal-check] archiving ok (last push ${last_archived_time})"
fi
