# Kite

A lightweight desktop app for streaming your own Xbox console over the internet (Xbox Remote Play), built with Rust and Tauri. It implements the same protocol as [Greenlight](https://github.com/unknownskl/greenlight): OAuth sign-in, the xHome REST API for session setup, and WebRTC for media. Your console does the work; your PC just plays the stream.

## Download

**[⬇ Get the latest release](https://github.com/DRHATL95/kite/releases)** — download the Windows installer (`kite_<version>_x64-setup.exe`) and run it.

- **Windows** is the supported platform right now. Linux/macOS build from source (below); a native Linux build is planned.
- The installer isn't code-signed yet, so Windows SmartScreen warns **"Unknown publisher"** — click **More info → Run anyway**. (Code-signing is on the roadmap.)
- The app **auto-updates** after install — choose **Stable** or **Nightly** in Settings → Updates.

Requires an Xbox console with Remote Play enabled and the same Microsoft account.

## Features

- **Cloud console discovery** — finds your Xbox consoles via the xHome API; no local network scanning
- **OAuth device-code sign-in** — sign in with your Microsoft account; tokens persist in the OS keychain
- **WebRTC streaming** — video and audio as WebRTC media tracks; gamepad and keyboard input forwarded to the console
- **Resilient streaming** — a media-flow watchdog gates the "Streaming" state on real decoded frames and auto-recovers (keyframe nudge → reconnect, then an honest failure message) when a console stalls
- **Clipping (opt-in)** — save the last N seconds as a lossless, native **MP4** (H.264 + AAC). Taps the console's already-encoded video via WebRTC Insertable Streams and remuxes it in Rust, so capturing never disturbs the live stream; plays in the Xbox media player, Discord, and VLC
- **Modern UI** — Svelte 5 + TypeScript, a themeable "Signal Deck" design system (five themes), a dedicated settings view, minimize-to-tray, and an opt-in diagnostics HUD for live WebRTC stats
- **Auto-update with channels** — checks on launch and installs signed updates in-app; choose **Stable** or **Nightly** in Settings

## Prerequisites

### Rust
If you don't have Rust installed:
```powershell
# Windows (PowerShell)
winget install Rustlang.Rustup
```
Or visit [rustup.rs](https://rustup.rs). Requires Rust 1.85+ (edition 2024).

### Windows
- [MSVC Build Tools](https://visualstudio.microsoft.com/downloads/) (or Visual Studio)
- WebView2 runtime (pre-installed on Windows 11)

### Linux (Ubuntu/Debian)
```bash
sudo apt-get install -y \
    build-essential libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
```

### macOS
```bash
xcode-select --install
```

## Installation

1. Clone the repository:
```powershell
git clone https://github.com/DRHATL95/kite.git
cd kite
```

2. Build the frontend, then run:
```powershell
# First time only: enable pnpm (bundled with node via corepack)
corepack enable

# Install frontend dependencies (first time / after package.json changes)
pnpm --dir ui install

# Build the Svelte frontend → ui/dist (Tauri embeds this at compile time)
pnpm --dir ui run build

# Build and launch the Tauri app
cargo run
```

There are no feature flags. `cargo run` builds and launches the full Tauri app.

> **Important:** This project does not use the Tauri CLI / `tauri dev`, and Tauri
> embeds `ui/dist` at compile time. You must run `pnpm --dir ui run build` before
> `cargo run`, or the app will ship a stale/empty frontend. After any change under
> `ui/src/`, rebuild the frontend and run `cargo clean -p kite && cargo run`
> so the new assets are re-embedded.

## Usage

1. **Sign in**: Click "Sign in with Microsoft". A device code and URL appear. Visit the URL in your browser, enter the code, and sign in with your Xbox/Microsoft account.

2. **Discover consoles**: After sign-in the app fetches your consoles from Xbox's cloud API. You'll see console name, type, and power state.

3. **Stream**: Click "Stream" on a powered-on console. The app creates a session, exchanges SDP and ICE candidates with Xbox, and the video stream starts in the window.

4. **Input**: Gamepad and keyboard input is forwarded to the Xbox over a WebRTC data channel.

5. **Settings**: open Settings (gear on the console list) to switch theme, choose your update channel (**Stable** or **Nightly**), or sign out. During a stream, press `` ` `` to toggle the diagnostics HUD (fps, bitrate, RTT, packet loss, ICE state).

## Project Structure

```
kite/
├── src/
│   ├── main.rs              # Tauri entry point and command registration
│   ├── auth.rs              # OAuth device-code flow and token chain
│   ├── xhome.rs             # xHome REST API client
│   ├── token_store.rs       # OS keychain token persistence
│   └── error.rs             # Centralized error types
├── ui/                      # Svelte 5 + TypeScript + Vite frontend
│   ├── src/
│   │   ├── screens/         # Login, DeviceCode, ConsoleList, Stream
│   │   ├── components/      # StreamControls, StreamStatus, DiagnosticsHud
│   │   ├── lib/
│   │   │   ├── connection/  # ConnectionManager, WebRTC, input encoder
│   │   │   ├── ipc/         # Typed wrappers around Tauri commands
│   │   │   ├── stores/      # Svelte rune-based state stores
│   │   │   ├── update/      # In-app auto-update (tauri-plugin-updater)
│   │   │   └── design/      # Design-system foundation
│   │   └── main.ts
│   └── dist/                # Vite build output (embedded by Tauri at compile time)
├── Cargo.toml
├── tauri.conf.json
└── build.rs
```

## Troubleshooting

See [AZURE_SETUP.md](./AZURE_SETUP.md) to register your own Azure app client ID, and
[TECHNICAL_DETAILS.md](./TECHNICAL_DETAILS.md) for protocol and implementation notes.

### No Consoles Found

- Ensure your Xbox is signed in with the same Microsoft account
- Enable "Remote features" in Xbox Settings > Devices & streaming
- Ensure your Xbox has an internet connection

### Authentication Issues

- If auth never completes, verify the device code hasn't expired (codes are valid for ~15 minutes)
- Run `$env:RUST_LOG="debug"; cargo run` and look for token-exchange errors in the output
- See [AZURE_SETUP.md](./AZURE_SETUP.md) to configure your own Azure client ID

### Build Issues

- `edition = "2024"` requires Rust 1.85+. Run `rustup update stable`.
- After changing files under `ui/src/`, run `pnpm --dir ui run build`, then `cargo clean -p kite` before rebuilding so the new frontend assets are re-embedded.

## Development

### Running Tests
```powershell
# Rust backend tests
cargo test

# Frontend unit tests (Vitest) and type-check
pnpm --dir ui run test
pnpm --dir ui run check
```

### Debug Logging
```powershell
$env:RUST_LOG = "debug"
cargo run
```

### Overriding the Azure Client ID
```powershell
$env:XBOX_CLIENT_ID = "your-client-id"
cargo run
```

## Building a Windows Installer

Kite uses Tauri's NSIS bundler for Windows setup `.exe` releases. Build the frontend first so Tauri embeds the current `ui/dist` assets, then run the Tauri build from the repository root:

```powershell
pnpm --dir ui install
pnpm --dir ui run build
cargo tauri build
```

The installer is written to:

```text
target\release\bundle\nsis\Kite_<version>_x64-setup.exe
```

Windows installer builds require the normal Windows Tauri prerequisites: MSVC Build Tools and WebView2. The generated setup executable uses Tauri's WebView2 download bootstrapper when WebView2 is missing.

> Releases are produced by CI (GitHub Actions), not by hand: pushing to `dev`
> cuts a rolling **nightly**, and tagging `vX.Y.Z` cuts a permanent **stable**
> release. The in-app updater tracks whichever channel you pick in Settings.

## How It Works

The streaming protocol follows the same approach as Greenlight:

1. **Auth chain**: OAuth device-code → Microsoft Access Token → Xbox Live Token → XSTS Token (gssv audience)
2. **Console discovery**: `GET /v2/login/user` on the xHome API returns the console list
3. **Session**: `POST /v5/sessions/home/{serverId}/play` creates a session and returns an SDP offer
4. **WebRTC**: Frontend creates `RTCPeerConnection`, sends SDP answer and ICE candidates back via the xHome API
5. **Data channels**: Four channels opened — `chat`, `control`, `message`, `input`
6. **Keepalive**: Both a data-channel heartbeat and an API keepalive at the interval provided by Xbox

See [TECHNICAL_DETAILS.md](./TECHNICAL_DETAILS.md) for protocol and implementation notes.

## Disclaimer

Kite is an unofficial, third-party project — **not affiliated with, endorsed by, or sponsored by Microsoft or Xbox**. "Xbox" and related names are trademarks of Microsoft. Use it only with your own console and account, and in accordance with the [Microsoft Services Agreement](https://www.microsoft.com/servicesagreement).

## License

[MIT](./LICENSE) © David Howard. Provided as-is; use it responsibly and in accordance with Xbox's terms of service.

## Acknowledgments

Inspired by [Greenlight](https://github.com/unknownskl/greenlight) and [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player). Built with Rust and Tauri.
