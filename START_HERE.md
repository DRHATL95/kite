# Xbox Remote - Start Here

## What This Is

Xbox Remote streams your Xbox console via Microsoft's cloud Remote Play service. It uses OAuth device-code auth, the xHome REST API for session setup, and WebRTC for media — the same protocol as [Greenlight](https://github.com/unknownskl/greenlight). Developed on Windows, targeting cross-platform.

## Quick Start

```powershell
cargo run
```

That's all. No feature flags, no separate CLI mode. `cargo run` builds and launches the Tauri app.

## What Should Happen

1. A window titled "Xbox Remote" appears
2. Click **"Sign in with Microsoft"**
3. A device code and verification URL are displayed
4. Visit the URL in your browser, enter the code, sign in with your Xbox/Microsoft account
5. Your Xbox consoles appear in the list
6. Click **"Stream"** on a powered-on console
7. Video streams via WebRTC

## If the Window Doesn't Appear

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for comprehensive help including WSL/display issues and browser console debugging.

Quick checks (Windows):
```powershell
# Is the process running?
Get-Process xbox-remote -ErrorAction SilentlyContinue

# Run with debug logging
$env:RUST_LOG = "debug"
cargo run
```

## Debugging Tools

The app has extensive console logging. To see it:
1. Right-click anywhere in the Tauri window
2. Select "Inspect Element"
3. Go to the Console tab

You should see on startup:
```
Xbox Remote App - Starting...
Tauri available: true
DOM Content Loaded!
Checking auth status...
```

See [TESTING_GUIDE.md](TESTING_GUIDE.md) for the full expected log sequences and manual test commands.

## Architecture

```
┌───────────────────────────────────────────┐
│   Tauri Window (WebView2 on Windows)      │
│   ┌───────────────────────────────────┐   │
│   │  Frontend (ui/public/app.js)       │   │
│   │  - Device code auth UI             │   │
│   │  - WebRTC peer connection          │   │
│   │  - Video display                   │   │
│   │  - Gamepad/keyboard input          │   │
│   └───────────────────────────────────┘   │
│              ↕ Tauri Commands              │
│   ┌───────────────────────────────────┐   │
│   │  Backend (Rust)                    │   │
│   │  - auth.rs  (OAuth device code)    │   │
│   │  - xhome.rs (xHome REST API)       │   │
│   │  - token_store.rs (OS keychain)    │   │
│   └───────────────────────────────────┘   │
└───────────────────────────────────────────┘
              ↕
    Xbox xHome API (Microsoft cloud)
              ↕
    Your Xbox Console (via WebRTC)
```

## Build Info

- Rust edition 2024, requires Rust 1.85+
- Tauri v2
- Frontend: vanilla JavaScript + WebRTC APIs
- OS keychain for token persistence

## Key Files

| File | What it does |
|------|-------------|
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Full test flow and debug commands |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Window/display/button debugging |
| [TECHNICAL_DETAILS.md](TECHNICAL_DETAILS.md) | Implementation notes, API details |
| [AZURE_SETUP.md](AZURE_SETUP.md) | Register your own Azure client ID |
| [CLAUDE.md](CLAUDE.md) | Architecture reference for AI assistants |
