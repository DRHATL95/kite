/**
 * Typed Tauri command wrappers.
 *
 * Each function maps 1:1 to a #[tauri::command] in src/main.rs
 * (mod tauri_commands).  Tauri automatically converts camelCase JS argument
 * keys to snake_case Rust parameter names, so we pass camelCase here.
 *
 * Return-type notes
 * -----------------
 * Commands that return a JSON *string* (serde_json::to_string) are unwrapped
 * with JSON.parse in the wrapper so callers receive the structured type.
 * Commands that return typed structs directly (Tauri serialises them) need no
 * extra parsing.
 *
 *   JSON-string commands (parse here):
 *     start_xbox_auth         → string (authorize URL)
 *     discover_xhome_consoles → XHomeConsole[]  (Vec<String> of per-item JSON)
 *     create_xhome_session    → StreamConfig
 *
 *   Raw string commands (return as string):
 *     exchange_sdp            → string  (SDP answer)
 *     send_session_keepalive  → string  (HTTP status code)
 *
 *   Directly typed commands (no parse needed):
 *     get_ice_servers         → IceServer[]
 *     poll_ice_candidates     → IceCandidate[]
 *
 *   Boolean commands:
 *     try_load_cached_auth, check_auth_status → boolean
 *
 *   Void commands:
 *     send_ice_candidate, set_stream_status → void
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { GamepadState } from "../connection/input";
import type { RtcEvent } from "../connection/types";
import type {
  IceCandidate,
  IceServer,
  StreamConfig,
  XHomeConsole,
} from "./types";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Try to load previously cached auth tokens from the OS keychain.
 * Returns true if valid (non-expired) tokens were found and loaded.
 * Rust: try_load_cached_auth(state) -> Result<bool, String>
 */
export async function tryLoadCachedAuth(): Promise<boolean> {
  return invoke<boolean>("try_load_cached_auth");
}

/**
 * Check whether the in-memory XSTS token is currently valid (not expired).
 * Rust: check_auth_status(state) -> Result<bool, String>
 */
export async function checkAuthStatus(): Promise<boolean> {
  return invoke<boolean>("check_auth_status");
}

/**
 * Drain the last background sign-in failure (one-shot — clears on read).
 * Polled alongside checkAuthStatus() while awaiting sign-in so a failed token
 * exchange surfaces as a real error instead of an indefinite wait.
 * Rust: take_auth_flow_error(state) -> Result<Option<String>, String>
 */
export async function takeAuthFlowError(): Promise<string | null> {
  return invoke<string | null>("take_auth_flow_error");
}

/**
 * Sign out: clear cached tokens from memory and the OS keychain on the backend.
 * Rust: sign_out(state) -> Result<(), String>
 */
export async function signOut(): Promise<void> {
  return invoke<void>("sign_out");
}

/**
 * Start the OAuth authorization-code (+ PKCE) sign-in flow.
 * Returns the authorize URL to open in the browser. A Rust background task
 * catches the loopback redirect and completes sign-in; call checkAuthStatus()
 * to detect completion.
 *
 * Rust: start_xbox_auth(state) -> Result<String (authorize URL), String>
 */
export async function startXboxAuth(): Promise<string> {
  return invoke<string>("start_xbox_auth");
}

// ---------------------------------------------------------------------------
// Console discovery
// ---------------------------------------------------------------------------

/**
 * Discover Xbox consoles associated with the authenticated account.
 * Rust: discover_xhome_consoles(state) -> Result<Vec<String (JSON)>, String>
 */
export async function discoverXhomeConsoles(): Promise<XHomeConsole[]> {
  const rawItems = await invoke<string[]>("discover_xhome_consoles");
  return rawItems.map((item) => JSON.parse(item) as XHomeConsole);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a streaming session for the given console.
 *
 * @param serverId  Console server ID (XHomeConsole.serverId)
 * @param playPath  Optional play path from XHomeConsole.playPath; if omitted
 *                  the backend uses its built-in default path.
 *
 * Rust: create_xhome_session(server_id, play_path, state) -> Result<String (JSON), String>
 * Tauri maps camelCase to snake_case automatically.
 */
export async function createXhomeSession(
  serverId: string,
  playPath?: string,
): Promise<StreamConfig> {
  const raw = await invoke<string>("create_xhome_session", {
    serverId,
    playPath: playPath ?? null,
  });
  return JSON.parse(raw) as StreamConfig;
}

/**
 * Send an ICE candidate to the Xbox streaming server.
 *
 * @param sessionPath  Session path from StreamConfig.sessionPath
 * @param candidate    JSON-serialised RTCIceCandidate string (or raw candidate line)
 *
 * Rust: send_ice_candidate(session_path, candidate, state) -> Result<(), String>
 */
export async function sendIceCandidate(
  sessionPath: string,
  candidate: string,
): Promise<void> {
  return invoke<void>("send_ice_candidate", { sessionPath, candidate });
}

/**
 * Poll for ICE candidates from the Xbox streaming server.
 * Returns typed IceCandidate objects directly (no JSON string parsing needed).
 *
 * Rust: poll_ice_candidates(session_path, state) -> Result<Vec<IceCandidate>, String>
 */
export async function pollIceCandidates(
  sessionPath: string,
): Promise<IceCandidate[]> {
  return invoke<IceCandidate[]>("poll_ice_candidates", { sessionPath });
}

/**
 * Retrieve STUN/TURN server configuration for this session.
 * Returns typed IceServer objects directly (no JSON string parsing needed).
 *
 * Rust: get_ice_servers(session_path, state) -> Result<Vec<IceServer>, String>
 */
export async function getIceServers(sessionPath: string): Promise<IceServer[]> {
  return invoke<IceServer[]>("get_ice_servers", { sessionPath });
}

/**
 * Exchange an SDP offer for the server's SDP answer.
 * Returns the raw SDP answer string (starts with "v=").
 *
 * @param sessionPath  Session path from StreamConfig.sessionPath
 * @param sdpOffer     Our WebRTC SDP offer string
 *
 * Rust: exchange_sdp(session_path, sdp_offer, state) -> Result<String, String>
 */
export async function exchangeSdp(
  sessionPath: string,
  sdpOffer: string,
): Promise<string> {
  return invoke<string>("exchange_sdp", { sessionPath, sdpOffer });
}

// ---------------------------------------------------------------------------
// Session maintenance
// ---------------------------------------------------------------------------

/**
 * Report WebRTC connection state to the backend for telemetry/logging.
 *
 * @param connectionState  RTCPeerConnection.connectionState string
 *
 * Rust: set_stream_status(connection_state, state) -> Result<(), String>
 */
export async function setStreamStatus(
  connectionState: string,
): Promise<void> {
  return invoke<void>("set_stream_status", { connectionState });
}

/**
 * Send a keepalive heartbeat to the xHome API to prevent session timeout.
 * Returns the HTTP status code string (e.g. "200") for logging.
 *
 * Rust: send_session_keepalive(session_path, state) -> Result<String, String>
 */
export async function sendSessionKeepalive(
  sessionPath: string,
): Promise<string> {
  return invoke<string>("send_session_keepalive", { sessionPath });
}

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

import { revealItemInDir } from "@tauri-apps/plugin-opener";

/**
 * Persist a recorded clip to disk under <Videos>/Kite Clips/.
 * Bytes are sent as a raw IPC body (no JSON serialisation); the file name
 * travels in the X-Clip-Name header.  Returns the absolute saved path.
 *
 * Rust: save_clip(request) -> Result<String, String>
 */
export async function saveClip(
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  return invoke<string>("save_clip", bytes, {
    headers: { "X-Clip-Name": fileName },
  });
}

/**
 * Reveal a saved clip in the OS file manager (Explorer / Finder / Files).
 */
export async function revealClip(path: string): Promise<void> {
  await revealItemInDir(path);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** A single log record as stored/returned by the Rust backend. */
export interface LogRecord {
  ts: string;
  level: string;
  target: string;
  message: string;
}

/** A log record emitted by the frontend and forwarded to the Rust backend. */
export interface FrontendLogRecord {
  level: string;
  category: string;
  message: string;
}

/**
 * Forward one or more frontend log records to the Rust logging sink.
 * Rust: log_event(records) -> Result<(), String>
 */
export function logEvent(records: FrontendLogRecord[]): Promise<void> {
  return invoke("log_event", { records });
}

/**
 * Retrieve the most recent log records from the Rust in-memory ring buffer.
 *
 * @param limit  Maximum number of records to return (omit for backend default).
 * Rust: get_recent_logs(limit) -> Result<Vec<LogRecord>, String>
 */
export function getRecentLogs(limit?: number): Promise<LogRecord[]> {
  return invoke("get_recent_logs", { limit });
}

/**
 * Toggle verbose (DEBUG-level) logging on the Rust backend.
 * Rust: set_log_verbosity(verbose) -> Result<(), String>
 */
export function setLogVerbosity(verbose: boolean): Promise<void> {
  return invoke("set_log_verbosity", { verbose });
}

/**
 * Export all buffered logs to a file on disk.
 * Returns the absolute path of the exported file.
 * Rust: export_logs() -> Result<String, String>
 */
export function exportLogs(): Promise<string> {
  return invoke("export_logs");
}

/**
 * Open the log directory in the OS file manager.
 * Rust: open_log_dir() -> Result<(), String>
 */
export function openLogDir(): Promise<void> {
  return invoke("open_log_dir");
}

/**
 * Open an external web URL (https/http/mailto) in the user's real browser.
 *
 * Prefer this over `@tauri-apps/plugin-opener`'s `openUrl` for external links:
 * on Linux the backend launches the browser with a sanitized environment so it
 * works inside an AppImage, where the bundled `LD_LIBRARY_PATH` would otherwise
 * make the child browser fail to start silently.
 * Rust: open_external_url(url) -> Result<(), String>
 */
export function openExternalUrl(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}

// ---------------------------------------------------------------------------
// Native WebRTC engine (Phase 6) — only meaningful on a `native-webrtc` build
// (Linux). On other builds the Rust commands return "native unavailable" and the
// frontend uses the browser ConnectionManager instead (selected via
// rtcNativeAvailable()).
// ---------------------------------------------------------------------------

/**
 * True iff the native Rust WebRTC engine is compiled in AND not force-disabled
 * (XBOX_FORCE_BROWSER_WEBRTC). The frontend resolves this once at startup to
 * pick the native engine vs the browser ConnectionManager.
 * Rust: rtc_native_available() -> bool
 */
export function rtcNativeAvailable(): Promise<boolean> {
  return invoke<boolean>("rtc_native_available");
}

/**
 * Start a native streaming session for the given console. Returns once the
 * engine thread has spawned; connection success/failure arrives asynchronously
 * as `rtc_event`s (terminal failures as `{kind:"disconnected"}`).
 * Rust: rtc_connect(state, server_id) -> Result<(), String>
 */
export function rtcConnect(serverId: string): Promise<void> {
  return invoke<void>("rtc_connect", { serverId });
}

/**
 * Tear down the active native session (joins the engine thread).
 * Rust: rtc_disconnect(state) -> Result<(), String>
 */
export function rtcDisconnect(): Promise<void> {
  return invoke<void>("rtc_disconnect");
}

/**
 * Forward one gamepad/keyboard input state to the engine, which encodes it to
 * the 38-byte wire packet and sends it on the input data channel. Driven by the
 * GamepadPoller at ~60 Hz in native mode.
 * Rust: rtc_send_input(state, gamepad) -> Result<(), String>
 */
export function rtcSendInput(state: GamepadState): Promise<void> {
  return invoke<void>("rtc_send_input", { gamepad: state });
}

/**
 * Ask the engine to request a keyframe (IDR) from the console — the native
 * equivalent of the "Fix Video" control.
 * Rust: rtc_request_keyframe(state) -> Result<(), String>
 */
export function rtcRequestKeyframe(): Promise<void> {
  return invoke<void>("rtc_request_keyframe");
}

/**
 * Set native audio playback volume (0.0 = mute, 1.0 = unity).
 * Rust: rtc_set_volume(state, gain) -> Result<(), String>
 */
export function rtcSetVolume(gain: number): Promise<void> {
  return invoke<void>("rtc_set_volume", { gain });
}

/**
 * Save a retroactive clip from the engine's clip ring. Returns the saved MP4 path.
 * Rust: rtc_save_clip(state) -> Result<String, String>
 */
export function rtcSaveClip(): Promise<string> {
  return invoke<string>("rtc_save_clip");
}

/**
 * Subscribe to native engine events on the `rtc_event` Tauri channel. Returns an
 * unlisten function; call it on disconnect. (New pattern for this codebase —
 * core:default already grants `core:event` listen/emit.)
 */
export async function subscribeRtcEvents(
  cb: (event: RtcEvent) => void,
): Promise<UnlistenFn> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<RtcEvent>("rtc_event", (e) => cb(e.payload));
}
