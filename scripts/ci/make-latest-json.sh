#!/usr/bin/env bash
# Emit the Tauri v2 updater manifest (latest.json) to stdout.
# Windows is always included; the Linux (AppImage) entry is added when both
# LINUX_SIG_FILE and LINUX_URL are set, so the same script serves a Windows-only
# build and a Windows+Linux build.
# Required env: VERSION, PUB_DATE, WIN_SIG_FILE, WIN_URL.
# Optional env: NOTES, LINUX_SIG_FILE, LINUX_URL.
set -euo pipefail
: "${VERSION:?}"; : "${PUB_DATE:?}"; : "${WIN_SIG_FILE:?}"; : "${WIN_URL:?}"

# Start with the Windows platform.
platforms="$(jq -nc \
  --arg wsig "$(cat "$WIN_SIG_FILE")" --arg wurl "$WIN_URL" \
  '{ "windows-x86_64": {signature:$wsig, url:$wurl} }')"

# Add Linux only when both inputs are present.
if [ -n "${LINUX_SIG_FILE:-}" ] && [ -n "${LINUX_URL:-}" ]; then
  platforms="$(jq -nc \
    --argjson p "$platforms" \
    --arg lsig "$(cat "$LINUX_SIG_FILE")" --arg lurl "$LINUX_URL" \
    '$p + { "linux-x86_64": {signature:$lsig, url:$lurl} }')"
fi

jq -nc \
  --arg v "$VERSION" --arg notes "${NOTES:-}" --arg date "$PUB_DATE" \
  --argjson platforms "$platforms" \
  '{version:$v, notes:$notes, pub_date:$date, platforms:$platforms}'
