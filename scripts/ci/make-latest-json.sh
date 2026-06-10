#!/usr/bin/env bash
# Emit the Tauri v2 updater manifest (latest.json) to stdout.
# Windows-only for now; Linux users build from source. Add a linux-x86_64
# entry here when a Linux build job is added.
# Required env: VERSION, PUB_DATE, WIN_SIG_FILE, WIN_URL. Optional: NOTES.
set -euo pipefail
: "${VERSION:?}"; : "${PUB_DATE:?}"; : "${WIN_SIG_FILE:?}"; : "${WIN_URL:?}"
jq -nc \
  --arg v "$VERSION" --arg notes "${NOTES:-}" --arg date "$PUB_DATE" \
  --arg wsig "$(cat "$WIN_SIG_FILE")" --arg wurl "$WIN_URL" \
  '{version:$v, notes:$notes, pub_date:$date,
    platforms:{ "windows-x86_64":{signature:$wsig,url:$wurl} }}'
