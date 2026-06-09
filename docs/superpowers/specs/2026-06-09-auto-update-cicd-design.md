# Cross-Platform Auto-Update + Self-Hosted CI/CD — Design Spec

- **Date:** 2026-06-09
- **Status:** Draft (awaiting user review)
- **Goal:** Every push to `master` produces installers automatically (Windows + Linux now,
  macOS later), and the installed app updates itself in-app (check on launch → prompt → apply).

---

## 1. Goal & locked decisions

| Decision | Choice |
|---|---|
| Platforms (now) | **Windows (NSIS)** + **Linux (AppImage)**. macOS **deferred** (needs a Mac). |
| CI platform | **Gitea Actions**, self-hosted runners on **Proxmox** (192.168.1.232). |
| Runners | **Linux** = LXC on Proxmox (I provision). **Windows** = VM on Proxmox *or* this PC (decide at sub-project 3). |
| Release model | **Two channels:** every push to `master` → **nightly** (auto-version); pushing a `vX.Y.Z` tag → **stable**. |
| Versioning | nightly = `0.1.<run_number>` (monotonic per CI run); stable = the tag's `X.Y.Z`. Injected at build time. |
| Update UX | **Check on launch → unobtrusive "Update available" prompt → user approves → signed download → relaunch.** |
| Update transport | Tauri **`tauri-plugin-updater`**; manifest (`latest.json`) + signed artifacts hosted on **Gitea releases**. |
| Linux updatable format | **AppImage** (the only Linux format the Tauri updater self-updates). `.deb` may be emitted for first-install convenience but updates flow via AppImage. |
| Signing | Tauri **updater signing keypair** (separate from OS code-signing). Private key in a Gitea Actions secret; public key in `tauri.conf.json`. OS-level code signing (Authenticode/notarization) is **out of scope** (unsigned installers → users may see SmartScreen; acceptable for personal/internal use). |

---

## 2. Architecture — the pipeline

```
 git push master / git push tag vX.Y.Z
        │
        ▼
 Gitea Actions workflow (.gitea/workflows/release.yml)
   ├─ job: build-linux   (runs-on: self-hosted, linux)   → AppImage + .sig
   └─ job: build-windows (runs-on: self-hosted, windows)  → NSIS .exe + updater .nsis.zip + .sig
        │   (each job: checkout → setup Rust/Node → npm build ui → inject version
        │    → tauri build (signed) → upload per-OS artifacts)
        ▼
 job: publish (needs both)
   ├─ create/Update a Gitea release (nightly: rolling "nightly" release; stable: vX.Y.Z release)
   ├─ attach the installers + updater artifacts (.nsis.zip, .AppImage, .sig)
   └─ generate + attach latest.json (version, per-platform url + signature)
        │
        ▼
 Installed app, on launch:
   tauri-plugin-updater.check() → GET latest.json (Gitea) → compare version
        │ newer?
        ▼ yes → Svelte "Update available (vX)" prompt → user clicks Install
   plugin downloads the signed artifact → verifies signature (public key) → installs → relaunch
```

**Channels & the manifest endpoint.** The app's updater is configured with a Gitea URL for
`latest.json`. Two options for "which channel the app follows":
- Default build follows **stable** (`.../releases/download/stable/latest.json` or the latest
  `v*` tag's manifest).
- A **nightly** build (and/or a future in-app toggle) points at the nightly manifest.
For this **personal daily-driver**, the shipped app follows the **nightly** channel by default:
every push to `master` produces a new version and the installed app prompts to update on next
launch — matching your "every push → update in-app" intent. Stable `vX.Y.Z` tags *additionally*
cut permanent milestone releases (useful for clean install points / future sharing). If the
per-push prompting ever feels excessive, the app can be switched to follow stable instead.

---

## 3. Sub-project 1 — App-side foundation *(build first; Windows-verifiable here, no runners needed)*

Make the app updater-capable and Linux-bundleable. Pure repo changes.

**Files / changes:**
- `Cargo.toml` — add `tauri-plugin-updater` (and `tauri-plugin-process` for relaunch).
- `src/main.rs` — register the updater + process plugins on the Tauri builder.
- `tauri.conf.json` — add:
  - `bundle.targets`: `["nsis", "appimage"]` (deb optional).
  - `bundle.createUpdaterArtifacts: true` (emit the `.nsis.zip` / AppImage updater artifacts + `.sig`).
  - `plugins.updater`: `{ "endpoints": ["https://gitea.howlab.co/.../latest.json"], "pubkey": "<public key>" }`.
- **Signing keypair** — generate with `tauri signer generate` (or `cargo tauri signer generate`).
  Public key → `tauri.conf.json`. Private key + its password → **Gitea Actions secrets**
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — **never committed**.
- **Frontend updater UI** — a small Svelte component + store (`ui/src/lib/update/`):
  - On launch, call the updater check (via a thin Tauri command or the JS updater API).
  - If an update exists, show an unobtrusive banner/badge ("Update available — vX.Y.Z · Install")
    in the **Carbon+Green** style (reuses `Badge`/`Button`/tokens).
  - On click: download (show progress) → install → relaunch.
  - Errors surfaced in `--bad`; never block the app if the check fails (offline = silent).
- **Version injection hook** — document/wire how CI overrides the version (the source `version`
  stays `0.1.0`; CI passes `--config` or edits the version for nightly/stable builds).

**Acceptance (sub-project 1):** `cargo tauri build` still produces the Windows installer; the
updater + process plugins compile and register; `tauri.conf.json` is valid with the updater
config + pubkey; the Svelte update component renders (a forced "update available" mock shows
the prompt); the private key is NOT in the repo; `npm run check`/`test` + `cargo build` pass.

---

## 4. Sub-project 2 — Gitea Actions workflow

`.gitea/workflows/release.yml`, triggered on `push` to `master` (nightly) and on `push` of
tags `v*` (stable).

- **Matrix/jobs:** `build-linux` (runs-on `[self-hosted, linux]`) and `build-windows`
  (runs-on `[self-hosted, windows]`). Each: checkout → setup Rust + Node → `npm --prefix ui ci`
  + build → compute version (nightly `0.1.${{ gitea.run_number }}`; stable from the tag) →
  inject it → `cargo tauri build` with the signing env secrets → upload artifacts.
- **Publish job** (`needs: [build-linux, build-windows]`): download artifacts → create/update the
  Gitea release (via the Gitea API or the `gitea-release`/`forgejo` action) → attach installers +
  updater artifacts + `.sig` → build `latest.json` (version + per-platform `{url, signature}`) and
  attach it.
- **Secrets:** `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and a Gitea
  token for publishing (a repo/org Actions secret). Configured in Gitea repo settings.
- **Nightly hygiene:** the nightly release is a single rolling release (tag `nightly`) that the
  workflow force-updates each push (so it doesn't accumulate thousands of releases); stable
  releases are permanent per `vX.Y.Z`.

**Acceptance (sub-project 2):** a push to `master` triggers the workflow; both build jobs produce
signed artifacts; the publish job updates the `nightly` Gitea release with installers + a valid
`latest.json`; a pushed `vX.Y.Z` tag produces a stable release. (Requires sub-project 3 runners.)

---

## 5. Sub-project 3 — Runner infrastructure (Proxmox)

Proxmox VE 9.1.2 @ 192.168.1.232 (80 cores / 125 GiB) — accessed via `ssh -i ~/.ssh/id_proxmox_claude root@192.168.1.232`.

- **Linux runner (I provision):** an **LXC** from the local `ubuntu-22.04`/`debian-12` template
  (e.g. ~4 cores / 8 GiB / 30 GiB on `local-lvm`). Install: Rust (rustup), Node, Tauri Linux deps
  (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`, plus
  AppImage tooling), and **`act_runner`** registered to the Gitea repo with labels incl. `linux`.
  Runs as a service (always-on). *Note: AppImage build in LXC may need `fuse`/`--privileged` or
  `appimagetool --appimage-extract` mode — validated during setup.*
- **Windows runner (decide):** either a **Windows VM on Proxmox** (KVM; needs a Windows ISO +
  VirtIO drivers + interactive/unattended install, then Rust + MSVC Build Tools + Node + WebView2
  + `act_runner` service) — fully always-on; **or** `act_runner` on **this PC** (fast, but tied to
  the PC being on). Recommend starting with **this PC** to get the pipeline green end-to-end, then
  optionally migrate to a Proxmox Windows VM for always-on.
- **Registration:** obtain a runner registration token from Gitea (repo → Settings → Actions →
  Runners), register each `act_runner` with appropriate labels (`linux`, `windows`).

**Acceptance (sub-project 3):** both runners show **online** in Gitea repo Actions settings; a
test workflow job succeeds on each; the full release workflow completes end-to-end.

---

## 6. End-to-end verification (the real definition of done)
1. Push to `master` → workflow runs on the runners → nightly Gitea release updated with Win +
   Linux installers + `latest.json`.
2. Install the app from a release `.exe`/AppImage; launch it.
3. Push again (new nightly version) → on the app's next launch, the "Update available" prompt
   appears → approve → it downloads the signed update → verifies → relaunches into the new version.
4. Push a `vX.Y.Z` tag → a stable release is produced.
*(Steps 1, 3, 4 require the runners + a real session; this is owner-verified, like the streaming.)*

---

## 7. Risks / out of scope
- **macOS:** deferred (no Mac). The workflow/config are structured so a `build-macos` job +
  a Mac runner can be added later without rework.
- **OS code-signing:** out of scope — installers are unsigned (SmartScreen warning on Windows;
  AppImage runs freely on Linux). The **updater signature** (Tauri key) IS implemented — it's what
  makes auto-update safe.
- **Windows VM build cost:** Rust release builds are heavy; the VM needs adequate cores/RAM.
- **`.deb` is not auto-updatable** via the Tauri updater — AppImage is the update channel for Linux.
- **Secret management:** the signing private key lives only in Gitea Actions secrets; losing it
  means future updates can't be verified by already-installed apps (keep a backup of the key).
  The key was generated for sub-project 1 at `~/.tauri/xbox-remote-updater.key` (empty password);
  its contents → `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = empty.
- **Nightly noise:** the app follows **nightly** by default (per §1/§2) — intentional for a
  personal daily-driver, so every push to `master` prompts an update on next launch. If per-push
  prompting ever feels excessive, switch the configured endpoint to the stable channel.
- **Network reachability (verified 2026-06-09):** Gitea (`gitea.howlab.co`) is reachable only on
  LAN/Tailscale, and the repo is **public**. Confirmed: anonymous release-asset download returns
  HTTP 200 (no token needed) and the host serves a **publicly-trusted TLS cert**
  (`ssl_verify_result=0`), so the Tauri updater's strict-HTTPS download succeeds when on-network.
  Off-network, `checkForUpdate()` swallows the failure to `null` → the banner simply doesn't show
  (no error, no nag). CI runners + the publish job are on the same network, so they reach Gitea fine.
