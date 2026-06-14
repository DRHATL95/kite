// Hide the console window on Windows in release builds (keep it in debug so
// tracing logs are visible during development).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod error;
mod token_store;
mod updater;
mod xhome;

// Tauri UI main function
fn main() {
    use tokio::sync::Mutex;
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Initialize logging
            use tracing::Level;
            use tracing_subscriber;

            tracing_subscriber::fmt()
                .with_max_level(Level::INFO)
                .init();

            // Initialize app state
            let auth = auth::XboxAuth::new();

            app.manage(tauri_commands::AppState {
                auth: Mutex::new(auth),
                xhome: Mutex::new(None),
                stream_status: Mutex::new(tauri_commands::StreamStatus::default()),
            });
            app.manage(updater::PendingUpdate::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_commands::try_load_cached_auth,
            tauri_commands::start_xbox_auth,
            tauri_commands::check_auth_status,
            tauri_commands::sign_out,
            tauri_commands::discover_xhome_consoles,
            tauri_commands::create_xhome_session,
            tauri_commands::send_ice_candidate,
            tauri_commands::poll_ice_candidates,
            tauri_commands::get_ice_servers,
            tauri_commands::exchange_sdp,
            tauri_commands::set_stream_status,
            tauri_commands::send_session_keepalive,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// This will be used by Tauri commands
mod tauri_commands {
    use super::*;
    use auth::XboxAuth;
    use tauri::State;
    use tokio::sync::Mutex;
    use xhome::XHomeClient;

    pub struct AppState {
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

    /// Sign out: clear the cached Microsoft/Xbox tokens from memory and the OS
    /// keychain, and drop the xHome client so subsequent API calls require a
    /// fresh sign-in.
    #[tauri::command]
    pub async fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
        let auth = state.auth.lock().await;
        auth.sign_out()
            .await
            .map_err(|e| format!("Sign out failed: {}", e))?;
        drop(auth);
        *state.xhome.lock().await = None;
        Ok(())
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

    /// Send keepalive to xHome API to prevent session timeout
    #[tauri::command]
    pub async fn send_session_keepalive(
        session_path: String,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let xhome = state.xhome.lock().await;
        if let Some(client) = xhome.as_ref() {
            client
                .send_keepalive(&session_path)
                .await
                .map_err(|e| format!("Keepalive failed: {}", e))
        } else {
            Err("xHome client not initialized".to_string())
        }
    }
}
