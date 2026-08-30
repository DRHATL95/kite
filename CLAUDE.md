# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kite is a desktop application for streaming Xbox consoles via Microsoft's cloud Remote Play service, built with Rust and Tauri. It implements the same protocol as [Greenlight](https://github.com/unknownskl/greenlight): OAuth device-code auth, the xHome REST API for session setup, and browser-side WebRTC for media. Developed on Windows, targeting cross-platform (Linux/macOS/Windows).

## Build & Run

This project does NOT use the Tauri CLI (the layout has `Cargo.toml` + `tauri.conf.json`
at the repo root, not under `src-tauri/`). Tauri embeds the pre-built frontend from
`ui/dist` at compile time, so the workflow is **build the frontend, then `cargo run`**:

```powershell
# First time only: enable pnpm (bundled with node via corepack)
corepack enable

# Install frontend dependencies (first time / after package.json changes)
pnpm --dir ui install

# 1) Build the frontend (Svelte → ui/dist, which Tauri embeds)
pnpm --dir ui run build

# 2) Run the app (embeds ui/dist and launches the Tauri window)
cargo run

# Release build
cargo build --release

# Windows NSIS installer (.exe)
pnpm --dir ui run build
cargo tauri build

# Run Rust tests
cargo test

# Override the default Azure app client ID
$env:XBOX_CLIENT_ID = "your-client-id-here"
cargo run
```

### Frontend Commands

```powershell
# Production build → ui/dist (embedded by Tauri; REQUIRED before cargo run)
pnpm --dir ui run build

# TypeScript + Svelte type-check
pnpm --dir ui run check

# Vitest unit tests
pnpm --dir ui run test
```

`cargo run` builds the full Tauri app with **default features**. Edition 2024 requires Rust 1.85+.

### Cargo Features

There is one optional feature, `native-webrtc` — the native Rust WebRTC media stack
(Linux-first). It is **opt-in** so the default build stays lean and doesn't need an
ffmpeg/str0m toolchain. It gates ten crates: `str0m`, `opus`, `ffmpeg-the-third`,
`bytes`, `cpal`, `gtk`, `glow`, `libloading`, `tao`, `wry`.

```powershell
cargo build --features native-webrtc
```

Five of those ten (`gtk`, `glow`, `libloading`, `tao`, `wry`) sit under
`[target.'cfg(target_os = "linux")'.dependencies]`, so **Linux is the only platform where
the whole set builds**. On Windows/macOS the feature pulls just `str0m`, `opus`,
`ffmpeg-the-third`, `bytes`, `cpal`.

**CI coverage.** `.github/workflows/ci.yml` has two Rust jobs, and the split matters:

| Job | Runner | Features | Covers |
|---|---|---|---|
| `rust` | windows-latest | default | everything except the ten crates above |
| `rust-native-webrtc` | ubuntu-latest | `native-webrtc` | all ten, plus the three gated examples |

The Linux job installs the FFmpeg/GTK/ALSA/Opus dev packages it needs, then runs
`cargo clippy --all-targets --features native-webrtc -- -D warnings` and
`cargo test --features native-webrtc`. `--all-targets` is load-bearing: the
`rtc_spike` / `render_spike` / `render_live` examples are `required-features` gated and
would otherwise never compile. `tests/rtc_e2e.rs` self-skips without `XBOX_E2E=1`.

> Before `rust-native-webrtc` existed, a dependency bump to any of those ten crates got
> **zero** automated verification and CI still went green — the trap that motivated the
> job. If you ever narrow or drop it, restore that warning here.

### Windows Installer

`tauri.conf.json` enables Tauri's NSIS bundler. To produce a setup `.exe`, build the frontend first and then run the Tauri build from the repository root:

```powershell
pnpm --dir ui install
pnpm --dir ui run build
cargo tauri build
```

The installer output is under (default host target):

```text
target\release\bundle\nsis\Kite_<version>_x64-setup.exe
```

Do not skip the frontend build; the installer embeds the current `ui/dist` output just like `cargo run` and `cargo build`.

### Releases & Auto-Update (CI/CD)

Releases are built by **GitHub Actions** (`.github/workflows/release.yml`) on a
**self-hosted** Linux runner (Proxmox LXC CT 106).

- **Single public repo**: `DRHATL95/kite` — source + CI + the release binaries.
  Public so the Tauri updater can fetch `latest.json` + installers anonymously
  (private-repo release assets aren't anonymously downloadable, which is why the
  old two-repo split existed; consolidated to one public repo 2026-06-30).

- **Branch model**: `dev` (nightly source) → `staging` (soak/integration, no
  build) → `main` (release, the **default branch**; tag `vX.Y.Z` on `main` to cut
  stable). Only `dev` pushes and `v*` tags trigger CI — pushing `main`/`staging`
  builds nothing. PRs target `dev`; promote `dev`→`main` via PR (main is
  branch-protected: require-PR + enforce-admins, no direct/force pushes) then tag.
- **Nightly**: every push to `dev` builds **both** platforms in one job and
  force-updates the rolling `nightly` release on this repo. Windows NSIS
  is cross-compiled (`cargo tauri build --runner cargo-xwin --target
  x86_64-pc-windows-msvc --bundles nsis`); the Linux AppImage is built natively
  on the same runner. Both updater artifacts are signed. Nightly version =
  `<target>-nightly.<run_number>` (committed `Cargo.toml` version = next
  unreleased `X.Y.Z`), injected via `--config` so the tree stays clean.
- **Stable**: pushing a `vX.Y.Z` tag (on `main`) cuts a permanent `vX.Y.Z`
  archive release **and** force-updates the rolling `stable` pointer. After cutting
  a stable, bump the committed target.
- **Publishing**: `scripts/ci/github-release.sh` (gh CLI) publishes to this repo's
  own Releases via the built-in `GITHUB_TOKEN` (`permissions: contents: write`;
  `RELEASES_REPO=${{ github.repository }}`) — ensure rolling release → upload
  binaries (`--clobber`) → swap `latest.json` last → prune stale assets.
- **In-app updates**: the app checks the active channel's `latest.json` on launch
  (`tauri-plugin-updater`; UI in `ui/src/lib/update/` + `UpdateBanner.svelte`).
  Two channels: `github.com/DRHATL95/kite/releases/download/{nightly,stable}/latest.json`.
  On Linux the updater only updates **AppImage** installs.
- **Secrets**: `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) for signing — public
  key embedded in `tauri.conf.json`. (The old cross-repo `RELEASES_TOKEN` PAT is
  no longer used — publishing is same-repo via `GITHUB_TOKEN`.) The signing
  private key lives at `~/.tauri/kite-updater.key` — keep a backup;
  **never commit it**.
- **Runner**: a self-hosted GitHub Actions runner on CT 106 (label set
  `[self-hosted, Linux, X64]`). Build deps baked in: clang/lld/llvm, nsis, rust
  target `x86_64-pc-windows-msvc`, `cargo-xwin`, warm xwin SDK cache, the GitHub
  CLI (`gh`) + `jq` (used by the publish scripts — `gh` is required; the publish
  step fails `gh: command not found` without it), plus the
  GTK/WebKit dev libs + AppImage tooling (`libgtk-3-dev libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2`). Use the
  **ayatana** appindicator, not legacy `libappindicator3-dev`.
  The full provisioning is codified in `scripts/runner/setup-ct106.sh` (the
  source of truth — re-run it to rebuild the box); the runner is on **Node 22**
  and runs as the unprivileged user **`ghrunner`** (not root) with a per-user
  rust toolchain in `/home/ghrunner/.cargo`.
- **Gotchas**: every `dev` push — even docs-only — produces a new nightly and an
  update prompt; `main`/`staging` pushes build nothing (stable is tag-cut on
  `main`). macOS is still build-from-source. The GitHub **default branch is
  `main`**; `.github/dependabot.yml` pins `target-branch: dev` for all three
  ecosystems (cargo, npm, github-actions) so dependency-update PRs land on `dev`
  (not the default) and flow through the normal release path.

> **Important — the frontend does NOT auto-rebuild.** There is no Tauri CLI / dev server
> here, and `tauri.conf.json` has no `devUrl`. After changing anything under `ui/src/`, run
> `pnpm --dir ui run build`, then `cargo clean -p kite && cargo run` so the new
> assets are re-embedded. Skipping the rebuild ships stale UI; skipping `cargo clean -p`
> can serve a cached copy. (A previous misconfiguration set `devUrl` without installing the
> Tauri CLI, which made `cargo run` show "localhost refused to connect" — removed.)

### System Dependencies

**Windows**: Install [MSVC Build Tools](https://visualstudio.microsoft.com/downloads/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 11).

**Linux (Ubuntu/Debian)** — build deps:
```bash
sudo apt-get install -y \
    build-essential libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
```

**Linux runtime — streaming codecs.** WebRTC video is decoded inside WebKitGTK's
GStreamer pipeline, so the H.264/WebRTC plugins must be installed or the stream
negotiates but renders **black** (the media-flow watchdog then reconnects in a loop):
```bash
sudo apt-get install -y \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav
# verify: gst-inspect-1.0 webrtcbin >/dev/null && echo "webrtcbin OK"
```

**Linux/Wayland.** WebKitGTK on native Wayland renders WebRTC video black and can
abort with "Gdk-Message: Error 71". The app therefore defaults to XWayland —
`src/main.rs` sets `GDK_BACKEND=x11` + `WEBKIT_DISABLE_COMPOSITING_MODE=1` on Linux
(each only if unset). Opt out with `KITE_NATIVE_WAYLAND=1` (legacy alias
`XBOX_REMOTE_NATIVE_WAYLAND=1`), or override either
variable directly. (NVIDIA users who want to keep native Wayland can instead try
`__NV_DISABLE_EXPLICIT_SYNC=1`.)

**macOS**: Install Xcode Command Line Tools.

## Architecture

### How It Works

1. **OAuth device-code auth** (`src/auth.rs`): User clicks "Sign in". App requests a device code from Microsoft, displays it with a verification URL. Polls until the user completes sign-in in their browser. Chains tokens: Microsoft Access Token → Xbox Live Token → XSTS token (audience: `gssv`).

2. **Token storage** (`src/token_store.rs`): XSTS and refresh tokens are persisted in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service) so users stay logged in across sessions.

3. **Console discovery** (`src/xhome.rs`): Calls `GET /v2/login/user` on the xHome REST API with the XSTS token. Returns the list of consoles associated with the account. There is no local network discovery; everything is cloud-only.

4. **Session creation** (`src/xhome.rs`): `POST /v5/sessions/home/{serverId}/play` creates a streaming session. The response includes an SDP offer from Xbox and `keepAlivePulseInSeconds`.

5. **WebRTC in the browser** (`ui/src/lib/connection/`): The frontend creates an `RTCPeerConnection`, sets the remote SDP offer, generates an SDP answer, and sends it back via `POST /{sessionPath}/sdp`. ICE candidates are exchanged via `POST /{sessionPath}/ice`. Four data channels are opened: `chat`, `control`, `message`, `input`. Video and audio flow as WebRTC media tracks. The `ConnectionManager` class orchestrates the full session lifecycle.

6. **Keepalive** (`ui/src/lib/connection/ConnectionManager.ts`): The session stays alive by sending a keepalive both on the WebRTC data channel and to the xHome API at the interval specified by `keepAlivePulseInSeconds` (with a 2-second safety margin, minimum 5 seconds).

7. **Clipping (opt-in)** (`ui/src/lib/clip/`): When enabled, an `EncodedTap` taps the console's already-encoded H.264 + Opus off the WebRTC receivers via **Insertable Streams** (`encodedInsertableStreams`) — no re-encode, so it never disturbs the live stream (the receiver transform always re-enqueues; a tap error can never break playback). On Clip it slices from the last keyframe, transcodes audio Opus→AAC with WebCodecs, and ships the encoded frames to Rust (`save_clip` → `src/clip.rs`), which remuxes them into a native fast-start **MP4** (H.264 + AAC) with `muxide`. Falls back to a HW-H.264 `MediaRecorder` (`ClipBuffer`) when Insertable Streams are unavailable. A/V is aligned on a shared wall-clock origin (a small residual, audio slightly behind video, is expected — likely AAC encoder priming).

### Module Structure

### Rust Backend (`src/`)

| File | Purpose |
|------|---------|
| `src/main.rs` | Tauri entry point; registers all Tauri commands |
| `src/auth.rs` | OAuth device-code flow, token chain, `check_auth_status` |
| `src/xhome.rs` | xHome REST API client: login, list consoles, create session, SDP/ICE exchange, keepalive |
| `src/token_store.rs` | OS keychain read/write for XSTS and refresh tokens |
| `src/clip.rs` | Clip payload parser + H.264/AAC remux to a native MP4 via `muxide` |
| `src/error.rs` | `XboxError` enum with `thiserror` |

### Frontend (`ui/src/`) — Svelte 5 + TypeScript + Vite

The frontend is a Svelte 5 app built with Vite. Production output goes to `ui/dist/`, which Tauri embeds. `ui/vite.config.ts` sets `publicDir: false` so the old `ui/public/` directory is not served.

| Path | Purpose |
|------|---------|
| `ui/src/lib/ipc/` | Typed wrappers around every Tauri command (`invoke`) |
| `ui/src/lib/connection/ConnectionManager.ts` | Orchestrates the full WebRTC session lifecycle |
| `ui/src/lib/connection/dataChannels.ts` | Data channel setup and protocol helpers |
| `ui/src/lib/connection/input.ts` | Gamepad/keyboard input encoder (38-byte packet format) |
| `ui/src/lib/connection/stats.ts` | WebRTC stats collection and bitrate calculation |
| `ui/src/lib/connection/constants.ts` | Protocol constants (channel names, timeouts, packet offsets) |
| `ui/src/lib/connection/messages.ts` | Structured message builders for data channels |
| `ui/src/lib/clip/` | Clipping: `EncodedTap` (encoded-frame ring buffers + keyframe-aligned assemble), `annexB`/`rtpTime`/`encodedTapLogic`/`clipPayload` (pure, unit-tested), `audioTranscode` (WebCodecs Opus→AAC on Clip), `ClipBuffer` (MediaRecorder HW-H.264 fallback) |
| `ui/src/lib/stores/` | Svelte 5 rune-based stores (app state, session, diagnostics) |
| `ui/src/lib/design/` | Design-system foundation (tokens, typography, spacing) |
| `ui/src/screens/` | Top-level screens: Login, DeviceCode, ConsoleList, Stream |
| `ui/src/components/` | Shared components: StreamControls, StreamStatus, DiagnosticsHud + HUD panels |

### Tauri Commands (src/main.rs)

- `start_xbox_auth()` — initiates device code flow, returns `{ user_code, verification_uri }`
- `complete_xbox_auth(device_code)` — polls until auth completes, stores tokens
- `check_auth_status()` — returns `bool`; true if valid tokens exist
- `discover_xhome_consoles()` — returns JSON array of consoles from xHome API
- `create_xhome_session(console_id)` — creates session, returns SDP offer + session path + `keepAlivePulseInSeconds`
- `send_ice_candidate(session_path, candidate)` — forwards ICE candidate to xHome
- `send_sdp_answer(session_path, sdp)` — forwards SDP answer to xHome
- `send_keepalive(session_path)` — sends API-side keepalive
- `save_clip(payload)` — remuxes an encoded-frame clip payload into an MP4 under `<Videos>/Kite Clips/` (or writes a fallback blob as-is); returns the saved path

### xHome API Endpoints

- **Region base**: `https://uks.core.gssv-play-prodxhome.xboxlive.com` (UK; region auto-detected at login)
- **Console list**: `GET /v2/login/user`
- **Create session**: `POST /v5/sessions/home/{serverId}/play`
- **ICE**: `POST /{sessionPath}/ice`
- **SDP**: `POST /{sessionPath}/sdp`
- **Keepalive**: `POST /{sessionPath}/keepalive`

### WebRTC Data Channels

| Channel | Purpose |
|---------|---------|
| `chat` | Heartbeat / connection health |
| `control` | Stream control messages (start, stop) |
| `message` | Protocol messages (init, config) |
| `input` | Gamepad and keyboard input to Xbox |

## Common Pitfalls

1. **Session URL must include serverId** — `POST /v5/sessions/home/{serverId}/play` not `/home/play`; omitting it returns a 404.
2. **XSTS audience** — must use `gssv` audience (`https://gssv.xboxlive.com/`) for the streaming XSTS token; the default Xbox Live audience will be rejected by the xHome API.
3. **Keepalive drift** — use `keepAlivePulseInSeconds` from the session config response, not a hardcoded interval; Xbox disconnects after ~56 seconds if the interval is wrong.
4. **Token expiry** — XSTS tokens expire in ~1 hour; call `check_auth_status()` before API calls and prompt re-auth if expired.
5. **Frontend rebuild** — Tauri embeds frontend files at compile time. After changing any file under `ui/src/`, run `pnpm --dir ui run build` (regenerates `ui/dist`), then `cargo clean -p kite && cargo run` so the new assets are re-embedded. Nothing rebuilds the frontend automatically — there is no Tauri CLI / `tauri dev` in this project.
6. **Edition 2024** — requires Rust 1.85+. Run `rustup update stable` if the build fails with edition errors.
7. **`glib` RUSTSEC-2024-0429 can't be fixed here** — the advisory wants `glib >= 0.20`, but `glib` comes in via `gtk` 0.18, and **`gtk` 0.18.2 is the final release of that crate** (unmaintained; upstream says "use gtk4 instead"). Tauri's own Linux backend (`wry`/`tao`) pulls the same GTK3 stack, so removing our optional `gtk` dep changes nothing. It needs Tauri to move to GTK4. Impact is limited: it's a crash-class unsoundness, the GTK deps are `cfg(target_os = "linux")` so the shipped Windows binary never compiles `glib`, and Linux is gated off (`BUILD_LINUX: 'false'`). **Dependabot alert #1 is dismissed** (`tolerable_risk`) — re-open it once a GTK4 backend exists. The `ignore` entry in `.github/dependabot.yml` documents the same reasoning and blocks *version* updates, but note it does **not** silence the security job: security updates run with `"ignore-conditions": []` regardless of that file (see pitfall 8), so dismissing the alert is the only thing that stops the recurring `security_update_not_possible` failure.
8. **Dependabot *security* updates ignore `target-branch`** — `.github/dependabot.yml` pins `target-branch: dev`, but that governs scheduled **version** updates only. Security updates always open against the **default branch (`main`)**. A Dependabot PR based on `main` is expected behavior, not a misconfigured target.
9. **Never tap WebRTC audio with `createMediaElementSource`** — in Chromium (and therefore WebView2), `AudioContext.createMediaElementSource(video)` yields a node carrying **zero samples** when the element's source is a `MediaStream` (`srcObject`), which is always the case here. It **does not throw**, so any `try`/`catch` fallback around it silently never fires: the graph looks live, the `GainNode` becomes the volume authority, and the slider goes inert (this shipped in v1.1.0–v1.2.0 as "volume slider does nothing"). Tap the stream instead — `createMediaStreamSource(connectionStore.mediaStream)`. Because a stream tap leaves the element's own output intact (an element tap would have re-routed it), the `<video>` must be muted while the graph is live or the audio plays twice, once at a level the slider can't reach. `ui/src/lib/connection/streamAudio.ts` owns that element state; nothing else may write `video.muted` / `video.volume` on the browser path.

## Error Handling

All errors use `XboxError` from `src/error.rs`:
- `AuthError` — OAuth / token exchange failures
- `ApiError` — xHome REST API errors (includes HTTP status + body)
- `SerializationError` — JSON parsing (`serde_json::Error`)
- `NetworkError` — HTTP transport (`reqwest::Error`)
- `KeychainError` — OS keychain read/write failures
- `IoError` — file / socket operations

Functions return `Result<T>` which is `std::result::Result<T, XboxError>`.
