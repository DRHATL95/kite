//! Kite engine crate: everything that talks to Microsoft and the console, with no UI.
//!
//! The Tauri app (repo root) depends on this and re-exports these modules.

pub mod auth;
pub mod clip;
pub mod error;
// `rtc` compiles in the default build: its pure protocol modules (input/protocol/
// clip_tap) and trait seams carry no codec/transport deps and are unit-tested
// without the feature. Only the str0m/ffmpeg-backed engine + adapters inside it
// are gated behind `native-webrtc` (see src/rtc/mod.rs).
pub mod rtc;
pub mod token_store;
pub mod xhome;
