//! Pure helpers for the engine's API-side keepalive. The xHome keepalive is only
//! valid while the session is provisioning; once media flows, Xbox rejects it
//! with 400 / "SessionInUnexpectedState" (the data-channel traffic is the live
//! keepalive). Port of the stop condition in
//! `ui/src/lib/connection/ConnectionManager.ts` `_startApiKeepalive`.

/// Fixed keepalive cadence (s). Matches the browser's hardcoded 30 s; the Xbox
/// `keepAlivePulseInSeconds` hint is intentionally not used (the browser ignores
/// it too — 30 s is well inside the ~56 s expiry).
pub const API_KEEPALIVE_SECS: u64 = 30;

/// True if a keepalive error means we should stop pulsing (session moved past
/// provisioning). Transient/network errors return false (keep trying).
pub fn keepalive_should_stop(err: &str) -> bool {
    err.contains("400") || err.contains("SessionInUnexpectedState")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_on_session_in_unexpected_state() {
        assert!(keepalive_should_stop("keepalive: ApiError 400 SessionInUnexpectedState"));
    }

    #[test]
    fn stops_on_400() {
        assert!(keepalive_should_stop("keepalive: HTTP 400 Bad Request"));
    }

    #[test]
    fn keeps_going_on_transient_errors() {
        assert!(!keepalive_should_stop("keepalive: network timeout"));
        assert!(!keepalive_should_stop("keepalive: HTTP 503"));
    }
}
