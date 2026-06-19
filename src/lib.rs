//! Xbox Remote library crate.
//!
//! The application logic lives here as a library so that **examples**
//! (`examples/*.rs`), **integration tests** (`tests/*.rs`), and future binaries
//! can reuse the modules — Cargo's `examples`/`tests`/`bin` targets link against
//! the crate's *library*, not its binary. `src/main.rs` is a thin shim that calls
//! [`run`]. (Idiomatic Tauri 2 lib+bin layout.)

pub mod auth;
pub mod clip;
pub mod error;
pub mod logging;
// `rtc` compiles in the default build: its pure protocol modules (input/protocol/
// clip_tap) and trait seams carry no codec/transport deps and are unit-tested
// without the feature. Only the str0m/ffmpeg-backed engine + adapters inside it
// are gated behind `native-webrtc` (see src/rtc/mod.rs).
pub mod rtc;
pub mod token_store;
pub mod updater;
pub mod xhome;

/// Launch the Tauri application (window, plugins, commands). Called from
/// `main.rs`. Returns when the app exits.
pub fn run() {
    use tauri::Manager;
    use tokio::sync::Mutex;

    // WebKitGTK + Wayland is hostile to WebRTC video: the native DMA-BUF path
    // renders incoming video as black squares (Tauri #14924) and also triggers
    // "Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display" on
    // many compositor + GPU combos, aborting before the window opens. The
    // documented fix for WebRTC-in-WebKitGTK is to run under XWayland with
    // compositing disabled (Tauri discussion #8426): GDK_BACKEND=x11 sidesteps the
    // Wayland protocol error AND keeps video decoding/rendering, where merely
    // disabling the DMA-BUF *renderer* fixed the crash but left video black.
    //
    // Each variable is only set if the user hasn't already set it (so they can
    // override individually), and the entire workaround is skipped when
    // XBOX_REMOTE_NATIVE_WAYLAND is set — for setups where native Wayland already
    // works and the user prefers it (e.g. HiDPI/latency reasons).
    //
    // SAFETY: runs at the very top of run() (the first thing main() calls),
    // before any other thread is spawned, so there is no concurrent access to the
    // environment.
    #[cfg(target_os = "linux")]
    if std::env::var_os("XBOX_REMOTE_NATIVE_WAYLAND").is_none() {
        if std::env::var_os("GDK_BACKEND").is_none() {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Initialize unified logging (file + ring). Keep the guard alive for
            // the whole process by managing it in state.
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("xbox-remote-logs"));
            let (log_state, log_guard) = logging::init_logging(&log_dir);
            app.manage(log_state);
            app.manage(log_guard);
            tracing::info!("xbox-remote starting; logs at {}", log_dir.display());

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
            tauri_commands::open_external_url,
            tauri_commands::discover_xhome_consoles,
            tauri_commands::create_xhome_session,
            tauri_commands::send_ice_candidate,
            tauri_commands::poll_ice_candidates,
            tauri_commands::get_ice_servers,
            tauri_commands::exchange_sdp,
            tauri_commands::set_stream_status,
            tauri_commands::send_session_keepalive,
            tauri_commands::save_clip,
            updater::check_update,
            updater::install_update,
            logging::log_event,
            logging::get_recent_logs,
            logging::set_log_verbosity,
            logging::open_log_dir,
            logging::export_logs,
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

    use std::path::{Path, PathBuf};

    /// Build the absolute path for a clip file under `base`, rejecting any name
    /// that could escape the directory (separators, `..`, empty).
    pub fn clip_file_path(base: &Path, name: &str) -> Result<PathBuf, String> {
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(format!("invalid clip file name: {name:?}"));
        }
        Ok(base.join(name))
    }

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

    /// Open an external web URL in the user's real browser.
    ///
    /// Replaces the frontend `@tauri-apps/plugin-opener` call for the sign-in
    /// page. On Linux the browser must be launched with a **sanitized
    /// environment**: an AppImage injects `LD_LIBRARY_PATH` (plus GTK/GST module
    /// paths) that a child browser inherits and then fails to start from —
    /// *silently*, so the button appeared to do nothing. On other platforms we
    /// delegate to the opener plugin, which already works.
    #[tauri::command]
    pub fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
        // Allowlist web/mail schemes only — never hand arbitrary schemes to the OS.
        let allowed =
            url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
        if !allowed {
            tracing::warn!("open_external_url refused non-web URL");
            return Err("refused to open non-web URL".to_string());
        }

        #[cfg(target_os = "linux")]
        {
            let _ = &app; // AppHandle is only needed on non-Linux platforms.
            open_url_linux(&url)
        }
        #[cfg(not(target_os = "linux"))]
        {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("failed to open URL: {e}"))
        }
    }

    /// Launch the default browser via `xdg-open`, stripping the AppImage's
    /// injected library/module paths from the child so it loads system libraries.
    #[cfg(target_os = "linux")]
    fn open_url_linux(url: &str) -> Result<(), String> {
        use std::process::{Command, Stdio};

        // Variables an AppImage runtime injects that break a child browser by
        // forcing it to load the AppImage's bundled libraries. Cleared from the
        // child so it uses the host's libraries instead.
        const APPIMAGE_POLLUTION: &[&str] = &[
            "LD_LIBRARY_PATH",
            "LD_LIBRARY_PATH_ORIG",
            "LD_PRELOAD",
            "GTK_PATH",
            "GTK_EXE_PREFIX",
            "GTK_DATA_PREFIX",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GIO_MODULE_DIR",
            "GIO_EXTRA_MODULES",
            "GSETTINGS_SCHEMA_DIR",
            "FONTCONFIG_FILE",
            "FONTCONFIG_PATH",
            "QT_PLUGIN_PATH",
            "PYTHONPATH",
            "PERLLIB",
            "LIBGL_DRIVERS_PATH",
            "XKB_CONFIG_ROOT",
        ];

        let in_appimage =
            std::env::var_os("APPDIR").is_some() || std::env::var_os("APPIMAGE").is_some();

        let mut cmd = Command::new("xdg-open");
        cmd.arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if in_appimage {
            for var in APPIMAGE_POLLUTION {
                cmd.env_remove(var);
            }
            tracing::info!("AppImage detected — launching browser with sanitized environment");
        }

        match cmd.spawn() {
            Ok(_) => {
                tracing::info!("xdg-open launched for external URL ({} bytes)", url.len());
                Ok(())
            }
            Err(e) => {
                tracing::error!("xdg-open failed to launch: {e}");
                Err(format!(
                    "failed to launch browser (is xdg-utils installed?): {e}"
                ))
            }
        }
    }

    #[tauri::command]
    pub async fn try_load_cached_auth(state: State<'_, AppState>) -> Result<bool, String> {
        let auth = state.auth.lock().await;
        let loaded = auth
            .load_cached_tokens()
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
        // Authorization-code flow: returns the authorize URL to open in the
        // browser; a background task completes sign-in. The frontend opens the
        // URL and polls check_auth_status until tokens are stored.
        let authorize_url = auth
            .start_auth_code_flow()
            .await
            .map_err(|e| format!("Auth failed: {}", e))?;

        // Clone auth instance for xHome client (they share the same tokens via Arc<Mutex>)
        let auth_clone = auth.clone();
        drop(auth); // Release lock before acquiring xhome lock

        // Initialize xHome client (it will use tokens once sign-in completes)
        let xhome_client = XHomeClient::new(auth_clone);
        *state.xhome.lock().await = Some(xhome_client);

        Ok(authorize_url)
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

    /// Persist a recorded clip (raw WebM bytes) under <Videos>/Xbox Remote Clips/.
    /// Bytes arrive as a raw IPC body; the file name is passed via the X-Clip-Name header.
    /// Returns the absolute path of the written file.
    #[tauri::command]
    pub fn save_clip(request: tauri::ipc::Request) -> Result<String, String> {
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err("clip body must be raw bytes".to_string());
        };
        let name = request
            .headers()
            .get("X-Clip-Name")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "missing X-Clip-Name header".to_string())?;

        let dir = dirs::video_dir()
            .ok_or_else(|| "could not resolve Videos directory".to_string())?
            .join("Xbox Remote Clips");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create dir failed: {e}"))?;

        let path = clip_file_path(&dir, name)?;

        // Encoded-frame clips arrive as an `XCLP` payload to remux into a native
        // MP4. MediaRecorder fallback clips arrive as a finished media file and
        // are written through unchanged.
        let data: Vec<u8> = if bytes.starts_with(&crate::clip::MAGIC.to_le_bytes()) {
            let payload =
                crate::clip::ClipPayload::parse(bytes).map_err(|e| format!("clip parse: {e}"))?;
            crate::clip::mux_to_mp4(&payload).map_err(|e| format!("clip mux: {e}"))?
        } else {
            bytes.clone()
        };
        std::fs::write(&path, &data).map_err(|e| format!("write failed: {e}"))?;

        Ok(path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod clip_tests {
    use super::tauri_commands::clip_file_path;
    use std::path::Path;

    #[test]
    fn joins_a_valid_name() {
        let p = clip_file_path(Path::new("/clips"), "xbox-clip-20260616-101500.webm").unwrap();
        assert_eq!(p.parent().unwrap(), Path::new("/clips"));
        assert!(p.ends_with("xbox-clip-20260616-101500.webm"));
    }

    #[test]
    fn rejects_path_traversal_and_separators() {
        assert!(clip_file_path(Path::new("/clips"), "../evil.webm").is_err());
        assert!(clip_file_path(Path::new("/clips"), "a/b.webm").is_err());
        assert!(clip_file_path(Path::new("/clips"), "a\\b.webm").is_err());
        assert!(clip_file_path(Path::new("/clips"), "").is_err());
    }
}
