/**
 * Xbox Remote — load-bearing protocol constants
 *
 * Every value in this file is taken VERBATIM from ui/public/app.js.
 * Do NOT change any value without also updating app.js and re-verifying
 * against the reference implementation (xbox-xcloud-player).
 *
 * Cross-checked 1:1 against ui/public/app.js on 2026-06-08:
 *
 *   CHANNELS[0]              app.js:306-309   label:"chat",    protocol:"chatV1"
 *   CHANNELS[1]              app.js:311-314   label:"control", protocol:"controlV1"
 *   CHANNELS[2]              app.js:316-319   label:"message", protocol:"messageV1"
 *   CHANNELS[3]              app.js:321-324   label:"input",   protocol:"1.0"
 *   CONTROL_ACCESS_KEY       app.js:485       "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E"
 *   HANDSHAKE_VERSION        app.js:459       "messageV1"
 *   HANDSHAKE_ID             app.js:460       "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179"
 *   API_KEEPALIVE_MS         app.js:183       30000
 *   KEYFRAME_DELAY_MS        app.js:500       2000
 *   IDLE_KEEPALIVE_INTERVAL_MS  app.js:428    30000
 *   IDLE_PULSE_RECENTER_MS   app.js:919       32
 *   IDLE_PULSE_LEFT_THUMB_X  app.js:903       4096
 *   RECONNECT_MAX_ATTEMPTS   app.js:15        3
 *   RECONNECT_BASE_DELAY_MS  app.js:98        3000   (delay = base * attemptNumber)
 *   WAIT_FOR_DATA_CHANNELS_MS  app.js:106     15000
 *   ICE_POLL_MAX_ATTEMPTS    app.js:764       20
 *   ICE_POLL_INTERVAL_MS     app.js:809       500
 *   DISCONNECT_GRACE_MS      app.js:718       10000
 *   ICE_GATHER_WAIT_MS       app.js:274       1000
 *   GAMEPAD_POLL_MS          app.js:1540      16
 *   IDLE_FRAME_EVERY         app.js:1541      62
 *   STICK_DEADZONE           app.js:1542      0.1
 *   REPORT_TYPE_GAMEPAD      app.js:1548      2
 *   REPORT_TYPE_CLIENT_METADATA  app.js:1549  8
 */

// ─────────────────────────────────────────────────────────────
// Data Channels
// ─────────────────────────────────────────────────────────────

/**
 * Data channel (label, protocol) pairs — REQUIRED by Xbox; do not change.
 *
 * Channel names and protocols MUST match the reference implementation
 * (xbox-xcloud-player). Do NOT use negotiated:true — DCEP negotiation
 * is required so the Xbox server receives channel OPEN messages and
 * knows which channels exist.
 *
 * app.js:301-327 (_createDataChannels)
 */
export const CHANNELS = [
  { label: "chat",    protocol: "chatV1",    ordered: true },
  { label: "control", protocol: "controlV1", ordered: true },
  { label: "message", protocol: "messageV1", ordered: true },
  { label: "input",   protocol: "1.0",       ordered: true },
] as const;

// ─────────────────────────────────────────────────────────────
// Control Channel Handshake
// ─────────────────────────────────────────────────────────────

/**
 * Access key sent in the authorizationRequest on the control channel.
 * This is a hard-coded GUID from the reference implementation; Xbox
 * will reject the authorization if this value is wrong.
 *
 * app.js:484-486 (_sendControlAuth)
 */
export const CONTROL_ACCESS_KEY = "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E";

/**
 * Message channel handshake type string — sent as the first message
 * on the message channel after it opens; Xbox responds with HandshakeAck.
 *
 * app.js:457-464 (_sendMessageHandshake)
 */
export const MESSAGE_HANDSHAKE_TYPE = "Handshake";

/**
 * Protocol version string for the message channel Handshake payload.
 * Xbox uses this to validate the wire protocol version.
 *
 * app.js:459 (_sendMessageHandshake → version field)
 */
export const MESSAGE_HANDSHAKE_VERSION = "messageV1";

/**
 * Correlation ID included in the message channel Handshake.
 * Taken verbatim from the reference implementation.
 *
 * app.js:460 (_sendMessageHandshake → id field)
 */
export const MESSAGE_HANDSHAKE_ID = "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179";

/**
 * Keyframe request payload sent on the control channel after authorization.
 * The exact field names (message / ifrRequested) are required by Xbox.
 *
 * app.js:493-497 (_sendControlAuth setTimeout) and
 * app.js:877-880 (sendKeyframeRequest)
 */
export const KEYFRAME_REQUEST = {
  message: "videoKeyframeRequested",
  ifrRequested: true,
} as const;

/**
 * Delay (ms) after sending authorizationRequest before sending the first
 * keyframe request. Xbox needs time to process auth before it can handle
 * keyframe commands.
 *
 * app.js:491-500 (_sendControlAuth → setTimeout delay)
 */
export const KEYFRAME_DELAY_MS = 2000;

// ─────────────────────────────────────────────────────────────
// Keepalive Intervals
// ─────────────────────────────────────────────────────────────

/**
 * API-side keepalive interval (ms). Hardcoded to 30 s to match the
 * reference implementation (xbox-xcloud-player). The value from the
 * session creation response (keepAlivePulseSeconds) is logged but not
 * used to set this interval.
 *
 * app.js:183 (_createSessionAndStream: this.apiKeepAliveMs = 30000)
 */
export const API_KEEPALIVE_MS = 30_000;

/**
 * Interval (ms) at which periodic idle keepalives are sent on the input
 * channel after an idle warning is received from Xbox.
 *
 * app.js:428 (_handleJsonMessage → setInterval … 30000)
 */
export const IDLE_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Delay (ms) after the micro-pulse stick deflection before sending a
 * re-center (neutral) frame to undo the movement. ~2 frames at 60 fps.
 *
 * app.js:919 (sendIdleKeepalive → setTimeout … 32)
 */
export const IDLE_PULSE_RECENTER_MS = 32;

/**
 * LeftThumbX value used for the idle micro-pulse (~12.5% deflection).
 * Inside most game deadzones but enough for Xbox session manager to
 * register as user activity.
 *
 * app.js:903 (sendIdleKeepalive → v.setInt16(18, 4096, true))
 */
export const IDLE_PULSE_LEFT_THUMB_X = 4096;

// ─────────────────────────────────────────────────────────────
// Reconnect
// ─────────────────────────────────────────────────────────────

/**
 * Maximum number of reconnect attempts before giving up and entering
 * the 'failed' state.
 *
 * app.js:15 (constructor: this.maxReconnectAttempts = 3)
 */
export const RECONNECT_MAX_ATTEMPTS = 3;

/**
 * Base delay (ms) for the increasing reconnect back-off.
 * Actual delay = RECONNECT_BASE_DELAY_MS * attemptNumber
 * (3 s, 6 s, 9 s on attempts 1, 2, 3).
 *
 * app.js:98 (reconnect: const delay = 3000 * this.reconnectAttempts)
 */
export const RECONNECT_BASE_DELAY_MS = 3_000;

/**
 * Timeout (ms) passed to _waitForDataChannels() during reconnect.
 * If the message channel does not reach 'open' within this window,
 * the reconnect attempt is considered failed.
 *
 * app.js:106 (reconnect: this._waitForDataChannels(15000))
 */
export const WAIT_FOR_DATA_CHANNELS_MS = 15_000;

// ─────────────────────────────────────────────────────────────
// ICE Polling
// ─────────────────────────────────────────────────────────────

/**
 * Maximum number of ICE candidate poll iterations before stopping.
 *
 * app.js:764 (_pollForIceCandidates: const maxAttempts = 20)
 */
export const ICE_POLL_MAX_ATTEMPTS = 20;

/**
 * Interval (ms) between ICE candidate poll attempts.
 *
 * app.js:809 (_pollForIceCandidates: await new Promise(r => setTimeout(r, 500)))
 */
export const ICE_POLL_INTERVAL_MS = 500;

/**
 * Grace period (ms) to wait after a WebRTC 'disconnected' state before
 * triggering a reconnect. Allows transient network blips to recover.
 *
 * app.js:718 (_setupConnectionStateHandler → setTimeout … 10000)
 */
export const DISCONNECT_GRACE_MS = 10_000;

/**
 * Fixed wait (ms) for ICE gathering to progress before calling
 * exchange_sdp. Gives the local ICE agent time to enumerate candidates.
 *
 * app.js:274 (_setupWebRTC: await new Promise(r => setTimeout(r, 1000)))
 */
export const ICE_GATHER_WAIT_MS = 1_000;

// ─────────────────────────────────────────────────────────────
// Input / Gamepad
// ─────────────────────────────────────────────────────────────

/**
 * Gamepad polling interval (ms) — 16 ms ≈ 60 Hz.
 *
 * app.js:1540 (const GAMEPAD_POLL_MS = 16)
 */
export const GAMEPAD_POLL_MS = 16;

/**
 * Send one idle (null) gamepad frame every N poll ticks when there is no
 * active input. Keeps the Xbox input channel alive without spamming.
 *
 * app.js:1541 (const IDLE_FRAME_EVERY = 62)
 */
export const IDLE_FRAME_EVERY = 62;

/**
 * Axis dead-zone threshold (0–1). Stick values with absolute magnitude
 * below this are clamped to 0.
 *
 * app.js:1542 (const STICK_DEADZONE = 0.1)
 */
export const STICK_DEADZONE = 0.1;

/**
 * Input packet report-type byte for standard gamepad frames.
 * From xbox-xcloud-player InputPacket.ts.
 *
 * app.js:1548 (const REPORT_TYPE_GAMEPAD = 2)
 */
export const REPORT_TYPE_GAMEPAD = 2;

/**
 * Input packet report-type byte for the ClientMetadata initialisation
 * packet (sent once when the input channel first opens).
 * From xbox-xcloud-player InputPacket.ts.
 *
 * app.js:1549 (const REPORT_TYPE_CLIENT_METADATA = 8)
 */
export const REPORT_TYPE_CLIENT_METADATA = 8;

/**
 * Button index → Xbox protocol bitmask.
 * Exact values from xbox-xcloud-player _writeGamepadData().
 * Keys are Standard Gamepad API button indices.
 *
 * app.js:1553-1569 (const BUTTON_BITS)
 */
export const BUTTON_BITS: Readonly<Record<number, number>> = {
  16: 2,      // Nexus (Guide)
  9:  4,      // Menu (Start)
  8:  8,      // View (Back)
  0:  16,     // A
  1:  32,     // B
  2:  64,     // X
  3:  128,    // Y
  12: 256,    // DPadUp
  13: 512,    // DPadDown
  14: 1024,   // DPadLeft
  15: 2048,   // DPadRight
  4:  4096,   // LeftShoulder
  5:  8192,   // RightShoulder
  10: 16384,  // LeftThumb
  11: 32768,  // RightThumb
} as const;
