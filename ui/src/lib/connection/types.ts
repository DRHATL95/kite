/**
 * types.ts — Shared connection-layer types for Kite.
 *
 * DiagnosticsSnapshot is the central data structure fed to the diagnostics HUD.
 * Fields are split into two groups:
 *
 *   1. getStats-derived — populated by StatsSampler from RTCPeerConnection.getStats()
 *   2. manager-owned   — populated by ConnectionManager and merged in before emit
 *
 * The manager merges a ManagerStats partial into each snapshot before passing
 * it to the HUD. The sampler itself only fills what getStats can provide.
 */

// ─────────────────────────────────────────────────────────────
// Sub-types
// ─────────────────────────────────────────────────────────────

/** ICE candidate type as reported in RTCIceCandidateStats. */
export type CandidateType = "host" | "srflx" | "relay" | "prflx" | "unknown";

/** High-level connection state (mirrors RTCPeerConnectionState). */
export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed"
  | "unknown";

/** ICE connection state (mirrors RTCIceConnectionState). */
export type IceConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed"
  | "unknown";

/** ICE gathering state (mirrors RTCIceGatheringState). */
export type IceGatheringState = "new" | "gathering" | "complete" | "unknown";

/** Session lifecycle state managed by ConnectionManager. */
export type SessionState =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "failed";

/** Active keepalive mode. */
export type KeepaliveMode = "api" | "idle" | "none";

/** ICE candidate provenance — which servers were actually reachable. */
export type IceProvenance =
  | "xbox-provided"
  | "fallback-only"
  | "unknown";

/** Per-channel diagnostics state. */
export interface ChannelStats {
  /** RTCDataChannel label (chat / control / message / input). */
  label: string;
  /** RTCDataChannelState at snapshot time. */
  state: RTCDataChannelState;
  /** Timestamp (ms since epoch) when the channel first reached 'open'. */
  openedAt: number | null;
}

// ─────────────────────────────────────────────────────────────
// DiagnosticsSnapshot
// ─────────────────────────────────────────────────────────────

/**
 * Full diagnostics snapshot emitted by StatsSampler on each tick.
 *
 * Fields are grouped by domain.  All numeric time fields use milliseconds
 * unless otherwise noted.  Optional fields may be absent when the
 * underlying RTCStatsReport entry is not yet available.
 */
export interface DiagnosticsSnapshot {
  /** Wall-clock time (Date.now()) when this snapshot was taken. */
  capturedAt: number;

  // ── video ──────────────────────────────────────────────────
  /** Frames per second from inbound-rtp (framesPerSecond). */
  fps: number | null;
  /** Decoded frame width in pixels. */
  width: number | null;
  /** Decoded frame height in pixels. */
  height: number | null;
  /** Total frames decoded since session start (inbound-rtp framesDecoded). */
  framesDecoded: number | null;
  /** Total frames dropped since session start (inbound-rtp framesDropped). */
  framesDropped: number | null;
  /** Number of video freezes detected (inbound-rtp freezeCount). */
  freezeCount: number | null;
  /** Total duration of all video freezes in seconds (inbound-rtp totalFreezesDuration). */
  totalFreezesDuration: number | null;

  // ── bitrate ────────────────────────────────────────────────
  /**
   * Delta-computed inbound video bitrate in kbps.
   * Matches app.js lines 1502-1504:
   *   bytesDelta = bytesReceived - prevBytesReceived
   *   timeDelta  = (timestamp - prevTimestamp) / 1000   [seconds]
   *   kbps       = Math.round((bytesDelta * 8) / timeDelta / 1000)
   */
  inboundVideoKbps: number | null;
  /** Available incoming bitrate in bps from candidate-pair (availableIncomingBitrate). */
  availableIncomingBitrate: number | null;

  // ── packets ────────────────────────────────────────────────
  /** Total packets lost (inbound-rtp packetsLost). */
  packetsLost: number | null;
  /** Total packets received (inbound-rtp packetsReceived). */
  packetsReceived: number | null;
  /** Packet loss percentage (0–100). */
  lossPct: number | null;
  /** Jitter in seconds from inbound-rtp. */
  jitter: number | null;
  /** Jitter buffer delay in seconds (inbound-rtp jitterBufferDelay). */
  jitterBufferDelay: number | null;

  // ── recovery ───────────────────────────────────────────────
  /** Total NACK packets sent (inbound-rtp nackCount). */
  nackCount: number | null;
  /** Total PLI packets sent (inbound-rtp pliCount). */
  pliCount: number | null;
  /**
   * Manager-supplied count of keyframe requests sent via the control channel.
   * Not available from getStats — filled by ConnectionManager.
   */
  keyframeRequestsSent: number | null;
  /**
   * Milliseconds since the last keyframe was decoded.
   * Computed from inbound-rtp keyFramesDecoded and its timestamp.
   */
  msSinceLastKeyframe: number | null;

  // ── network ────────────────────────────────────────────────
  /** Round-trip time in ms from the selected candidate-pair (currentRoundTripTime × 1000). */
  rttMs: number | null;
  /** Type of the local ICE candidate in the selected pair. */
  localCandidateType: CandidateType | null;
  /** Type of the remote ICE candidate in the selected pair. */
  remoteCandidateType: CandidateType | null;
  /** State of the selected candidate-pair (succeeded / in-progress / etc.). */
  candidatePairState: string | null;

  // ── ice ────────────────────────────────────────────────────
  /** RTCPeerConnection.iceConnectionState at snapshot time. */
  iceConnectionState: IceConnectionState;
  /** RTCPeerConnection.iceGatheringState at snapshot time. */
  iceGatheringState: IceGatheringState;
  /** RTCPeerConnection.connectionState at snapshot time. */
  connectionState: ConnectionState;
  /**
   * Number of remote ICE candidates added from Xbox's polling endpoint.
   * Manager-supplied.
   */
  remoteCandidatesAdded: number | null;
  /**
   * Number of ICE polling attempts used during the current session.
   * Manager-supplied.
   */
  icePollAttemptsUsed: number | null;

  // ── iceProvenance ──────────────────────────────────────────
  /** How many STUN URLs were in the ICE config. */
  stunCount: number | null;
  /** How many TURN URLs were in the ICE config. */
  turnCount: number | null;
  /**
   * Whether the active candidate pair came from Xbox-provided ICE servers
   * or fell back to public STUN only.  Manager-supplied.
   */
  source: IceProvenance;

  // ── session ────────────────────────────────────────────────
  /**
   * Session lifecycle state.  Manager-supplied.
   * 'streaming' once both media tracks are received.
   */
  state: SessionState;
  /** Active keepalive mode.  Manager-supplied. */
  activeKeepalive: KeepaliveMode;
  /**
   * Milliseconds since the last keepalive was sent.
   * Manager-supplied.
   */
  msSinceLastKeepalive: number | null;
  /**
   * If an idle-warning was received, the secondsUntilKick value from Xbox.
   * Manager-supplied.
   */
  lastIdleWarningSecondsUntilKick: number | null;

  // ── channels ───────────────────────────────────────────────
  /** Per-channel diagnostics for chat / control / message / input. */
  channels: ChannelStats[];
  /**
   * Milliseconds from the first channel 'open' event to HandshakeAck.
   * Manager-supplied.
   */
  handshakeMs: number | null;

  // ── reconnect ──────────────────────────────────────────────
  /** Current reconnect attempt index (0 = not reconnecting). Manager-supplied. */
  currentAttempt: number;
  /** Maximum reconnect attempts allowed. Manager-supplied. */
  maxAttempts: number;
  /** Human-readable reason for the last reconnect trigger. Manager-supplied. */
  lastTriggerReason: string | null;
  /** Backoff delay (ms) used for the last reconnect. Manager-supplied. */
  backoffMs: number | null;

  // ── tracks ─────────────────────────────────────────────────
  /** Timestamp (ms since epoch) when the first video track was received. Manager-supplied. */
  videoArrivedAt: number | null;
  /** Timestamp (ms since epoch) when the first audio track was received. Manager-supplied. */
  audioArrivedAt: number | null;
  /**
   * Skew between video and audio track arrival in ms.
   * |videoArrivedAt - audioArrivedAt|.  Manager-supplied.
   */
  skewMs: number | null;

  // ── input ──────────────────────────────────────────────────
  /**
   * Outbound gamepad packet rate in Hz (packets/second) on the input channel.
   * Manager-supplied.
   */
  outboundPacketHz: number | null;
  /**
   * Last input sequence number sent.  Manager-supplied.
   */
  lastSequence: number | null;

  // ── identity ───────────────────────────────────────────────
  /** Console display name (deviceName). Manager-supplied. */
  consoleName: string | null;
  /** Console model type string (consoleType). Manager-supplied. */
  consoleType: string | null;
}

// ─────────────────────────────────────────────────────────────
// ManagerStats — the fields StatsSampler cannot fill
// ─────────────────────────────────────────────────────────────

/**
 * Partial snapshot of fields owned by ConnectionManager.
 * The manager builds this and passes it to StatsSampler.mergeManagerStats()
 * (or directly to the HUD merge step) so the final DiagnosticsSnapshot is complete.
 */
export type ManagerStats = Pick<
  DiagnosticsSnapshot,
  | "keyframeRequestsSent"
  | "remoteCandidatesAdded"
  | "icePollAttemptsUsed"
  | "source"
  | "stunCount"
  | "turnCount"
  | "state"
  | "activeKeepalive"
  | "msSinceLastKeepalive"
  | "lastIdleWarningSecondsUntilKick"
  | "channels"
  | "handshakeMs"
  | "currentAttempt"
  | "maxAttempts"
  | "lastTriggerReason"
  | "backoffMs"
  | "videoArrivedAt"
  | "audioArrivedAt"
  | "skewMs"
  | "outboundPacketHz"
  | "lastSequence"
  | "consoleName"
  | "consoleType"
>;

/**
 * An event emitted by the native Rust WebRTC engine, forwarded to the webview on
 * the `rtc_event` Tauri channel (Phase 6 / native-webrtc). Mirrors the Rust
 * `RtcEventDto` (serde `#[serde(tag = "kind")]`, camelCase fields). `disconnected`
 * is TERMINAL (transient drops surface as `reconnecting`); `ended` fires when the
 * engine's event stream closes (thread exited).
 */
export type RtcEvent =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "firstFrame" }
  | { kind: "reconnecting"; attempt: number }
  | {
      kind: "stats";
      bitrateKbps: number;
      fps: number;
      framesDecoded: number;
      freezeCount: number;
    }
  | { kind: "disconnected"; reason: string }
  | { kind: "ended" };
