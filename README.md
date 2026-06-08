# Xbox Remote

A desktop application for streaming Xbox consoles via Microsoft's cloud Remote Play service, built with Rust and Tauri. Implements the same protocol as [Greenlight](https://github.com/unknownskl/greenlight): OAuth device-code auth, the xHome REST API for session setup, and WebRTC for media. Developed on Windows, targeting cross-platform (Linux/macOS/Windows).

## Features

- **Cloud-based console discovery**: Finds your Xbox consoles via the xHome API — no local network scanning required
- **OAuth device-code sign-in**: Sign in with your Microsoft account using the standard device-code flow
- **WebRTC streaming**: Video and audio delivered via browser WebRTC data channels
- **Gamepad and keyboard input**: Forward controller and keyboard input back to the Xbox
- **Token persistence**: Stays logged in across sessions using the OS keychain
- **Modern UI**: Clean, responsive dark-theme interface built with vanilla HTML/CSS/JS

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

1. Clone the repository:
```powershell
git clone <your-repo-url>
cd xbox-remote
```

2. Build and run:
```powershell
cargo run
```

That's it. There are no feature flags. `cargo run` builds and launches the full Tauri app.

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
│   └── public/              # Tauri frontend (embedded at compile time)
│       ├── index.html
│       ├── styles.css
│       └── app.js           # Auth UI, WebRTC, input forwarding
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
- After changing `ui/public/` files, run `cargo clean -p xbox-remote` before rebuilding.

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
