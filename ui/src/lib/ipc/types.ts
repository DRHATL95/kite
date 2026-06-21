/**
 * Typed interfaces for the Tauri IPC layer.
 *
 * Field names match the serde JSON exactly (i.e. the serde `rename` values,
 * not the Rust snake_case field names).  Keep these in sync with:
 *   - src/xhome.rs  (XHomeConsole, IceCandidate, IceServer, StreamConfig)
 *   - src/auth.rs   (DeviceCodeInfo)
 */

/** Xbox console returned by discover_xhome_consoles (xhome.rs XHomeConsole). */
export interface XHomeConsole {
  /** serde rename = "serverId" */
  serverId: string;
  /** serde rename = "deviceName" */
  deviceName: string;
  /** serde rename = "consoleType" */
  consoleType: string;
  /** serde rename = "powerState" */
  powerState: string;
  /** serde rename = "isDevKit" */
  isDevKit: boolean;
  /** serde rename = "playPath" */
  playPath: string;
  [key: string]: unknown;
}

/**
 * ICE candidate from the Xbox streaming server (xhome.rs IceCandidate).
 * Returned directly as typed JSON by poll_ice_candidates.
 */
export interface IceCandidate {
  /** No serde rename — serialises as "candidate" */
  candidate: string;
  /** serde rename = "sdpMid" */
  sdpMid: string;
  /** serde rename = "sdpMLineIndex" */
  sdpMLineIndex: number;
}

/**
 * STUN/TURN server configuration (xhome.rs IceServer).
 * Returned directly as typed JSON by get_ice_servers.
 *
 * Note: The Rust field is Vec<String> so urls is always a string array on the
 * wire, but we widen to `string | string[]` to accept both shapes defensively
 * (some external STUN/TURN providers send a single string).
 */
export interface IceServer {
  /** No serde rename */
  urls: string | string[];
  /** No serde rename; optional */
  username?: string;
  /** No serde rename; optional */
  credential?: string;
}

/**
 * Streaming session configuration (xhome.rs StreamConfig).
 * Returned as a JSON string by create_xhome_session → must be JSON.parsed.
 */
export interface StreamConfig {
  /** serde rename = "sessionId" */
  sessionId: string;
  /** serde rename = "sessionPath" */
  sessionPath: string;
  /**
   * SDP offer from the Xbox WebRTC session; empty string until received.
   * serde rename = "exchangeResponse"
   */
  exchangeResponse: string;
  /** serde rename = "gsToken" */
  gsToken: string;
  /**
   * Keepalive interval in seconds from the Xbox session config.
   * serde rename = "keepAlivePulseSeconds"; skip_serializing_if = Option::is_none
   */
  keepAlivePulseSeconds?: number;
}
