//! Native Rust WebRTC media stack (Linux-first).
//!
//! See `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md`.
//!
//! ## Architecture (hexagonal / ports-and-adapters)
//!
//! A sans-IO [`engine`] (Phase 2) orchestrates str0m and depends *only* on the
//! trait seams defined in this module — never on concrete IO or codecs. Adding
//! an OS, swapping a decoder, or evolving the Xbox protocol therefore never
//! touches engine logic. The seams:
//!
//! - [`signaling::Signaling`] — the Xbox xHome control plane (session/SDP/ICE).
//! - [`transport::Transport`] — the UDP datagram socket str0m drives.
//! - [`media::VideoDecoder`] / [`media::AudioDecoder`] — encoded AU → frames.
//! - [`media::SharedFrame`] — cross-thread render seam (engine → GL thread).
//!
//! Pure protocol (`input`, `protocol`, `clip_tap`) carries no IO and is fully
//! unit-tested. These pure modules and the trait seams compile in the **default
//! build** (no codec/transport deps), so they can be tested without the ffmpeg/
//! str0m toolchain. Only the str0m/ffmpeg-backed engine and adapters (Phase 2+)
//! are gated behind the `native-webrtc` feature, keeping the default build lean.

#![allow(dead_code)] // Phase 0 skeleton: seams defined ahead of their adapters.

pub mod media;
pub mod signaling;
pub mod transport;

// Phase 1 (pure, TDD) — added with their tasks:
pub mod clip_tap;
pub mod input;
pub mod keepalive;
pub mod protocol;
pub mod stats;
pub mod watchdog;
// Phase 2+ (IO orchestration):
pub mod channels;
#[cfg(feature = "native-webrtc")]
pub mod engine;
pub mod state;

use thiserror::Error;

/// Errors surfaced by the native RTC engine. One variant per seam keeps failures
/// attributable to the layer that produced them.
#[derive(Debug, Error)]
pub enum RtcError {
    #[error("signaling error: {0}")]
    Signaling(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("session ended: {0}")]
    Ended(String),
}

pub type Result<T> = std::result::Result<T, RtcError>;

/// Lifecycle + diagnostics events the engine emits to the app layer (forwarded
/// to the UI over a Tauri event channel).
///
/// Deliberately carries **no pixel data** — decoded frames go straight to the
/// [`media::SharedFrame`] render seam in-process; shipping 1080p60 frames across the IPC
/// boundary is fatal to latency (see the render research in the plan). Only
/// control state and lightweight stats cross to the UI.
#[derive(Debug, Clone)]
pub enum RtcEvent {
    Connecting,
    Connected,
    /// First decoded video frame presented — UI leaves the "connecting" state.
    /// (Phase 2: emitted on the first *received* video AU; decode lands Phase 3.)
    FirstFrame,
    /// A reconnect attempt is starting (1-based attempt number).
    Reconnecting {
        attempt: u32,
    },
    Stats(StatsSnapshot),
    Disconnected(String),
}

/// Lightweight stats sample for the diagnostics HUD (cheap to clone/serialize).
#[derive(Debug, Clone, Default)]
pub struct StatsSnapshot {
    pub bitrate_kbps: u32,
    pub fps: u32,
    /// Phase 2: received-AU count until decode (Phase 3).
    pub frames_decoded: u64,
    pub freeze_count: u32,
}
