# Non-root CI Runner (CT 106) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the GitHub Actions runner on CT 106 as an unprivileged `ghrunner` user with a per-user Rust toolchain, instead of root.

**Architecture:** `setup-ct106.sh` is refactored to create `ghrunner`, install Rust under its home, and run the runner as it. The *existing* CT 106 runner (root-configured) is then migrated live: stop/uninstall the root service, chown the runner dir to `ghrunner`, reinstall the service as `ghrunner` (reusing the registration — no re-token needed).

**Tech Stack:** bash, Ubuntu 22.04 / Proxmox LXC, rustup (per-user), GitHub Actions runner, systemd.

**Note on testing:** Infra — verification is `bash -n` on the script, the live migration result (`systemctl` shows `User=ghrunner`), and a green nightly built as `ghrunner`.

**Access to CT 106:** `ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232`, then `pct exec 106 -- …`.

**Reference:** spec at `docs/superpowers/specs/2026-06-17-nonroot-runner-design.md`.

---

## File Structure

**New**
- `.gitattributes` — force LF on `*.sh` (the runner script runs on Linux; ends CRLF churn).

**Edited**
- `scripts/runner/setup-ct106.sh` — provision `ghrunner` + per-user toolchain + non-root runner.
- `CLAUDE.md`, `README.md` — runner runs as `ghrunner`.

---

## Task 1: Refactor `setup-ct106.sh` for a non-root runner

**Files:**
- Modify: `scripts/runner/setup-ct106.sh`

- [ ] **Step 1: Replace the script with the `ghrunner` version**

Overwrite `scripts/runner/setup-ct106.sh` with exactly:

```bash
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
```

- [ ] **Step 2: Syntax-check**

Run: `bash -n scripts/runner/setup-ct106.sh && echo "bash ok"`
Expected: `bash ok`

- [ ] **Step 3: Commit**

```bash
git add scripts/runner/setup-ct106.sh
git commit -m "ci(runner): provision runner as unprivileged ghrunner (not root)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `.gitattributes` to force LF on shell scripts

**Files:**
- Create: `.gitattributes`

- [ ] **Step 1: Create `.gitattributes`**

Create `.gitattributes` at the repo root with exactly:

```gitattributes
# Shell scripts must be LF — they run on the Linux CI runner. Prevents the
# CRLF churn that Windows checkouts otherwise introduce.
*.sh text eol=lf
```

- [ ] **Step 2: Renormalize tracked shell scripts**

```bash
git add .gitattributes
git add --renormalize .
git status --short
```
Expected: `.gitattributes` staged; any `*.sh` whose stored EOL changed is re-staged (the runner scripts). No content changes beyond line endings.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: force LF on *.sh via .gitattributes (CI runs on Linux)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Apply + migrate CT 106 to the non-root runner (live)

**Files:** none (live changes on CT 106).

- [ ] **Step 1: Provision `ghrunner` + its toolchain (run the updated script)**

Pipe the committed script into the container. Its runner section sees the
existing root `.runner` and leaves the running runner alone — this step only
creates `ghrunner` and installs its Rust toolchain (the `cargo install` compiles
tauri-cli + cargo-xwin from source — several minutes):

```bash
ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 \
  'pct exec 106 -- bash -s' < scripts/runner/setup-ct106.sh
```
Expected: ends `== provisioning complete ==`; the runner-agent section prints "left untouched".

- [ ] **Step 2: Verify `ghrunner`'s toolchain**

```bash
ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 \
  'pct exec 106 -- sudo -u ghrunner -H bash -lc "rustc --version; cargo-xwin --version; rustup target list --installed | grep msvc"'
```
Expected: a rustc version, a cargo-xwin version, `x86_64-pc-windows-msvc`.

- [ ] **Step 3: Migrate the runner service from root to `ghrunner`**

This reuses the existing registration (no re-token): stop/uninstall the root
service, chown the dir, point `.path` at `ghrunner`'s cargo, drop the allow-root
env, reinstall the service as `ghrunner`. Pipe this script to CT 106:

```bash
ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 'pct exec 106 -- bash -s' <<'EOF'
set -euo pipefail
cd /opt/actions-runner
./svc.sh stop
./svc.sh uninstall
chown -R ghrunner:ghrunner /opt/actions-runner
printf '%s\n' "/home/ghrunner/.cargo/bin:/sbin:/bin:/usr/sbin:/usr/bin" > .path
: > .env
chown ghrunner:ghrunner .path .env
./svc.sh install ghrunner
./svc.sh start
sleep 3
systemctl show -p User --value "actions.runner.DRHATL95-xbox-remote.ct106.service"
EOF
```
Expected: ends by printing `ghrunner` (the service's `User=`).

- [ ] **Step 4: Confirm the runner is online (as `ghrunner`)**

Run: `gh api repos/DRHATL95/xbox-remote/actions/runners -q '.runners[] | "\(.name): \(.status)"'`
Expected: `ct106: online`.

---

## Task 4: Docs — runner runs as `ghrunner`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the runner bullet**

In `CLAUDE.md`, the runner bullet currently says it runs as a self-hosted runner
on CT 106. Change the parenthetical about the runner user. Replace:

```markdown
  The full provisioning is codified in `scripts/runner/setup-ct106.sh` (the
  source of truth — re-run it to rebuild the box); the runner is on **Node 22**.
```

with:

```markdown
  The full provisioning is codified in `scripts/runner/setup-ct106.sh` (the
  source of truth — re-run it to rebuild the box); the runner is on **Node 22**
  and runs as the unprivileged user **`ghrunner`** (not root) with a per-user
  rust toolchain in `/home/ghrunner/.cargo`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: runner runs as unprivileged ghrunner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Verify + PR + merge (gated on Task 3)

**Files:** none.

- [ ] **Step 1: Confirm the live migration is done**

Run: `ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 'pct exec 106 -- systemctl show -p User --value actions.runner.DRHATL95-xbox-remote.ct106.service'`
Expected: `ghrunner`. (If `root`, do Task 3 first.)

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin nonroot-runner
gh pr create --repo DRHATL95/xbox-remote --base master --head nonroot-runner \
  --title "ci: run the self-hosted runner as unprivileged ghrunner" \
  --body "Refactors scripts/runner/setup-ct106.sh to provision + run the runner as ghrunner (per-user rust toolchain), and migrates CT 106 live (root -> ghrunner). Adds .gitattributes (*.sh eol=lf). Spec: docs/superpowers/specs/2026-06-17-nonroot-runner-design.md

CT 106 is already migrated to ghrunner; merging triggers a nightly that builds + signs + publishes as the non-root user."
```
Expected: prints the PR URL.

- [ ] **Step 3: Merge (REQUIRES USER GO-AHEAD) + watch**

Get explicit authorization (merge triggers a nightly built as `ghrunner` — the
real proof the per-user toolchain + signing + publish all work non-root), then:

```bash
gh pr merge nonroot-runner --repo DRHATL95/xbox-remote --merge --delete-branch
RID="$(gh run list --repo DRHATL95/xbox-remote --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RID" --repo DRHATL95/xbox-remote --interval 30
gh run view "$RID" --repo DRHATL95/xbox-remote --json status,conclusion -q '"status=\(.status) conclusion=\(.conclusion)"'
```
Expected: run succeeds — both platforms build, sign, and publish as `ghrunner`.

---

## Self-Review (completed during planning)

- **Spec coverage:** ghrunner + per-user toolchain + non-root runner → Task 1; live re-provision/migration → Task 3; docs → Task 4; verification → Tasks 3/5; the `.gitattributes` CRLF fix promised in the spec review → Task 2. All covered.
- **Placeholder scan:** Full script inline; concrete migration commands; exact `systemctl` service name. No TBD/TODO.
- **Consistency:** `RUNNER_USER=ghrunner`, `/home/ghrunner/.cargo/bin` `.path`, dropped `RUNNER_ALLOW_RUNASROOT`, and the service name `actions.runner.DRHATL95-xbox-remote.ct106.service` match across the script (Task 1), the live migration (Task 3), and the verify (Task 5). The migration reuses the existing registration (no token), consistent with the "no re-token" note.
