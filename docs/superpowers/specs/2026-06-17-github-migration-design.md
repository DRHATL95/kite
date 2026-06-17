# Gitea → GitHub Migration — Design

- **Date:** 2026-06-17
- **Status:** Approved (pending spec review)
- **Scope:** Move the project from self-hosted Gitea (`gitea.howlab.co/dave/xbox-remote`) to GitHub, including code, CI/CD, and the in-app auto-updater.

## Overview

The project currently lives on self-hosted Gitea with a Gitea Actions pipeline
([.gitea/workflows/release.yml](../../../.gitea/workflows/release.yml)) on a
self-hosted Proxmox runner, and the Tauri auto-updater points at Gitea release
URLs. This migrates everything to GitHub while **keeping the code private** and
**keeping the auto-updater working**.

### Decisions (locked during brainstorming)

1. **Private code repo + self-hosted runner.** Code stays private; the existing
   Proxmox runner is reused, so the CI is a near-verbatim port of today's
   single-runner cross-compile workflow (not a hosted-runner rewrite).
2. **Public releases repo.** A private repo's release assets are not
   anonymously downloadable, which would break the updater (it fetches
   `latest.json` + binaries over plain HTTPS with no auth). So release artifacts
   live in a separate **public** repo the updater can read anonymously.
3. **Reinstall once.** Existing installs have the Gitea updater URL baked in; no
   Gitea bridge. The first GitHub-pointed build is installed by hand on existing
   machines.

### Two-repo model

| Repo | Visibility | Contents |
|------|-----------|----------|
| `DRHATL95/xbox-remote` | **private** | All code, history, branches, tags, the CI workflow. Built by the self-hosted runner. |
| `DRHATL95/xbox-remote-releases` | **public** | Only release artifacts: signed binaries + `.sig` + per-channel `latest.json`. Rolling `nightly`/`stable` releases + permanent `vX.Y.Z` archives. No source code. |

The updater reads `https://github.com/DRHATL95/xbox-remote-releases/releases/download/{stable,nightly}/latest.json`.

### Non-goals (YAGNI)

- No migration of Gitea issues/PRs (none worth carrying over).
- No macOS build added here (still build-from-source; out of scope).
- No UI dependency pinning / cross-platform lockfile (pre-existing known issue;
  the CI's `rm -rf node_modules + npm install` workaround is ported as-is).
- No signing-key rotation — the **same keypair is reused** (see Part C).

## Part A — Repo + history move

- Create both repos with `gh`:
  - `gh repo create DRHATL95/xbox-remote --private`
  - `gh repo create DRHATL95/xbox-remote-releases --public --add-readme`
    (the README gives the releases repo a commit so release tags can be created).
- Add a `github` remote pointing at the private repo, push everything:
  `git push github --all` then `git push github --tags`.
- After verifying the push, make GitHub the default: rename `origin` (Gitea) →
  `gitea`, and `github` → `origin`. Gitea remains as an **inactive cold-mirror
  remote** (not deleted) until the user retires it.

## Part B — CI/CD on GitHub Actions (self-hosted)

### `.github/workflows/release.yml` (ported from the Gitea workflow)

Carries over verbatim (the Gitea workflow already uses GitHub Actions syntax and
`github.*` expressions): the `on:` triggers (push to `master`, `v*` tags), the
version/channel compute step, the frontend build (including the rolldown
lockfile-nuke workaround), the `cargo-xwin` Windows cross-build, the native
AppImage build, and the artifact staging step.

Changes from the Gitea version:
- `runs-on: linux` → `runs-on: [self-hosted, linux]`.
- Remove the `GITEA` / `REPO` / `TOKEN` (`GITEA_TOKEN`) env block.
- Remove the `actions/upload-artifact@v4` caveat comment (moot on GitHub).
- Keep `permissions: contents: write` (for the private repo); cross-repo
  publishing uses the PAT below, not `GITHUB_TOKEN`.
- The "Install Linux build dependencies" step stays (defensive; the runner
  already has them baked into CT 106).

### Release publishing — new `scripts/ci/github-release.sh`

Replaces [scripts/ci/gitea-release.sh](../../../scripts/ci/gitea-release.sh),
preserving the **same rolling-channel discipline** but via the `gh` CLI,
publishing **cross-repo** to the public releases repo.

- Env: `RELEASES_REPO=DRHATL95/xbox-remote-releases`, `GH_TOKEN=${{ secrets.RELEASES_TOKEN }}`.
- Functions (gh equivalents of the Gitea helpers):
  - `ensure_release <tag> <name> <prerelease>` — `gh release view --repo $RELEASES_REPO <tag>`; if absent, `gh release create --repo $RELEASES_REPO <tag> --title <name> [--prerelease] --notes <name>`; if present, `gh release edit` to refresh title/prerelease.
  - `replace_asset <tag> <file>` — `gh release upload --repo $RELEASES_REPO <tag> <file> --clobber` (delete-then-upload of the same-named asset — the atomic swap).
  - `prune_channel_assets <tag> <keep_version>` — list assets via `gh release view --repo $RELEASES_REPO <tag> --json assets`; `gh release delete-asset` for any asset whose name neither contains the current version nor equals `latest.json`.
  - Permanent archive: `gh release create --repo $RELEASES_REPO vX.Y.Z ...` then upload binaries.
- Publish order is unchanged and load-bearing: ensure pointer release → upload
  binaries (`--clobber`) → upload `latest.json` **last** (`--clobber`) → prune
  stale assets. This guarantees `latest.json` never references a missing asset.

### `scripts/ci/make-latest-json.sh`

Kept as-is; only the asset base URL it is fed changes. In the workflow, the
`WIN_URL` / `LINUX_URL` env values become
`https://github.com/DRHATL95/xbox-remote-releases/releases/download/<pointer>/<asset>`.

### Removed

- `.gitea/` (the entire Gitea workflow directory).

### Secrets on the private repo (user sets — see "User steps")

- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (same keypair).
- `RELEASES_TOKEN` — a PAT with `contents:write` on the releases repo, used by
  `gh release` to publish cross-repo.

## Part C — Updater cutover

- [tauri.conf.json:54](../../../tauri.conf.json) updater endpoint →
  `https://github.com/DRHATL95/xbox-remote-releases/releases/download/stable/latest.json`.
- [src/updater.rs:7-10](../../../src/updater.rs) `channel_endpoint()` →
  `https://github.com/DRHATL95/xbox-remote-releases/releases/download/{ch}/latest.json`.
  The existing tests assert the **path suffix** (`/download/<ch>/latest.json`)
  only, so they stay green.
- **Pubkey unchanged** ([tauri.conf.json:56](../../../tauri.conf.json)): the same
  signing keypair is reused, so binaries published from GitHub verify against the
  pubkey already shipped in existing installs — no key rotation, no re-trust.
- **Existing installs:** reinstall the first GitHub-pointed build by hand. No
  Gitea bridge release.

## Part D — Docs

- CLAUDE.md: rewrite the "Releases & Auto-Update (CI/CD)" section for the
  two-repo GitHub model, self-hosted GitHub Actions runner, the `RELEASES_TOKEN`
  PAT, and the new endpoint URLs.
- [docs/RELEASES.md](../../../docs/RELEASES.md): update to GitHub flow.
- README: update any Gitea links/badges.
- Historical design/plan docs under `docs/superpowers/` are dated records and are
  left unchanged.

## User steps (credentials/infra — assistant will guide, not perform)

The assistant will provide exact commands/scopes for each, but the user runs
them (credentials and infra are out of the assistant's hands):

1. **PAT** with `contents:write` on `xbox-remote-releases` → `gh secret set RELEASES_TOKEN -R DRHATL95/xbox-remote`.
2. **Signing secrets** → `gh secret set TAURI_SIGNING_PRIVATE_KEY -R DRHATL95/xbox-remote < ~/.tauri/xbox-remote-updater.key` and the password secret.
3. **Register the self-hosted runner** on CT 106 against the private repo (GitHub
   Actions runner agent, label `linux`).
4. Confirm `xbox-remote-releases` is public; retire Gitea when ready.

## Testing / verification

- `cargo test` — `updater.rs` channel tests pass with the new host.
- `npm --prefix ui run test`, `npm --prefix ui run check`, `npm --prefix ui run build` — green.
- End-to-end (gated on the user's runner + secrets): trigger a `master` build,
  confirm it publishes to the public releases repo, that
  `…/releases/download/nightly/latest.json` is anonymously reachable, and that an
  installed app updates from GitHub.

## Files touched

**New**
- `.github/workflows/release.yml`
- `scripts/ci/github-release.sh`

**Edited**
- `tauri.conf.json` (updater endpoint)
- `src/updater.rs` (`channel_endpoint` host)
- `CLAUDE.md`, `docs/RELEASES.md`, `README.md`

**Unchanged (but reused)**
- `scripts/ci/make-latest-json.sh` — emits `latest.json` from env; the new asset
  base URL is supplied by the workflow, so the script itself needs no edit.

**Removed**
- `.gitea/` (workflow), `scripts/ci/gitea-release.sh`

## Sequencing

A (repos + push) → B & C (CI + updater, in parallel) → D (docs) → user steps
(secrets/runner) → end-to-end validation.
