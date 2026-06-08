# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Xbox Remote is a desktop application for streaming Xbox consoles via Microsoft's cloud Remote Play service, built with Rust and Tauri. It implements the same protocol as [Greenlight](https://github.com/unknownskl/greenlight): OAuth device-code auth, the xHome REST API for session setup, and browser-side WebRTC for media. Developed on Windows, targeting cross-platform (Linux/macOS/Windows).

## Build & Run

```powershell
# Run the app (launches Tauri window)
cargo run

# Release build
cargo build --release

# Run tests
cargo test

# Override the default Azure app client ID
$env:XBOX_CLIENT_ID = "your-client-id-here"
cargo run
```

There are no feature flags. `cargo run` always builds the full Tauri app. Edition 2024 requires Rust 1.85+.

### System Dependencies

**Windows**: Install [MSVC Build Tools](https://visualstudio.microsoft.com/downloads/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 11).

**Linux (Ubuntu/Debian)**:
```bash
sudo apt-get install -y \
    build-essential libgtk-3-dev libwebkit2gtk-4.1-dev \
    libappindicator3-dev librsvg2-dev patchelf
```

**macOS**: Install Xcode Command Line Tools.

## Architecture

### How It Works

1. **OAuth device-code auth** (`src/auth.rs`): User clicks "Sign in". App requests a device code from Microsoft, displays it with a verification URL. Polls until the user completes sign-in in their browser. Chains tokens: Microsoft Access Token → Xbox Live Token → XSTS token (audience: `gssv`).

2. **Token storage** (`src/token_store.rs`): XSTS and refresh tokens are persisted in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service) so users stay logged in across sessions.

3. **Console discovery** (`src/xhome.rs`): Calls `GET /v2/login/user` on the xHome REST API with the XSTS token. Returns the list of consoles associated with the account. There is no local network discovery; everything is cloud-only.

4. **Session creation** (`src/xhome.rs`): `POST /v5/sessions/home/{serverId}/play` creates a streaming session. The response includes an SDP offer from Xbox and `keepAlivePulseInSeconds`.

5. **WebRTC in the browser** (`ui/public/app.js`): The frontend creates an `RTCPeerConnection`, sets the remote SDP offer, generates an SDP answer, and sends it back via `POST /{sessionPath}/sdp`. ICE candidates are exchanged via `POST /{sessionPath}/ice`. Four data channels are opened: `chat`, `control`, `message`, `input`. Video and audio flow as WebRTC media tracks.

6. **Keepalive** (`ui/public/app.js`): The session stays alive by sending a keepalive both on the WebRTC data channel and to the xHome API at the interval specified by `keepAlivePulseInSeconds` (with a 2-second safety margin, minimum 5 seconds).

### Module Structure

| File | Purpose |
|------|---------|
| `src/main.rs` | Tauri entry point; registers all Tauri commands |
| `src/auth.rs` | OAuth device-code flow, token chain, `check_auth_status` |
| `src/xhome.rs` | xHome REST API client: login, list consoles, create session, SDP/ICE exchange, keepalive |
| `src/token_store.rs` | OS keychain read/write for XSTS and refresh tokens |
| `src/error.rs` | `XboxError` enum with `thiserror` |
| `ui/public/app.js` | All frontend logic: auth UI, WebRTC peer connection, media display, gamepad/keyboard input forwarding |
| `ui/public/index.html` | Single-page shell; section divs for login/discovery/streaming/error |
| `ui/public/styles.css` | Dark theme styles |

### Tauri Commands (src/main.rs)

- `start_xbox_auth()` — initiates device code flow, returns `{ user_code, verification_uri }`
- `complete_xbox_auth(device_code)` — polls until auth completes, stores tokens
- `check_auth_status()` — returns `bool`; true if valid tokens exist
- `discover_xhome_consoles()` — returns JSON array of consoles from xHome API
- `create_xhome_session(console_id)` — creates session, returns SDP offer + session path + `keepAlivePulseInSeconds`
- `send_ice_candidate(session_path, candidate)` — forwards ICE candidate to xHome
- `send_sdp_answer(session_path, sdp)` — forwards SDP answer to xHome
- `send_keepalive(session_path)` — sends API-side keepalive

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
5. **Frontend rebuild** — Tauri embeds frontend files at compile time. After changing any file under `ui/public/`, run `cargo clean -p xbox-remote` then `cargo build` to pick up changes.
6. **Edition 2024** — requires Rust 1.85+. Run `rustup update stable` if the build fails with edition errors.

## Error Handling

All errors use `XboxError` from `src/error.rs`:
- `AuthError` — OAuth / token exchange failures
- `ApiError` — xHome REST API errors (includes HTTP status + body)
- `SerializationError` — JSON parsing (`serde_json::Error`)
- `NetworkError` — HTTP transport (`reqwest::Error`)
- `KeychainError` — OS keychain read/write failures
- `IoError` — file / socket operations

Functions return `Result<T>` which is `std::result::Result<T, XboxError>`.
