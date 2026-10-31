#!/usr/bin/env bash
# Monthly restore smoke check — the honest version of the old drill.
#
# It restores a base backup (plus archived WAL) into a uniquely created private
# temp root, starts a THROWAWAY PostgreSQL as the `postgres` user on a loopback
# port, waits for recovery to finish, runs verify-invariants.sql and prints
# diagnostic row counts. Then it stops only the server it started and removes
# only its own temp root.
#
# This is a SMOKE CHECK. It does not prove source-data equality, and it does not
# prove that a selected time was reached. Missing later WAL can still produce a
# consistent, queryable promotion.
#
# Usage (from the backup sidecar image, with WAL-G credentials in the env):
#   ops/postgres/restore-drill.sh                                  # latest available
#   TARGET_TS="2026-10-08 21:00:00+00:00" BACKUP_NAME=base_<24 hex> \
#     ops/postgres/restore-drill.sh                                # validated PITR
#
# Requires: WALG_S3_PREFIX + AWS_* (restore), PGDATABASE, PGUSER, PGPASSWORD.
set -euo pipefail

TARGET_TS="${TARGET_TS:-}"
BACKUP_NAME="${BACKUP_NAME:-}"
DRILL_PORT="${DRILL_PORT:-5433}"

fatal() {
  echo "[drill] FATAL: $*" >&2
  exit 1
}

# --- fail before creating anything -----------------------------------------
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set for a restore drill — refusing a no-op drill that could falsely report PASS}"
: "${PGDATABASE:?PGDATABASE must be set explicitly for a restore drill (no default database)}"
: "${PGUSER:?PGUSER must be set explicitly for a restore drill}"
: "${PGPASSWORD:?PGPASSWORD must be set explicitly for a restore drill}"

if [ -n "$TARGET_TS" ] && [ -z "$BACKUP_NAME" ]; then
  fatal "a targeted drill requires BACKUP_NAME (the validated full base for TARGET_TS)"
fi
if [ -z "$TARGET_TS" ] && [ -n "$BACKUP_NAME" ]; then
  fatal "BACKUP_NAME requires TARGET_TS"
fi
case "$DRILL_PORT" in
  "" | *[!0-9]*) fatal "DRILL_PORT must be numeric, got '$DRILL_PORT'" ;;
esac
if [ "$DRILL_PORT" -lt 1 ] || [ "$DRILL_PORT" -gt 65535 ]; then
  fatal "DRILL_PORT must be between 1 and 65535, got '$DRILL_PORT'"
fi

# A missing executable is a blocker, never permission to weaken the check.
for tool in gosu pg_ctl pg_isready psql; do
  command -v "$tool" >/dev/null 2>&1 || fatal "required executable '$tool' is missing from this image"
done
id postgres >/dev/null 2>&1 || fatal "the postgres system user is missing from this image"

# Refuse to attach to (or race) another server on the drill port.
if pg_isready -h 127.0.0.1 -p "$DRILL_PORT" -q; then
  fatal "port ${DRILL_PORT} is already serving PostgreSQL — refusing to attach to another server"
fi

# --- unique private root; cleanup installed immediately --------------------
TMP_BASE="${TMPDIR:-/tmp}"
DRILL_ROOT="$(mktemp -d "${TMP_BASE%/}/jiangtang-restore-drill.XXXXXX")"
chmod 700 "$DRILL_ROOT"
chown postgres:postgres "$DRILL_ROOT"
DRILL_PGDATA="$DRILL_ROOT/18/docker"
DRILL_SOCKET_DIR="$DRILL_ROOT/socket"
DRILL_STARTED=0

cleanup() {
  status=$?
  trap - EXIT
  if [ "$DRILL_STARTED" = "1" ]; then
    echo "[drill] stopping the drill's own server"
    gosu postgres pg_ctl -D "$DRILL_PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  case "$DRILL_ROOT" in
    "${TMP_BASE%/}"/jiangtang-restore-drill.*)
      rm -rf -- "$DRILL_ROOT"
      ;;
    *)
      echo "[drill] refusing to remove unexpected temp root '$DRILL_ROOT'" >&2
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$DRILL_SOCKET_DIR"
chown postgres:postgres "$DRILL_SOCKET_DIR"

# --- restore through the guarded restore.sh (one recovery branch) ----------
echo "[drill] restoring into a private empty root (target: ${TARGET_TS:-latest available})"
PGDATA_MOUNT="$DRILL_ROOT" \
PGDATA="$DRILL_PGDATA" \
RESTORE_CONFIRM=empty-target \
TARGET_TS="$TARGET_TS" \
BACKUP_NAME="$BACKUP_NAME" \
  bash "$(dirname "$0")/restore.sh"

# The restored instance must never archive.
printf '\narchive_mode = off\n' >> "$DRILL_PGDATA/postgresql.auto.conf"

# --- start as postgres, loopback-only, own socket dir ----------------------
echo "[drill] starting the restored instance as postgres on 127.0.0.1:${DRILL_PORT}"
DRILL_STARTED=1
gosu postgres pg_ctl -D "$DRILL_PGDATA" -w \
  -o "-p ${DRILL_PORT} -k ${DRILL_SOCKET_DIR} -c listen_addresses=127.0.0.1 -c archive_mode=off" \
  start

echo "[drill] waiting for recovery to complete"
recovered=0
for _ in $(seq 1 120); do
  state="$(
    PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -p "$DRILL_PORT" -U "$PGUSER" -d "$PGDATABASE" \
      -Atqc "SELECT pg_is_in_recovery()" 2>/dev/null || true
  )"
  if [ "$state" = "f" ]; then
    recovered=1
    break
  fi
  sleep 1
done
if [ "$recovered" != "1" ]; then
  fatal "restored server did not finish recovery within 120s"
fi

# --- query + invariants ----------------------------------------------------
echo "[drill] running verify-invariants.sql"
PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -p "$DRILL_PORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 -f "$(dirname "$0")/verify-invariants.sql"

echo "[drill] diagnostic row counts (NOT compared to the live database):"
PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -p "$DRILL_PORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'Room' AS "table", count(*) FROM "Room"
UNION ALL SELECT 'Equipment', count(*) FROM "Equipment"
UNION ALL SELECT 'Ticket', count(*) FROM "Ticket"
UNION ALL SELECT 'Event', count(*) FROM "Event"
UNION ALL SELECT 'ActivityLog', count(*) FROM "ActivityLog";
SQL

echo "[drill] PASS — restore/query/invariant smoke check passed"
echo "[drill] LIMIT: this proves the backup is restorable, queryable and invariant-clean."
echo "[drill] It does NOT prove source-data equality or that a selected time was reached."
