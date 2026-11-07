#!/usr/bin/env bash
# Minimal healthcheck → alert hook. Polls the
# app's /healthz; on a non-200 (or a DB-down payload), pages via a webhook
# (a Mattermost, Slack or Teams incoming webhook URL in ALERT_WEBHOOK).
#
# Run as a sidecar cron. Tuned to be deliberately simple: the goal is "someone
# notices when the app is down," not a full metrics pipeline.
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://app:3000/healthz}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:?ALERT_WEBHOOK must be set (Mattermost/Slack/Teams incoming URL)}"
TIMEOUT="${TIMEOUT:-5}"

# post_alert (bounded by TIMEOUT, so a stalled webhook cannot hold up the
# alerting loop) lives in webhook.sh, shared with backup-alert.sh.
# shellcheck source=webhook.sh
source "$(dirname "$0")/webhook.sh"

status=$(curl -s -o /tmp/healthz-body -w "%{http_code}" --max-time "${TIMEOUT}" "${HEALTH_URL}" || echo "000")
if [ "${status}" != "200" ]; then
  body="$(cat /tmp/healthz-body 2>/dev/null || echo 'no body')"
  text="$(printf 'Jiangtang healthcheck FAILED (HTTP %s): %s' "${status}" "${body}")"
  if post_alert "${text}"; then
    echo "[alert] healthcheck failed (${status}); paged via webhook" >&2
  else
    echo "[alert] healthcheck failed (${status}); webhook post failed" >&2
  fi
  exit 1
fi
echo "[alert] ok"
