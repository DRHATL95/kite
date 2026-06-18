#!/usr/bin/env bash
# GitHub release helpers (gh CLI), sourced by the publish step. Publishes
# CROSS-REPO to the public releases repo so the updater can read assets
# anonymously while the code repo stays private.
# Requires env: RELEASES_REPO (owner/name), GH_TOKEN (PAT with contents:write
# on RELEASES_REPO). gh + jq are preinstalled on the runner.
set -euo pipefail
: "${RELEASES_REPO:?}"; : "${GH_TOKEN:?}"

# ensure_release <tag> <name> <prerelease:true|false> <notes_file>
# Reuse the rolling release if present (refresh title/notes/prerelease); create if absent.
# Rolling tags ("nightly"/"stable") are created at the releases repo's default HEAD;
# the tag commit is cosmetic (the updater reads latest.json, not the tag).
# Notes are always refreshed from <notes_file> — without it the body stays frozen at
# the text from the release's first-ever run (e.g. nightly body stuck on an old
# version while the title advances).
ensure_release() {
  local tag="$1" name="$2" pre="$3" notes_file="$4"
  if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    gh release edit "$tag" --repo "$RELEASES_REPO" \
      --title "$name" --notes-file "$notes_file" --prerelease="$pre" >/dev/null
  else
    local flag=""; [ "$pre" = "true" ] && flag="--prerelease"
    gh release create "$tag" --repo "$RELEASES_REPO" \
      --title "$name" --notes-file "$notes_file" $flag >/dev/null
  fi
  echo "ensured release: $tag"
}

# replace_asset <tag> <file> — upload, clobbering any same-named asset.
# --clobber deletes-then-uploads, giving the atomic "swap latest.json last" guarantee.
replace_asset() {
  gh release upload "$1" "$2" --repo "$RELEASES_REPO" --clobber >/dev/null
  echo "uploaded: $(basename "$2")"
}

# prune_channel_assets <tag> <keep_version> — delete assets that are neither the
# current version's binaries nor latest.json. Run AFTER the latest.json swap.
prune_channel_assets() {
  local tag="$1" ver="$2" name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    case "$name" in
      *"$ver"*)    ;;  # keep current-version binaries
      latest.json) ;;  # keep the manifest
      *) gh release delete-asset "$tag" "$name" --repo "$RELEASES_REPO" -y >/dev/null || true
         echo "pruned: $name" ;;
    esac
  done < <(gh release view "$tag" --repo "$RELEASES_REPO" --json assets -q '.assets[].name')
}

# create_archive_release <tag> <name> <notes_file> — permanent vX.Y.Z (fails if it
# already exists; stable tags are cut once).
create_archive_release() {
  gh release create "$1" --repo "$RELEASES_REPO" --title "$2" --notes-file "$3" >/dev/null
  echo "created archive release: $1"
}
