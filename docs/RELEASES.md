# Releases & Versioning

How Xbox Remote is versioned, how the two release channels (nightly vs stable)
differ, and what the in-app auto-updater actually does. The authoritative
source is `.github/workflows/release.yml`; this document explains the *why*.

## TL;DR

| | Nightly | Stable |
|---|---|---|
| **Trigger** | Every push to `master` | Pushing a `vX.Y.Z` git tag |
| **Version** | `X.Y.Z-nightly.<run_number>` (prerelease of target) | `X.Y.Z` (from the tag) |
| **Release** | Rolling `nightly` release, **overwritten** each build | Permanent `vX.Y.Z` archive **and** rolling `stable` pointer |
| **Marked** | Pre-release | Full release |
| **Auto-update source** | `…/nightly/latest.json` | `…/stable/latest.json` |

## Versioning

- **Committed version** (`Cargo.toml`, `tauri.conf.json`) is the in-development
  **target** — the next unreleased `X.Y.Z` (currently `0.3.0`).
- **Nightly** (every push to `master`): `X.Y.Z-nightly.<run_number>` — a semver
  prerelease of the target, so nightlies sort below the eventual stable
  (`0.3.0-nightly.41 < 0.3.0-nightly.42 < 0.3.0`). Published to the rolling
  `nightly` release.
- **Stable** (push a `vX.Y.Z` tag): clean `X.Y.Z` from the tag. Published to BOTH
  the permanent `vX.Y.Z` archive release AND the rolling `stable` pointer.
- **After cutting a stable `vX.Y.Z`**, bump the committed version to the next
  target so subsequent nightlies stay ahead.

## Channels

Two rolling pointer releases hold the updater manifests:
- `…/releases/download/nightly/latest.json`
- `…/releases/download/stable/latest.json`

The app's **Settings → Updates → Nightly builds** toggle chooses which manifest the
updater polls (default **Stable**; on = **Nightly** pre-release builds). Launch checks
only ever upgrade; switching channels in Settings moves you to the chosen channel's
latest build immediately — even if that's a lower version. Channel selection is
implemented Rust-side (`src/updater.rs`: `check_update`/`install_update` build the
updater endpoint per channel), since the JS updater can't override the endpoint at
runtime.

The committed version in `Cargo.toml` / `tauri.conf.json` is the in-development
target — a placeholder that stays clean in the tree. The real version is injected
at build time via Tauri's `--config` flag (an RFC 7396 merge-patch):

```bash
printf '{"version":"%s"}' "$VERSION" > ci-version.json
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc \
  --bundles nsis --config ci-version.json
```

To find the version a user is running, look at the installer filename or the
in-app version readout, not the repo.

## Nightly channel

- **Fires on every push to `master`** — including docs-only commits. There is no
  filtering, so every merge produces a new nightly and (because of auto-update)
  an update prompt for everyone currently online.
- **Version = `<target>-nightly.<run_number>`**, where `<target>` is the committed
  `Cargo.toml` version and `<run_number>` is the GitHub Actions run counter
  (monotonically increasing, never resets).
- Publishes to a **single rolling release tagged `nightly`** in the public
  releases repo. Each build replaces that release's assets in place
  (`scripts/ci/github-release.sh`), so `releases/download/nightly/…` URLs are
  stable and always point at the newest build.
- Marked as a **pre-release**.

## Stable channel

- **Fires when you push a tag matching `v*`** (e.g. `v0.3.0`).
- **Version = the tag without the `v`** (`v0.3.0` → `0.3.0`).
- Creates a **permanent, named release** (`v0.3.0`) that is never overwritten,
  **and** force-updates the rolling `stable` release pointer so
  `releases/download/stable/…` URLs always point at the latest stable build.
- Marked as a **full release**.
- **After cutting a stable**, bump `Cargo.toml` / `tauri.conf.json` to the next
  target version so subsequent nightlies produce `<next>-nightly.<run_number>`.

To cut a stable release:

```bash
git tag v0.3.0
git push origin v0.3.0
```

## Auto-update

The app checks for updates on launch via `tauri-plugin-updater`
(UI in `ui/src/lib/update/`). Two manifests exist:

```
https://github.com/DRHATL95/xbox-remote-releases/releases/download/nightly/latest.json
https://github.com/DRHATL95/xbox-remote-releases/releases/download/stable/latest.json
```

**Notes:**

1. **Semver prerelease ordering is correct.** Nightly versions like
   `0.3.0-nightly.42` sort *below* the eventual stable `0.3.0`, so the updater
   correctly considers the stable release "newer" when it ships.
2. **Channel selection** (choosing which `latest.json` the app queries) is a
   separate in-app feature; see the in-app update UI under `ui/src/lib/update/`.
3. Offline, the check silently no-ops. The releases repo is public on GitHub, so
   the check works from anywhere with internet (no LAN dependency).

## The `latest.json` updater manifest

Generated per build by `scripts/ci/make-latest-json.sh` and uploaded alongside
the installers. Windows is always present; the `linux-x86_64` entry is added
when the build produces an AppImage (the script takes optional `LINUX_SIG_FILE`
+ `LINUX_URL` env):

```json
{
  "version": "0.3.0-nightly.42",
  "notes": "Nightly 0.3.0-nightly.42",
  "pub_date": "2026-06-12T10:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<minisign sig>", "url": "https://…/xbox-remote_0.3.0-nightly.42_x64-setup.exe" },
    "linux-x86_64":   { "signature": "<minisign sig>", "url": "https://…/xbox-remote_0.3.0-nightly.42_amd64.AppImage" }
  }
}
```

Update artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (GitHub Actions
secret; public key embedded in `tauri.conf.json`). The `.sig` signs the file
*bytes*, so the CI rename to space-free asset names does not invalidate it.

## Platforms

CI ships **Windows x64** (NSIS installer, cross-compiled from the Linux runner
via `cargo-xwin`) and **Linux x64** (AppImage, built natively on the same
runner). Both are signed and both auto-update via `latest.json`. macOS users
still build from source.

Both artifacts are produced in a *single* job on the self-hosted runner, then
published cross-repo to the public releases repo via `gh release`. The Linux
build needs GTK/WebKit dev libs + AppImage tooling on the runner; the workflow
installs them defensively but they're best baked into the runner image. See
`CLAUDE.md` → "Releases & Auto-Update (CI/CD)" for the runner details.

> **Linux auto-update caveat:** the Tauri updater only updates **AppImage**
> installs on Linux. A user who runs the AppImage gets in-app updates; if the app
> is ever repackaged (`.deb`, distro package, `cargo install`), the updater
> cannot replace it and the launch check no-ops.
