use crate::error::{Result, XboxError};
use crate::token_store::{KeyringBackend, TokenStore};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// Default Azure AD app client ID for Xbox Live authentication.
/// Override at runtime with the XBOX_CLIENT_ID environment variable.
/// Register at https://portal.azure.com -> App registrations (enable
/// "Allow public client flows" in Authentication settings).
const DEFAULT_CLIENT_ID: &str = "6f40db01-bee0-49fc-8f48-fa29e949426e";

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
}

/// Device code response from Microsoft
#[derive(Debug, Deserialize, Clone)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    interval: i64,
}

/// Device code polling response
#[derive(Debug, Deserialize)]
struct DeviceCodePollResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
}

/// Public device code info to return to frontend
#[derive(Debug, Serialize, Clone)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
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
        }
    }

    /// Path to the pre-keychain plaintext token file (used only for one-time migration).
    fn legacy_cache_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("xbox-remote").join(TOKEN_CACHE_FILE))
    }

    fn token_store() -> Result<TokenStore<KeyringBackend>> {
        Ok(TokenStore::new(KeyringBackend::new()?, Self::legacy_cache_path()))
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
                        warn!("Failed to clear expired tokens from keychain: {}", clear_err);
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
            .map_err(|e| XboxError::AuthError(format!("Token refresh failed: {}", e)))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!("Token refresh failed: {}", error_text)));
        }

        let poll_response = response
            .json::<DeviceCodePollResponse>()
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to parse refresh response: {}", e)))?;

        if let Some(access_token) = poll_response.access_token {
            // Exchange for Xbox Live tokens
            let xbox_token = self.authenticate_xbox_live(&access_token).await?;
            let xsts_token = self.get_xsts_token(&xbox_token.token).await?;

            let tokens = XboxTokens {
                access_token,
                refresh_token: poll_response.refresh_token.or(Some(refresh_token.to_string())),
                xsts_token: xsts_token.token,
                user_hash: xsts_token.display_claims.xui[0].uhs.clone(),
                expires_at: Utc::now() + chrono::Duration::seconds(poll_response.expires_in.unwrap_or(3600)),
            };

            *self.tokens.lock().await = Some(tokens);
            self.save_tokens_to_cache().await?;
            return Ok(());
        }

        Err(XboxError::AuthError("No access token in refresh response".to_string()))
    }

    /// Start the OAuth device code flow
    /// Returns device code info (user code and verification URL) for the user
    pub async fn start_device_code_auth(&self) -> Result<DeviceCodeInfo> {
        info!("Starting Xbox Live OAuth device code flow");

        let client_id = resolve_client_id();
        let params = [
            ("client_id", client_id.as_str()),
            ("scope", "XboxLive.signin XboxLive.offline_access"),
        ];

        let response = self
            .client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
            .form(&params)
            .send()
            .await
            .map_err(|e| XboxError::AuthError(format!("Device code request failed: {}", e)))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::AuthError(format!(
                "Device code request failed: {}",
                error_text
            )));
        }

        let device_response = response
            .json::<DeviceCodeResponse>()
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to parse device code response: {}", e)))?;

        info!("Device code obtained: {}", device_response.user_code);
        info!("Verification URI: {}", device_response.verification_uri);

        // Store device code for polling
        let device_code = device_response.device_code.clone();
        let interval = device_response.interval;

        // Start polling in background
        let auth_clone = self.clone();
        tokio::spawn(async move {
            if let Err(e) = auth_clone.poll_for_token(device_code, interval).await {
                tracing::error!("Device code polling failed: {}", e);
            }
        });

        Ok(DeviceCodeInfo {
            user_code: device_response.user_code,
            verification_uri: device_response.verification_uri,
        })
    }

    /// Poll Microsoft for the token after user completes device authorization
    async fn poll_for_token(&self, device_code: String, interval: i64) -> Result<()> {
        info!("Starting to poll for device code authorization...");

        let poll_interval = tokio::time::Duration::from_secs(interval as u64);
        let max_attempts = 60; // 5 minutes if interval is 5 seconds

        for attempt in 1..=max_attempts {
            tokio::time::sleep(poll_interval).await;

            let client_id = resolve_client_id();
            let params = [
                ("client_id", client_id.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device_code.as_str()),
            ];

            let response = self
                .client
                .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
                .form(&params)
                .send()
                .await
                .map_err(|e| XboxError::AuthError(format!("Token poll failed: {}", e)))?;

            let poll_response = response
                .json::<DeviceCodePollResponse>()
                .await
                .map_err(|e| XboxError::AuthError(format!("Failed to parse poll response: {}", e)))?;

            if let Some(error) = poll_response.error {
                match error.as_str() {
                    "authorization_pending" => {
                        debug!("Authorization pending (attempt {}/{})", attempt, max_attempts);
                        continue;
                    }
                    "slow_down" => {
                        debug!("Slowing down polling");
                        tokio::time::sleep(poll_interval).await;
                        continue;
                    }
                    "authorization_declined" => {
                        return Err(XboxError::AuthError("User declined authorization".to_string()));
                    }
                    "expired_token" => {
                        return Err(XboxError::AuthError("Device code expired".to_string()));
                    }
                    _ => {
                        return Err(XboxError::AuthError(format!("Authorization error: {}", error)));
                    }
                }
            }

            // Success! We got the access token
            if let Some(access_token) = poll_response.access_token {
                info!("Successfully obtained access token!");

                // Exchange Microsoft token for Xbox Live token
                let xbox_token = self.authenticate_xbox_live(&access_token).await?;

                // Get XSTS token for game streaming
                let xsts_token = self.get_xsts_token(&xbox_token.token).await?;

                // Store tokens
                let tokens = XboxTokens {
                    access_token,
                    refresh_token: poll_response.refresh_token,
                    xsts_token: xsts_token.token,
                    user_hash: xsts_token.display_claims.xui[0].uhs.clone(),
                    expires_at: Utc::now() + chrono::Duration::seconds(poll_response.expires_in.unwrap_or(3600)),
                };

                *self.tokens.lock().await = Some(tokens);
                
                // Save to cache
                self.save_tokens_to_cache().await?;

                info!("Xbox Live authentication completed successfully");
                return Ok(());
            }
        }

        Err(XboxError::AuthError("Device code authorization timed out".to_string()))
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
            .map_err(|e| XboxError::AuthError(format!("Xbox Live auth failed: {}", e)))?;

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
            .map_err(|e| XboxError::AuthError(format!("XSTS request failed: {}", e)))?;

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

        Ok(format!("XBL3.0 x={};{}", tokens.user_hash, tokens.xsts_token))
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
        assert_eq!(resolve_client_id_from(Some("custom-id".to_string())), "custom-id");
    }

    #[test]
    fn falls_back_to_default_when_absent() {
        assert_eq!(resolve_client_id_from(None), DEFAULT_CLIENT_ID);
    }
}
