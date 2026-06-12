#!/usr/bin/env bash
# Emit the Tauri v2 updater manifest (latest.json) to stdout.
# Required env: VERSION, PUB_DATE, WIN_SIG_FILE, WIN_URL, LIN_SIG_FILE, LIN_URL.
# Optional: NOTES.
set -euo pipefail
: "${VERSION:?}"; : "${PUB_DATE:?}"
: "${WIN_SIG_FILE:?}"; : "${WIN_URL:?}"
: "${LIN_SIG_FILE:?}"; : "${LIN_URL:?}"
jq -nc \
  --arg v "$VERSION" --arg notes "${NOTES:-}" --arg date "$PUB_DATE" \
  --arg wsig "$(cat "$WIN_SIG_FILE")" --arg wurl "$WIN_URL" \
  --arg lsig "$(cat "$LIN_SIG_FILE")" --arg lurl "$LIN_URL" \
  '{version:$v, notes:$notes, pub_date:$date,
    platforms:{ "windows-x86_64":{signature:$wsig,url:$wurl},
                "linux-x86_64":{signature:$lsig,url:$lurl} }}'
