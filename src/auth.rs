use crate::error::{Result, XboxError};
use crate::token_store::{KeyringBackend, TokenStore};
use base64::Engine;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// Default Azure AD app client ID for Xbox Live authentication.
///
/// This MUST be a third-party app registration you own (personal-accounts,
/// "Allow public client flows" enabled). A Microsoft first-party client ID is
/// rejected for fresh user consent ("users are not permitted to consent to
/// first party applications") even though it still works for token refresh.
/// Register at https://portal.azure.com -> App registrations.
/// Override at runtime with the XBOX_CLIENT_ID environment variable.
const DEFAULT_CLIENT_ID: &str = "cd779487-1790-4b69-8304-d845a52c9b79";

/// Pure resolver (testable): env value if present and non-empty, else the default.
fn resolve_client_id_from(env: Option<String>) -> String {
    env.filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// Resolve the client ID, honoring the XBOX_CLIENT_ID env override.
fn resolve_client_id() -> String {
    resolve_client_id_from(std::env::var("XBOX_CLIENT_ID").ok())
}

/// Token cache filename
const TOKEN_CACHE_FILE: &str = "xbox_tokens.json";

/// Xbox Live authentication tokens
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XboxTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub xsts_token: String,
    pub user_hash: String,
    pub expires_at: DateTime<Utc>,
}

/// Xbox Live authentication client using OAuth2 device code flow
#[derive(Clone)]
pub struct XboxAuth {
    client: Client,
    tokens: Arc<Mutex<Option<XboxTokens>>>,
    /// Last failure from the background authorization-code task. The UI polls
    /// token validity (`is_authenticated`) and otherwise cannot see *why* a
    /// sign-in died; the task records the reason here and the UI drains it via
    /// [`XboxAuth::take_flow_error`] to show a real error instead of waiting
    /// forever. Shared (`Arc`) so the spawned `self.clone()` writes where the
    /// managed instance reads.
    flow_error: Arc<Mutex<Option<String>>>,
}

/// Token endpoint response (authorization-code exchange and refresh share it).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
}

/// PKCE pair: the verifier (kept secret, sent only at token exchange) and the
/// S256 challenge (public, sent in the authorize URL).
struct Pkce {
    verifier: String,
    challenge: String,
}

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Generate a PKCE verifier (32 random bytes, base64url) and its SHA-256 challenge.
fn generate_pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS RNG unavailable");
    let verifier = B64URL.encode(bytes);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

/// Random opaque `state` for CSRF protection on the redirect.
fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS RNG unavailable");
    B64URL.encode(bytes)
}

/// Percent-encode a query value per RFC 3986 (unreserved chars pass through).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Decode a percent-encoded query value (`+` → space).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(h) => {
                    out.push(h);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Render an error together with its full `source()` chain.
///
/// `reqwest` collapses the useful cause (DNS failure, connection refused, TLS
/// error) under a generic top-level `"error sending request for url (...)"`, so
/// logging only `{e}` hides *why* a request failed. Walking the chain surfaces
/// the real cause — e.g. a DNS sinkhole shows up as a trailing `": ... dns ..."`.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

/// Parse the loopback redirect's HTTP request line into `(code, state)`,
/// surfacing an `error` query param (e.g. user-declined consent) as an error.
fn parse_redirect_query(request: &str) -> Result<(String, String)> {
    let first_line = request.lines().next().unwrap_or("");
    // e.g. "GET /?code=...&state=... HTTP/1.1"
    let target = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "code" => code = Some(percent_decode(v)),
            "state" => state = Some(percent_decode(v)),
            "error" => error = Some(percent_decode(v)),
            _ => {}
        }
    }

    if let Some(e) = error {
        return Err(XboxError::AuthError(format!(
            "Sign-in was not completed: {e}"
        )));
    }
    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err(XboxError::AuthError(
            "Redirect was missing the authorization code".to_string(),
        )),
    }
}

/// Xbox Live authentication response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxLiveAuthResponse {
    token: String,
    display_claims: DisplayClaims,
}

#[derive(Debug, Deserialize)]
struct DisplayClaims {
    xui: Vec<UserInfo>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    uhs: String,
}

/// XSTS authorization response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XSTSAuthResponse {
    token: String,
    display_claims: DisplayClaims,
}

impl XboxAuth {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            tokens: Arc::new(Mutex::new(None)),
            flow_error: Arc::new(Mutex::new(None)),
        }
    }

    /// Path to the pre-keychain plaintext token file (used only for one-time migration).
    fn legacy_cache_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("xbox-remote").join(TOKEN_CACHE_FILE))
    }

    fn token_store() -> Result<TokenStore<KeyringBackend>> {
        Ok(TokenStore::new(
            KeyringBackend::new()?,
            Self::legacy_cache_path(),
        ))
    }

    /// Load cached tokens from the OS keychain (with one-time migration from legacy file).
    pub async fn load_cached_tokens(&self) -> Result<bool> {
        let store = Self::token_store()?;
        let tokens = match store.load()? {
            Some(t) => t,
            None => return Ok(false),
        };

        // Check if tokens are still valid (with 5 min buffer)
        if tokens.expires_at > Utc::now() + chrono::Duration::minutes(5) {
            info!("Cached tokens are still valid");
            *self.tokens.lock().await = Some(tokens);
            return Ok(true);
        }

        // Try to refresh if we have a refresh token
        if let Some(ref refresh_token) = tokens.refresh_token {
            info!("Cached tokens expired, attempting refresh...");
            match self.refresh_tokens(refresh_token).await {
                Ok(()) => return Ok(true),
                Err(e) => {
                    warn!("Failed to refresh tokens: {}", e);
                    if let Err(clear_err) = store.clear() {
                        warn!(
                            "Failed to clear expired tokens from keychain: {}",
                            clear_err
                        );
                    }
                }
            }
        }

        Ok(false)
    }

    /// Save tokens to the OS keychain.
    async fn save_tokens_to_cache(&self) -> Result<()> {
        let tokens = self.tokens.lock().await;
        if let Some(ref tokens) = *tokens {
            Self::token_store()?.save(tokens)?;
            info!("Saved tokens to OS keychain");
        }
        Ok(())
    }

    /// Refresh tokens using refresh token
    async fn refresh_tokens(&self, refresh_token: &str) -> Result<()> {
        info!("Refreshing access token...");

        let client_id = resolve_client_id();
        let params = [
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", "XboxLive.signin XboxLive.offline_access"),
        ];

        let response = self
            .client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| XboxError::AuthError(format!("Token refresh failed: {}", error_chain(&e))))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!(
                "Token refresh failed: {}",
                error_text
            )));
        }

        let poll_response = response.json::<TokenResponse>().await.map_err(|e| {
            XboxError::AuthError(format!("Failed to parse refresh response: {}", e))
        })?;

        if let Some(access_token) = poll_response.access_token {
            // Exchange for Xbox Live tokens
            let xbox_token = self.authenticate_xbox_live(&access_token).await?;
            let xsts_token = self.get_xsts_token(&xbox_token.token).await?;

            let tokens = XboxTokens {
                access_token,
                refresh_token: poll_response
                    .refresh_token
                    .or(Some(refresh_token.to_string())),
                xsts_token: xsts_token.token,
                user_hash: xsts_token.display_claims.xui[0].uhs.clone(),
                expires_at: Utc::now()
                    + chrono::Duration::seconds(poll_response.expires_in.unwrap_or(3600)),
            };

            *self.tokens.lock().await = Some(tokens);
            self.save_tokens_to_cache().await?;
            return Ok(());
        }

        Err(XboxError::AuthError(
            "No access token in refresh response".to_string(),
        ))
    }

    /// Start the OAuth2 authorization-code (+ PKCE) sign-in flow.
    ///
    /// Xbox Live's `XboxLive.signin` scope is NOT grantable via the device-code
    /// flow for third-party apps (it demands resource pre-authorization — the
    /// "first party application" error); the authorization-code flow with an
    /// interactive consent screen is the supported path.
    ///
    /// Binds an ephemeral `http://localhost:<port>` loopback listener to catch
    /// the redirect, returns the authorize URL for the caller to open in the
    /// browser, and spawns a task that awaits the redirect, exchanges the code
    /// (PKCE), runs the Xbox Live → XSTS chain, and stores the tokens. The caller
    /// polls `check_auth_status` to learn when it has completed.
    pub async fn start_auth_code_flow(&self) -> Result<String> {
        info!("Starting Xbox Live OAuth authorization-code flow");

        // Clear any failure from a previous attempt so the polling UI never sees
        // a stale error from the last sign-in.
        *self.flow_error.lock().await = None;

        let client_id = resolve_client_id();
        let pkce = generate_pkce();
        let state = generate_state();

        // Loopback listener on an ephemeral port (RFC 8252 native-app redirect).
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
            XboxError::AuthError(format!("Failed to bind loopback listener: {}", e))
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| XboxError::AuthError(format!("Failed to read loopback port: {}", e)))?
            .port();
        let redirect_uri = format!("http://localhost:{port}");

        let scope = "XboxLive.signin XboxLive.offline_access";
        let authorize_url = format!(
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize\
             ?client_id={cid}&response_type=code&redirect_uri={redirect}&response_mode=query\
             &scope={scope}&code_challenge={challenge}&code_challenge_method=S256&state={state}",
            cid = percent_encode(&client_id),
            redirect = percent_encode(&redirect_uri),
            scope = percent_encode(scope),
            challenge = pkce.challenge,
            state = percent_encode(&state),
        );

        info!("Authorize URL prepared; awaiting browser redirect on {redirect_uri}");

        // Wait + exchange off-thread so the command returns the URL immediately.
        let auth_clone = self.clone();
        let verifier = pkce.verifier;
        tokio::spawn(async move {
            if let Err(e) = auth_clone
                .await_redirect_and_exchange(listener, client_id, redirect_uri, verifier, state)
                .await
            {
                let msg = e.to_string();
                tracing::error!("Authorization-code sign-in failed: {}", msg);
                // Record it so the polling UI can surface a real error and stop,
                // instead of waiting indefinitely with no feedback.
                *auth_clone.flow_error.lock().await = Some(msg);
            }
        });

        Ok(authorize_url)
    }

    /// Await the single loopback redirect, validate `state`, exchange the code
    /// for tokens, run the Xbox Live → XSTS chain, and persist.
    async fn await_redirect_and_exchange(
        &self,
        listener: TcpListener,
        client_id: String,
        redirect_uri: String,
        verifier: String,
        expected_state: String,
    ) -> Result<()> {
        // Cap the wait so a never-completed sign-in doesn't leak the listener.
        let (mut stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
                .await
                .map_err(|_| {
                    XboxError::AuthError("Sign-in timed out (no redirect received)".to_string())
                })?
                .map_err(|e| XboxError::AuthError(format!("Loopback accept failed: {}", e)))?;

        let mut buf = vec![0u8; 8192];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to read redirect: {}", e)))?;
        let request = String::from_utf8_lossy(&buf[..n]);

        // Run the *entire* exchange before answering the browser, so the page can
        // tell the truth. Previously the success page was sent the moment a code
        // came back — even when the token exchange then failed (e.g. a DNS-blocked
        // login endpoint), telling the user "signed in" while the app silently
        // never advanced. A few seconds of HTTP wait is well within browser limits.
        let outcome = self
            .complete_redirect(&request, &client_id, &redirect_uri, &verifier, &expected_state)
            .await;

        let (status, message) = match &outcome {
            Ok(()) => (
                "200 OK",
                "Signed in to Kite — you can close this tab.",
            ),
            Err(_) => (
                "502 Bad Gateway",
                "Sign-in failed — return to the app to see what went wrong.",
            ),
        };
        let body = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Kite</title></head>\
             <body style=\"font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;\
             display:flex;min-height:100vh;align-items:center;justify-content:center\">\
             <p style=\"font-size:1.1rem\">{message}</p></body></html>"
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            len = body.len(),
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;

        outcome
    }

    /// Parse the redirect, validate `state`, exchange the code for tokens, run
    /// the Xbox Live → XSTS chain, and persist. Split out of
    /// [`Self::await_redirect_and_exchange`] so the caller can answer the
    /// browser based on the *true* result rather than on parsing alone.
    async fn complete_redirect(
        &self,
        request: &str,
        client_id: &str,
        redirect_uri: &str,
        verifier: &str,
        expected_state: &str,
    ) -> Result<()> {
        let (code, state) = parse_redirect_query(request)?;
        if state != expected_state {
            return Err(XboxError::AuthError(
                "State mismatch on redirect (possible CSRF) — sign-in aborted".to_string(),
            ));
        }

        let token = self
            .exchange_code(client_id, &code, redirect_uri, verifier)
            .await?;
        let access_token = token
            .access_token
            .ok_or_else(|| XboxError::AuthError("No access token in token response".to_string()))?;
        info!("Successfully obtained access token!");

        let xbox_token = self.authenticate_xbox_live(&access_token).await?;
        let xsts_token = self.get_xsts_token(&xbox_token.token).await?;

        let tokens = XboxTokens {
            access_token,
            refresh_token: token.refresh_token,
            xsts_token: xsts_token.token,
            user_hash: xsts_token.display_claims.xui[0].uhs.clone(),
            expires_at: Utc::now() + chrono::Duration::seconds(token.expires_in.unwrap_or(3600)),
        };
        *self.tokens.lock().await = Some(tokens);
        self.save_tokens_to_cache().await?;

        info!("Xbox Live authentication completed successfully");
        Ok(())
    }

    /// Exchange an authorization code for tokens (PKCE; no client secret).
    async fn exchange_code(
        &self,
        client_id: &str,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<TokenResponse> {
        let params = [
            ("client_id", client_id),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
            ("scope", "XboxLive.signin XboxLive.offline_access"),
        ];

        let response = self
            .client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| XboxError::AuthError(format!("Token exchange failed: {}", error_chain(&e))))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!(
                "Token exchange failed: {}",
                error_text
            )));
        }

        response
            .json::<TokenResponse>()
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to parse token response: {}", e)))
    }

    /// Authenticate with Xbox Live using Microsoft access token
    async fn authenticate_xbox_live(&self, ms_token: &str) -> Result<XboxLiveAuthResponse> {
        debug!("Authenticating with Xbox Live");

        let body = serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={}", ms_token)
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        });

        let response = self
            .client
            .post("https://user.auth.xboxlive.com/user/authenticate")
            .header("Content-Type", "application/json")
            .header("x-xbl-contract-version", "1")
            .json(&body)
            .send()
            .await
            .map_err(|e| XboxError::AuthError(format!("Xbox Live auth failed: {}", error_chain(&e))))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!(
                "Xbox Live authentication failed: {}",
                error_text
            )));
        }

        response
            .json::<XboxLiveAuthResponse>()
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to parse Xbox Live response: {}", e)))
    }

    /// Get XSTS token for game streaming
    async fn get_xsts_token(&self, xbox_token: &str) -> Result<XSTSAuthResponse> {
        debug!("Getting XSTS token for game streaming");

        // Use http://gssv.xboxlive.com/ relying party for game streaming access
        let body = serde_json::json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbox_token]
            },
            "RelyingParty": "http://gssv.xboxlive.com/",
            "TokenType": "JWT"
        });

        let response = self
            .client
            .post("https://xsts.auth.xboxlive.com/xsts/authorize")
            .header("Content-Type", "application/json")
            .header("x-xbl-contract-version", "1")
            .json(&body)
            .send()
            .await
            .map_err(|e| XboxError::AuthError(format!("XSTS request failed: {}", error_chain(&e))))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!(
                "XSTS authorization failed: {}",
                error_text
            )));
        }

        response
            .json::<XSTSAuthResponse>()
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to parse XSTS response: {}", e)))
    }

    /// Sign out: clear in-memory tokens AND wipe the persisted tokens from the
    /// OS keychain so the next launch starts signed-out. The keychain clear is
    /// best-effort surfaced as an error, but the in-memory tokens are dropped
    /// first so the session is immediately unauthenticated regardless.
    pub async fn sign_out(&self) -> Result<()> {
        *self.tokens.lock().await = None;
        Self::token_store()?.clear()?;
        info!("Signed out: cleared in-memory tokens and OS keychain");
        Ok(())
    }

    /// Drain the last background sign-in failure (one-shot — clears on read).
    /// The polling UI calls this while awaiting sign-in so a failed token
    /// exchange surfaces as a real error instead of an indefinite wait.
    pub async fn take_flow_error(&self) -> Option<String> {
        self.flow_error.lock().await.take()
    }

    /// Check if tokens are valid
    pub async fn is_authenticated(&self) -> bool {
        if let Some(tokens) = self.tokens.lock().await.as_ref() {
            tokens.expires_at > Utc::now()
        } else {
            false
        }
    }

    /// Get authorization header value for API requests
    pub async fn get_auth_header(&self) -> Result<String> {
        let tokens = self
            .tokens
            .lock()
            .await
            .clone()
            .ok_or_else(|| XboxError::AuthError("Not authenticated".to_string()))?;

        if tokens.expires_at <= Utc::now() {
            return Err(XboxError::AuthError("Token expired".to_string()));
        }

        Ok(format!(
            "XBL3.0 x={};{}",
            tokens.user_hash, tokens.xsts_token
        ))
    }
}

impl Default for XboxAuth {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_env_value_when_present() {
        assert_eq!(
            resolve_client_id_from(Some("custom-id".to_string())),
            "custom-id"
        );
    }

    #[test]
    fn falls_back_to_default_when_absent() {
        assert_eq!(resolve_client_id_from(None), DEFAULT_CLIENT_ID);
    }

    #[test]
    fn error_chain_appends_each_source() {
        // reqwest hides the real cause (DNS/connection/TLS) behind a generic
        // top-level message; error_chain must walk source() so the cause shows.
        #[derive(Debug)]
        struct Cause;
        impl std::fmt::Display for Cause {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "dns error: no record")
            }
        }
        impl std::error::Error for Cause {}

        #[derive(Debug)]
        struct Top(Cause);
        impl std::fmt::Display for Top {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "error sending request")
            }
        }
        impl std::error::Error for Top {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        assert_eq!(
            error_chain(&Top(Cause)),
            "error sending request: dns error: no record"
        );
    }

    #[test]
    fn error_chain_of_a_sourceless_error_is_just_its_message() {
        let e = std::io::Error::other("boom");
        assert_eq!(error_chain(&e), "boom");
    }
}
