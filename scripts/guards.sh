#!/usr/bin/env bash
# Anti-collision / golden-rule guards. Run in CI and locally.
set -uo pipefail
fail=0

# 1) No direct `@prisma/client` imports in app code — use ~/generated/prisma/client.
#    (The generated client itself imports @prisma/client/runtime; that's allowed.)
hits=$(grep -rnE "from ['\"]@prisma/client['\"]" app --include='*.ts' --include='*.tsx' 2>/dev/null \
        | grep -v '^app/generated/' || true)
if [ -n "$hits" ]; then
  echo "::error:: Direct '@prisma/client' import is banned. Import from ~/generated/prisma/client."
  echo "$hits"
  fail=1
fi

# 2) No raw db.$transaction in app/domains — mutations must go through txWithAudit().
hits=$(grep -rnE 'db\.\$transaction' app/domains --include='*.ts' --include='*.tsx' 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "::error:: Raw 'db.\$transaction' in app/domains is banned. Use txWithAudit()."
  echo "$hits"
  fail=1
fi

# 3) No `session_replication_role` outside the audit-privacy migration — this is
#    the audit-bypass knob. The sanctioned bypass is the `jiangtang.audit_bypass`
#    GUC, set only by 20261023000300_audit_privacy. A reference anywhere in app/
#    or scripts/ is a red flag (it would let application code silently disable
#    the audit-immutability trigger).
#    (guards.sh itself names the knob; __tests__ assert it is REJECTED — both excluded.)
hits=$(grep -rnE 'session_replication_role' app scripts --include='*.ts' --include='*.tsx' --include='*.sh' 2>/dev/null \
        | grep -v 'scripts/guards.sh' | grep -v '__tests__' || true)
if [ -n "$hits" ]; then
  echo "::error:: 'session_replication_role' is banned outside 20261023000300_audit_privacy (audit-bypass knob)."
  echo "$hits"
  fail=1
fi

# 4) No committed migration may drop the `during` column.
#
#    `during` is the generated tstzrange column that BOTH no-double-booking
#    EXCLUDE constraints sit on. Prisma cannot express a generated column, so it
#    is absent from the schema and `prisma migrate dev` re-proposes
#    `ALTER TABLE ... DROP COLUMN "during"` on every single run. Postgres drops
#    the constraint WITH the column and the statement SUCCEEDS: psql exit 0, no
#    warning, and no mention of `event_room_no_overlap` /
#    `equipment_alloc_no_overlap`. The filter is a one-time hand edit; this is
#    what stops the next one from shipping the invariant's destruction.
#
#    Scanned through a SQL-comment stripper on purpose. A migration comment may
#    discuss or quote the statement by name, and that documentation is the most
#    valuable text in the file: a guard that matched raw bytes would ban the
#    warning and force its removal, which is the tail wagging the dog. Only
#    EXECUTABLE SQL is scanned. The shipped baseline carries the executable drop
#    nowhere; `--self-test` fabricates the comment-quoting case as its fixture.
strip_sql_comments() {
  # Removes /* ... */ (multi-line), -- ... (to EOL), and preserves single-quoted
  # literals, so a '...' containing -- or /* cannot corrupt the scan.
  #
  # The delimiter characters are built with sprintf("%c", n) rather than written
  # as literals, for a measured reason: gawk honours /* */ as a comment even
  # inside what looks like a string context, and an awk program that compares
  # against a literal delimiter is one refactor away from being silently eaten.
  awk '
    BEGIN {
      SL = sprintf("%c", 47)   # /
      ST = sprintf("%c", 42)   # *
      DASH = sprintf("%c", 45) # -
      SQ = sprintf("%c", 39)   # '"'"'
      OPEN = SL ST
      CLOSE = ST SL
    }
    {
      line = $0
      if (inblock) {
        j = index(line, CLOSE)
        if (j == 0) next
        line = substr(line, j + 2); inblock = 0
      }
      out = ""; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1); two = substr(line, i, 2)
        if (c == DASH && two == DASH DASH) break
        if (c == SL && two == OPEN) {
          j = index(substr(line, i + 2), CLOSE)
          if (j == 0) { inblock = 1; i = n + 1 } else { i = i + 2 + j + 1 }
          continue
        }
        if (c == SQ) {
          out = out c; i++
          while (i <= n) {
            cc = substr(line, i, 1)
            out = out cc
            if (cc == SQ) {
              if (substr(line, i + 1, 1) == SQ) { out = out SQ; i = i + 2; continue }
              i++; break
            }
            i++
          }
          continue
        }
        out = out c; i++
      }
      print out
    }
  '
}

# Echoes every migration.sql under $1 whose EXECUTABLE sql drops "during".
scan_for_during_drop() {
  local root="$1" f
  for f in "$root"/*/migration.sql; do
    [ -f "$f" ] || continue
    if strip_sql_comments < "$f" | grep -qiE 'DROP[[:space:]]+COLUMN[[:space:]]+"during"'; then
      echo "$f"
    fi
  done
}

# Negative control. Without it, check 4 is a comment: nobody has yet watched this
# guard go red. Run it — it is cheap, and it is the only evidence the check can look.
#   bash scripts/guards.sh --self-test
if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  # The real layout is <root>/<migration-name>/migration.sql; the fixtures must
  # match it, or the glob matches nothing and every case passes vacuously —
  # which is exactly what happened the first time this was run.
  mkdir -p "$tmp/quoted/20260101_quoted" "$tmp/executable/20260101_executable" "$tmp/lowercase/20260101_lowercase"
  # A) a comment that NAMES the drop must NOT fire — the case a raw grep would
  #    get wrong.
  printf '%s\n' \
    '/*' \
    '  Deleted statements preserve, by name:' \
    '    ALTER TABLE "EventRoomBooking" DROP COLUMN "during";' \
    '*/' \
    'CREATE TABLE "ok" ("id" TEXT);' > "$tmp/quoted/20260101_quoted/migration.sql"
  # B) an executable drop MUST fire, and must be named.
  printf '%s\n' 'ALTER TABLE "EventRoomBooking" DROP COLUMN "during";' > "$tmp/executable/20260101_executable/migration.sql"
  # C) SQL keywords are case-insensitive, so a hand-written lowercase drop still fires.
  printf '%s\n' 'alter table "EquipmentAllocation" drop column "during" ;' > "$tmp/lowercase/20260101_lowercase/migration.sql"

  a=$(scan_for_during_drop "$tmp/quoted")
  if [ -n "$a" ]; then
    echo "guards self-test FAILED: a comment quoting the drop must not fire"; echo "$a"; exit 1
  fi
  b=$(scan_for_during_drop "$tmp/executable")
  if [ -z "$b" ] || [ "$(echo "$b" | grep -c 'executable/migration.sql')" -ne 1 ]; then
    echo "guards self-test FAILED: an executable drop was not detected by name"; echo "[$b]"; exit 1
  fi
  c=$(scan_for_during_drop "$tmp/lowercase")
  if [ -z "$c" ]; then
    echo "guards self-test FAILED: a lowercase drop was not detected"; exit 1
  fi
  echo "guards: self-test OK (comment-quoted ignored, executable detected, mixed-case detected)"
  exit 0
fi

hits=$(scan_for_during_drop prisma/migrations)
if [ -n "$hits" ]; then
  echo "::error:: A committed migration drops the 'during' column. That column carries both no-double-booking EXCLUDE constraints (event_room_no_overlap, equipment_alloc_no_overlap); Postgres drops the constraint with it, silently. Delete the statement and keep the explanatory comment."
  echo "$hits"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "guards: OK"; fi
exit $fail
