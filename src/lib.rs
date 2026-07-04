//! Kite library crate.
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
pub mod releases;
// `rtc` compiles in the default build: its pure protocol modules (input/protocol/
// clip_tap) and trait seams carry no codec/transport deps and are unit-tested
// without the feature. Only the str0m/ffmpeg-backed engine + adapters inside it
// are gated behind `native-webrtc` (see src/rtc/mod.rs).
pub mod rtc;
pub mod token_store;
pub mod tray;
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
    // KITE_NATIVE_WAYLAND is set (legacy alias: XBOX_REMOTE_NATIVE_WAYLAND) — for
    // setups where native Wayland already works and the user prefers it (e.g.
    // HiDPI/latency reasons).
    //
    // SAFETY: runs at the very top of run() (the first thing main() calls),
    // before any other thread is spawned, so there is no concurrent access to the
    // environment.
    #[cfg(target_os = "linux")]
    if std::env::var_os("KITE_NATIVE_WAYLAND").is_none()
        && std::env::var_os("XBOX_REMOTE_NATIVE_WAYLAND").is_none()
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
        // Required even in native-webrtc builds: without it the WebKit HUD itself
        // renders black under XWayland (not just browser-path WebRTC video). The
        // connecting-phase "ghosting" is addressed in the frontend instead, by
        // only making the HUD transparent once video is actually flowing.
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
                .unwrap_or_else(|_| std::env::temp_dir().join("kite-logs"));
            let (log_state, log_guard) = logging::init_logging(&log_dir);
            app.manage(log_state);
            app.manage(log_guard);
            tracing::info!("kite starting; logs at {}", log_dir.display());

            // Initialize app state
            let auth = auth::XboxAuth::new();

            // Native render seam: the engine's decode thread publishes decoded
            // frames here; the GTK GL thread pulls them for upload. Created here
            // so it can be both stored in AppState (for `rtc_connect`, a later
            // 6c task) and handed to the render mount below. Feature-gated so the
            // lean Win/macOS browser-path build doesn't carry it.
            #[cfg(all(target_os = "linux", feature = "native-webrtc"))]
            let frame_sink = rtc::media::frame_sink::SharedFrame::new();

            app.manage(tauri_commands::AppState {
                auth: Mutex::new(auth),
                xhome: Mutex::new(None),
                stream_status: Mutex::new(tauri_commands::StreamStatus::default()),
                #[cfg(all(target_os = "linux", feature = "native-webrtc"))]
                frame_sink: frame_sink.clone(),
                #[cfg(feature = "native-webrtc")]
                rtc: Mutex::new(None),
            });
            app.manage(updater::PendingUpdate::default());

            // Always-on system tray (Show/Quit + restore-on-click). Non-fatal:
            // if it fails, the app still runs and close simply quits.
            if let Err(e) = tray::build_tray(app) {
                tracing::warn!("tray icon setup failed (continuing without tray): {e}");
            }

            // Mount the native GTK video surface UNDER the transparent web HUD.
            // Linux + native-webrtc only; the browser path (Windows/macOS, or
            // Linux without the feature) is untouched.
            #[cfg(all(target_os = "linux", feature = "native-webrtc"))]
            native_render::mount(app.handle(), frame_sink);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Tear down the native WebRTC engine when the main window closes so
            // the Xbox session is cleanly ended (not left as an orphaned session
            // on the console). Gated so the lean Windows/macOS build is untouched.
            #[cfg(feature = "native-webrtc")]
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<tauri_commands::AppState>();
                // Block_on is safe here: we are on the GTK/Win32 event-loop
                // thread (not inside a tokio async context), so we can create
                // a throwaway runtime to run the brief async lock acquisition.
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .build()
                {
                    rt.block_on(async {
                        let handle_opt = state.rtc.lock().await.take();
                        if let Some(handle) = handle_opt {
                            tracing::info!(
                                "window closing — disconnecting native WebRTC engine"
                            );
                            // disconnect() sends Disconnect cmd + joins the engine
                            // thread, ensuring the session is torn down before the
                            // process exits.
                            handle.disconnect();
                        }
                    });
                }
            }
            // Non-feature builds: no engine to tear down; suppress unused warnings.
            #[cfg(not(feature = "native-webrtc"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            tauri_commands::try_load_cached_auth,
            tauri_commands::start_xbox_auth,
            tauri_commands::check_auth_status,
            tauri_commands::take_auth_flow_error,
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
            releases::get_releases,
            logging::log_event,
            logging::get_recent_logs,
            logging::set_log_verbosity,
            logging::open_log_dir,
            logging::export_logs,
            tauri_commands::rtc_native_available,
            tauri_commands::rtc_connect,
            tauri_commands::rtc_disconnect,
            tauri_commands::rtc_send_input,
            tauri_commands::rtc_request_keyframe,
            tauri_commands::rtc_set_volume,
            tauri_commands::rtc_save_clip,
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
        /// Native render seam handed to the engine by `rtc_connect` (6c). Only
        /// present on the Linux native-webrtc build; the browser path never uses
        /// it, so the field is feature-gated to keep the default build lean.
        #[cfg(all(target_os = "linux", feature = "native-webrtc"))]
        pub frame_sink: std::sync::Arc<crate::rtc::media::frame_sink::SharedFrame>,
        /// Running native WebRTC engine handle (6c.9 fills the body of
        /// `rtc_connect`; here it starts as `None`). Gated on the feature
        /// because `RtcHandle` lives in `crate::rtc::engine` which is itself
        /// gated — the field disappears on the lean Windows/macOS build.
        #[cfg(feature = "native-webrtc")]
        pub rtc: Mutex<Option<crate::rtc::engine::RtcHandle>>,
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

    /// Drain the last background sign-in failure (one-shot). The frontend polls
    /// this alongside `check_auth_status` while awaiting sign-in so a failed
    /// token exchange surfaces as a real error instead of polling forever.
    #[tauri::command]
    pub async fn take_auth_flow_error(state: State<'_, AppState>) -> Result<Option<String>, String> {
        let auth = state.auth.lock().await;
        Ok(auth.take_flow_error().await)
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
        // Self-heal auth before creating the session. The persistent XHomeClient
        // mints its gsToken once at login and never refreshes it, and the XSTS
        // token also expires ~1h — so a reconnect (or a connect from an idle
        // console list) after expiry would 401 and surface as a generic failure.
        // Refresh the XSTS if near expiry (auth-before-xhome lock order), then
        // re-login for a fresh gsToken, then create the session.
        state
            .auth
            .lock()
            .await
            .ensure_valid_tokens()
            .await
            .map_err(|e| format!("Session auth refresh failed: {}", e))?;

        let mut xhome = state.xhome.lock().await;
        let client = xhome
            .as_mut()
            .ok_or_else(|| "Not authenticated. Please login first.".to_string())?;

        client
            .login()
            .await
            .map_err(|e| format!("xHome re-login failed: {}", e))?;

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

    /// Persist a recorded clip (raw WebM bytes) under <Videos>/Kite Clips/.
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
            .join("Kite Clips");
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

    // ─────────────────────────────────────────────────────────────────────────
    // Native WebRTC command surface (6c)
    // ─────────────────────────────────────────────────────────────────────────

    /// Minimal gamepad button state mirroring the JS `GamepadButton` interface.
    #[derive(serde::Deserialize)]
    pub struct GamepadButtonDto {
        pub pressed: bool,
        pub value: f64,
    }

    /// Virtual gamepad state mirroring the JS `GamepadState` interface in
    /// `ui/src/lib/connection/input.ts`.
    /// `buttons`: full Standard Gamepad button array.
    /// `axes`: [leftX, leftY, rightX, rightY] in the range −1..+1.
    #[derive(serde::Deserialize)]
    pub struct GamepadStateDto {
        pub buttons: Vec<GamepadButtonDto>,
        pub axes: [f64; 4],
    }

    /// Lifecycle + diagnostics events forwarded from the native engine to the
    /// webview over the `rtc_event` Tauri event channel.
    ///
    /// Serialised with `#[serde(tag = "kind", rename_all = "camelCase")]` so the
    /// TypeScript consumer can discriminate on `event.payload.kind` using the
    /// camelCase names: `"connecting"`, `"connected"`, `"firstFrame"`,
    /// `"reconnecting"`, `"stats"`, `"disconnected"`, `"ended"`.
    #[cfg(feature = "native-webrtc")]
    #[derive(serde::Serialize, Clone, Debug)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum RtcEventDto {
        Connecting,
        Connected,
        FirstFrame,
        Reconnecting {
            attempt: u32,
        },
        Stats {
            #[serde(rename = "bitrateKbps")]
            bitrate_kbps: u32,
            fps: u32,
            #[serde(rename = "framesDecoded")]
            frames_decoded: u64,
            #[serde(rename = "freezeCount")]
            freeze_count: u32,
        },
        Disconnected {
            reason: String,
        },
        /// Emitted when the event stream closes (engine exited cleanly or the
        /// forwarding task detected channel closure).
        Ended,
    }

    #[cfg(feature = "native-webrtc")]
    fn rtc_event_to_dto(ev: crate::rtc::RtcEvent) -> RtcEventDto {
        use crate::rtc::RtcEvent;
        match ev {
            RtcEvent::Connecting => RtcEventDto::Connecting,
            RtcEvent::Connected => RtcEventDto::Connected,
            RtcEvent::FirstFrame => RtcEventDto::FirstFrame,
            RtcEvent::Reconnecting { attempt } => RtcEventDto::Reconnecting { attempt },
            RtcEvent::Stats(s) => RtcEventDto::Stats {
                bitrate_kbps: s.bitrate_kbps,
                fps: s.fps,
                frames_decoded: s.frames_decoded,
                freeze_count: s.freeze_count,
            },
            RtcEvent::Disconnected(reason) => RtcEventDto::Disconnected { reason },
        }
    }

    /// Map a `GamepadStateDto` (JS Standard Gamepad API shape) to a `GamepadFrame`
    /// (Xbox 38-byte wire format fields), mirroring `encodeGamepadFrame` from
    /// `ui/src/lib/connection/input.ts`.
    ///
    /// Button-index → bitmask mapping from `BUTTON_BITS` in `constants.ts`:
    ///
    /// | Index | Button          | Bit   |
    /// |-------|-----------------|-------|
    /// | 0     | A               | 16    |
    /// | 1     | B               | 32    |
    /// | 2     | X               | 64    |
    /// | 3     | Y               | 128   |
    /// | 4     | LB              | 4096  |
    /// | 5     | RB              | 8192  |
    /// | 6     | LT (trigger)    | –     |
    /// | 7     | RT (trigger)    | –     |
    /// | 8     | View / Back     | 8     |
    /// | 9     | Menu / Start    | 4     |
    /// | 10    | LeftThumb       | 16384 |
    /// | 11    | RightThumb      | 32768 |
    /// | 12    | DPad Up         | 256   |
    /// | 13    | DPad Down       | 512   |
    /// | 14    | DPad Left       | 1024  |
    /// | 15    | DPad Right      | 2048  |
    /// | 16    | Nexus / Guide   | 2     |
    ///
    /// Axes are dead-zoned (|v| < 0.1 → 0), then scaled to i16 via
    /// `round(v * 32767)` clamped to [−32767, +32767]. Y axes are stored
    /// without negation; `encode_gamepad` (src/rtc/input.rs) negates them on
    /// the wire, matching `normalizeAxis(-ly)` / `normalizeAxis(-ry)` in input.ts.
    #[cfg(feature = "native-webrtc")]
    fn gamepad_dto_to_frame(g: &GamepadStateDto) -> crate::rtc::input::GamepadFrame {
        use crate::rtc::input::{
            GamepadFrame, BTN_A, BTN_B, BTN_DPAD_DOWN, BTN_DPAD_LEFT, BTN_DPAD_RIGHT,
            BTN_DPAD_UP, BTN_LEFT_SHOULDER, BTN_LEFT_THUMB, BTN_MENU, BTN_NEXUS,
            BTN_RIGHT_SHOULDER, BTN_RIGHT_THUMB, BTN_VIEW, BTN_X, BTN_Y,
        };

        // Button index → bitmask table (indices 6 & 7 are triggers, handled below).
        const BUTTON_BITS: &[(usize, u16)] = &[
            (0, BTN_A),
            (1, BTN_B),
            (2, BTN_X),
            (3, BTN_Y),
            (4, BTN_LEFT_SHOULDER),
            (5, BTN_RIGHT_SHOULDER),
            // 6 = LT trigger value (not a bitmask)
            // 7 = RT trigger value (not a bitmask)
            (8, BTN_VIEW),
            (9, BTN_MENU),
            (10, BTN_LEFT_THUMB),
            (11, BTN_RIGHT_THUMB),
            (12, BTN_DPAD_UP),
            (13, BTN_DPAD_DOWN),
            (14, BTN_DPAD_LEFT),
            (15, BTN_DPAD_RIGHT),
            (16, BTN_NEXUS),
        ];

        let mut buttons: u16 = 0;
        for &(idx, bit) in BUTTON_BITS {
            if g.buttons.get(idx).map(|b| b.pressed).unwrap_or(false) {
                buttons |= bit;
            }
        }

        // Triggers: buttons[6].value and buttons[7].value, scaled 0..1 → 0..65535.
        let lt_val = g.buttons.get(6).map(|b| b.value).unwrap_or(0.0);
        let rt_val = g.buttons.get(7).map(|b| b.value).unwrap_or(0.0);
        let left_trigger = (lt_val.max(0.0) * 65535.0).round().min(65535.0) as u16;
        let right_trigger = (rt_val.max(0.0) * 65535.0).round().min(65535.0) as u16;

        // Dead-zone (matches STICK_DEADZONE = 0.1 in constants.ts).
        fn deadzone(v: f64) -> f64 {
            if v.abs() < 0.1 { 0.0 } else { v }
        }
        // Axis scaling: round(v * 32767), clamped to [−32767, +32767].
        fn normalize(v: f64) -> i16 {
            (v * 32767.0).round().clamp(-32767.0, 32767.0) as i16
        }

        let lx = normalize(deadzone(g.axes[0]));
        let ly = normalize(deadzone(g.axes[1]));
        let rx = normalize(deadzone(g.axes[2]));
        let ry = normalize(deadzone(g.axes[3]));

        GamepadFrame {
            buttons,
            left_thumb_x: lx,
            left_thumb_y: ly,   // encode_gamepad negates on the wire (Y-flip protocol)
            right_thumb_x: rx,
            right_thumb_y: ry,  // encode_gamepad negates on the wire (Y-flip protocol)
            left_trigger,
            right_trigger,
        }
    }

    /// Resolve the clips directory (`<Videos>/Kite Clips/`), creating it
    /// if absent. Shared between `save_clip` (browser path) and `rtc_save_clip`
    /// (native path).
    #[cfg(feature = "native-webrtc")]
    fn clips_dir() -> Result<std::path::PathBuf, String> {
        let dir = dirs::video_dir()
            .ok_or_else(|| "could not resolve Videos directory".to_string())?
            .join("Kite Clips");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create clips dir: {e}"))?;
        Ok(dir)
    }

    /// Returns `true` when the native WebRTC engine is available for this build
    /// and the user has not opted into the browser path via the env override.
    #[tauri::command]
    pub fn rtc_native_available() -> bool {
        #[cfg(feature = "native-webrtc")]
        {
            std::env::var_os("XBOX_FORCE_BROWSER_WEBRTC").is_none()
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            false
        }
    }

    /// Begin a native WebRTC streaming session.
    ///
    /// Clones the current auth under its lock (matches the pattern in
    /// `start_xbox_auth`), refuses if a session is already running, spawns the
    /// engine, takes the event receiver, and launches a detached tokio task that
    /// forwards every `RtcEvent` to the webview as an `rtc_event` Tauri event.
    /// Returns `Ok(())` immediately; connection failures arrive as
    /// `Disconnected` events.
    #[tauri::command]
    pub async fn rtc_connect(
        app: tauri::AppHandle,
        state: State<'_, AppState>,
        server_id: String,
    ) -> Result<(), String> {
        #[cfg(feature = "native-webrtc")]
        {
            use tauri::Emitter;

            // Clone auth under its lock, then drop the lock before acquiring rtc.
            let auth = {
                let guard = state.auth.lock().await;
                guard.clone()
            };

            let mut rtc_guard = state.rtc.lock().await;
            if rtc_guard.is_some() {
                return Err("already connected".into());
            }

            #[cfg(all(target_os = "linux", feature = "native-webrtc"))]
            let frame_sink = Some(state.frame_sink.clone());
            #[cfg(not(target_os = "linux"))]
            let frame_sink: Option<std::sync::Arc<crate::rtc::media::frame_sink::SharedFrame>> =
                None;

            // `play_path` is intentionally not accepted from the webview: it is
            // opaque data that originates from the xHome API, not user input, so
            // the engine sources its own default rather than trusting a JS string
            // in the request URL. (Pass `None` → engine/signaling default.)
            let mut handle =
                crate::rtc::engine::spawn(auth, server_id, None, frame_sink)
                    .map_err(|e| format!("engine spawn: {e}"))?;

            // Take the event receiver out of the handle before locking it away.
            let rx = handle
                .take_events()
                .ok_or_else(|| "engine produced no event receiver".to_string())?;

            *rtc_guard = Some(handle);
            drop(rtc_guard);

            // Forward events to the webview. The task exits when the channel
            // closes (engine exited), emitting `Ended` as the final event.
            let app_for_task = app.clone();
            tokio::spawn(async move {
                let mut rx = rx;
                while let Some(ev) = rx.recv().await {
                    let dto = rtc_event_to_dto(ev);
                    let _ = app_for_task.emit("rtc_event", dto);
                }
                let _ = app_for_task.emit("rtc_event", RtcEventDto::Ended);
            });

            Ok(())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = (app, state, server_id);
            Err("native WebRTC unavailable in this build".into())
        }
    }

    /// Tear down the running native WebRTC session.
    #[tauri::command]
    pub async fn rtc_disconnect(state: State<'_, AppState>) -> Result<(), String> {
        #[cfg(feature = "native-webrtc")]
        {
            let mut rtc_guard = state.rtc.lock().await;
            if let Some(handle) = rtc_guard.take() {
                handle.disconnect();
            }
            Ok(())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = state;
            Err("native WebRTC unavailable in this build".into())
        }
    }

    /// Forward a gamepad state snapshot to the engine's input encoder.
    #[tauri::command]
    pub async fn rtc_send_input(
        state: State<'_, AppState>,
        gamepad: GamepadStateDto,
    ) -> Result<(), String> {
        #[cfg(feature = "native-webrtc")]
        {
            let rtc_guard = state.rtc.lock().await;
            if let Some(handle) = rtc_guard.as_ref() {
                let frame = gamepad_dto_to_frame(&gamepad);
                handle.send_input(frame);
            }
            Ok(())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = (state, gamepad);
            Err("native WebRTC unavailable in this build".into())
        }
    }

    /// Ask the encoder to emit a keyframe on the next opportunity.
    #[tauri::command]
    pub async fn rtc_request_keyframe(state: State<'_, AppState>) -> Result<(), String> {
        #[cfg(feature = "native-webrtc")]
        {
            let rtc_guard = state.rtc.lock().await;
            if let Some(handle) = rtc_guard.as_ref() {
                handle.request_keyframe();
            }
            Ok(())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = state;
            Err("native WebRTC unavailable in this build".into())
        }
    }

    /// Set native audio playback volume (0.0 = mute, 1.0 = unity).
    #[tauri::command]
    pub async fn rtc_set_volume(state: State<'_, AppState>, gain: f32) -> Result<(), String> {
        #[cfg(feature = "native-webrtc")]
        {
            let rtc_guard = state.rtc.lock().await;
            if let Some(handle) = rtc_guard.as_ref() {
                handle.set_volume(gain);
            }
            Ok(())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = (state, gain);
            Err("native WebRTC unavailable in this build".into())
        }
    }

    /// Assemble and save a clip from the engine's encoded-frame ring buffer.
    /// Returns the absolute path of the saved MP4.
    #[tauri::command]
    pub async fn rtc_save_clip(state: State<'_, AppState>) -> Result<String, String> {
        #[cfg(feature = "native-webrtc")]
        {
            let rtc_guard = state.rtc.lock().await;
            let handle = rtc_guard
                .as_ref()
                .ok_or_else(|| "no active native session".to_string())?;
            let clip = handle
                .clip()
                .await
                .ok_or_else(|| "no clip data available (ring buffer empty or engine gone)".to_string())?;
            let dir = clips_dir()?;
            let path = crate::clip::save_assembled_clip(&clip, &dir)?;
            Ok(path.to_string_lossy().into_owned())
        }
        #[cfg(not(feature = "native-webrtc"))]
        {
            let _ = state;
            Err("native WebRTC unavailable in this build".into())
        }
    }
}

/// Native render mount (Linux + `native-webrtc`): re-parents the live wry
/// webview on top of a GTK [`gtk::GLArea`] inside a [`gtk::Overlay`], so decoded
/// Xbox video composites *under* the transparent Svelte HUD — the same proven
/// `GtkOverlay { GLArea base, transparent webview overlay }` pattern as
/// `examples/render_live.rs`, but applied to the Tauri-managed window.
///
/// ## Spike status
/// This is the make-or-break compositing spike (Task 6b.B3). It compiles on
/// Linux but display correctness is validated on a real Linux box by the owner.
/// No video appears until the engine feeds `frame_sink` (a later 6c
/// `rtc_connect` task); the spike validates the re-parent + compositing only.
#[cfg(all(target_os = "linux", feature = "native-webrtc"))]
mod native_render {
    use std::sync::Arc;

    use tauri::{AppHandle, Manager};

    use crate::rtc::media::frame_sink::SharedFrame;
    use crate::rtc::media::render_gtk::GtkGlRenderer;

    /// Re-parent the main window's webview onto a GL video surface.
    ///
    /// Must run on the GTK main thread; Tauri's `.setup()` runs there, and the
    /// GTK work is additionally deferred into [`tauri::WebviewWindow::with_webview`],
    /// whose closure is invoked on the main thread. Tauri owns the GTK main loop,
    /// so the render tick scheduled here cooperates with it.
    pub fn mount(app: &AppHandle, frame_sink: Arc<SharedFrame>) {
        let Some(window) = app.get_webview_window("main") else {
            tracing::error!("native_render: no 'main' webview window; skipping render mount");
            return;
        };

        // All GTK widget access happens inside this closure (main thread). The
        // closure is `Send + 'static`; `Arc<SharedFrame>` is Send, and we move a
        // clone of the (Send) WebviewWindow in to reach its gtk_window/default_vbox.
        let window_for_closure = window.clone();
        let result = window.with_webview(move |platform_webview| {
            use gtk::prelude::*;

            // The live webkit2gtk::WebView (an `IsA<gtk::Widget>`). Upcast to a
            // plain Widget so we never have to name the webkit2gtk crate (it's a
            // transitive dep of wry/tauri, sharing our gtk 0.18).
            let webview_widget: gtk::Widget = platform_webview.inner().upcast();

            // Tauri's window tree is `gtk::ApplicationWindow → gtk::Box (vbox) →
            // webview`. We re-home the webview into a `gtk::Overlay` so video can
            // composite under it — but the overlay must become the window's
            // *direct* child, NOT another layer inside the vbox.
            //
            // Why: wry attaches an undecorated-resize handler to every webview
            // (`tauri-runtime-wry .../undecorated_resizing.rs`) that, on a
            // left-button press, does `webview.parent().parent().downcast::<gtk::
            // Window>().unwrap()`. That walks exactly two levels up and expects
            // the gtk::Window. If we leave the overlay nested in the vbox
            // (`window → vbox → overlay → webview`), that walk lands on the vbox
            // (a GtkBox), the downcast `unwrap()` fails, and because it runs
            // inside a GTK C callback the panic is non-unwinding → the whole app
            // aborts on the first click. Keeping `window → overlay → webview`
            // preserves the two-hop invariant. (Found live, 2026-06-22.)
            let vbox = match window_for_closure.default_vbox() {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!("native_render: default_vbox() failed: {e}");
                    return;
                }
            };
            let gtk_window = match window_for_closure.gtk_window() {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("native_render: gtk_window() failed: {e}");
                    return;
                }
            };

            // Detach the webview from the vbox, then remove the now-empty vbox
            // from the window so the overlay can take its place as the window's
            // sole child (gtk::ApplicationWindow is a Bin — one child only).
            if let Some(parent) = webview_widget.parent()
                && let Ok(container) = parent.downcast::<gtk::Container>()
            {
                container.remove(&webview_widget);
            }
            gtk_window.remove(&vbox);

            // Build Overlay { GLArea base (video), webview overlay on top }.
            // Mirrors examples/render_live.rs's flicker-free composite. We add the
            // existing webview as the overlay child directly — gtk::Overlay sizes
            // overlay children to fill the overlay by default.
            let overlay = gtk::Overlay::new();
            let gl_area = gtk::GLArea::new();
            gl_area.set_has_alpha(true);
            gl_area.set_auto_render(true);

            // Wire the reusable GL renderer (realize + render closures) before
            // the area is shown, matching render_live's ordering.
            GtkGlRenderer::attach(&gl_area, Arc::clone(&frame_sink));

            overlay.add(&gl_area);
            overlay.add_overlay(&webview_widget);

            // Install the overlay as the window's direct child and show the tree.
            gtk_window.add(&overlay);
            overlay.show_all();

            // ~60fps render tick on the GTK main loop (Tauri-owned): repaint the
            // GL surface only when the decode thread has actually published a new
            // frame. Skipping queue_render while idle keeps the shared GTK main
            // thread free for the WebKit HUD — otherwise a constant 60fps redraw
            // (with WebKit compositing disabled) makes the HUD sluggish on the
            // login / console-list / connecting screens.
            let area_tick = gl_area.clone();
            let sink_tick = Arc::clone(&frame_sink);
            let tick_id = gtk::glib::timeout_add_local(
                std::time::Duration::from_millis(16),
                move || {
                    if sink_tick.has_pending() {
                        area_tick.queue_render();
                    }
                    gtk::glib::ControlFlow::Continue
                },
            );

            // Cancel the tick when the GLArea is destroyed so we never call
            // queue_render on a dead widget and never leak the source (matters
            // if the window/area is ever torn down and re-created).
            let tick_id = std::rc::Rc::new(std::cell::RefCell::new(Some(tick_id)));
            gl_area.connect_unrealize(move |_| {
                if let Some(id) = tick_id.borrow_mut().take() {
                    id.remove();
                }
            });

            tracing::info!(
                "native_render: mounted GLArea under the webview HUD (awaiting frames from rtc_connect)"
            );
        });

        if let Err(e) = result {
            tracing::error!("native_render: with_webview failed: {e}");
        }
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
