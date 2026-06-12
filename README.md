# Xbox Remote

A desktop application for streaming Xbox consoles via Microsoft's cloud Remote Play service, built with Rust and Tauri. Implements the same protocol as [Greenlight](https://github.com/unknownskl/greenlight): OAuth device-code auth, the xHome REST API for session setup, and WebRTC for media. Developed on Windows, targeting cross-platform (Linux/macOS/Windows).

## Features

- **Cloud-based console discovery**: Finds your Xbox consoles via the xHome API — no local network scanning required
- **OAuth device-code sign-in**: Sign in with your Microsoft account using the standard device-code flow
- **WebRTC streaming**: Video and audio delivered via browser WebRTC data channels
- **Gamepad and keyboard input**: Forward controller and keyboard input back to the Xbox
- **Token persistence**: Stays logged in across sessions using the OS keychain
- **Modern UI**: Svelte 5 + TypeScript interface with a Carbon+Green design system and diagnostics HUD
- **Auto-update**: Checks for new releases on launch and updates itself in-app (signed updates via the Tauri updater)

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
    libappindicator3-dev librsvg2-dev patchelf
```

### macOS

```bash
xcode-select --install
```

## Installation

### Release Builds

The Gitea Actions release publishes a rolling `nightly` release for people you give access to:

- Windows: download and run `xbox-remote_<version>_x64-setup.exe`.
- Linux x64: download `xbox-remote_<version>_amd64.AppImage`, make it executable, then run it:

```bash
chmod +x xbox-remote_<version>_amd64.AppImage
./xbox-remote_<version>_amd64.AppImage
```

The in-app updater checks the `nightly` release manifest on launch. Linux updates use the AppImage artifact; `.deb` packages are not part of the updater path.

### From Source

1. Clone the repository:

```powershell
git clone <your-repo-url>
cd xbox-remote
```

2. Build and run:

```powershell
npm --prefix ui install
npm --prefix ui run build
cargo run
```

There are no feature flags. The frontend build writes `ui/dist`, which Tauri embeds when `cargo run` launches the app.

## Usage

1. **Sign in**: Click "Sign in with Microsoft". A device code and URL appear. Visit the URL in your browser, enter the code, and sign in with your Xbox/Microsoft account.

2. **Discover consoles**: After sign-in the app fetches your consoles from Xbox's cloud API. You'll see console name, type, and power state.

3. **Stream**: Click "Stream" on a powered-on console. The app creates a session, exchanges SDP and ICE candidates with Xbox, and the video stream starts in the window.

4. **Input**: Gamepad and keyboard input is forwarded to the Xbox over a WebRTC data channel.

## Project Structure

```
xbox-remote/
├── src/
│   ├── main.rs              # Tauri entry point and command registration
│   ├── auth.rs              # OAuth device-code flow and token chain
│   ├── xhome.rs             # xHome REST API client
│   ├── token_store.rs       # OS keychain token persistence
│   └── error.rs             # Centralized error types
├── ui/
│   ├── src/                 # Svelte 5 + TypeScript frontend
│   ├── index.html
│   └── dist/                # Built frontend embedded by Tauri
├── Cargo.toml
├── tauri.conf.json
└── build.rs
```

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for window visibility issues, WSL/display setup, and button-click debugging.

See [AZURE_SETUP.md](./AZURE_SETUP.md) if you need to register your own Azure app client ID.

See [TESTING_GUIDE.md](./TESTING_GUIDE.md) for the full test flow, expected console log sequences, and manual debug commands.

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
- After changing `ui/src/` files, run `npm --prefix ui run build`, then `cargo clean -p xbox-remote` before rebuilding.

## Development

### Running Tests

```powershell
cargo test
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

Xbox Remote uses Tauri's NSIS bundler for Windows setup `.exe` releases. Build the frontend first so Tauri embeds the current `ui/dist` assets, then run the Tauri build from the repository root:

```powershell
npm --prefix ui install
npm --prefix ui run build
cargo tauri build
```

The installer is written to:

```text
target\release\bundle\nsis\Xbox Remote_<version>_x64-setup.exe
```

Windows installer builds require the normal Windows Tauri prerequisites: MSVC Build Tools and WebView2. The generated setup executable uses Tauri's WebView2 download bootstrapper when WebView2 is missing.

## Building a Linux AppImage

Linux releases use Tauri's AppImage bundler, because that is the Linux format supported by the Tauri updater.

```bash
npm --prefix ui install
npm --prefix ui run build
cargo tauri build --bundles appimage
```

The AppImage is written to:

```text
target/release/bundle/appimage/
```

Ubuntu/Debian build hosts need the Linux prerequisites listed above. The Gitea Actions release workflow builds and publishes the AppImage as `xbox-remote_<version>_amd64.AppImage` alongside its `.sig` updater signature.

## How It Works

The streaming protocol follows the same approach as Greenlight:

1. **Auth chain**: OAuth device-code → Microsoft Access Token → Xbox Live Token → XSTS Token (gssv audience)
2. **Console discovery**: `GET /v2/login/user` on the xHome API returns the console list
3. **Session**: `POST /v5/sessions/home/{serverId}/play` creates a session and returns an SDP offer
4. **WebRTC**: Frontend creates `RTCPeerConnection`, sends SDP answer and ICE candidates back via the xHome API
5. **Data channels**: Four channels opened — `chat`, `control`, `message`, `input`
6. **Keepalive**: Both a data-channel heartbeat and an API keepalive at the interval provided by Xbox

See [TECHNICAL_DETAILS.md](./TECHNICAL_DETAILS.md) for implementation notes and [docs/ARCHITECTURE_RESEARCH.md](./docs/ARCHITECTURE_RESEARCH.md) for the initial protocol research that shaped this design.

## License

This project is open source. Please ensure compliance with Xbox's terms of service when using.

## Acknowledgments

Inspired by [Greenlight](https://github.com/unknownskl/greenlight) and [xbox-xcloud-player](https://github.com/unknownskl/xbox-xcloud-player). Built with Rust and Tauri.
