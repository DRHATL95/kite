#!/usr/bin/env bash
# Provision the Xbox Remote CI runner (Proxmox LXC CT 106) from a fresh
# Ubuntu 22.04 root shell. Idempotent: safe to re-run. Run as root.
#
#   ./setup-ct106.sh                            # provision toolchain only
#   ./setup-ct106.sh --runner-token <TOKEN>     # also register the runner
#
# The runner and its rust toolchain run as the unprivileged user RUNNER_USER
# (not root). Source of truth for the runner's build deps.
# See scripts/runner/README.md.
set -euo pipefail

NODE_MAJOR=22
RUNNER_USER=ghrunner
RUNNER_DIR=/opt/actions-runner
GH_REPO_URL=https://github.com/DRHATL95/kite
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
  build-essential clang lld llvm nsis jq curl file git ca-certificates gnupg sudo \
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

echo "== runner user: ${RUNNER_USER} =="
id "${RUNNER_USER}" >/dev/null 2>&1 || useradd -m -s /bin/bash "${RUNNER_USER}"
RUNNER_HOME="$(getent passwd "${RUNNER_USER}" | cut -d: -f6)"

echo "== rust + cross-compile toolchain (as ${RUNNER_USER}) =="
sudo -u "${RUNNER_USER}" -H bash -lc '
  set -e
  if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  . "$HOME/.cargo/env"
  rustup target list --installed | grep -qx "x86_64-pc-windows-msvc" || rustup target add x86_64-pc-windows-msvc
  command -v cargo-tauri >/dev/null 2>&1 || cargo install tauri-cli --locked
  command -v cargo-xwin  >/dev/null 2>&1 || cargo install cargo-xwin --locked
  echo "rust: $(rustc --version)"
'
# NOTE: cargo-xwin downloads the MSVC SDK into the runner user's
# ~/.cache/cargo-xwin on the first cross-build; not pre-warmed here (keeps the
# provisioner project-independent).

echo "== GitHub Actions runner agent (as ${RUNNER_USER}) =="
mkdir -p "${RUNNER_DIR}"
if [ ! -e "${RUNNER_DIR}/.runner" ]; then
  if [ ! -x "${RUNNER_DIR}/config.sh" ]; then
    ( cd "${RUNNER_DIR}"
      REL="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
      VER="$(grep -m1 '"tag_name"' <<<"${REL}" | sed -E 's/.*"v([^"]+)".*/\1/')"
      curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
      tar xzf runner.tar.gz && rm -f runner.tar.gz
      ./bin/installdependencies.sh )
  fi
  printf '%s\n' "${RUNNER_HOME}/.cargo/bin:/sbin:/bin:/usr/sbin:/usr/bin" > "${RUNNER_DIR}/.path"
  : > "${RUNNER_DIR}/.env"
  chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}"
  if [ -n "${RUNNER_TOKEN}" ]; then
    sudo -u "${RUNNER_USER}" -H bash -lc "cd '${RUNNER_DIR}' && ./config.sh --unattended --replace --url '${GH_REPO_URL}' --token '${RUNNER_TOKEN}' --name ct106 --work _work"
    ( cd "${RUNNER_DIR}" && ./svc.sh install "${RUNNER_USER}" && ./svc.sh start )
    echo "runner registered + service started as ${RUNNER_USER}"
  else
    echo "runner agent downloaded but NOT registered (no --runner-token); see README"
  fi
else
  echo "runner already configured at ${RUNNER_DIR} — left untouched (see README to migrate an existing root runner to ${RUNNER_USER})"
fi

echo "== provisioning complete =="
