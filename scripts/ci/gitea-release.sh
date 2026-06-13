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

delete_release() { curl -fsS -X DELETE -H "$AUTH" "${API}/releases/$1"; }

delete_tag() { curl -fsS -X DELETE -H "$AUTH" "${API}/tags/$1" || true; }

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

# roll_channel <tag> <name> <prerelease> <sha> — delete old release+tag, recreate; echoes new id.
# Used for the rolling channel pointers ("nightly", "stable"). Gitea API quirk:
# deleting a release does NOT delete its tag, and re-creating a tag does NOT update
# an existing release — both must be deleted before recreating.
roll_channel() {
  local id; id="$(release_id_for_tag "$1")"
  [ -n "$id" ] && delete_release "$id" || true
  delete_tag "$1"
  create_release "$1" "$2" "$3" "$4"
}
