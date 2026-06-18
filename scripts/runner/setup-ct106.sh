#!/usr/bin/env bash
# Provision the Xbox Remote CI runner (Proxmox LXC CT 106) from a fresh
# Ubuntu 22.04 root shell. Idempotent: safe to re-run. Run as root.
#
#   ./setup-ct106.sh                            # provision toolchain only
#   ./setup-ct106.sh --runner-token <TOKEN>     # also register the runner
#
# This is the source of truth for the runner's build deps.
# See scripts/runner/README.md for the registration token + full flow.
set -euo pipefail

NODE_MAJOR=22
RUST_TARGET=x86_64-pc-windows-msvc
RUNNER_DIR=/opt/actions-runner
GH_REPO_URL=https://github.com/DRHATL95/xbox-remote
RUNNER_TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --runner-token) RUNNER_TOKEN="${2:?--runner-token needs a value}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== apt base deps =="
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential clang lld llvm nsis jq curl file git ca-certificates gnupg \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libfuse2

echo "== node ${NODE_MAJOR} =="
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
corepack enable
echo "node: $(node --version)"

echo "== gh (GitHub CLI) =="
if ! command -v gh >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y gh
fi
echo "gh: $(gh --version | head -1)"

echo "== rust + cross-compile toolchain =="
if [ ! -x "${HOME}/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
. "${HOME}/.cargo/env"
rustup target list --installed | grep -qx "${RUST_TARGET}" || rustup target add "${RUST_TARGET}"
command -v cargo-tauri >/dev/null 2>&1 || cargo install tauri-cli --locked
command -v cargo-xwin  >/dev/null 2>&1 || cargo install cargo-xwin --locked
echo "rust: $(rustc --version)"
# NOTE: cargo-xwin downloads the MSVC SDK into ~/.cache/cargo-xwin on the first
# cross-build (the CI 'Tauri cross-build' step). That first build is slower; it
# is not pre-warmed here to keep the provisioner project-independent.

echo "== GitHub Actions runner agent =="
if [ ! -e "${RUNNER_DIR}/.runner" ]; then
  mkdir -p "${RUNNER_DIR}"; cd "${RUNNER_DIR}"
  if [ ! -x ./config.sh ]; then
    REL="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
    VER="$(grep -m1 '"tag_name"' <<<"${REL}" | sed -E 's/.*"v([^"]+)".*/\1/')"
    curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
    tar xzf runner.tar.gz && rm -f runner.tar.gz
    ./bin/installdependencies.sh
  fi
  printf '%s\n' "/root/.cargo/bin:/sbin:/bin:/usr/sbin:/usr/bin" > .path
  printf '%s\n' "RUNNER_ALLOW_RUNASROOT=1" > .env
  if [ -n "${RUNNER_TOKEN}" ]; then
    RUNNER_ALLOW_RUNASROOT=1 ./config.sh --unattended --replace \
      --url "${GH_REPO_URL}" --token "${RUNNER_TOKEN}" --name ct106 --work _work
    ./svc.sh install root
    ./svc.sh start
    echo "runner registered + service started"
  else
    echo "runner agent downloaded but NOT registered (no --runner-token); see README"
  fi
else
  echo "runner already configured at ${RUNNER_DIR} — left untouched"
fi

echo "== provisioning complete =="
