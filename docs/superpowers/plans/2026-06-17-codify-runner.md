# Codify CI Runner (CT 106) + Node 22 / pnpm 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CT 106 rebuildable via a committed idempotent provisioning script, bump the runner to Node 22 LTS, and then move the repo to pnpm 11.

**Architecture:** A single idempotent `scripts/runner/setup-ct106.sh` provisions every runner dep (apt, Node 22, gh, rust + cross-compile toolchain, runner agent) from a fresh Ubuntu 22.04 CT. It is applied live to CT 106 (upgrading Node 20→22) before the repo bumps pnpm 10→11 — because pnpm 11 needs Node ≥22.13, the runner must be on Node 22 first.

**Tech Stack:** bash, Ubuntu 22.04 / Proxmox LXC, nodesource Node 22, rustup + cargo-tauri + cargo-xwin, GitHub Actions runner, pnpm 11 (corepack).

**Note on testing:** Infra, not app code — verification is `bash -n` on the script, idempotency (re-run is clean), the live apply on CT 106 (Node 22 + tools present), a local pnpm-11 frozen build, and a green nightly.

**Access to CT 106:** `ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232`, then `pct exec 106 -- …` (run the script by piping it to `pct exec 106 -- bash -s`).

**Sequencing (load-bearing):** Task 3 (apply Node 22 to CT 106) MUST complete before Task 6 (merge → pnpm-11 nightly). pnpm 10 on the current master still runs fine on Node 22, so there's no breakage window.

**Reference:** spec at `docs/superpowers/specs/2026-06-17-codify-runner-design.md`.

---

## File Structure

**New**
- `scripts/runner/setup-ct106.sh` — idempotent runner provisioner.
- `scripts/runner/README.md` — usage + token-gated registration.

**Edited**
- `ui/package.json` — `packageManager` → pnpm 11.7.0, `engines.node` → `>=22.13`.
- `.nvmrc` — `20` → `22`.
- `ui/pnpm-lock.yaml` — regenerated with pnpm 11 (commit only if changed).
- `CLAUDE.md`, `README.md` — runner section references the script; Node 22.

---

## Task 1: Write `scripts/runner/setup-ct106.sh`

**Files:**
- Create: `scripts/runner/setup-ct106.sh`

- [ ] **Step 1: Create the script**

Create `scripts/runner/setup-ct106.sh` with exactly:

```bash
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
```

- [ ] **Step 2: Syntax-check**

Run: `bash -n scripts/runner/setup-ct106.sh && echo "bash ok"`
Expected: `bash ok`

- [ ] **Step 3: Make it executable + commit**

```bash
chmod +x scripts/runner/setup-ct106.sh
git add scripts/runner/setup-ct106.sh
git update-index --chmod=+x scripts/runner/setup-ct106.sh
git commit -m "ci(runner): idempotent CT 106 provisioning script (node 22)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Write `scripts/runner/README.md`

**Files:**
- Create: `scripts/runner/README.md`

- [ ] **Step 1: Create the README**

Create `scripts/runner/README.md` with exactly:

````markdown
# CI runner (CT 106)

The release workflow runs on a self-hosted GitHub Actions runner: Proxmox LXC
**CT 106** (`gitea-ci-linux`), Ubuntu 22.04. `setup-ct106.sh` is the source of
truth for its build toolchain — re-run it any time to (re)provision the box.

## Provision a runner (fresh or existing CT)

As root on the CT:

```bash
./setup-ct106.sh
```

Installs: apt build deps + GTK/WebKit + AppImage tooling, **Node 22** (nodesource)
+ corepack, **gh**, **rust** (rustup) with the `x86_64-pc-windows-msvc` target +
`cargo-tauri` + `cargo-xwin`, and downloads the GitHub Actions runner agent to
`/opt/actions-runner`. Idempotent — safe to re-run; it upgrades Node and leaves
an already-registered runner untouched.

## Register the runner (one-time, token-gated)

Registration needs a short-lived token (kept out of the committed script). From
a machine with `gh` logged in:

```bash
gh api -X POST repos/DRHATL95/xbox-remote/actions/runners/registration-token -q .token
```

Then either re-run the script with the token:

```bash
./setup-ct106.sh --runner-token <TOKEN>
```

or register by hand in `/opt/actions-runner`:

```bash
RUNNER_ALLOW_RUNASROOT=1 ./config.sh --unattended --replace \
  --url https://github.com/DRHATL95/xbox-remote --token <TOKEN> --name ct106 --work _work
./svc.sh install root && ./svc.sh start
```

The runner runs **as root** (`RUNNER_ALLOW_RUNASROOT=1`, set in `.env`) and gets
`/root/.cargo/bin` on its PATH via `.path`, so `cargo`/`cargo-tauri`/`cargo-xwin`
resolve in jobs. Labels are the defaults: `self-hosted, Linux, X64`.

## Verify

```bash
node --version            # v22.x
gh --version; cargo-xwin --version
gh api repos/DRHATL95/xbox-remote/actions/runners -q '.runners[] | "\(.name) \(.status)"'
```
````

- [ ] **Step 2: Commit**

```bash
git add scripts/runner/README.md
git commit -m "docs(runner): how to provision + register CT 106

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Apply Node 22 to CT 106 (live) + verify

**Files:** none (runs the committed script on CT 106).

- [ ] **Step 1: Run the provisioner on CT 106**

Pipe the committed script into the container (no `--runner-token`, so the
already-registered runner is left untouched):

```bash
ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 \
  'pct exec 106 -- bash -s' < scripts/runner/setup-ct106.sh
```
Expected: ends with `== provisioning complete ==`; the Node section upgrades 20→22.

- [ ] **Step 2: Verify Node 22 + toolchain on CT 106**

```bash
ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 \
  'pct exec 106 -- bash -lc "node --version; command -v gh corepack; cargo-xwin --version; rustup target list --installed | grep msvc"'
```
Expected: `v22.x`; `gh`/`corepack` paths; a cargo-xwin version; `x86_64-pc-windows-msvc`.

- [ ] **Step 3: Confirm the runner is still online**

Run: `gh api repos/DRHATL95/xbox-remote/actions/runners -q '.runners[] | "\(.name): \(.status)"'`
Expected: `ct106: online` (the idempotent runner guard left it registered/running).

---

## Task 4: Repo bump to pnpm 11 + Node 22 alignment

**Files:**
- Modify: `ui/package.json`, `.nvmrc`
- Regenerate: `ui/pnpm-lock.yaml` (commit only if changed)

- [ ] **Step 1: Bump `packageManager` + `engines.node`**

In `ui/package.json`, change:

```json
  "packageManager": "pnpm@10.34.3",
  "engines": {
    "node": ">=20"
  },
```

to:

```json
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": ">=22.13"
  },
```

- [ ] **Step 2: Bump `.nvmrc`**

Set the repo-root `.nvmrc` contents to exactly:

```
22
```

- [ ] **Step 3: Regenerate the lockfile with pnpm 11 + verify**

```bash
rm -rf ui/node_modules
CI=true corepack pnpm@11.7.0 --dir ui install
corepack pnpm@11.7.0 --dir ui install --frozen-lockfile
corepack pnpm@11.7.0 --dir ui run check
corepack pnpm@11.7.0 --dir ui run test
corepack pnpm@11.7.0 --dir ui run build
```
Expected: install succeeds; `--frozen-lockfile` reports up-to-date; svelte-check 0/0; vitest green; `ui/dist` written. (pnpm 10→11 share lockfile v9.0, so `ui/pnpm-lock.yaml` likely has no diff.)

- [ ] **Step 4: Commit**

```bash
git add ui/package.json .nvmrc ui/pnpm-lock.yaml
git commit -m "build(ui): move to pnpm 11 + node 22 (runner now on node 22)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(If `ui/pnpm-lock.yaml` has no diff, it simply isn't staged — that's expected.)

---

## Task 5: Docs — runner section points at the script; Node 22

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Point CLAUDE.md's runner bullet at the script**

In `CLAUDE.md`, in the `- **Runner**:` bullet, append a sentence after the
existing dep list:

```markdown
  The full provisioning is codified in `scripts/runner/setup-ct106.sh` (the
  source of truth — re-run it to rebuild the box); the runner is on **Node 22**.
```

- [ ] **Step 2: Update any Node-20 references**

Run: `grep -rn "node 20\|Node 20\|node_20" CLAUDE.md README.md`
For each hit that describes the runner/build target, change `20` → `22`.
(If none, this is a no-op.)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: runner provisioning script + node 22

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verify + PR + merge (gated on Task 3)

**Files:** none.

- [ ] **Step 1: Confirm Task 3 is done (runner on Node 22)**

Run: `ssh -i ~/.ssh/id_proxmox_claude -o IdentitiesOnly=yes root@192.168.1.232 'pct exec 106 -- node --version'`
Expected: `v22.x`. (If not, do Task 3 first — merging pnpm 11 onto a Node 20 runner will fail.)

- [ ] **Step 2: Push the branch + open the PR**

```bash
git push -u origin codify-runner
gh pr create --repo DRHATL95/xbox-remote --base master --head codify-runner \
  --title "ci: codify runner provisioning + node 22 + pnpm 11" \
  --body "Adds scripts/runner/setup-ct106.sh (idempotent CT 106 provisioner) + README; bumps the runner to Node 22 (applied live) and the repo to pnpm 11. Spec: docs/superpowers/specs/2026-06-17-codify-runner-design.md

Runner is already on Node 22 (applied before this merge), so the pnpm-11 nightly will pass. Merging triggers a nightly."
```
Expected: prints the PR URL.

- [ ] **Step 3: Merge (REQUIRES USER GO-AHEAD) + watch**

Merging triggers a nightly that runs pnpm 11 on the Node 22 runner. Get explicit
user authorization, then:

```bash
gh pr merge codify-runner --repo DRHATL95/xbox-remote --merge --delete-branch
RID="$(gh run list --repo DRHATL95/xbox-remote --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RID" --repo DRHATL95/xbox-remote --interval 30
gh run view "$RID" --repo DRHATL95/xbox-remote --json status,conclusion -q '"status=\(.status) conclusion=\(.conclusion)"'
```
Expected: run succeeds; the frontend step installs via pnpm 11 on Node 22.

---

## Self-Review (completed during planning)

- **Spec coverage:** setup script → Task 1; README/registration → Task 2; live Node 22 apply → Task 3; pnpm 11 + node alignment → Task 4; docs → Task 5; sequencing + validation → Tasks 3/6. All covered. Deviation: the spec's "pre-warm xwin cache" is intentionally documented-not-scripted (the provisioner is project-independent; the first CI cross-build warms it) — noted in the script comment.
- **Placeholder scan:** Concrete throughout (Node 22, pnpm 11.7.0, exact apt list, full script). No TBD/TODO.
- **Consistency:** pnpm@11.7.0 + `engines.node >=22.13` + `.nvmrc 22` + `NODE_MAJOR=22` all agree; the runner `.path`/`.env`/`RUNNER_ALLOW_RUNASROOT` match what's live on CT 106; the registration command in the README matches the script's `config.sh` invocation.
