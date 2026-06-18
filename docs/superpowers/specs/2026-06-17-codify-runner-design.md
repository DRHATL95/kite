# Codify the CI Runner (CT 106) + Node 22 / pnpm 11 — Design

- **Date:** 2026-06-17
- **Status:** Approved (pending spec review)
- **Scope:** Infra-as-code for the self-hosted runner (CT 106) + a Node 20→22 bump + a pnpm 10→11 bump. Touches a new `scripts/runner/` dir, the UI package config, and docs.

## Problem

CT 106 (the self-hosted GitHub Actions runner) is a hand-built pet:

- Its toolchain was installed ad hoc. `gh` was never installed → the first
  publish failed `gh: command not found`. A rebuild or snapshot-restore would
  regress the same way. CLAUDE.md *describes* the deps in prose, which drifts.
- It runs **Node 20** (near/at EOL), which capped the project at pnpm 10.

## Decisions

1. **Idempotent committed shell script** provisions the runner toolchain from a
   fresh Ubuntu 22.04 CT — the executable source of truth for runner deps.
2. **Bump Node 20→22 LTS** and apply it to CT 106.
3. With Node 22 in place, **bump pnpm 10.34.3→11.7.0** in the repo — sequenced
   **after** the runner is on Node 22 (pnpm 11 needs Node ≥22.13).

## Components

### `scripts/runner/setup-ct106.sh` (new)
Idempotent bash, run as root on Ubuntu 22.04 (fresh or existing). Versions as
variables at the top (`NODE_MAJOR=22`, `RUST_TARGET=x86_64-pc-windows-msvc`).
Re-run-safe sections:
- **apt base:** `build-essential clang lld llvm nsis jq curl file git
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  patchelf libfuse2`
- **Node 22** via the nodesource setup script (replaces 20); `corepack enable`
  (pnpm is provisioned per-project from `packageManager`)
- **gh** via the GitHub CLI apt repo + keyring
- **Rust** via rustup (`-y`, profile minimal) + `rustup target add
  $RUST_TARGET` + `cargo install tauri-cli cargo-xwin`; then **pre-warm the xwin
  SDK cache** (`XWIN_ACCEPT_LICENSE=1 cargo xwin …`) so a rebuilt runner's first
  cross-build isn't slow
- **Runner agent:** download the latest actions-runner to `/opt/actions-runner`,
  run `bin/installdependencies.sh`, write `.path`
  (`/root/.cargo/bin:/sbin:/bin:/usr/sbin:/usr/bin`) and `.env`
  (`RUNNER_ALLOW_RUNASROOT=1`). If invoked with `--runner-token <TOK>`, also
  `config.sh --unattended` + `svc.sh install/start`; otherwise skip registration.

Idempotency: every step guards on "already present" (e.g. `command -v`,
`dpkg -s`, `rustup component`/`target` checks) so a second run is a no-op.

### `scripts/runner/README.md` (new)
How to use: create an Ubuntu 22.04 CT → run `setup-ct106.sh` as root → register
the runner. Registration is the one **token-gated** step (kept out of the
committed script): `gh api -X POST repos/DRHATL95/xbox-remote/actions/runners/registration-token -q .token`
then either pass `--runner-token` or run `config.sh`/`svc.sh` by hand.

### Repo: Node/pnpm bump
- `ui/package.json`: `packageManager` → `pnpm@11.7.0`; `engines.node` → `>=22.13`.
- `.nvmrc`: `20` → `22`.
- Regenerate `ui/pnpm-lock.yaml` with pnpm 11 (commit only if it changes — pnpm
  10 and 11 share lockfile v9.0, so it may be a no-op).
- `CLAUDE.md` / `README.md`: runner section references `scripts/runner/setup-ct106.sh`
  as the source of truth for runner deps; Node references updated to 22.

## Sequencing (critical — must not reorder)

1. **Provision/apply Node 22 on CT 106** (run `setup-ct106.sh` live). Confirm
   Node 22 + corepack + the full toolchain.
2. **Then** land the pnpm 11 repo bump and merge. Because pnpm 11 requires
   Node ≥22.13, the runner MUST already be on Node 22 — otherwise the nightly
   breaks like the pnpm-11/Node-20 failure in Effort A.

(The committed PR can carry both the script and the pnpm bump; the load-bearing
constraint is that CT 106 is on Node 22 *before* the PR merges and a nightly runs.)

## Verification

- **Script:** `bash -n` (and shellcheck if available); idempotent — running it
  twice is clean.
- **CT 106:** after applying, `node --version` = 22.x (≥22.13); `gh`, `pnpm` (via
  corepack), `cargo-xwin`, target, xwin cache all present.
- **Repo (local, Node 24 ≥22.13):** `corepack pnpm@11.7.0 --dir ui install
  --frozen-lockfile` + `check`/`test`/`build` green.
- **CI:** a nightly on the Node 22 runner with pnpm 11 is green end-to-end.

## Files

**New**
- `scripts/runner/setup-ct106.sh`
- `scripts/runner/README.md`

**Edited**
- `ui/package.json` (pnpm 11, engines node >=22.13)
- `.nvmrc` (22)
- `ui/pnpm-lock.yaml` (only if pnpm 11 changes it)
- `CLAUDE.md`, `README.md` (runner section → script; Node 22)

## Out of scope
- The `gen/schemas/*.json` tracked-generated-file noise (separate).
- Retiring the old Gitea `act_runner` on CT 106 (user's call, separate).
