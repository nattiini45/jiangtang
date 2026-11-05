#!/usr/bin/env bash
# Backup and WAL-archive alerts. The backup sidecar writes one status file per
# failing check into the shared backup-status volume (ops/postgres/backup.sh,
# ops/postgres/check-wal-archive.sh); this script runs every minute in the
# alerting sidecar, next to healthcheck-alert.sh, and posts to ALERT_WEBHOOK:
#
# - a failure when it first appears or the first line of its message changes,
#   and again every REALERT_SECONDS while it persists (the lines below the first
#   carry counters and times that change on every check);
# - a recovery once it clears;
# - a stale-backup failure when the last successful base backup (backup.ok) is
#   older than BACKUP_MAX_AGE_SECONDS, which also catches a backup loop that
#   stopped running. Nothing is reported before the first backup has run.
#
# What was last posted is kept in ALERT_STATE_DIR, so a restart of this sidecar
# at most repeats an alert once. A post the webhook rejects is retried on the
# next poll.
set -euo pipefail

ALERT_WEBHOOK="${ALERT_WEBHOOK:?ALERT_WEBHOOK must be set (Mattermost/Slack/Teams incoming URL)}"
STATUS_DIR="${BACKUP_STATUS_DIR:-/backup-status}"
STATE_DIR="${ALERT_STATE_DIR:-/tmp/backup-alert-state}"
REALERT_SECONDS="${REALERT_SECONDS:-21600}"
# 36 hours: one daily backup plus room for a slow run; a missed day still shows
# within half a day.
BACKUP_MAX_AGE_SECONDS="${BACKUP_MAX_AGE_SECONDS:-129600}"

# shellcheck source=webhook.sh
source "$(dirname "$0")/webhook.sh"

mkdir -p "${STATE_DIR}"
now="$(date +%s)"

# Message for one check, empty when it is healthy.
current_message() {
  case "$1" in
    backup-stale)
      local ok="${STATUS_DIR}/backup.ok"
      [ -f "${ok}" ] || return 0
      local age=$(( now - $(stat -c %Y "${ok}") ))
      if [ "${age}" -ge "${BACKUP_MAX_AGE_SECONDS}" ]; then
        printf 'Jiangtang: No successful base backup since %s. Details: docker compose logs backup' \
          "$(head -n 1 "${ok}")"
      fi
      ;;
    *)
      local file="${STATUS_DIR}/$1.failed"
      [ -f "${file}" ] && cat "${file}"
      ;;
  esac
  return 0
}

recovered_message() {
  case "$1" in
    backup) echo "Jiangtang base backup recovered: the latest run succeeded." ;;
    backup-stale) echo "Jiangtang base backups recovered: a recent backup succeeded." ;;
    wal-archive) echo "Jiangtang WAL archiving recovered." ;;
  esac
}

for check in backup backup-stale wal-archive; do
  state="${STATE_DIR}/${check}"
  message="$(current_message "${check}")"
  if [ -n "${message}" ]; then
    if [ -f "${state}" ] && [ "$(head -n 1 "${state}")" = "$(printf '%s\n' "${message}" | head -n 1)" ] \
      && [ $(( now - $(stat -c %Y "${state}") )) -lt "${REALERT_SECONDS}" ]; then
      continue
    fi
    if post_alert "${message}"; then
      printf '%s' "${message}" > "${state}"
      echo "[backup-alert] ${check}: paged via webhook" >&2
    else
      echo "[backup-alert] ${check}: webhook post failed; retrying next poll" >&2
    fi
  elif [ -f "${state}" ]; then
    if post_alert "$(recovered_message "${check}")"; then
      rm -f "${state}"
      echo "[backup-alert] ${check}: recovered" >&2
    fi
  fi
done
