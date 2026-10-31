#!/usr/bin/env bash
# Minimal healthcheck → alert hook. Polls the
# app's /healthz; on a non-200 (or a DB-down payload), pages via a webhook
# (Coolify's, or a generic Slack/Teams incoming webhook URL in ALERT_WEBHOOK).
#
# Run as a sidecar cron. Tuned to be deliberately simple: the goal is "someone
# notices when the app is down," not a full metrics pipeline.
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://app:3000/healthz}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:?ALERT_WEBHOOK must be set (Coolify/Slack/Teams incoming URL)}"
TIMEOUT="${TIMEOUT:-5}"

# JSON-escape a string for safe embedding in a double-quoted JSON value. The
# healthz body is untrusted: a raw " or \ or newline would break the payload
# JSON (or inject a field), and because the send below is best-effort (|| true)
# a malformed request is silently rejected by the webhook — dropping the page
# exactly when the app is unhealthy. Pure bash keeps this last-line-of-defense
# free of any dependency beyond bash+curl.
#
# Built char-by-char appending single-quoted literals, NOT via `${s//pat/repl}`:
# bash processes backslashes in a substitution's replacement text, and does so
# differently across versions (the 5.2 change), so `${s//\\/\\\\}` silently
# emits the wrong bytes on some shells. Literal appends are version-stable.
json_escape() {
  local s="$1" out="" i c code hex
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      '\')   out+='\\' ;;   # \  -> \\
      '"')   out+='\"' ;;   # "  -> \"
      $'\n') out+='\n' ;;   # LF -> \n
      $'\r') out+='\r' ;;   # CR -> \r
      $'\t') out+='\t' ;;   # TAB -> \t
      *)
        # RFC 8259 requires escaping ALL C0 controls (U+0000–U+001F), not just
        # the five above. Emit the remaining ones as \u00XX. NUL can't occur (a
        # bash string can't hold it). Gate on the numeric value (< 0x20), not
        # [[:cntrl:]]: that class is locale-dependent and would also catch DEL
        # (0x7F, legal unescaped) and misread multibyte UTF-8 — whereas any
        # UTF-8 lead/continuation byte is >= 0x80, so it stays verbatim here.
        printf -v code '%d' "'${c}"
        if [ "${code}" -lt 32 ]; then
          printf -v hex '%02x' "${code}"
          out+="\\u00${hex}"
        else
          out+="$c"
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

status=$(curl -s -o /tmp/healthz-body -w "%{http_code}" --max-time "${TIMEOUT}" "${HEALTH_URL}" || echo "000")
if [ "${status}" != "200" ]; then
  body="$(cat /tmp/healthz-body 2>/dev/null || echo 'no body')"
  text="$(printf 'Jiangtang healthcheck FAILED (HTTP %s): %s' "${status}" "${body}")"
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\": \"$(json_escape "${text}")\"}" "${ALERT_WEBHOOK}" || true
  echo "[alert] healthcheck failed (${status}); paged via webhook" >&2
  exit 1
fi
echo "[alert] ok"
