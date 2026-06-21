// Hide the console window on Windows in release builds (keep it in debug so
// tracing logs are visible during development).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin binary shim. All application logic lives in the library crate
// (`src/lib.rs`) so that examples, integration tests, and future binaries can
// reuse the modules — Cargo's example/test/bin targets link against the
// library, not the binary. See `xbox_remote::run`.
fn main() {
    xbox_remote::run();
}
