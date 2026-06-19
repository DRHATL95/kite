//! Unified logging: redaction, in-memory ring buffer, and the tracing sink that
//! writes every event (Rust + frontend) to a rotating file and the ring.

use std::sync::LazyLock;

use regex::Regex;

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap()
});
static TOKEN_KV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(authorization|refresh_token|access_token|token)\b\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}"?"#)
        .unwrap()
});
static SDP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"v=0[\s\S]*").unwrap());

/// Scrub secrets from a log message before it is persisted or shown. Idempotent.
pub fn redact(input: &str) -> String {
    let s = BEARER.replace_all(input, "Bearer [REDACTED]");
    let s = JWT.replace_all(&s, "[JWT REDACTED]");
    let s = TOKEN_KV.replace_all(&s, "$1=[REDACTED]");
    let s = SDP.replace_all(&s, |c: &regex::Captures| {
        format!("[SDP {} bytes redacted]", c[0].len())
    });
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
}
