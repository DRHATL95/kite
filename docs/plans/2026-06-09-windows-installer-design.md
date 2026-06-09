# Windows Installer Design

## Goal

Create a repeatable Windows installer path for Xbox Remote using Tauri v2's built-in bundler.

## Context

Xbox Remote is a Rust/Tauri v2 desktop app with a Svelte/Vite frontend. The repository uses a root-level `Cargo.toml` and `tauri.conf.json`, not the common `src-tauri/` layout. The frontend must be built into `ui/dist` before Rust/Tauri embeds it.

The current configuration disables bundling with `"bundle.active": false`, so release builds produce an executable but no installer artifact.

## Chosen Approach

Use Tauri's NSIS Windows installer target first.

This produces a familiar setup `.exe`, keeps the packaging surface small, and avoids WiX/MSI-specific requirements. MSI can be added later if the project needs enterprise deployment support.

## Configuration

Update `tauri.conf.json` so:

- `bundle.active` is `true`
- `bundle.targets` is `["nsis"]`
- Windows installer settings are explicit enough for repeatable builds
- Existing product name, version, identifier, and icons remain the source of installer branding

## Release Flow

The installer build should run from the repository root:

```powershell
npm --prefix ui install
npm --prefix ui run build
cargo tauri build
```

Expected installer output:

```text
target\x86_64-pc-windows-msvc\release\bundle\nsis\
```

## Documentation

Update project documentation to explain the installer workflow, prerequisites, and output path. Keep development `cargo run` guidance intact because the installer path is for distribution, not local iteration.

## Verification

Run the existing frontend and Rust checks where possible:

```powershell
npm --prefix ui run check
npm --prefix ui run test
npm --prefix ui run build
cargo test
cargo tauri build
```

If the Tauri CLI is unavailable, install or invoke it according to the project's dependency setup before running the final bundling command.
