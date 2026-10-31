#!/usr/bin/env bash
# Volume restore — the destructive counterpart of
# restore-drill.sh: restores a WAL-G base backup INTO an empty pgdata and writes
# the recovery config, so that the postgres service replays all archived WAL —
# including commits made after the base backup — on its next start.
#
# Runs inside the profile-gated `restore` service (pgdata mounted READ-WRITE —
# the backup sidecar mounts it :ro, so restores cannot reuse that service):
#
#   docker compose stop postgres backup
#   RESTORE_CONFIRM=empty-target docker compose --profile restore run --rm --no-deps restore
#   docker compose start postgres          # replays archived WAL, then promotes
#
# `--no-deps` matters: a restore must never start PostgreSQL (or anything else)
# on its own. The destination must be missing or completely empty — dotfiles
# count as content. This script NEVER deletes an existing directory; clean the
# target yourself, deliberately, before running it.
#
# Without TARGET_TS the latest *available* base is fetched; that makes no
# replay-completeness claim. A time-targeted restore requires both
# TARGET_TS and a concrete BACKUP_NAME and is validated by select-backup.py
# before anything is written:
#
#   TARGET_TS="2026-10-08 21:00:00+00:00" BACKUP_NAME=base_<24 hex> \
#     RESTORE_CONFIRM=empty-target docker compose --profile restore run --rm --no-deps restore
#
# Requires the same WALG_*/AWS_* env the backup sidecar carries (compose
# already provides them).
set -euo pipefail

fatal() {
  echo "[restore] FATAL: $*" >&2
  exit 1
}

# Confirmation comes before any storage call, mkdir or directory inspection.
if [ "${RESTORE_CONFIRM:-}" != "empty-target" ]; then
  fatal "refusing to restore without RESTORE_CONFIRM=empty-target (an explicit confirmation that the destination was emptied deliberately)"
fi

# shellcheck source=wal-g/env.sh
source "$(dirname "$0")/wal-g/env.sh"

: "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set — refusing to restore from nowhere}"

PG_MOUNT_ROOT="${PGDATA_MOUNT:-/var/lib/postgresql}"
PG_MOUNT_ROOT="${PG_MOUNT_ROOT%/}"
: "${PGDATA:?PGDATA must be set to the configured absolute PostgreSQL data directory}"
PGDATA_DIR="${PGDATA}"

# The destination is exactly the configured data subdirectory: absolute,
# normalized, strictly below the mounted data root, and never a root itself.
case "$PGDATA_DIR" in
  /) fatal "refusing destination '/': the filesystem root is never a PostgreSQL data directory" ;;
  *//* | */./* | */../* | */. | */.. | */)
    fatal "refusing destination '$PGDATA_DIR': path must be normalized (no empty, '.' or '..' segments and no trailing slash)"
    ;;
  /*) : ;;
  *) fatal "refusing destination '$PGDATA_DIR': path must be absolute" ;;
esac
case "$PG_MOUNT_ROOT" in
  "" | /) fatal "refusing mount root '${PG_MOUNT_ROOT}': PGDATA_MOUNT must be an absolute directory, not the filesystem root" ;;
  /*) : ;;
  *) fatal "refusing mount root '$PG_MOUNT_ROOT': PGDATA_MOUNT must be absolute" ;;
esac
case "$PGDATA_DIR" in
  "$PG_MOUNT_ROOT"/*) : ;;
  *)
    fatal "refusing destination '$PGDATA_DIR': it must be a subdirectory of the configured mount root '$PG_MOUNT_ROOT'"
    ;;
esac

if [ -L "$PGDATA_DIR" ]; then
  fatal "refusing destination '$PGDATA_DIR': it is a symbolic link"
fi
if [ -e "$PGDATA_DIR" ] && [ ! -d "$PGDATA_DIR" ]; then
  fatal "refusing destination '$PGDATA_DIR': it exists and is not a directory"
fi
# Dotfiles count: -mindepth 1 finds every entry, including hidden ones.
if [ -d "$PGDATA_DIR" ] && [ -n "$(find "$PGDATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  fatal "refusing to overwrite non-empty destination '$PGDATA_DIR' (including dotfiles); empty it yourself after verifying it"
fi

mkdir -p "$PGDATA_DIR"

BACKUP_NAME="${BACKUP_NAME:-}"
TARGET_TS="${TARGET_TS:-}"

if [ -n "$TARGET_TS" ]; then
  if [ -z "$BACKUP_NAME" ]; then
    fatal "TARGET_TS requires a concrete BACKUP_NAME (LATEST is not accepted for a time-targeted restore)"
  fi
  if ! [[ "$BACKUP_NAME" =~ ^base_[0-9A-F]{24}$ ]]; then
    fatal "BACKUP_NAME must be a full backup name (base_ + 24 uppercase hex); LATEST, paths and incremental names are not accepted"
  fi

  META_DIR="$(mktemp -d)"
  chmod 700 "$META_DIR"
  cleanup() {
    rm -f "$META_DIR/backup-list.json" "$META_DIR/sentinel.json"
    rmdir "$META_DIR" 2>/dev/null || true
  }
  trap cleanup EXIT

  echo "[restore] validating ${BACKUP_NAME} against target ${TARGET_TS}"
  if ! wal-g backup-list --json --detail > "$META_DIR/backup-list.json"; then
    fatal "failed to read the backup list"
  fi
  if ! wal-g st cat "basebackups_005/${BACKUP_NAME}_backup_stop_sentinel.json" > "$META_DIR/sentinel.json"; then
    fatal "failed to read the sentinel for ${BACKUP_NAME}"
  fi
  # Plain command substitution inside `if !`: its exit status is preserved, so a
  # rejected selection can never be mistaken for a valid one.
  if ! selection="$(python3 "$(dirname "$0")/select-backup.py" "$BACKUP_NAME" "$TARGET_TS" "$META_DIR/backup-list.json" "$META_DIR/sentinel.json")"; then
    fatal "no full backup named ${BACKUP_NAME} is eligible for target ${TARGET_TS}"
  fi
  BACKUP_NAME="$(printf '%s\n' "$selection" | sed -n '1p')"
  TARGET_TS="$(printf '%s\n' "$selection" | sed -n '2p')"
  if ! [[ "$BACKUP_NAME" =~ ^base_[0-9A-F]{24}$ ]]; then
    fatal "the selector returned an unsafe backup name; refusing to use it as an object path"
  fi
  if [ -z "$TARGET_TS" ]; then
    fatal "the selector returned an empty target time"
  fi
  FETCH_SOURCE="$BACKUP_NAME"
  echo "[restore] selected ${BACKUP_NAME}, target ${TARGET_TS}"
else
  if [ -n "$BACKUP_NAME" ]; then
    fatal "BACKUP_NAME requires TARGET_TS: an exact backup is fetched only after validation against a target"
  fi
  echo "[restore] fetching the latest-available backup list (no TARGET_TS; no replay-completeness claim)"
  wal-g backup-list
  FETCH_SOURCE="LATEST"
fi

echo "[restore] restoring ${FETCH_SOURCE} into ${PGDATA_DIR}"
wal-g backup-fetch "${PGDATA_DIR}" "${FETCH_SOURCE}"

# Replay every archived WAL segment (covers commits after the base backup),
# then promote. With TARGET_TS set, replay stops at that timestamp instead.
cat >> "${PGDATA_DIR}/postgresql.auto.conf" <<EOF
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_action = 'promote'
$(if [ -n "${TARGET_TS:-}" ]; then echo "recovery_target_time = '${TARGET_TS}'"; fi)
EOF
touch "${PGDATA_DIR}/recovery.signal"

# backup-fetch ran as root; the postgres container runs as uid 999.
chown -R postgres:postgres "${PGDATA_DIR}"
chmod 700 "${PGDATA_DIR}"

echo "[restore] done — start the postgres service; it will replay WAL and promote."
echo "[restore] afterwards verify with ops/postgres/verify-invariants.sql"
