# Releases & Versioning

How Xbox Remote is versioned, how the two release channels (nightly vs stable)
differ, and what the in-app auto-updater actually does. The authoritative
source is `.gitea/workflows/release.yml`; this document explains the *why*.

## TL;DR

| | Nightly | Stable |
|---|---|---|
| **Trigger** | Every push to `master` | Pushing a `vX.Y.Z` git tag |
| **Version** | `0.1.<run_number>` (CI build number) | `X.Y.Z` (from the tag) |
| **Release** | One rolling `nightly` release, **overwritten** each build | A permanent `vX.Y.Z` release |
| **Marked** | Pre-release | Full release |
| **Auto-update source** | ✅ Yes — the app updates from here | ❌ No (see [Auto-update](#auto-update)) |

## The committed version never changes

`Cargo.toml` and `tauri.conf.json` both pin `version = "0.1.0"` and we **leave it
that way**. The real version is injected at build time so the working tree stays
clean and there are no version-bump commits.

CI writes a one-line `ci-version.json` and merges it into the Tauri config via
Tauri's `--config` flag (an RFC 7396 merge-patch):

```bash
printf '{"version":"%s"}' "$VERSION" > ci-version.json
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc \
  --bundles nsis --config ci-version.json
```

So `0.1.0` in git is a placeholder, not the shipped version. To find the version
a user is running, look at the installer filename / the in-app version readout,
not the repo.

## Nightly channel

- **Fires on every push to `master`** — including docs-only commits. There is no
  filtering, so every merge produces a new nightly and (because of auto-update)
  an update prompt for everyone currently online.
- **Version = `0.1.<run_number>`**, where `<run_number>` is the Gitea Actions run
  counter — monotonically increasing, never resets.
- Publishes to a **single rolling release tagged `nightly`**. Each build deletes
  and recreates that release's assets (`roll_nightly` in
  `scripts/ci/gitea-release.sh`), so `releases/download/nightly/…` URLs are stable
  and always point at the newest build.
- Marked as a **pre-release**.

## Stable channel

- **Fires when you push a tag matching `v*`** (e.g. `v0.2.0`).
- **Version = the tag without the `v`** (`v0.2.0` → `0.2.0`).
- Creates a **permanent, named release** (`v0.2.0`) that is never overwritten.
- Marked as a **full release**.

To cut a stable release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Auto-update

The app checks for updates on launch via `tauri-plugin-updater`
(UI in `ui/src/lib/update/`). The updater endpoint is **hard-pinned to the
nightly manifest** (`tauri.conf.json`):

```
https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/latest.json
```

**Consequences — read this before changing the version scheme:**

1. **All auto-updates come from the nightly channel.** A user who installs a
   stable `vX.Y.Z` build still auto-updates *to nightly* on next launch, because
   that is the only endpoint the app knows. Stable releases today are effectively
   **manual downloads**, not an auto-update track.
2. **Version comparison is semver.** Nightly is `0.1.<run_number>`; once
   `<run_number>` climbs past a stable patch (e.g. nightly `0.1.140` vs a stable
   `v0.1.5`), the updater always considers nightly "newer." This is fine while
   there is one channel, but is a sharp edge if a true stable auto-update track is
   ever added — it would likely need its own `latest.json` endpoint and a version
   scheme that can't be overtaken by nightly build numbers (e.g. nightlies on a
   `0.0.x` line, or date-based nightly versions).
3. Offline / off-LAN, the check silently no-ops — `gitea.howlab.co` is only
   reachable on the home network.

## The `latest.json` updater manifest

Generated per build by `scripts/ci/make-latest-json.sh` and uploaded alongside
the installers. Windows is always present; the `linux-x86_64` entry is added
when the build produces an AppImage (the script takes optional `LINUX_SIG_FILE`
+ `LINUX_URL` env):

```json
{
  "version": "0.1.42",
  "notes": "Nightly 0.1.42",
  "pub_date": "2026-06-12T10:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<minisign sig>", "url": "https://…/xbox-remote_0.1.42_x64-setup.exe" },
    "linux-x86_64":   { "signature": "<minisign sig>", "url": "https://…/xbox-remote_0.1.42_amd64.AppImage" }
  }
}
```

Update artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (Gitea Actions
secret; public key embedded in `tauri.conf.json`). The `.sig` signs the file
*bytes*, so the CI rename to space-free asset names does not invalidate it.

## Platforms

CI ships **Windows x64** (NSIS installer, cross-compiled from the Linux runner
via `cargo-xwin`) and **Linux x64** (AppImage, built natively on the same
runner). Both are signed and both auto-update via `latest.json`. macOS users
still build from source.

Both artifacts are produced in a *single* job — the `upload-artifact` action
refuses non-GitHub hosts, so there is no cross-job handoff. The Linux build
needs GTK/WebKit dev libs + AppImage tooling on the runner; the workflow installs
them defensively but they're best baked into the runner image. See `CLAUDE.md` →
"Releases & Auto-Update (CI/CD)" for the runner details.

> **Linux auto-update caveat:** the Tauri updater only updates **AppImage**
> installs on Linux. A user who runs the AppImage gets in-app updates; if the app
> is ever repackaged (`.deb`, distro package, `cargo install`), the updater
> cannot replace it and the launch check no-ops.
