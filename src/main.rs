mod auth;
mod discovery;
mod error;
mod xhome;

use discovery::XboxDiscovery;

// CLI-only main function
#[cfg(not(feature = "tauri"))]
#[tokio::main]
async fn main() -> error::Result<()> {
    use tracing::{info, Level};
    use tracing_subscriber;

    // Initialize logging
    tracing_subscriber::fmt()
        .with_max_level(Level::INFO)
        .init();

    info!("Xbox Remote starting...");

    // Create discovery instance
    let mut discovery = XboxDiscovery::new()?;

    // Discover Xbox consoles
    info!("Scanning for Xbox consoles on the network...");
    let consoles = discovery.discover().await?;

    if consoles.is_empty() {
        println!("No Xbox consoles found on the network.");
        println!("\nTroubleshooting:");
        println!("1. Make sure your Xbox is turned on");
        println!("2. Ensure your Xbox and PC are on the same network");
        println!("3. Check that Xbox Remote Play is enabled in Xbox settings");
        println!("4. Verify firewall settings are not blocking discovery (UDP port 1900)");
        return Ok(());
    }

    println!("\nFound {} Xbox console(s):", consoles.len());
    for (i, console) in consoles.iter().enumerate() {
        println!(
            "  {}. {} ({:?}) at {}",
            i + 1,
            console.name,
            console.console_type,
            console.address
        );
    }

    // For now, just demonstrate discovery
    // The Tauri UI will handle the actual connection and streaming

    info!("Xbox Remote ready. Start the UI to connect and stream.");

    Ok(())
}

// Tauri UI main function
#[cfg(feature = "tauri")]
fn main() {
    use tokio::sync::Mutex;
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize logging
            use tracing::Level;
            use tracing_subscriber;

            tracing_subscriber::fmt()
                .with_max_level(Level::INFO)
                .init();

            // Initialize app state
            let discovery = XboxDiscovery::new().expect("Failed to initialize discovery");
            let auth = auth::XboxAuth::new();

            app.manage(tauri_commands::AppState {
                discovery: Mutex::new(discovery),
                auth: Mutex::new(auth),
                xhome: Mutex::new(None),
                stream_status: Mutex::new(tauri_commands::StreamStatus::default()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_commands::try_load_cached_auth,
            tauri_commands::start_xbox_auth,
            tauri_commands::check_auth_status,
            tauri_commands::discover_xhome_consoles,
            tauri_commands::create_xhome_session,
            tauri_commands::send_ice_candidate,
            tauri_commands::poll_ice_candidates,
            tauri_commands::get_ice_servers,
            tauri_commands::send_sdp_answer,
            tauri_commands::exchange_sdp,
            tauri_commands::discover_consoles,
            tauri_commands::discover_local_xbox,
            tauri_commands::get_stream_status,
            tauri_commands::set_stream_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// This will be used by Tauri commands
#[cfg(feature = "tauri")]
mod tauri_commands {
    use super::*;
    use auth::XboxAuth;
    use tauri::State;
    use tokio::sync::Mutex;
    use xhome::XHomeClient;

    pub struct AppState {
        pub discovery: Mutex<XboxDiscovery>,
        pub auth: Mutex<XboxAuth>,
        pub xhome: Mutex<Option<XHomeClient>>,
        pub stream_status: Mutex<StreamStatus>,
    }

    #[derive(Default, serde::Serialize, Clone)]
    pub struct StreamStatus {
        pub state: String,
        pub connected: bool,
        pub streaming: bool,
    }

    #[tauri::command]
    pub async fn try_load_cached_auth(state: State<'_, AppState>) -> Result<bool, String> {
        let auth = state.auth.lock().await;
        let loaded = auth.load_cached_tokens()
            .await
            .map_err(|e| format!("Failed to load cached tokens: {}", e))?;

        if loaded {
            // Initialize xHome client with the loaded auth
            let auth_clone = auth.clone();
            drop(auth);
            
            let xhome_client = XHomeClient::new(auth_clone);
            *state.xhome.lock().await = Some(xhome_client);
        }

        Ok(loaded)
    }

    #[tauri::command]
    pub async fn start_xbox_auth(state: State<'_, AppState>) -> Result<String, String> {
        let auth = state.auth.lock().await;
        let device_info = auth.start_device_code_auth()
            .await
            .map_err(|e| format!("Auth failed: {}", e))?;

        // Clone auth instance for xHome client (they share the same tokens via Arc<Mutex>)
        let auth_clone = auth.clone();
        drop(auth); // Release lock before acquiring xhome lock

        // Initialize xHome client (it will use tokens when they're available)
        let xhome_client = XHomeClient::new(auth_clone);
        *state.xhome.lock().await = Some(xhome_client);

        // Return device info as JSON
        serde_json::to_string(&device_info)
            .map_err(|e| format!("Failed to serialize device info: {}", e))
    }

    #[tauri::command]
    pub async fn check_auth_status(state: State<'_, AppState>) -> Result<bool, String> {
        let auth = state.auth.lock().await;
        Ok(auth.is_authenticated().await)
    }

    #[tauri::command]
    pub async fn discover_xhome_consoles(
        state: State<'_, AppState>,
    ) -> Result<Vec<String>, String> {
        let mut xhome = state.xhome.lock().await;
        let client = xhome
            .as_mut()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        let consoles = client
            .get_consoles()
            .await
            .map_err(|e| format!("Failed to get consoles: {}", e))?;

        let console_list: Vec<String> = consoles
            .iter()
            .map(|c| serde_json::to_string(c).unwrap_or_default())
            .collect();

        Ok(console_list)
    }

    #[tauri::command]
    pub async fn create_xhome_session(
        server_id: String,
        play_path: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let mut xhome = state.xhome.lock().await;
        let client = xhome
            .as_mut()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        let stream_config = client
            .create_session(&server_id, play_path.as_deref())
            .await
            .map_err(|e| format!("Failed to create session: {}", e))?;

        serde_json::to_string(&stream_config)
            .map_err(|e| format!("Failed to serialize session config: {}", e))
    }

    #[tauri::command]
    pub async fn send_ice_candidate(
        session_path: String,
        candidate: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let xhome = state.xhome.lock().await;
        let client = xhome
            .as_ref()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        client
            .send_ice_candidate(&session_path, &candidate)
            .await
            .map_err(|e| format!("Failed to send ICE candidate: {}", e))
    }

    #[tauri::command]
    pub async fn poll_ice_candidates(
        session_path: String,
        state: State<'_, AppState>,
    ) -> Result<Vec<crate::xhome::IceCandidate>, String> {
        tracing::info!("poll_ice_candidates called for session: {}", session_path);
        let xhome = state.xhome.lock().await;
        let client = xhome
            .as_ref()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        let result = client
            .poll_ice_candidates(&session_path)
            .await
            .map_err(|e| format!("Failed to poll ICE candidates: {}", e))?;
        
        tracing::info!("poll_ice_candidates returned {} candidates", result.len());
        Ok(result)
    }

    #[tauri::command]
    pub async fn get_ice_servers(
        session_path: String,
        state: State<'_, AppState>,
    ) -> Result<Vec<crate::xhome::IceServer>, String> {
        tracing::info!("get_ice_servers called for session: {}", session_path);
        let xhome = state.xhome.lock().await;
        let client = xhome
            .as_ref()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        client
            .get_ice_servers(&session_path)
            .await
            .map_err(|e| format!("Failed to get ICE servers: {}", e))
    }

    #[tauri::command]
    pub async fn send_sdp_answer(
        session_path: String,
        sdp: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let xhome = state.xhome.lock().await;
        let client = xhome
            .as_ref()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        client
            .send_sdp_answer(&session_path, &sdp)
            .await
            .map_err(|e| format!("Failed to send SDP answer: {}", e))
    }

    /// Exchange our SDP offer for the server's SDP answer
    #[tauri::command]
    pub async fn exchange_sdp(
        session_path: String,
        sdp_offer: String,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let xhome = state.xhome.lock().await;
        let client = xhome
            .as_ref()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        client
            .exchange_sdp_offer(&session_path, &sdp_offer)
            .await
            .map_err(|e| format!("SDP exchange failed: {}", e))
    }

    #[tauri::command]
    pub async fn discover_consoles(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        let mut discovery = state.discovery.lock().await;

        match discovery.discover().await {
            Ok(consoles) => {
                let console_list: Vec<String> = consoles
                    .iter()
                    .map(|c| c.to_json_safe().unwrap_or_default())
                    .collect();
                Ok(console_list)
            }
            Err(e) => Err(format!("Discovery failed: {}", e)),
        }
    }

    /// Discover Xbox consoles on local network using SmartGlass protocol
    #[tauri::command]
    pub async fn discover_local_xbox(
        state: State<'_, AppState>,
    ) -> Result<Vec<String>, String> {
        let mut discovery = state.discovery.lock().await;

        // Try SmartGlass discovery first (native Xbox discovery)
        match discovery.discover_smartglass().await {
            Ok(consoles) if !consoles.is_empty() => {
                return Ok(consoles
                    .iter()
                    .map(|c| c.to_json_safe().unwrap_or_default())
                    .collect());
            }
            Ok(_) => {
                tracing::info!("SmartGlass discovery found no consoles, trying SSDP...");
            }
            Err(e) => {
                tracing::warn!("SmartGlass discovery failed: {}, trying SSDP...", e);
            }
        }

        // Fall back to SSDP discovery
        match discovery.discover().await {
            Ok(consoles) => Ok(consoles
                .iter()
                .map(|c| c.to_json_safe().unwrap_or_default())
                .collect()),
            Err(e) => Err(format!("Discovery failed: {}", e)),
        }
    }

    /// Get current streaming status
    #[tauri::command]
    pub async fn get_stream_status(state: State<'_, AppState>) -> Result<String, String> {
        let xhome = state.xhome.lock().await;
        let authenticated = xhome.is_some();
        let status = state.stream_status.lock().await;

        Ok(serde_json::json!({
            "authenticated": authenticated,
            "streaming": status.streaming,
            "connected": status.connected,
            "state": status.state,
        })
        .to_string())
    }

    /// Update stream status from frontend
    #[tauri::command]
    pub async fn set_stream_status(
        connection_state: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let mut status = state.stream_status.lock().await;
        status.connected = connection_state == "connected";
        status.streaming = connection_state == "connected";
        status.state = connection_state;
        Ok(())
    }
}
