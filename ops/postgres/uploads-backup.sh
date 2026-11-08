#!/usr/bin/env bash
# Scheduled archive of the encrypted uploads volume to the WAL-G S3 target. WAL-G
# backs up PostgreSQL only; attachments live in the "uploads" volume, so without
# this a lost host loses every photo even when the database can be restored.
#
# The backup sidecar mounts the volume read-only at UPLOADS_DIR and runs this
# daily, right after the base backup. The archive is a plain tar streamed into
# "wal-g st put" under uploads/ in the same bucket and prefix as the database
# backups. The files are already AES-256-GCM ciphertext, so the archive is not
# compressed again and is unreadable without STORAGE_ENCRYPTION_KEY. WAL-G's own
# encryption still applies when the operator configured it.
#
# The stack keeps running while the archive is taken. Objects are written once
# under random keys and never modified, so an archive holds every object that
# existed when it started; an upload in flight at that moment may be missing or
# truncated and is complete in the next run.
#
# UPLOADS_RETENTION_COUNT (default 14) archives are kept; older ones are deleted
# after a successful upload. The outcome goes to BACKUP_STATUS_DIR/uploads.failed
# (present = failing), which ops/alerting/backup-alert.sh posts to ALERT_WEBHOOK.
set -euo pipefail

UPLOADS_PHASE="uploads archive"

status_enabled() {
  [ -n "${BACKUP_STATUS_DIR:-}" ] && [ -d "${BACKUP_STATUS_DIR}" ]
}

record_uploads_status() {
  local code=$?
  status_enabled || return 0
  if [ "${code}" -eq 0 ]; then
    rm -f "${BACKUP_STATUS_DIR}/uploads.failed"
  else
    printf '%s\n' "Jiangtang ${UPLOADS_PHASE} FAILED (exit ${code})." \
      "At $(date -u +%FT%TZ). Details: docker compose logs backup" \
      > "${BACKUP_STATUS_DIR}/.uploads.failed.tmp"
    mv -f "${BACKUP_STATUS_DIR}/.uploads.failed.tmp" "${BACKUP_STATUS_DIR}/uploads.failed"
  fi
  return 0
}
trap record_uploads_status EXIT

# shellcheck source=wal-g/env.sh
source "$(dirname "$0")/wal-g/env.sh"

if [ -z "${WALG_S3_PREFIX:-}" ]; then
  echo "[uploads] WALG_S3_PREFIX unset — nothing to archive (dev/local no-op)."
  exit 0
fi

UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
UPLOADS_RETENTION_COUNT="${UPLOADS_RETENTION_COUNT-14}"
if ! [[ "${UPLOADS_RETENTION_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[uploads] FATAL: UPLOADS_RETENTION_COUNT must be a positive integer without leading zeros (got \"${UPLOADS_RETENTION_COUNT}\"); refusing to archive or delete" >&2
  exit 1
fi
if [ ! -d "${UPLOADS_DIR}" ]; then
  echo "[uploads] FATAL: ${UPLOADS_DIR} is not a directory; is the uploads volume mounted?" >&2
  exit 1
fi

object="uploads/uploads_$(date -u +%Y%m%dT%H%M%SZ).tar"
echo "[uploads] archiving ${UPLOADS_DIR} to ${object} at $(date -u +%FT%TZ)"
set +e
tar --numeric-owner -cf - -C "${UPLOADS_DIR}" . | wal-g st put --no-compress --read-stdin "${object}"
codes=("${PIPESTATUS[@]}")
set -e
# GNU tar exits 1 when a file changed while it was read (an upload in flight);
# the archive is still complete for every other object.
if [ "${codes[0]}" -eq 1 ]; then
  echo "[uploads] warning: a file changed while it was archived; the next run picks it up" >&2
fi
if [ "${codes[0]}" -gt 1 ] || [ "${codes[1]}" -ne 0 ]; then
  echo "[uploads] FATAL: archive failed (tar exit ${codes[0]}, wal-g exit ${codes[1]}); removing the partial object" >&2
  wal-g st rm "${object}" >/dev/null 2>&1 || true
  exit 1
fi
echo "[uploads] archive complete"

UPLOADS_PHASE="uploads retention pruning"
mapfile -t archives < <(wal-g st ls uploads/ | awk '{print $NF}' | grep -E '^uploads_[0-9]{8}T[0-9]{6}Z\.tar$' | sort)
excess=$(( ${#archives[@]} - UPLOADS_RETENTION_COUNT ))
echo "[uploads] retention: keeping the newest ${UPLOADS_RETENTION_COUNT} archives (${#archives[@]} present)"
for (( i = 0; i < excess; i++ )); do
  wal-g st rm "uploads/${archives[i]}"
  echo "[uploads] deleted uploads/${archives[i]}"
done
echo "[uploads] done at $(date -u +%FT%TZ)"
