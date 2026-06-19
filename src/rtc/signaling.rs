//! Signaling seam: the Xbox xHome control plane (create session, exchange
//! SDP/ICE, keepalive).
//!
//! Abstracted so the engine binds to this trait rather than the concrete HTTP
//! client — enabling a mock in tests and insulating the engine from protocol
//! changes. The production adapter (`XHomeSignaling`, Phase 2) wraps the
//! existing [`crate::xhome`] client; the HTTP, response-shape tolerance, and
//! ICE `a=`-prefix/stringified-array quirks already handled there are reused
//! verbatim.
//!
//! The engine is generic over `S: Signaling` (static dispatch), so `async fn` in
//! the trait needs no boxing.

use super::Result;

/// Identifies an active streaming session and the path used for SDP/ICE/keepalive.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub session_path: String,
    /// From the session configuration response; drives keepalive cadence.
    pub keepalive_pulse_secs: u32,
}

/// A remote ICE candidate received from Xbox (already prefix-stripped/parsed).
#[derive(Debug, Clone)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: String,
    pub sdp_m_line_index: u32,
}

/// The Xbox control plane the engine drives. We are the **offerer**: create the
/// session, POST our SDP offer, receive Xbox's answer, then exchange ICE.
#[allow(async_fn_in_trait)] // generic engine uses static dispatch; no Send-boxing needed.
pub trait Signaling: Send {
    /// Create a streaming session for the given console, polling until ready.
    async fn create_session(&self, server_id: &str) -> Result<SessionInfo>;

    /// POST our SDP **offer**; returns Xbox's SDP **answer**.
    async fn exchange_sdp(&self, session: &SessionInfo, offer_sdp: &str) -> Result<String>;

    /// POST one local ICE candidate to Xbox.
    async fn send_ice(&self, session: &SessionInfo, candidate: &str) -> Result<()>;

    /// Poll for remote ICE candidates Xbox has queued.
    async fn poll_ice(&self, session: &SessionInfo) -> Result<Vec<IceCandidate>>;

    /// API-side keepalive (valid only while the session is provisioning).
    async fn keepalive(&self, session: &SessionInfo) -> Result<()>;
}
