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

use super::{Result, RtcError};
use crate::auth::XboxAuth;
use crate::xhome::XHomeClient;
use tokio::sync::Mutex;

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

/// Pure map: xHome `StreamConfig` → seam `SessionInfo` (keepalive defaults to 0).
pub(crate) fn session_info_from(cfg: &crate::xhome::StreamConfig) -> SessionInfo {
    SessionInfo {
        session_id: cfg.session_id.clone(),
        session_path: cfg.session_path.clone(),
        keepalive_pulse_secs: cfg.keep_alive_pulse_seconds.unwrap_or(0),
    }
}

/// Pure map: xHome ICE candidate → seam ICE candidate.
pub(crate) fn ice_from(x: &crate::xhome::IceCandidate) -> IceCandidate {
    IceCandidate {
        candidate: x.candidate.clone(),
        sdp_mid: x.sdp_mid.clone(),
        sdp_m_line_index: x.sdp_m_line_index,
    }
}

/// Production `Signaling` adapter over the existing xHome HTTP client. The client
/// holds `&mut self` methods, so it lives behind a Mutex; the engine drives this
/// from a single thread, so contention is nil. NOTE: each call holds the guard
/// across its HTTP round-trip — safe and uncontended in the single-threaded
/// engine; revisit the lock scope if the engine ever issues concurrent calls.
pub struct XHomeSignaling {
    client: Mutex<XHomeClient>,
}

impl XHomeSignaling {
    /// Build + log in (resolves the region base URI + gsToken). `auth` must
    /// already hold valid cached tokens (loaded via `XboxAuth::load_cached_tokens`).
    pub async fn connect(auth: XboxAuth) -> Result<Self> {
        let mut client = XHomeClient::new(auth);
        client
            .login()
            .await
            .map_err(|e| RtcError::Signaling(format!("xHome login: {e}")))?;
        Ok(Self {
            client: Mutex::new(client),
        })
    }
}

impl Signaling for XHomeSignaling {
    async fn create_session(&self, server_id: &str) -> Result<SessionInfo> {
        let cfg = self
            .client
            .lock()
            .await
            .create_session(server_id, None)
            .await
            .map_err(|e| RtcError::Signaling(format!("create_session: {e}")))?;
        Ok(session_info_from(&cfg))
    }

    async fn exchange_sdp(&self, session: &SessionInfo, offer_sdp: &str) -> Result<String> {
        self.client
            .lock()
            .await
            .exchange_sdp_offer(&session.session_path, offer_sdp)
            .await
            .map_err(|e| RtcError::Signaling(format!("exchange_sdp: {e}")))
    }

    async fn send_ice(&self, session: &SessionInfo, candidate: &str) -> Result<()> {
        self.client
            .lock()
            .await
            .send_ice_candidate(&session.session_path, candidate)
            .await
            .map_err(|e| RtcError::Signaling(format!("send_ice: {e}")))
    }

    async fn poll_ice(&self, session: &SessionInfo) -> Result<Vec<IceCandidate>> {
        let cands = self
            .client
            .lock()
            .await
            .poll_ice_candidates(&session.session_path)
            .await
            .map_err(|e| RtcError::Signaling(format!("poll_ice: {e}")))?;
        Ok(cands.iter().map(ice_from).collect())
    }

    async fn keepalive(&self, session: &SessionInfo) -> Result<()> {
        self.client
            .lock()
            .await
            .send_keepalive(&session.session_path)
            .await
            .map_err(|e| RtcError::Signaling(format!("keepalive: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xhome::{IceCandidate as XIce, StreamConfig};

    #[test]
    fn maps_stream_config_to_session_info() {
        let cfg = StreamConfig {
            session_id: "S1".into(),
            session_path: "v5/sessions/home/S1".into(),
            exchange_response: String::new(),
            gs_token: "tok".into(),
            keep_alive_pulse_seconds: Some(300),
        };
        let info = session_info_from(&cfg);
        assert_eq!(info.session_id, "S1");
        assert_eq!(info.session_path, "v5/sessions/home/S1");
        assert_eq!(info.keepalive_pulse_secs, 300);
    }

    #[test]
    fn missing_keepalive_defaults_to_zero() {
        let cfg = StreamConfig {
            session_id: "S".into(),
            session_path: "p".into(),
            exchange_response: String::new(),
            gs_token: String::new(),
            keep_alive_pulse_seconds: None,
        };
        assert_eq!(session_info_from(&cfg).keepalive_pulse_secs, 0);
    }

    #[test]
    fn maps_xhome_ice_candidate() {
        let x = XIce {
            candidate: "candidate:1 1 udp …".into(),
            sdp_mid: "0".into(),
            sdp_m_line_index: 0,
        };
        let c = ice_from(&x);
        assert_eq!(c.candidate, "candidate:1 1 udp …");
        assert_eq!(c.sdp_mid, "0");
        assert_eq!(c.sdp_m_line_index, 0);
    }
}
