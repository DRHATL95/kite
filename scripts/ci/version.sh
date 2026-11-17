#!/usr/bin/env bash
# version.sh — the release workflow's version + channel, as GITHUB_OUTPUT lines.
# Shared by both release jobs so the AppImage and the installer can never disagree.
# Reads GITHUB_REF, GITHUB_REF_NAME, GITHUB_RUN_NUMBER and ./Cargo.toml.
#   v* tag  -> stable   X.Y.Z
#   else    -> nightly  <Cargo.toml version>-nightly.<run number>
set -euo pipefail
if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
  VER="${GITHUB_REF_NAME#v}"
  printf 'version=%s\npointer_tag=stable\narchive_tag=v%s\nname=v%s\nprerelease=false\n' "$VER" "$VER" "$VER"
else
  TARGET="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
  VER="${TARGET}-nightly.${GITHUB_RUN_NUMBER}"
  printf 'version=%s\npointer_tag=nightly\narchive_tag=\nname=Nightly %s\nprerelease=true\n' "$VER" "$VER"
fi
