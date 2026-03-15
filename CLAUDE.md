# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Xbox Remote is a desktop application for streaming Xbox audio/video, built with Rust and Tauri. It provides an alternative to Greenlight with improved connection handling and cross-platform support. The key focus is **avoiding circular JSON serialization errors** that plagued earlier implementations.

## Build & Development Commands

### CLI Mode (No UI)
```bash
# Build
cargo build --release

# Run discovery only
cargo run

# Run with debug logging
RUST_LOG=debug cargo run
```

### Tauri UI Mode
```bash
# Build with UI and streaming support
cargo build --release --features tauri

# Run with UI
cargo run --features tauri

# Run tests
cargo test
```

### Features
- `tauri` - Enables Tauri UI (optional)
- `gstreamer-support` - Enables video streaming with GStreamer (enabled by default)

### System Dependencies Required

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update && sudo apt-get install -y \
    build-essential \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-libav
```

## Architecture

### Module Structure

- **src/main.rs**: Entry point; runs CLI discovery or Tauri app
- **src/discovery/**: SSDP-based Xbox console discovery on local network
- **src/streaming/**: Connection and streaming session management
- **src/error.rs**: Centralized error types using `thiserror`
- **ui/public/**: Tauri frontend (HTML/CSS/JS)

### Key Design Patterns

**1. Safe JSON Serialization**

The codebase explicitly addresses circular JSON reference issues (a known problem in Greenlight). See `XboxConsole::to_json_safe()` in `src/discovery/mod.rs`:

```rust
pub fn to_json_safe(&self) -> Result<String> {
    // Creates safe JSON without circular refs by using a temporary struct
}
```

The `XboxConsole` struct has `#[serde(skip)]` on `last_seen: std::time::Instant` to prevent serialization errors. When sending console data between Rust and UI, always use `to_json_safe()`.

**2. Async Runtime**

All network operations use Tokio for non-blocking I/O. The discovery process uses a blocking `UdpSocket` with timeouts inside an async context via `tokio::time::sleep()`.

**3. Feature Flags**

- `tauri`: Enables Tauri UI and commands (optional)
- `gstreamer-support`: Enables GStreamer video/audio (optional, not fully implemented)

### Tauri Integration

Tauri commands are in `src/main.rs` under `#[cfg(feature = "tauri")]`. Commands:
- `discover_consoles`: Returns JSON-safe console list
- `connect_to_console`: Creates streaming session, returns session ID
- `start_stream`: Begins streaming, returns stream URL
- `stop_stream`: Stops streaming but maintains connection
- `disconnect`: Closes session completely

State is managed via `AppState` with `Mutex<XboxDiscovery>` and `Mutex<StreamingManager>`.

### Discovery Protocol

Xbox consoles are discovered via SSDP (Simple Service Discovery Protocol):
- Sends M-SEARCH to multicast address `239.255.255.250:1900`
- Search target: `urn:microsoft.com:service:X_MS_MediaReceiverRegistrar:1`
- Parses responses for Xbox identification and console type
- Default timeout: 10 seconds

### Streaming Protocol

Xbox SmartGlass protocol outline (src/streaming/mod.rs):
1. Connect to Xbox on port 5050
2. Request device capabilities at `/device`
3. Initiate session at `/streaming/session` with client_id and request_id (UUIDs)
4. Receive session_id for subsequent operations
5. Stream URL format: `http://{address}:5050/streaming/{session_id}`

**Note**: Full streaming implementation requires WebRTC or similar protocol integration with GStreamer (planned).

### Connection States

`ConnectionState` enum in `src/streaming/mod.rs`:
- `Disconnected`: No active connection
- `Connecting`: Handshake in progress
- `Connected`: Session established, ready to stream
- `Streaming`: Active video/audio stream
- `Error`: Connection failed

### Error Handling

All errors use `XboxError` enum from `src/error.rs`:
- `DiscoveryError`: SSDP/network discovery failures
- `ConnectionError`: SmartGlass connection issues
- `StreamError`: Streaming session problems
- `SerializationError`: JSON parsing (from `serde_json::Error`)
- `NetworkError`: HTTP requests (from `reqwest::Error`)
- `IoError`: Socket operations

Functions return `Result<T>` which is `std::result::Result<T, XboxError>`.

## Video Streaming Architecture

### Xbox Nano Protocol (`src/streaming/nano.rs`)
Implements the Xbox game streaming protocol based on [OpenXbox Nano documentation](https://openxbox.org/smartglass-documentation/nano/):
- **RTP over TCP/UDP**: TCP (port 5050) for control, UDP (port 5051) for media
- **Protocol handshakes**: Connection establishment with Xbox console
- **Channel management**: Opens Video and Audio channels
- **H.264/Opus codecs**: Video uses H.264, audio uses Opus or AAC

### GStreamer Pipeline (`src/streaming/video_receiver.rs`)
Receives and decodes Xbox video stream:
```
udpsrc (port 5051) → rtph264depay → h264parse → avdec_h264 →
videoconvert → jpegenc → multipartmux → tcpserversink (port 8080)
```
- Receives RTP packets from Xbox
- Decodes H.264 video
- Re-encodes to MJPEG for browser compatibility
- Serves via HTTP on localhost:8080

### Frontend Integration
- Detects local stream URLs (http://127.0.0.1:8080)
- Dynamically switches from `<video>` to `<img>` for MJPEG
- Displays stream status with color-coded messages

## Common Pitfalls

1. **Never serialize `XboxConsole` directly** - always use `to_json_safe()` to avoid `last_seen` field issues
2. **Port 5050/5051 assumption** - Xbox Nano uses these ports by default
3. **SSDP multicast** - Requires UDP port 1900 open and network discovery enabled
4. **Edition 2024** - Cargo.toml uses `edition = "2024"` (ensure compatible Rust version)
5. **GStreamer required** - Must have GStreamer 1.0 and plugins installed for video streaming
6. **Local HTTP server** - GStreamer serves on port 8080; ensure it's not blocked by firewall
7. **MJPEG format** - Browser receives MJPEG stream, not raw H.264 (for simplicity)
