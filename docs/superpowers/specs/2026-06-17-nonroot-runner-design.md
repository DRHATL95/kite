# Non-root CI Runner (CT 106) — Design

- **Date:** 2026-06-17
- **Status:** Approved (pending spec review)
- **Scope:** Re-provision the self-hosted GitHub Actions runner on CT 106 to run as a dedicated unprivileged user. Updates `scripts/runner/setup-ct106.sh` + a live re-provision + docs.

## Problem

The runner runs as **root** (`RUNNER_ALLOW_RUNASROOT=1`), with the Rust toolchain
in `/root/.cargo` and the signing key + `RELEASES_TOKEN` injected into every job.
A compromised build dependency therefore executes as root on CT 106 — it could
trash the container, the Proxmox bind-mounts, or other services.

## Decision

Run the runner as a dedicated unprivileged user **`ghrunner`** with a **per-user
Rust toolchain** (`~ghrunner/.cargo`). Codify it in `setup-ct106.sh` and apply
live.

### Honest limit (in scope vs not)

This contains **privilege** damage (a hostile build can no longer act as root /
reach other services). It does **not** isolate the secrets — the signing key and
`RELEASES_TOKEN` are still injected into the job env, which is inherent to a
runner that signs and publishes. Full secret isolation would require
ephemeral/disposable runners — explicitly **out of scope**.

## Changes

### `scripts/runner/setup-ct106.sh` refactor
- Add `RUNNER_USER=ghrunner` near the top vars.
- **Create the user** if missing: `useradd -m -s /bin/bash "$RUNNER_USER"`.
- **Rust per-user:** run rustup as `ghrunner` (e.g. `sudo -u "$RUNNER_USER" -H
  bash -lc '… rustup-init -y --profile minimal'`), then (as `ghrunner`)
  `rustup target add x86_64-pc-windows-msvc` and `cargo install tauri-cli
  cargo-xwin` — installed under `~ghrunner/.cargo`. Guarded so a re-run skips
  what's present.
- **System-wide deps unchanged:** apt base, Node 22 (nodesource) + corepack, gh
  stay system-wide (already accessible to `ghrunner`).
- **Runner agent as `ghrunner`:** `/opt/actions-runner` owned by `ghrunner`;
  `.path` → `/home/ghrunner/.cargo/bin:/sbin:/bin:/usr/sbin:/usr/bin`; `.env`
  **drops** `RUNNER_ALLOW_RUNASROOT`; `config.sh`/`svc.sh install` run **as
  `ghrunner`** (`svc.sh install ghrunner`). With `--runner-token`, register +
  install/start the service as that user.

### Live re-provision of CT 106
1. Run the updated script on CT 106 → creates `ghrunner`, installs its toolchain
   (the `cargo install` compiles tauri-cli + cargo-xwin from source — several
   minutes).
2. Migrate the runner: stop + `svc.sh uninstall` the current root service;
   `chown -R ghrunner:ghrunner /opt/actions-runner`; re-register as `ghrunner`
   with a fresh registration token (`config.sh --replace`); `svc.sh install
   ghrunner` + start.
3. The first cross-build re-warms `~ghrunner/.cache/cargo-xwin`.

### Docs
- `CLAUDE.md` / `README.md`: note the runner runs as **`ghrunner`** (not root).

## Verification

- The systemd runner service runs as `ghrunner` (`Run as user: ghrunner`),
  `RUNNER_ALLOW_RUNASROOT` absent.
- `ct106` runner shows online.
- A nightly builds, **signs**, and **publishes** green as `ghrunner` (proves the
  per-user toolchain + signing secret + cross-repo publish all work non-root).

## Files

**Edited**
- `scripts/runner/setup-ct106.sh` (provision `ghrunner` + per-user toolchain + non-root runner)
- `CLAUDE.md`, `README.md` (runner runs as `ghrunner`)

## Out of scope
- Ephemeral/disposable runners (the only thing that would remove secrets from the
  job env) — a much larger change.
