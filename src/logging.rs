//! Unified logging: redaction, in-memory ring buffer, and the tracing sink that
//! writes every event (Rust + frontend) to a rotating file and the ring.

use std::sync::LazyLock;

use regex::Regex;

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap()
});
// JSON form: "sensitiveKey": "value"  (handles the quote between key and colon)
static KV_QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)"(authorization|refresh_token|access_token|auth_token|accesstoken|authtoken|token|xsts)"\s*:\s*"[^"]*""#).unwrap()
});
// Unquoted / header / query form: key=value or key: value (value runs to end-of-value)
static KV_UNQUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(authorization|refresh_token|access_token|auth_token|accesstoken|authtoken|token|xsts)\b\s*[:=]\s*"?([^\r\n,}\]"]+)"?"#).unwrap()
});
// Sensitive standalone SDP attribute lines (candidate/IP lines are intentionally KEPT).
static SDP_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^(\s*a=(?:ice-pwd|fingerprint))\s*:.*$").unwrap()
});
// Whole SDP blob, bounded at a blank line or end-of-string (not greedy past it).
static SDP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"v=0[\s\S]*?(?:\r?\n\r?\n|$)").unwrap()
});

/// Scrub secrets from a log message before it is persisted or shown. Idempotent.
pub fn redact(input: &str) -> String {
    let s = BEARER.replace_all(input, "Bearer [REDACTED]");
    let s = JWT.replace_all(&s, "[JWT REDACTED]");
    let s = KV_QUOTED.replace_all(&s, |c: &regex::Captures| format!("\"{}\":\"[REDACTED]\"", &c[1]));
    let s = KV_UNQUOTED.replace_all(&s, |c: &regex::Captures| format!("{}=[REDACTED]", &c[1]));
    let s = SDP_ATTR.replace_all(&s, "$1:[REDACTED]");
    let s = SDP.replace_all(&s, |c: &regex::Captures| format!("[SDP {} bytes redacted]", c[0].len()));
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_jwt() {
        let jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM";
        let out = redact(&format!("Authorization: Bearer {jwt}"));
        assert!(!out.contains(jwt), "jwt leaked: {out}");
        assert!(out.contains("[REDACTED]") || out.contains("[JWT REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_token_kv() {
        let out = redact(r#"refresh_token: "M.C123_abcDEF456ghi""#);
        assert!(out.contains("refresh_token=[REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_sdp_blob() {
        let out = redact("offer v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\nm=audio 9 ...");
        assert!(out.contains("[SDP "), "{out}");
        assert!(!out.contains("m=audio"), "sdp leaked: {out}");
    }

    #[test]
    fn preserves_ordinary_text() {
        let msg = "state=connected status=200 keepAlive=30s gamertag=Player1";
        assert_eq!(redact(msg), msg);
    }

    #[test]
    fn redacts_json_quoted_token() {
        let out = redact(r#"resp {"Token":"AbCdEf0123456789opaqueXSTS"}"#);
        assert!(!out.contains("AbCdEf0123456789opaqueXSTS"), "leaked: {out}");
        assert!(out.contains("[REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_json_access_token_with_space() {
        let out = redact(r#"{"access_token": "EwAoA8secretvalue123"}"#);
        assert!(!out.contains("EwAoA8secretvalue123"), "leaked: {out}");
    }

    #[test]
    fn redacts_opaque_authorization_header() {
        let out = redact("Authorization: XBL3.0 x=uhs;EwAoSecretXstsToken99");
        assert!(!out.contains("EwAoSecretXstsToken99"), "leaked: {out}");
    }

    #[test]
    fn redacts_sdp_ice_pwd_but_keeps_candidate_ip() {
        let out = redact("a=ice-pwd:SuperSecretIcePwd123\r\na=candidate:1 1 udp 2 192.168.1.5 9 typ host");
        assert!(!out.contains("SuperSecretIcePwd123"), "ice-pwd leaked: {out}");
        assert!(out.contains("192.168.1.5"), "LAN candidate IP should be preserved: {out}");
    }
}
