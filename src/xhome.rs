use crate::auth::XboxAuth;
use crate::error::{Result, XboxError};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

/// Xbox console information from xHome API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XHomeConsole {
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
    #[serde(rename = "consoleType")]
    pub console_type: String,
    #[serde(rename = "powerState")]
    pub power_state: String,
    #[serde(rename = "isDevKit")]
    pub is_dev_kit: bool,
    #[serde(rename = "playPath")]
    pub play_path: String,
}

/// ICE candidate from the server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(rename = "sdpMid")]
    pub sdp_mid: String,
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_m_line_index: u32,
}

/// ICE server configuration (STUN/TURN)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// Streaming session configuration
#[derive(Debug, Serialize, Deserialize)]
pub struct StreamConfig {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionPath")]
    pub session_path: String,
    /// SDP offer from the WebRTC session exchange; empty until received.
    #[serde(rename = "exchangeResponse", default)]
    pub exchange_response: String,
    /// Game streaming token for authentication
    #[serde(rename = "gsToken")]
    pub gs_token: String,
    /// Keepalive interval from Xbox session config (seconds)
    #[serde(
        rename = "keepAlivePulseSeconds",
        skip_serializing_if = "Option::is_none"
    )]
    pub keep_alive_pulse_seconds: Option<u32>,
}

/// xHome streaming API client
pub struct XHomeClient {
    client: Client,
    auth: XboxAuth,
    gs_token: Option<String>,
    api_base: Option<String>,
}

/// Login request to xHome service
#[derive(Debug, Serialize)]
struct LoginRequest {
    token: String,
    #[serde(rename = "offeringId")]
    offering_id: String,
}

/// Login response from xHome service
#[derive(Debug, Deserialize)]
struct LoginResponse {
    #[serde(rename = "gsToken")]
    gs_token: String,
    #[serde(rename = "offeringSettings")]
    offering_settings: OfferingSettings,
}

#[derive(Debug, Deserialize)]
struct OfferingSettings {
    regions: Vec<RegionSettings>,
}

#[derive(Debug, Deserialize)]
struct RegionSettings {
    #[serde(rename = "baseUri")]
    base_uri: String,
}

#[derive(Debug, Deserialize)]
struct ConsoleListResponse {
    #[serde(rename = "totalItems")]
    #[allow(dead_code)] // API-mirror field; not consumed, kept for Debug/diagnostics
    total_items: u32,
    results: Vec<XHomeConsole>,
}

#[derive(Debug, Serialize)]
struct SessionRequest {
    #[serde(rename = "titleId")]
    title_id: String,
    #[serde(rename = "systemUpdateGroup")]
    system_update_group: String,
    #[serde(rename = "serverId")]
    server_id: String,
    #[serde(rename = "settings")]
    settings: SessionSettings,
}

#[derive(Debug, Serialize)]
struct SessionSettings {
    #[serde(rename = "nanoVersion")]
    nano_version: String,
    #[serde(rename = "audioConfiguration")]
    audio_configuration: String,
    #[serde(rename = "videoConfiguration")]
    video_configuration: VideoConfiguration,
    #[serde(rename = "chatConfiguration")]
    chat_configuration: String,
    #[serde(rename = "enableTextToSpeech")]
    enable_text_to_speech: bool,
    #[serde(rename = "enableTextInput")]
    enable_text_input: bool,
    #[serde(rename = "locale")]
    locale: String,
}

#[derive(Debug, Serialize)]
struct VideoConfiguration {
    #[serde(rename = "minVersion")]
    min_version: i32,
    #[serde(rename = "maxVersion")]
    max_version: i32,
    #[serde(rename = "preferredVersion")]
    preferred_version: i32,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "sessionPath")]
    session_path: String,
    #[serde(rename = "state")]
    state: Option<String>,
    #[serde(rename = "exchangeResponse")]
    exchange_response: Option<String>,
    #[serde(rename = "serverDetails")]
    server_details: Option<ServerDetails>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `detailed_session_state` is an API-mirror field kept for Debug/diagnostics
struct SessionStateResponse {
    state: String,
    #[serde(rename = "detailedSessionState")]
    detailed_session_state: Option<i32>,
    #[serde(rename = "errorDetails")]
    error_details: Option<ErrorDetails>,
    /// SDP offer may be included in state response
    #[serde(rename = "sdp")]
    sdp: Option<String>,
    #[serde(rename = "exchangeResponse")]
    exchange_response: Option<String>,
    #[serde(rename = "serverDetails")]
    server_details: Option<ServerDetails>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // net fields are API-mirror data kept for Debug/diagnostics; not consumed yet
struct ServerDetails {
    #[serde(rename = "ipAddress")]
    ip_address: Option<String>,
    #[serde(rename = "ipV4Address")]
    ipv4_address: Option<String>,
    #[serde(rename = "ipV6Address")]
    ipv6_address: Option<String>,
    port: Option<u16>,
    #[serde(rename = "tcpPort")]
    tcp_port: Option<u16>,
    #[serde(rename = "udpPort")]
    udp_port: Option<u16>,
    #[serde(rename = "sdp")]
    sdp: Option<String>,
}

/// Configuration response from session
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `server_details` is an API-mirror field kept for Debug/diagnostics
struct SessionConfiguration {
    #[serde(rename = "keepAlivePulseInSeconds")]
    keep_alive_pulse_in_seconds: Option<u32>,
    #[serde(rename = "serverDetails")]
    server_details: Option<ServerDetails>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `code`/`message` are API-mirror fields kept for Debug/diagnostics
struct ErrorDetails {
    code: Option<String>,
    message: Option<String>,
}

/// Response from the SDP exchange endpoint
#[derive(Debug, Deserialize)]
struct SdpExchangeResponse {
    /// The SDP offer from the server
    #[serde(rename = "sdp", alias = "exchangeSdp", alias = "offer")]
    sdp: Option<String>,
    /// Sometimes the whole response is the exchange
    #[serde(rename = "exchangeResponse")]
    exchange_response: Option<String>,
}

/// Transport descriptor the xHome session API expects. Despite the legacy
/// "nano" name, this value configures the WebRTC transport — it never varies.
const NANO_VERSION: &str = "V3;WebrtcTransport.dll";

impl XHomeClient {
    pub fn new(auth: XboxAuth) -> Self {
        Self {
            client: Client::new(),
            auth,
            gs_token: None,
            api_base: None,
        }
    }

    /// Login to xHome service and get game streaming token
    pub async fn login(&mut self) -> Result<()> {
        info!("Logging into xHome service");

        let auth_header = self.auth.get_auth_header().await?;

        // First, we need to get a GSSV token for xhome
        let login_url = "https://xhome.gssv-play-prod.xboxlive.com/v2/login/user";

        let login_request = LoginRequest {
            token: auth_header.clone(),
            offering_id: "xhome".to_string(),
        };

        let response = self
            .client
            .post(login_url)
            .header("x-gssv-client", "XboxComBrowser")
            .json(&login_request)
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::ConnectionError(format!(
                "Failed to login to xHome: HTTP {} - {}",
                status, error_text
            )));
        }

        let login_response = response.json::<LoginResponse>().await.map_err(|e| {
            XboxError::ConnectionError(format!("Failed to parse login response: {}", e))
        })?;

        // Store the gs_token and base URL from the first region
        self.gs_token = Some(login_response.gs_token);
        if let Some(region) = login_response.offering_settings.regions.first() {
            self.api_base = Some(region.base_uri.clone());
            info!("Connected to xHome region: {}", region.base_uri);
        } else {
            return Err(XboxError::ConnectionError(
                "No regions available".to_string(),
            ));
        }

        Ok(())
    }

    /// Get list of available Xbox consoles
    pub async fn get_consoles(&mut self) -> Result<Vec<XHomeConsole>> {
        // Ensure we're logged in
        if self.gs_token.is_none() {
            self.login().await?;
        }

        info!("Fetching console list from xHome API");

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!("{}/v6/servers/home", api_base);

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::ConnectionError(format!(
                "Failed to get consoles: HTTP {} - {}",
                status, error_text
            )));
        }

        let console_response = response
            .json::<ConsoleListResponse>()
            .await
            .map_err(|e| XboxError::ConnectionError(format!("Failed to parse response: {}", e)))?;

        info!("Found {} consoles", console_response.results.len());
        Ok(console_response.results)
    }

    /// Wake up a console before streaming
    pub async fn wake_console(&self, server_id: &str) -> Result<()> {
        info!("Sending wake command to console: {}", server_id);

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        // Try the wake endpoint
        let url = format!("{}/v6/servers/home/{}/wake", api_base, server_id);
        debug!("Wake URL: {}", url);

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        let status = response.status();
        let response_text = response.text().await.unwrap_or_default();

        if status.is_success() {
            info!("Wake command sent successfully");
        } else {
            // Wake might fail but we should still try to connect
            warn!(
                "Wake command returned {}: {} - will still try to connect",
                status, response_text
            );
        }

        // Give the console a moment to wake up
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        Ok(())
    }

    /// Create a streaming session with a console
    /// play_path should come from the XHomeConsole's play_path field
    pub async fn create_session(
        &mut self,
        server_id: &str,
        play_path: Option<&str>,
    ) -> Result<StreamConfig> {
        // Ensure we're logged in
        if self.gs_token.is_none() {
            self.login().await?;
        }

        info!("Creating streaming session for console: {}", server_id);

        // Try to wake the console first
        if let Err(e) = self.wake_console(server_id).await {
            warn!("Wake command failed (non-fatal): {}", e);
        }

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        // Use play_path from console if provided, otherwise construct default
        let path = play_path.unwrap_or("v5/sessions/home/play");
        let url = format!("{}/{}", api_base, path);

        debug!("Session URL: {}", url);

        let request_body = SessionRequest {
            title_id: "".to_string(), // Empty for home streaming
            system_update_group: "".to_string(),
            server_id: server_id.to_string(),
            settings: SessionSettings {
                nano_version: NANO_VERSION.to_string(),
                audio_configuration: "Stereo".to_string(),
                video_configuration: VideoConfiguration {
                    min_version: 1,
                    max_version: 3,
                    preferred_version: 3,
                },
                chat_configuration: "None".to_string(),
                enable_text_to_speech: false,
                enable_text_input: true,
                locale: "en-US".to_string(),
            },
        };

        debug!("Sending session request...");

        // Add timeout to prevent hanging indefinitely
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.client
                .post(&url)
                .header("Authorization", format!("Bearer {}", gs_token))
                .header("x-gssv-client", "XboxComBrowser")
                .header("Content-Type", "application/json")
                .json(&request_body)
                .send(),
        )
        .await
        .map_err(|_| XboxError::StreamError("Session request timed out after 30s".to_string()))?
        .map_err(XboxError::NetworkError)?;

        debug!("Got response with status: {}", response.status());

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::StreamError(format!(
                "Failed to create session: HTTP {} - {}",
                status, error_text
            )));
        }

        // Get the response text first so we can log it
        let response_text = response
            .text()
            .await
            .map_err(|e| XboxError::StreamError(format!("Failed to read response: {}", e)))?;

        debug!("Session response body: {}", response_text);

        let session_response: SessionResponse =
            serde_json::from_str(&response_text).map_err(|e| {
                XboxError::StreamError(format!(
                    "Failed to parse session response: {} - Body: {}",
                    e, response_text
                ))
            })?;

        info!(
            "Session created: {} (state: {:?})",
            session_response.session_id, session_response.state
        );

        // If session is provisioning, we need to poll until it's ready
        let session_path = session_response.session_path.clone();
        let (exchange_response, _server_details, keepalive_seconds) =
            if session_response.state.as_deref() == Some("Provisioning") {
                info!("Session is provisioning, waiting for it to be ready...");
                self.wait_for_session_ready(&session_path).await?
            } else if let Some(exchange) = session_response.exchange_response {
                // The exchange response might be the SDP directly or might need extraction
                let sdp = self.extract_sdp_from_response(&exchange).ok();
                // Still fetch config to get keepalive interval
                let keepalive = match self.get_session_configuration(&session_path).await {
                    Ok(config) => {
                        if let Some(secs) = config.keep_alive_pulse_in_seconds {
                            info!("Xbox keepAlivePulseInSeconds: {}s", secs);
                        }
                        config.keep_alive_pulse_in_seconds
                    }
                    Err(e) => {
                        warn!("Failed to get session configuration: {}", e);
                        None
                    }
                };
                (sdp, session_response.server_details, keepalive)
            } else {
                // Try to get session state/configuration
                self.wait_for_session_ready(&session_path).await?
            };

        // Log if we got an exchange response (SDP offer)
        if let Some(ref sdp) = exchange_response {
            info!("Got SDP offer from session creation ({} bytes)", sdp.len());
        } else {
            warn!("No SDP offer in session creation response");
        }

        Ok(StreamConfig {
            session_id: session_response.session_id,
            session_path,
            exchange_response: exchange_response.unwrap_or_default(),
            gs_token: gs_token.to_string(),
            keep_alive_pulse_seconds: keepalive_seconds,
        })
    }

    /// Extract SDP from a response string (handles both raw SDP and JSON-wrapped SDP)
    fn extract_sdp_from_response(&self, response: &str) -> Result<String> {
        let trimmed = response.trim();

        // If it already starts with v=, it's raw SDP
        if trimmed.starts_with("v=") {
            return Ok(response.to_string());
        }

        // Try to parse as JSON
        if let Ok(json_response) = serde_json::from_str::<SdpExchangeResponse>(trimmed)
            && let Some(sdp) = json_response.sdp.or(json_response.exchange_response)
                && sdp.trim().starts_with("v=") {
                    return Ok(sdp);
                }

        // Try generic JSON value
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            for key in &["sdp", "exchangeSdp", "offer", "exchangeResponse"] {
                if let Some(sdp) = json_value.get(*key).and_then(|v| v.as_str())
                    && sdp.trim().starts_with("v=") {
                        return Ok(sdp.to_string());
                    }
            }
        }

        // Return as-is if nothing else works (will fail validation later)
        warn!(
            "Could not extract SDP from response, returning as-is: {}",
            &response.chars().take(100).collect::<String>()
        );
        Ok(response.to_string())
    }

    /// Wait for session to be ready and return the exchange response and server details
    async fn wait_for_session_ready(
        &self,
        session_path: &str,
    ) -> Result<(Option<String>, Option<ServerDetails>, Option<u32>)> {
        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!("{}/{}/state", api_base, session_path);

        // Poll for up to 30 seconds
        let max_attempts = 30;
        for attempt in 1..=max_attempts {
            debug!(
                "Polling session state (attempt {}/{})",
                attempt, max_attempts
            );

            let response = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", gs_token))
                .header("x-gssv-client", "XboxComBrowser")
                .send()
                .await
                .map_err(XboxError::NetworkError)?;

            if !response.status().is_success() {
                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                debug!("Session state poll failed: {} - {}", status, error_text);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }

            let response_text = response.text().await.map_err(|e| {
                XboxError::StreamError(format!("Failed to read state response: {}", e))
            })?;

            debug!("Session state response: {}", response_text);

            let state_response: SessionStateResponse = serde_json::from_str(&response_text)
                .map_err(|e| {
                    XboxError::StreamError(format!(
                        "Failed to parse state response: {} - {}",
                        e, response_text
                    ))
                })?;

            match state_response.state.as_str() {
                "Provisioned" | "ReadyToConnect" => {
                    info!("Session is ready!");

                    // Always fetch session configuration for keepalive interval
                    let keepalive_seconds = match self.get_session_configuration(session_path).await
                    {
                        Ok(config) => {
                            if let Some(secs) = config.keep_alive_pulse_in_seconds {
                                info!("Xbox keepAlivePulseInSeconds: {}s", secs);
                            }
                            config.keep_alive_pulse_in_seconds
                        }
                        Err(e) => {
                            warn!("Failed to get session configuration: {}", e);
                            None
                        }
                    };

                    // Try to get SDP from state response first
                    if let Some(sdp) = state_response.sdp
                        && sdp.trim().starts_with("v=") {
                            info!("Got SDP from state response");
                            return Ok((
                                Some(sdp),
                                state_response.server_details,
                                keepalive_seconds,
                            ));
                        }
                    if let Some(exchange) = state_response.exchange_response
                        && let Ok(extracted) = self.extract_sdp_from_response(&exchange)
                            && extracted.trim().starts_with("v=") {
                                info!("Got SDP from exchangeResponse in state");
                                return Ok((
                                    Some(extracted),
                                    state_response.server_details,
                                    keepalive_seconds,
                                ));
                            }
                    if let Some(ref server_details) = state_response.server_details
                        && let Some(ref sdp) = server_details.sdp
                            && sdp.trim().starts_with("v=") {
                                info!("Got SDP from serverDetails");
                                return Ok((
                                    Some(sdp.clone()),
                                    state_response.server_details,
                                    keepalive_seconds,
                                ));
                            }

                    // Return what we have from state
                    return Ok((None, state_response.server_details, keepalive_seconds));
                }
                "Provisioning" | "WaitingForResources" => {
                    debug!("Session still provisioning...");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                "Failed" | "Error" => {
                    return Err(XboxError::StreamError(format!(
                        "Session failed to provision: {} - {:?}",
                        state_response.state, state_response.error_details
                    )));
                }
                other => {
                    debug!("Unknown session state: {:?}", other);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }

        Err(XboxError::StreamError(
            "Timeout waiting for session to be ready".to_string(),
        ))
    }

    /// Get session configuration including server details
    async fn get_session_configuration(&self, session_path: &str) -> Result<SessionConfiguration> {
        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let config_url = format!("{}/{}/configuration", api_base, session_path);
        debug!("Getting session configuration: {}", config_url);

        let response = self
            .client
            .get(&config_url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(XboxError::StreamError(format!(
                "Failed to get configuration: {} - {}",
                status, error_text
            )));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| XboxError::StreamError(format!("Failed to read configuration: {}", e)))?;

        info!("Full configuration response: {}", response_text);

        let config: SessionConfiguration = serde_json::from_str(&response_text).map_err(|e| {
            XboxError::StreamError(format!(
                "Failed to parse configuration: {} - {}",
                e, response_text
            ))
        })?;

        Ok(config)
    }

    /// Send ICE candidate to server
    pub async fn send_ice_candidate(&self, session_path: &str, candidate: &str) -> Result<()> {
        info!("Sending ICE candidate to server");

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!("{}/{}/ice", api_base, session_path);
        info!("ICE candidate URL: {}", url);

        // Parse the candidate JSON to extract just the candidate string
        let candidate_str = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(candidate)
        {
            parsed
                .get("candidate")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| candidate.to_string())
        } else {
            candidate.to_string()
        };

        let body = serde_json::json!({
            "candidate": candidate_str
        });
        info!("Sending ICE candidate body: {}", body);

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        let status = response.status();
        let response_text = response.text().await.unwrap_or_default();
        info!(
            "ICE candidate send response ({}): {}",
            status, response_text
        );

        if !status.is_success() {
            warn!(
                "Failed to send ICE candidate: HTTP {} - {}",
                status, response_text
            );
        }

        Ok(())
    }

    /// Poll for ICE candidates from the server
    pub async fn poll_ice_candidates(&self, session_path: &str) -> Result<Vec<IceCandidate>> {
        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!("{}/{}/ice", api_base, session_path);
        info!("Polling for ICE candidates: {}", url);

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| XboxError::StreamError(format!("Failed to read ICE response: {}", e)))?;

        info!("ICE candidates response ({}): {}", status, &response_text);

        if !status.is_success() {
            return Ok(vec![]);
        }

        // Parse the ICE candidates from JSON
        let mut candidates = Vec::new();
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
            // Check for exchangeResponse (Xbox uses this nested format)
            if let Some(exchange) = json_value.get("exchangeResponse").and_then(|v| v.as_str()) {
                info!("Parsing exchangeResponse for ICE candidates");
                // exchangeResponse contains a JSON array as a string
                if let Ok(inner) = serde_json::from_str::<serde_json::Value>(exchange) {
                    // It's an array of candidate objects
                    if let Some(arr) = inner.as_array() {
                        for item in arr {
                            if let Some(cand) = item.get("candidate").and_then(|v| v.as_str()) {
                                // Skip end-of-candidates marker
                                if cand.contains("end-of-candidates") {
                                    info!("Found end-of-candidates marker");
                                    continue;
                                }
                                // Remove "a=" prefix if present (Xbox sends "a=candidate:...")
                                let clean_cand = cand
                                    .strip_prefix("a=")
                                    .unwrap_or(cand)
                                    .to_string();

                                // Get sdpMid and sdpMLineIndex from the response
                                let sdp_mid = item
                                    .get("sdpMid")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("0")
                                    .to_string();
                                let sdp_m_line_index =
                                    item.get("sdpMLineIndex")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0) as u32;

                                info!(
                                    "Found ICE candidate: {} (mid={}, index={})",
                                    clean_cand, sdp_mid, sdp_m_line_index
                                );
                                candidates.push(IceCandidate {
                                    candidate: clean_cand,
                                    sdp_mid,
                                    sdp_m_line_index,
                                });
                            }
                        }
                    }
                }
            } else if let Some(arr) = json_value.as_array() {
                // Direct array format
                for item in arr {
                    if let Some(cand) = item.get("candidate").and_then(|v| v.as_str())
                        && !cand.contains("end-of-candidates") {
                            let clean_cand = cand
                                .strip_prefix("a=")
                                .unwrap_or(cand)
                                .to_string();
                            let sdp_mid = item
                                .get("sdpMid")
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();
                            let sdp_m_line_index =
                                item.get("sdpMLineIndex")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0) as u32;
                            candidates.push(IceCandidate {
                                candidate: clean_cand,
                                sdp_mid,
                                sdp_m_line_index,
                            });
                        }
                }
            }
        }

        info!("Parsed {} ICE candidates", candidates.len());

        Ok(candidates)
    }

    /// Get ICE server configuration (STUN/TURN servers)
    pub async fn get_ice_servers(&self, session_path: &str) -> Result<Vec<IceServer>> {
        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        // Get ICE/STUN servers from the configuration endpoint
        let config_url = format!("{}/{}/configuration", api_base, session_path);
        info!("Getting ICE config from: {}", config_url);

        let mut servers = Vec::new();

        if let Ok(response) = self
            .client
            .get(&config_url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .send()
            .await
            && response.status().is_success()
                && let Ok(text) = response.text().await {
                    info!("Configuration for ICE: {}", text);
                    if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&text) {
                        // Check serverDetails.stunServerAddresses (this is what Xbox uses!)
                        if let Some(server_details) = json_value.get("serverDetails") {
                            if let Some(stun_addrs) = server_details
                                .get("stunServerAddresses")
                                .and_then(|v| v.as_array())
                            {
                                let stun_urls: Vec<String> = stun_addrs
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect();
                                if !stun_urls.is_empty() {
                                    info!("Found Xbox STUN servers: {:?}", stun_urls);
                                    servers.push(IceServer {
                                        urls: stun_urls,
                                        username: None,
                                        credential: None,
                                    });
                                }
                            }

                            // Also check for TURN servers in serverDetails
                            if let Some(turn_addrs) = server_details
                                .get("turnServerAddresses")
                                .and_then(|v| v.as_array())
                            {
                                let turn_urls: Vec<String> = turn_addrs
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect();
                                let username = server_details
                                    .get("turnUsername")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let credential = server_details
                                    .get("turnPassword")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                if !turn_urls.is_empty() {
                                    info!("Found Xbox TURN servers: {:?}", turn_urls);
                                    servers.push(IceServer {
                                        urls: turn_urls,
                                        username,
                                        credential,
                                    });
                                }
                            }
                        }

                        // Check for iceServers directly
                        if let Some(ice_servers) =
                            json_value.get("iceServers").and_then(|v| v.as_array())
                        {
                            for server in ice_servers {
                                let urls: Vec<String> = server
                                    .get("urls")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect()
                                    })
                                    .or_else(|| {
                                        server
                                            .get("url")
                                            .and_then(|v| v.as_str())
                                            .map(|s| vec![s.to_string()])
                                    })
                                    .unwrap_or_default();

                                let username = server
                                    .get("username")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let credential = server
                                    .get("credential")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);

                                if !urls.is_empty() {
                                    servers.push(IceServer {
                                        urls,
                                        username,
                                        credential,
                                    });
                                }
                            }
                        }

                        // Check for turn servers at top level
                        if let Some(turn) = json_value.get("turnServers").or(json_value.get("turn"))
                            && let Some(arr) = turn.as_array() {
                                for server in arr {
                                    let urls: Vec<String> = server
                                        .get("urls")
                                        .and_then(|v| v.as_array())
                                        .map(|arr| {
                                            arr.iter()
                                                .filter_map(|v| v.as_str().map(String::from))
                                                .collect()
                                        })
                                        .or_else(|| {
                                            server
                                                .get("url")
                                                .and_then(|v| v.as_str())
                                                .map(|s| vec![s.to_string()])
                                        })
                                        .unwrap_or_default();

                                    let username = server
                                        .get("username")
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    let credential = server
                                        .get("credential")
                                        .and_then(|v| v.as_str())
                                        .map(String::from);

                                    if !urls.is_empty() {
                                        servers.push(IceServer {
                                            urls,
                                            username,
                                            credential,
                                        });
                                    }
                                }
                            }
                    }
                }

        // Add Microsoft STUN and Google STUN as fallbacks
        if servers.is_empty() {
            info!("No ICE servers from config, using defaults");
        }

        // Always add Google STUN as additional fallback
        servers.push(IceServer {
            urls: vec![
                "stun:stun.l.google.com:19302".to_string(),
                "stun:stun1.l.google.com:19302".to_string(),
            ],
            username: None,
            credential: None,
        });

        info!("Returning {} ICE server configs", servers.len());
        Ok(servers)
    }

    /// Exchange SDP offer for answer - send our offer, get server's answer.
    ///
    /// When `XBOX_DUMP_SDP` is set in the environment, the local offer and the
    /// Xbox answer are appended to a local capture file (default
    /// `<tmp>/kite-sdp-capture.txt`, override with `XBOX_DUMP_SDP_PATH`)
    /// for Phase-0 SRTP-mode classification (DTLS-SRTP vs SDES). Local-only
    /// diagnostics: the answer carries the DTLS fingerprint, not a long-lived
    /// secret. Written raw (bypassing log redaction) so the crypto lines survive.
    pub async fn exchange_sdp_offer(&self, session_path: &str, sdp_offer: &str) -> Result<String> {
        let answer = self.exchange_sdp_offer_impl(session_path, sdp_offer).await;
        if std::env::var_os("XBOX_DUMP_SDP").is_some() {
            Self::dump_sdp_capture(sdp_offer, answer.as_deref().ok());
        }
        answer
    }

    /// Append a local offer + Xbox answer pair to the SDP capture file. Best
    /// effort: failures are logged but never affect the exchange result.
    fn dump_sdp_capture(offer: &str, answer: Option<&str>) {
        use std::io::Write;

        let path = std::env::var_os("XBOX_DUMP_SDP_PATH")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("kite-sdp-capture.txt"));

        let mut buf = String::new();
        buf.push_str("================ SDP EXCHANGE CAPTURE ================\n");
        buf.push_str(&format!(
            "captured_at: {}\n",
            chrono::Utc::now().to_rfc3339()
        ));
        buf.push_str("---------------- LOCAL OFFER ------------------------\n");
        buf.push_str(offer.trim_end());
        buf.push_str("\n---------------- XBOX ANSWER ------------------------\n");
        buf.push_str(
            answer
                .map(str::trim_end)
                .unwrap_or("<exchange failed; no answer captured>"),
        );
        buf.push_str("\n=====================================================\n\n");

        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(mut f) => match f.write_all(buf.as_bytes()) {
                Ok(()) => info!("XBOX_DUMP_SDP: appended SDP capture to {}", path.display()),
                Err(e) => warn!("XBOX_DUMP_SDP: failed to write {}: {e}", path.display()),
            },
            Err(e) => warn!("XBOX_DUMP_SDP: failed to open {}: {e}", path.display()),
        }
    }

    async fn exchange_sdp_offer_impl(&self, session_path: &str, sdp_offer: &str) -> Result<String> {
        info!("Exchanging SDP offer for answer");

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        // The SDP endpoint format for xHome
        let url = format!("{}/{}/sdp", api_base, session_path);
        info!("SDP exchange URL: {}", url);

        // Xbox xHome requires specific format for SDP exchange
        let body = serde_json::json!({
            "messageType": "offer",
            "sdp": sdp_offer,
            "configuration": {
                "chatConfiguration": {
                    "bytesPerSample": 2,
                    "expectedClipDurationMs": 100,
                    "format": {
                        "codec": "opus",
                        "container": "webm"
                    },
                    "numChannels": 1,
                    "sampleFrequencyHz": 24000
                },
                "chat": {
                    "minVersion": 1,
                    "maxVersion": 1
                },
                "control": {
                    "minVersion": 1,
                    "maxVersion": 3
                },
                "input": {
                    "minVersion": 1,
                    "maxVersion": 8
                },
                "message": {
                    "minVersion": 1,
                    "maxVersion": 1
                },
                "audio": {
                    "minVersion": 1,
                    "maxVersion": 1
                },
                "video": {
                    "minVersion": 1,
                    "maxVersion": 1
                }
            }
        });

        info!("Sending SDP offer ({} bytes)", sdp_offer.len());

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("x-gssv-client", "XboxComBrowser")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        let status = response.status();
        let response_text = response.text().await.map_err(|e| {
            XboxError::StreamError(format!("Failed to read SDP exchange response: {}", e))
        })?;

        info!("SDP exchange response status: {}", status);
        info!("SDP exchange response body: {}", response_text);

        if !status.is_success() {
            return Err(XboxError::StreamError(format!(
                "SDP exchange failed: HTTP {} - {}",
                status, response_text
            )));
        }

        // Handle empty response - server might need us to poll for the answer
        if response_text.trim().is_empty() {
            info!("Empty SDP response, polling for answer...");
            return self.poll_for_sdp_answer(session_path).await;
        }

        // Parse the response to extract the SDP answer
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
            info!("Parsed JSON response: {:?}", json_value);

            // Look for SDP in various possible field names
            for key in &["sdp", "exchangeResponse", "answer", "exchangeSdp"] {
                if let Some(sdp) = json_value.get(*key).and_then(|v| v.as_str())
                    && sdp.trim().starts_with("v=") {
                        info!("Got SDP answer ({} bytes)", sdp.len());
                        return Ok(sdp.to_string());
                    }
            }

            // If the whole response looks like SDP
            if response_text.trim().starts_with("v=") {
                return Ok(response_text);
            }

            return Err(XboxError::StreamError(format!(
                "SDP exchange response missing answer: {}",
                response_text
            )));
        }

        // Maybe it's raw SDP
        if response_text.trim().starts_with("v=") {
            return Ok(response_text);
        }

        Err(XboxError::StreamError(format!(
            "Could not parse SDP exchange response: {}",
            response_text
        )))
    }

    /// Poll for SDP answer after sending offer
    async fn poll_for_sdp_answer(&self, session_path: &str) -> Result<String> {
        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!("{}/{}/sdp", api_base, session_path);

        for attempt in 1..=10 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            info!("Polling for SDP answer (attempt {})", attempt);

            let response = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", gs_token))
                .header("x-gssv-client", "XboxComBrowser")
                .send()
                .await
                .map_err(XboxError::NetworkError)?;

            let status = response.status();
            let response_text = response.text().await.map_err(|e| {
                XboxError::StreamError(format!("Failed to read SDP poll response: {}", e))
            })?;

            info!("SDP poll response ({}): {}", status, &response_text);

            if !status.is_success() {
                continue;
            }

            if response_text.trim().is_empty() {
                continue;
            }

            // Try to parse as JSON
            if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
                // Log the full structure for debugging
                debug!(
                    "SDP poll JSON keys: {:?}",
                    json_value.as_object().map(|o| o.keys().collect::<Vec<_>>())
                );

                // First check for exchangeResponse which is a JSON string that needs re-parsing
                if let Some(exchange_str) =
                    json_value.get("exchangeResponse").and_then(|v| v.as_str())
                {
                    // Parse the inner JSON
                    if let Ok(inner_json) = serde_json::from_str::<serde_json::Value>(exchange_str)
                        && let Some(sdp) = inner_json.get("sdp").and_then(|v| v.as_str())
                            && sdp.trim().starts_with("v=") {
                                info!("Got SDP answer from exchangeResponse ({} bytes)", sdp.len());
                                return Ok(sdp.to_string());
                            }
                    // Maybe exchangeResponse is raw SDP
                    if exchange_str.trim().starts_with("v=") {
                        return Ok(exchange_str.to_string());
                    }
                }

                // Try direct keys
                for key in &["sdp", "answer", "exchangeSdp"] {
                    if let Some(sdp) = json_value.get(*key).and_then(|v| v.as_str())
                        && sdp.trim().starts_with("v=") {
                            info!("Got SDP answer from poll ({} bytes)", sdp.len());
                            return Ok(sdp.to_string());
                        }
                }
            }

            // Check if raw SDP
            if response_text.trim().starts_with("v=") {
                return Ok(response_text);
            }
        }

        Err(XboxError::StreamError(
            "Timeout waiting for SDP answer".to_string(),
        ))
    }

    /// Keep session alive with heartbeat
    /// Returns the HTTP status code as a string so JS can log it
    pub async fn send_keepalive(&self, session_path: &str) -> Result<String> {
        debug!("Sending session keepalive");

        let gs_token = self
            .gs_token
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("Not logged in to xHome".to_string()))?;
        let api_base = self
            .api_base
            .as_ref()
            .ok_or_else(|| XboxError::AuthError("No API base URL".to_string()))?;

        let url = format!(
            "{}/{}/keepalive",
            api_base.trim_end_matches('/'),
            session_path.trim_start_matches('/')
        );

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", gs_token))
            .header("Content-Type", "application/json")
            .header("x-gssv-client", "XboxComBrowser")
            .send()
            .await
            .map_err(XboxError::NetworkError)?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            warn!("Keepalive failed: {} - {}", status, body);
            return Err(XboxError::ConnectionError(format!(
                "Keepalive HTTP {}: {}",
                status, body
            )));
        }

        Ok(format!("{}", status))
    }
}
