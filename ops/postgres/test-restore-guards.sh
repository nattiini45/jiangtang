#!/usr/bin/env bash
# In-image guard tests: exercise restore.sh's stub tests inside the built
# WAL-G/postgres image, so the checks run as the real `postgres` user with the
# real `chown` binary. `wal-g` is the only stub; there is no PostgreSQL server,
# S3 endpoint or network.
#
#   docker run --rm -v "$PWD/ops/postgres:/ops:ro" jiangtang-postgres-walg:local \
#     bash /ops/test-restore-guards.sh
#
# CI runs the same `docker run` command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE="$SCRIPT_DIR/restore.sh"
[ -f "$RESTORE" ] || { echo "FAIL: restore.sh not found at $RESTORE" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "FAIL: must run as root inside the image (real chown)" >&2; exit 1; }
id postgres >/dev/null 2>&1 || { echo "FAIL: postgres user is missing; run inside the image" >&2; exit 1; }

SANDBOX="$(mktemp -d /tmp/jiangtang-restore-guards.XXXXXX)"
# Traversable only (711): root keeps write access, while the real postgres user
# can enter its own case directories for the initdb parser check.
chmod 711 "$SANDBOX"
trap 'rm -rf "$SANDBOX"' EXIT
FAKE_BIN="$SANDBOX/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/wal-g" <<'STUB'
#!/usr/bin/env bash
# The ONLY stubbed executable. Logs its arguments, then simulates the two calls
# restore.sh makes on the latest-available path.
printf '%s\n' "$*" >> "$WAL_LOG"
case "${1:-}" in
  backup-list) exit 0 ;;
  backup-fetch)
    [ "${FAIL_FETCH:-0}" = "1" ] && exit 1
    mkdir -p "$2"
    echo 18 > "$2/PG_VERSION"
    exit 0
    ;;
esac
exit 1
STUB
chmod 755 "$FAKE_BIN/wal-g"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }

CASE_NO=0
case_root() {
  CASE_NO=$((CASE_NO + 1))
  CASE="$SANDBOX/case$CASE_NO"
  MOUNT="$CASE/mount"
  PGDATA_DIR="$MOUNT/18/docker"
  WAL_LOG="$CASE/wal.log"
  OUT="$CASE/out.log"
  mkdir -p "$MOUNT"
}

# run_restore confirm|no-confirm [ENV=value ...]
run_restore() {
  local confirm="$1"
  shift
  local args=(
    env -i
    "PATH=$FAKE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "HOME=/tmp"
    "WALG_S3_PREFIX=s3://synthetic/restore-guards"
    "AWS_ACCESS_KEY_ID=synthetic"
    "AWS_SECRET_ACCESS_KEY=synthetic"
    "PGDATA_MOUNT=$MOUNT"
    "PGDATA=$PGDATA_DIR"
    "WAL_LOG=$WAL_LOG"
    "FAIL_FETCH=${FAIL_FETCH:-0}"
  )
  if [ "$confirm" = "confirm" ]; then
    args+=("RESTORE_CONFIRM=empty-target")
  fi
  args+=("$@")
  set +e
  "${args[@]}" bash "$RESTORE" >"$OUT" 2>&1
  STATUS=$?
  set -e
}

no_wal_call() { [ ! -f "$WAL_LOG" ] || [ ! -s "$WAL_LOG" ]; }
check_refusal() {
  local name="$1"
  if [ "$STATUS" -eq 1 ] && no_wal_call; then
    pass "$name: refused before any storage call"
  else
    fail "$name: expected exit 1 and no wal-g call (status=$STATUS)"
  fi
}
check_message() {
  local name="$1" needle="$2"
  if grep -Fq "$needle" "$OUT"; then
    pass "$name: message names the reason"
  else
    fail "$name: missing message '$needle'"
  fi
}

# 1. Confirmation is required.
case_root
run_restore no
check_refusal "missing confirmation"

# 2. A populated destination is refused.
case_root
mkdir -p "$PGDATA_DIR"
printf 'keep\n' > "$PGDATA_DIR/existing"
run_restore confirm
check_refusal "populated destination"
[ -f "$PGDATA_DIR/existing" ] && pass "populated destination: bytes preserved" \
  || fail "populated destination: bytes were removed"

# 3. Dotfiles count as content.
case_root
mkdir -p "$PGDATA_DIR"
printf 'keep\n' > "$PGDATA_DIR/.hidden"
run_restore confirm
check_refusal "dotfile-only destination"
[ -f "$PGDATA_DIR/.hidden" ] && pass "dotfile-only destination: bytes preserved" \
  || fail "dotfile-only destination: bytes were removed"

# 4. Root-like, relative and outside paths are refused.
case_root
run_restore confirm "PGDATA=/"
check_refusal "filesystem root"
check_message "filesystem root" "filesystem root"

case_root
run_restore confirm "PGDATA=$MOUNT"
check_refusal "mount root"

case_root
run_restore confirm "PGDATA=relative/path"
check_refusal "relative path"

case_root
run_restore confirm "PGDATA=$CASE/outside"
check_refusal "outside mount root"

# 5. A symlinked destination is refused.
case_root
mkdir -p "$MOUNT/18" "$MOUNT/real"
ln -s "$MOUNT/real" "$PGDATA_DIR"
run_restore confirm
check_refusal "symlink destination"
check_message "symlink destination" "symbolic link"

# 6. A valid empty target succeeds, with real ownership and recovery config.
case_root
run_restore confirm
if [ "$STATUS" -eq 0 ]; then
  pass "empty target: restore succeeded"
else
  fail "empty target: expected exit 0 (status=$STATUS)"
fi
[ -f "$PGDATA_DIR/PG_VERSION" ] && pass "empty target: wal-g fetch ran" \
  || fail "empty target: fetch did not create the data files"
[ -f "$PGDATA_DIR/recovery.signal" ] && pass "empty target: recovery.signal written" \
  || fail "empty target: recovery.signal missing"
if grep -Fq "recovery_target_action = 'promote'" "$PGDATA_DIR/postgresql.auto.conf" 2>/dev/null; then
  pass "empty target: recovery config written"
else
  fail "empty target: recovery config missing"
fi
owner="$(stat -c '%U:%G' "$PGDATA_DIR" 2>/dev/null || true)"
mode="$(stat -c '%a' "$PGDATA_DIR" 2>/dev/null || true)"
[ "$owner" = "postgres:postgres" ] && pass "empty target: real chown applied ($owner)" \
  || fail "empty target: owner is '$owner', expected postgres:postgres"
[ "$mode" = "700" ] && pass "empty target: mode 700" \
  || fail "empty target: mode is '$mode', expected 700"

# 7. A failed fetch exits nonzero and leaves no recovery config.
case_root
FAIL_FETCH=1 run_restore confirm
if [ "$STATUS" -ne 0 ]; then
  pass "failed fetch: nonzero exit"
else
  fail "failed fetch: expected a nonzero exit"
fi
[ ! -f "$PGDATA_DIR/recovery.signal" ] && [ ! -f "$PGDATA_DIR/postgresql.auto.conf" ] \
  && pass "failed fetch: no recovery config" \
  || fail "failed fetch: recovery config was written"

# 8. The selector's normalized target must be accepted by a REAL PostgreSQL
#    config parser: PostgreSQL rejects the RFC3339 "Z" suffix in
#    recovery_target_time at server start, so the selector emits +00:00.
case_root
mkdir -p "$CASE/sel"
cat > "$CASE/sel/list.json" <<'JSON'
[{"backup_name":"base_000000010000000000000003","start_time":"2026-10-08T20:00:00Z","finish_time":"2026-10-08T20:05:00Z","is_permanent":false}]
JSON
cat > "$CASE/sel/sentinel.json" <<'JSON'
{"StartTime":"2026-10-08T20:00:00Z","FinishTime":"2026-10-08T20:05:00Z"}
JSON
if selection="$(python3 "$SCRIPT_DIR/select-backup.py" \
  base_000000010000000000000003 "2026-10-08T21:00:00Z" \
  "$CASE/sel/list.json" "$CASE/sel/sentinel.json")"; then
  normalized="$(printf '%s\n' "$selection" | sed -n '2p')"
  case "$normalized" in
    *+00:00) pass "selector target has a numeric UTC offset (+00:00)" ;;
    *) fail "selector target is '$normalized', expected a +00:00 suffix" ;;
  esac

  mkdir -p "$CASE/pg"
  chown postgres:postgres "$CASE/pg"
  if gosu postgres initdb -D "$CASE/pg/data" -A trust >/dev/null 2>&1; then
    printf "recovery_target_time = '%s'\n" "$normalized" >> "$CASE/pg/data/postgresql.conf"
    if gosu postgres postgres -D "$CASE/pg/data" -C recovery_target_time \
      >"$CASE/pg/value.out" 2>"$CASE/pg/value.err"; then
      pass "real PostgreSQL accepts the selector target at config parse"
    else
      fail "real PostgreSQL rejected the selector target: $(head -1 "$CASE/pg/value.err")"
    fi
  else
    fail "initdb failed; cannot verify the PostgreSQL parser"
  fi
else
  fail "selector failed on the synthetic fixture"
fi

printf '\nrestore guard tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
