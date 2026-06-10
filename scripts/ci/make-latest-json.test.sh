#!/usr/bin/env bash
# Unit test for make-latest-json.sh (run: bash scripts/ci/make-latest-json.test.sh)
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
printf 'WINSIG' > "$tmp/win.sig"
out="$(VERSION=0.1.42 NOTES='n' PUB_DATE=2026-06-09T00:00:00Z \
  WIN_SIG_FILE="$tmp/win.sig" WIN_URL='https://h/win.exe' \
  ./make-latest-json.sh)"
echo "$out" | jq -e '.version=="0.1.42"' >/dev/null
echo "$out" | jq -e '.pub_date=="2026-06-09T00:00:00Z"' >/dev/null
echo "$out" | jq -e '.platforms["windows-x86_64"].signature=="WINSIG"' >/dev/null
echo "$out" | jq -e '.platforms["windows-x86_64"].url=="https://h/win.exe"' >/dev/null
echo "$out" | jq -e '(.platforms|keys|length)==1' >/dev/null
echo "PASS"
