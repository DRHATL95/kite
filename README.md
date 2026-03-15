# Xbox Remote

A desktop application for streaming Xbox audio/video, built with Rust and Tauri. This project aims to provide a reliable alternative to Greenlight with improved connection handling and cross-platform support.

## Features

- **Xbox Discovery**: Automatically find Xbox consoles on your local network using SSDP
- **Robust Connection**: Proper error handling to avoid circular JSON errors
- **Streaming**: Video and audio streaming from Xbox consoles
- **Modern UI**: Clean, responsive interface built with HTML/CSS/JS
- **Cross-Platform**: Works on Linux, Windows, and macOS

## Prerequisites

### System Dependencies

#### Linux (Ubuntu/Debian)
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

#### macOS
```bash
brew install gstreamer gst-plugins-base gst-plugins-good gst-libav
```

#### Windows
- Install [MSVC Build Tools](https://visualstudio.microsoft.com/downloads/)
- Install [GStreamer](https://gstreamer.freedesktop.org/download/)

### Rust
This project uses Rust. If you don't have it installed:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd xbox-remote
```

2. Build the project:
```bash
# For CLI-only version (no UI)
cargo build --release

# For Tauri UI version
cargo build --release --features tauri
```

3. Run the application:
```bash
# CLI version
cargo run --release

# Tauri UI version
cargo run --release --features tauri
```

## Usage

### CLI Mode

The CLI mode allows you to test Xbox discovery without the UI:

```bash
cargo run
```

This will scan your network for Xbox consoles and display any found devices.

### GUI Mode

To run the full application with the graphical interface:

```bash
cargo run --features tauri
```

The application will:
1. Start with the discovery screen
2. Scan for Xbox consoles on your network
3. Allow you to connect to a discovered console
4. Enable streaming once connected

## Project Structure

```
xbox-remote/
├── src/
│   ├── main.rs              # Main application entry point
│   ├── error.rs             # Error types and handling
│   ├── discovery/           # Xbox console discovery
│   │   └── mod.rs
│   └── streaming/           # Streaming and connection logic
│       ├── mod.rs
│       └── gstreamer_player.rs
├── ui/
│   └── public/              # Tauri frontend
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── Cargo.toml               # Rust dependencies
├── tauri.conf.json          # Tauri configuration
└── build.rs                 # Build script
```

## Key Features

### 1. Xbox Discovery
Uses SSDP (Simple Service Discovery Protocol) to find Xbox consoles on the local network. Avoids the circular JSON serialization errors that can occur with naive implementations.

### 2. Safe JSON Handling
The `XboxConsole` type includes a `to_json_safe()` method that creates a serialization-safe representation, preventing circular reference issues.

```rust
pub fn to_json_safe(&self) -> Result<String> {
    // Creates a safe JSON representation without circular refs
}
```

### 3. Connection Management
Robust connection handling with proper state management and error recovery.

### 4. Async Runtime
Uses Tokio for asynchronous operations, providing non-blocking network I/O.

## Troubleshooting

### No Consoles Found

If no Xbox consoles are discovered:

1. **Ensure Xbox is on**: The console must be powered on and connected to the network
2. **Same network**: Your PC and Xbox must be on the same local network
3. **Enable Remote Play**: On your Xbox, go to Settings > Devices & streaming > Remote features > Enable remote features
4. **Firewall**: Ensure UDP port 1900 (SSDP) is not blocked
5. **Network discovery**: On Windows, ensure network discovery is enabled

### Connection Errors

Common connection issues:

1. **Circular JSON Error**: This version addresses the circular JSON serialization issue found in Greenlight by using safe serialization methods
2. **Timeout**: Increase the timeout in `src/discovery/mod.rs` if your network is slow
3. **Authentication**: Some Xbox features require authentication through Xbox Live

### Linux-Specific Issues

- **GStreamer plugins**: Ensure all required GStreamer plugins are installed
- **Permissions**: You may need to run with appropriate network permissions
- **Wayland vs X11**: If you experience display issues, try running under X11

### Building Issues

- **Missing linker**: Install build-essential (Linux) or MSVC (Windows)
- **GTK errors**: Install required GTK development packages
- **GStreamer not found**: Ensure GStreamer development packages are installed

## Development

### Running Tests
```bash
cargo test
```

### Running with Debug Logging
```bash
RUST_LOG=debug cargo run
```

### Code Structure

- **Error Handling**: Uses `thiserror` for clean error types
- **Async**: All network operations are async using Tokio
- **Serialization**: Uses `serde` with careful attention to avoiding circular references
- **Logging**: Uses `tracing` for structured logging

## Comparison with Greenlight

Key improvements over Greenlight:

1. **Circular JSON Fix**: Proper JSON serialization without circular references
2. **Better Error Messages**: Clear, actionable error messages
3. **Rust Performance**: Leverages Rust's performance and safety
4. **Cross-Platform**: Works consistently across Linux, Windows, and macOS
5. **Modular Design**: Clean separation of concerns for easier maintenance

## Contributing

Contributions are welcome! Areas for improvement:

- [ ] Full GStreamer integration for actual video playback
- [ ] Input handling (controller/keyboard forwarding)
- [ ] Authentication with Xbox Live
- [ ] Settings and configuration persistence
- [ ] Multiple simultaneous streams
- [ ] Performance optimizations
- [ ] Better error recovery

## License

This project is open source. Please ensure compliance with Xbox's terms of service when using.

## Acknowledgments

Inspired by Greenlight and other Xbox streaming projects. Built with Rust, Tauri, and GStreamer.

## Version History

- **v0.1.0**: Initial release
  - Xbox console discovery
  - Basic connection handling
  - Tauri UI framework
  - Safe JSON serialization
