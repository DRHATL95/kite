#!/usr/bin/env bash
# build-ffmpeg.sh — build the FFmpeg that Kite's Linux AppImage links and bundles.
#
# Why not the distro's FFmpeg:
#   - Its version depends on the build image (22.04 ships 4.4; ffmpeg-the-third 6 needs 5.1+).
#   - Distro FFmpeg is configured --enable-gpl. The AppImage bundles the libraries it
#     links, so that would put a GPL FFmpeg inside Kite's download.
# This build is LGPL (no --enable-gpl / --enable-nonfree / --enable-version3) and holds
# only what Kite uses: the H.264 decoder and parser, plus swscale. --disable-autodetect
# keeps every external library out.
#
# Usage (as root): build-ffmpeg.sh [prefix]     default prefix: /opt/kite-ffmpeg
# Used by the linux-appimage job in .github/workflows/release.yml.
# Idempotent: does nothing when the prefix already holds this version.
set -euo pipefail

VERSION=7.1.5
# Tarball verified 2026-11-16 against the FFmpeg release signing key
# FCF986EA15E6E293A5644F10B4322F04D67658D8 (ffmpeg-7.1.5.tar.xz.asc: good signature).
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
PREFIX="${1:-/opt/kite-ffmpeg}"

if [ "$(cat "$PREFIX/.kite-ffmpeg-version" 2>/dev/null)" = "$VERSION" ]; then
  echo "kite-ffmpeg $VERSION already at $PREFIX"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends build-essential nasm pkg-config curl xz-utils ca-certificates

work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT
cd "$work"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
echo "$SHA256  ffmpeg-$VERSION.tar.xz" | sha256sum -c -
tar -xf "ffmpeg-$VERSION.tar.xz"
cd "ffmpeg-$VERSION"

./configure \
  --prefix="$PREFIX" \
  --enable-shared --disable-static \
  --disable-programs --disable-doc --disable-debug \
  --disable-autodetect \
  --disable-everything \
  --enable-decoder=h264 --enable-parser=h264
# Fail closed if a later edit ever turns this into a GPL or nonfree build.
if grep -q -E -- '--enable-(gpl|nonfree|version3)' ffbuild/config.mak; then
  echo "refusing to build: configuration is not LGPL" >&2
  exit 1
fi
make -j"$(nproc)"
make install
echo "$VERSION" > "$PREFIX/.kite-ffmpeg-version"
echo "kite-ffmpeg $VERSION installed at $PREFIX"
