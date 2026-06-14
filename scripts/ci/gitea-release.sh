#!/usr/bin/env bash
# Gitea REST API release helpers, sourced by the publish job.
# Requires env: GITEA (base URL), REPO (owner/name), TOKEN.
set -euo pipefail
: "${GITEA:?}"; : "${REPO:?}"; : "${TOKEN:?}"
AUTH="Authorization: token ${TOKEN}"
API="${GITEA}/api/v1/repos/${REPO}"

# echo the release id for a tag, or empty string if none (404)
release_id_for_tag() {
  curl -fsS -H "$AUTH" "${API}/releases/tags/$1" 2>/dev/null | jq -r '.id // empty'
}

delete_release() { curl -fsS -X DELETE -H "$AUTH" "${API}/releases/$1" >/dev/null; }

delete_tag() { curl -fsS -X DELETE -H "$AUTH" "${API}/tags/$1" >/dev/null || true; }

# create_release <tag> <name> <prerelease:true|false> <target_sha> -> echoes new id
create_release() {
  curl -fsS -X POST -H "$AUTH" -H "Content-Type: application/json" "${API}/releases" \
    -d "$(jq -nc --arg t "$1" --arg n "$2" --argjson pre "$3" --arg c "$4" \
          '{tag_name:$t,name:$n,prerelease:$pre,target_commitish:$c,draft:false}')" \
    | jq -r '.id'
}

# upload_asset <release_id> <asset_name> <file_path>
upload_asset() {
  curl -fsS -X POST -H "$AUTH" \
    "${API}/releases/$1/assets?name=$(jq -rn --arg s "$2" '$s|@uri')" \
    -F "attachment=@$3" >/dev/null
  echo "uploaded: $2"
}

# ── Atomic channel publishing ────────────────────────────────────────────────
# The rolling channel pointers ("nightly", "stable") are updated IN PLACE rather
# than deleted-and-recreated. Deleting the release first left a minutes-long window
# where the channel's latest.json was missing and every client's update check 404'd
# (silent no-op). Now the release is reused, new binaries are uploaded, latest.json
# is swapped LAST (a ~1s window for that one asset), and stale assets are pruned
# afterwards — so the manifest is never missing or pointing at an absent asset.

# asset_id_by_name <release_id> <name> -> asset id, or empty
asset_id_by_name() {
  curl -fsS -H "$AUTH" "${API}/releases/$1/assets" 2>/dev/null \
    | jq -r --arg n "$2" 'map(select(.name==$n)) | .[0].id // empty'
}

# replace_asset <release_id> <name> <file> — delete any same-named asset, then upload.
replace_asset() {
  local aid; aid="$(asset_id_by_name "$1" "$2")"
  [ -n "$aid" ] && curl -fsS -X DELETE -H "$AUTH" "${API}/releases/$1/assets/$aid" >/dev/null || true
  upload_asset "$1" "$2" "$3"
}

# ensure_release <tag> <name> <prerelease> <sha> -> echoes id.
# Reuses the existing rolling release (refreshing name/prerelease) instead of
# deleting it; creates it only if absent. NOTE: a reused release keeps its original
# tag commit — cosmetic only (the updater reads latest.json, not the tag).
ensure_release() {
  local id; id="$(release_id_for_tag "$1")"
  if [ -n "$id" ]; then
    curl -fsS -X PATCH -H "$AUTH" -H "Content-Type: application/json" "${API}/releases/$id" \
      -d "$(jq -nc --arg n "$2" --argjson pre "$3" '{name:$n,prerelease:$pre}')" >/dev/null
    echo "$id"
  else
    create_release "$1" "$2" "$3" "$4"
  fi
}

# prune_channel_assets <release_id> <keep_version> — delete assets that are neither
# the current version's binaries nor latest.json. Run AFTER the latest.json swap so
# the live manifest never references a pruned asset.
prune_channel_assets() {
  local id="$1" ver="$2" ids aid
  ids="$(curl -fsS -H "$AUTH" "${API}/releases/$id/assets" 2>/dev/null \
    | jq -r --arg v "$ver" '.[] | select((.name|contains($v))|not) | select(.name!="latest.json") | .id')" || true
  for aid in $ids; do
    curl -fsS -X DELETE -H "$AUTH" "${API}/releases/$id/assets/$aid" >/dev/null || true
  done
}
