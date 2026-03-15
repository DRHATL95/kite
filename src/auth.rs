use crate::error::{Result, XboxError};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// Azure AD app client ID for Xbox Live authentication
/// Register at: https://portal.azure.com -> App registrations
/// Make sure to enable "Allow public client flows" in Authentication settings
const CLIENT_ID: &str = "6f40db01-bee0-49fc-8f48-fa29e949426e";

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

    /// Get the token cache file path
    fn get_cache_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("xbox-remote").join(TOKEN_CACHE_FILE))
    }

    /// Load cached tokens from disk
    pub async fn load_cached_tokens(&self) -> Result<bool> {
        let cache_path = match Self::get_cache_path() {
            Some(p) => p,
            None => return Ok(false),
        };

        if !cache_path.exists() {
            return Ok(false);
        }

        info!("Loading cached tokens from {:?}", cache_path);

        let contents = tokio::fs::read_to_string(&cache_path)
            .await
            .map_err(|e| XboxError::AuthError(format!("Failed to read token cache: {}", e)))?;

        let tokens: XboxTokens = serde_json::from_str(&contents)
            .map_err(|e| XboxError::AuthError(format!("Failed to parse token cache: {}", e)))?;

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
                Ok(()) => {
                    info!("Successfully refreshed tokens");
                    return Ok(true);
                }
                Err(e) => {
                    warn!("Failed to refresh tokens: {}", e);
                    // Delete invalid cache
                    let _ = tokio::fs::remove_file(&cache_path).await;
                }
            }
        }

        Ok(false)
    }

    /// Save tokens to cache
    async fn save_tokens_to_cache(&self) -> Result<()> {
        let cache_path = match Self::get_cache_path() {
            Some(p) => p,
            None => return Ok(()),
        };

        // Create directory if it doesn't exist
        if let Some(parent) = cache_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| XboxError::AuthError(format!("Failed to create cache dir: {}", e)))?;
        }

        let tokens = self.tokens.lock().await;
        if let Some(ref tokens) = *tokens {
            let json = serde_json::to_string_pretty(tokens)
                .map_err(|e| XboxError::AuthError(format!("Failed to serialize tokens: {}", e)))?;
            
            tokio::fs::write(&cache_path, json)
                .await
                .map_err(|e| XboxError::AuthError(format!("Failed to write token cache: {}", e)))?;
            
            info!("Saved tokens to cache: {:?}", cache_path);
        }

        Ok(())
    }

    /// Refresh tokens using refresh token
    async fn refresh_tokens(&self, refresh_token: &str) -> Result<()> {
        info!("Refreshing access token...");

        let params = [
            ("client_id", CLIENT_ID),
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

        let params = [
            ("client_id", CLIENT_ID),
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

            let params = [
                ("client_id", CLIENT_ID),
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
