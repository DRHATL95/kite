/**
 * ConnectionManager.ts — Xbox Remote streaming state machine
 *
 * Pure-TS class (no Svelte imports).  Owns the session lifecycle, WebRTC peer
 * connection, keepalives, handshake event routing, reconnect logic, and stats
 * aggregation.  Composed from the standalone modules in this directory.
 *
 * Source of truth for behaviour: ui/public/app.js (ConnectionManager class).
 * Every deliberate deviation is annotated; this is a faithful port.
 *
 * §3 behaviour-preservation contract cross-references are cited as "spec §3.N".
 */

import {
  createXhomeSession,
  getIceServers,
  exchangeSdp,
  sendIceCandidate,
  pollIceCandidates,
  sendSessionKeepalive,
  setStreamStatus,
} from "../ipc/commands.js";

import {
  API_KEEPALIVE_MS,
  IDLE_KEEPALIVE_INTERVAL_MS,
  IDLE_PULSE_LEFT_THUMB_X,
  IDLE_PULSE_RECENTER_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  WAIT_FOR_DATA_CHANNELS_MS,
  ICE_POLL_MAX_ATTEMPTS,
  ICE_POLL_INTERVAL_MS,
  DISCONNECT_GRACE_MS,
  ICE_GATHER_WAIT_MS,
  REPORT_TYPE_GAMEPAD,
  MEDIA_MONITOR_TICK_MS,
} from "./constants.js";

import { createDataChannels, sendKeyframeRequest } from "./dataChannels.js";
import type { DataChannelSet } from "./dataChannels.js";

import { GamepadPoller } from "./input.js";

import { MediaMonitor } from "./mediaMonitor.js";

import { StatsSampler } from "./stats.js";

import type { DiagnosticsSnapshot, ManagerStats, SessionState, ChannelStats } from "./types.js";
import type { XHomeConsole, IceServer, StreamConfig } from "../ipc/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

/** Callbacks the ConnectionManager fires on state changes and data events. */
export interface ConnectionManagerCallbacks {
  /** Called on every SessionState transition. */
  onStateChange: (state: SessionState) => void;
  /** Called on each DiagnosticsSnapshot emitted by the StatsSampler. */
  onDiagnostics: (snapshot: DiagnosticsSnapshot) => void;
  /** Human-readable log messages. */
  onLog: (msg: string) => void;
  /**
   * Called when a MediaStream is ready (first track received).
   * The stream may not yet have both tracks — the 'streaming' state
   * transition is gated on BOTH tracks (spec §3.10).
   */
  onMediaStream: (stream: MediaStream) => void;
  /**
   * Called at the start of each reconnect attempt so the UI can show
   * a live count without depending on the (stopped) StatsSampler snapshot.
   */
  onReconnectAttempt?: (current: number, max: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ConnectionManager — owns the full streaming session lifecycle.
 *
 * Mirrors app.js ConnectionManager (lines 4–924).  All methods that were
 * private in app.js are prefixed with _ here for clarity.
 */
export class ConnectionManager {
  // ── State machine ──────────────────────────────────────────────────────────
  /** app.js:6 */
  private _state: SessionState = "idle";

  // ── WebRTC ─────────────────────────────────────────────────────────────────
  /** app.js:7 */
  private _pc: RTCPeerConnection | null = null;
  /** Typed channel handles from createDataChannels(); app.js:8-10 */
  private _channels: DataChannelSet | null = null;

  // ── Keepalives ─────────────────────────────────────────────────────────────
  /** API keepalive timer; app.js:12 */
  private _apiKeepAliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic idle keepalive interval (after idle warning); app.js:424-428 */
  private _idleKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Tracks when the last keepalive was sent (ms since epoch), for diagnostics. */
  private _lastKeepaliveAt: number | null = null;

  // ── Media ──────────────────────────────────────────────────────────────────
  /** app.js:13 */
  private _mediaStream: MediaStream | null = null;
  /** app.js:28 */
  private _tracksReceived: { video: boolean; audio: boolean } = {
    video: false,
    audio: false,
  };
  /** app.js:29 — prevents double-transition to 'streaming' */
  private _hasStartedPlaying = false;

  // ── Session info ───────────────────────────────────────────────────────────
  /** app.js:19 */
  private _serverId: string | null = null;
  /** app.js:20 */
  private _consoleName: string | null = null;
  /** app.js:21 */
  private _gsToken: string | null = null;
  /** app.js:22 */
  private _sessionPath: string | null = null;
  /** app.js:23 */
  private _sessionId: string | null = null;

  // ── Reconnect ──────────────────────────────────────────────────────────────
  /** app.js:14 */
  private _reconnectAttempts = 0;
  /** app.js:16 */
  private _disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reason for the last reconnect trigger — reported to diagnostics. */
  private _lastTriggerReason: string | null = null;
  /** Backoff used in the last reconnect (ms). */
  private _lastBackoffMs: number | null = null;

  // ── ICE stats ──────────────────────────────────────────────────────────────
  /** ICE server provenance from getIceServers response. */
  private _stunCount: number | null = null;
  private _turnCount: number | null = null;
  private _iceSource: "xbox-provided" | "fallback-only" | "unknown" = "unknown";
  private _remoteCandidatesAdded = 0;
  private _icePollAttemptsUsed = 0;

  // ── Channel diagnostics ─────────────────────────────────────────────────────
  /** Timestamps when each channel first reached 'open'. */
  private _channelOpenedAt: Record<string, number | null> = {
    chat: null,
    control: null,
    message: null,
    input: null,
  };
  /** When the first channel opened (for handshake timing). */
  private _firstChannelOpenAt: number | null = null;
  /** When HandshakeAck was received (for handshake timing). */
  private _handshakeAckAt: number | null = null;

  // ── Track arrival timing ───────────────────────────────────────────────────
  private _videoArrivedAt: number | null = null;
  private _audioArrivedAt: number | null = null;

  // ── Input stats ────────────────────────────────────────────────────────────
  private _gamepadPoller: GamepadPoller | null = null;
  private _keyframeRequestsSent = 0;

  // ── Idle warning ───────────────────────────────────────────────────────────
  private _lastIdleWarningSecondsUntilKick: number | null = null;

  // ── Stats sampler ──────────────────────────────────────────────────────────
  private _sampler: StatsSampler | null = null;

  // ── Media-flow watchdog ────────────────────────────────────────────────────
  private _mediaMonitor: MediaMonitor | null = null;
  private _mediaMonitorTimer: ReturnType<typeof setInterval> | null = null;

  // ── Callbacks ──────────────────────────────────────────────────────────────
  private readonly _cb: ConnectionManagerCallbacks;

  // ── Input sequence (for idle keepalive; mirrors app.js inputSequenceNum) ───
  /** Shared with the idle keepalive encoder; app.js:1544 */
  private _inputSeq = 0;

  // ──────────────────────────────────────────────────────────────────────────
  constructor(callbacks: ConnectionManagerCallbacks) {
    this._cb = callbacks;
    this._mediaMonitor = new MediaMonitor({
      onMediaStart: () => {
        if (this._state === "connecting" || this._state === "reconnecting") {
          this._log("First decoded frame — transitioning to streaming");
          this._setState("streaming");
          this._startGamepadPoller();
        }
      },
      onNudge: (context) => {
        if (this._channels && this._channels.control.readyState === "open") {
          sendKeyframeRequest(this._channels.control);
          this._keyframeRequestsSent++;
          this._log(`Media ${context} — sent keyframe nudge`);
          this._pushManagerStats();
        }
      },
      onRecover: (reason) => {
        this._log(`Media watchdog: ${reason} — escalating to reconnect`);
        this._triggerReconnect(reason);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public accessors
  // ─────────────────────────────────────────────────────────────────────────

  /** Current SessionState. */
  get state(): SessionState {
    return this._state;
  }

  /** The reason for the most recent reconnect trigger / failure, or null. */
  get lastTriggerReason(): string | null {
    return this._lastTriggerReason;
  }

  /** Last DiagnosticsSnapshot emitted (may be null before first sample). */
  private _lastSnapshot: DiagnosticsSnapshot | null = null;
  get lastSnapshot(): DiagnosticsSnapshot | null {
    return this._lastSnapshot;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initiate a new connection to the given console.
   * Duplicate-guarded: ignored if already connecting or reconnecting.
   *
   * app.js:50-69 (connect)
   */
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    // spec §3.7 duplicate-guard — app.js:51-54
    // Use a local snapshot so TypeScript's control-flow narrowing does NOT
    // eliminate "connecting" from this._state's type for the rest of the method.
    const stateNow = this._state;
    if (stateNow === "connecting" || stateNow === "reconnecting") {
      this._log("Already connecting, ignoring duplicate connect call");
      return;
    }

    // Tear down any stale session from a previous failed/abandoned connection
    // before starting fresh.  Prevents keepalive timers and partial WebRTC
    // state from a prior "failed" attempt leaking into the new one.
    this._cleanupConnection();

    this._setState("connecting");
    this._reconnectAttempts = 0;

    // Store for reconnect; app.js:58-60
    this._serverId = xboxConsole.serverId;
    this._consoleName =
      xboxConsole.deviceName ||
      (xboxConsole as Record<string, unknown>)["serverName"] as string ||
      "Xbox";

    try {
      await this._createSessionAndStream();
    } catch (error) {
      this._log("Connect failed: " + String(error));
      this._cleanupConnection();
      // Guard: if disconnect() was called while we were awaiting (state → "idle"),
      // do NOT overwrite it with "failed".
      if (this._state === "connecting") {
        this._setState("failed");
      }
      // Don't re-throw — callers watch reactive state, not return values.
      // The "failed" → auto-return effect in App.svelte handles UX recovery.
    }
  }

  /**
   * User-initiated disconnect. Cleans up everything and returns to 'idle'.
   *
   * app.js:153-163 (disconnect)
   */
  async disconnect(): Promise<void> {
    this._log("User-initiated disconnect");
    this._cleanupConnection();
    this._cleanupMedia();
    this._serverId = null;
    this._consoleName = null;
    this._gsToken = null;
    this._sessionPath = null;
    this._sessionId = null;
    this._setState("idle");
  }

  /**
   * Send a manual keyframe request on the control channel.
   *
   * app.js:874-885 (sendKeyframeRequest)
   */
  requestKeyframe(): void {
    if (!this._channels || this._channels.control.readyState !== "open") return;
    sendKeyframeRequest(this._channels.control);
    this._keyframeRequestsSent++;
    this._log("Sent manual keyframe request");
    this._pushManagerStats();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: logging + state machine
  // ─────────────────────────────────────────────────────────────────────────

  private _log(msg: string): void {
    this._cb.onLog(msg);
  }

  /**
   * Transition to a new SessionState, logging old → new, firing the callback.
   * Duplicate-guard: transitions to the current state are suppressed.
   *
   * app.js:42-47 (setState)
   */
  private _setState(newState: SessionState): void {
    if (this._state === newState) return;
    const old = this._state;
    this._state = newState;
    this._log(`ConnectionManager: ${old} → ${newState}`);
    this._cb.onStateChange(newState);
    this._pushManagerStats();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: session + WebRTC setup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an xHome session, start the API keepalive IMMEDIATELY, then set up
   * the WebRTC peer connection.
   *
   * ORDERING IS CRITICAL — see spec §3.1 and app.js:166-201.
   *
   * app.js:166-202 (_createSessionAndStream)
   */
  private async _createSessionAndStream(): Promise<void> {
    // Step 1: Create xHome session — app.js:170-186
    this._log("Creating xHome session for: " + (this._serverId ?? ""));

    const session: StreamConfig = await createXhomeSession(
      this._serverId!,
      undefined,
    );
    this._log("Session created: " + session.sessionId);

    this._sessionPath = session.sessionPath;
    this._sessionId = session.sessionId;
    this._gsToken = session.gsToken;

    // Log the Xbox keepalive hint but use our fixed 30 s — app.js:184-186
    if (session.keepAlivePulseSeconds) {
      this._log(`Xbox keepalive timeout: ${session.keepAlivePulseSeconds}s`);
    }

    // CRITICAL: Start API keepalive IMMEDIATELY after session creation,
    // BEFORE SDP exchange. The session is in "Provisioned" state now and
    // accepts keepalives.  If we wait until after SDP exchange, the session
    // transitions to "SdpExchangeComplete" which rejects keepalives, causing
    // a ~56 s timeout.
    //
    // app.js:192-198 (comment + _startApiKeepalive() call)
    // spec §3.1
    this._startApiKeepalive();

    // Step 2: WebRTC — app.js:201
    await this._setupWebRTC();
  }

  /**
   * Set up the RTCPeerConnection in the order specified by spec §3.3.
   *
   * app.js:205-297 (_setupWebRTC)
   */
  private async _setupWebRTC(): Promise<void> {
    this._log("Setting up WebRTC...");

    // ── ICE servers — app.js:212-232 ────────────────────────────────────────
    // Fallback STUN list matches app.js:213-217
    let iceServers: RTCIceServer[] = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.services.mozilla.com" },
    ];
    let iceSource: "xbox-provided" | "fallback-only" = "fallback-only";
    let stunCount = 3;
    let turnCount = 0;

    try {
      const serverIceConfig: IceServer[] = await getIceServers(
        this._sessionPath!,
      );
      if (serverIceConfig && serverIceConfig.length > 0) {
        iceServers = serverIceConfig.map((s) => ({
          urls: s.urls,
          username: s.username,
          credential: s.credential,
        }));
        iceSource = "xbox-provided";

        // Count STUN vs TURN for diagnostics (spec §5 ICE server provenance)
        stunCount = 0;
        turnCount = 0;
        for (const s of serverIceConfig) {
          const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
          for (const u of urls) {
            if (u.startsWith("turn:") || u.startsWith("turns:")) turnCount++;
            else stunCount++;
          }
        }
        this._log("ICE servers: " + JSON.stringify(iceServers));
      }
    } catch (e) {
      this._log("Failed to get ICE servers: " + String(e));
    }

    this._stunCount = stunCount;
    this._turnCount = turnCount;
    this._iceSource = iceSource;

    // ── RTCPeerConnection — app.js:235-238 ──────────────────────────────────
    // spec §3.3
    this._pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
    });

    // ── Data channels BEFORE createOffer (so SCTP is in the SDP) — app.js:241 ──
    // spec §3.3, §3.4
    // Reset channel timing for this attempt
    this._channelOpenedAt = { chat: null, control: null, message: null, input: null };
    this._firstChannelOpenAt = null;
    this._handshakeAckAt = null;

    this._channels = createDataChannels(this._pc, {
      onHandshakeComplete: () => {
        this._handshakeAckAt = Date.now();
        this._log("HandshakeAck received — channels fully active");
        // Once handshake is complete, start the GamepadPoller if we're
        // already streaming (tracks may have arrived first).
        // The poller is started from the dual-track gate, but if handshake
        // arrives after both tracks that case is also covered there.
        this._pushManagerStats();
      },
      onIdleWarning: (secondsUntilKick: number) => {
        this._lastIdleWarningSecondsUntilKick = secondsUntilKick;
        this._log(
          `Idle warning: ${secondsUntilKick}s until kick — sending keepalive`,
        );
        this._sendIdleKeepalive();
        // Schedule periodic idle keepalives every 30 s to prevent repeated
        // warnings — app.js:425-429
        if (!this._idleKeepaliveInterval) {
          this._idleKeepaliveInterval = setInterval(() => {
            this._sendIdleKeepalive();
          }, IDLE_KEEPALIVE_INTERVAL_MS);
        }
        this._pushManagerStats();
      },
      onServerDisconnect: (reason: string) => {
        this._log(`Server disconnect: ${reason}`);
        // spec §3.9 — serverInitiatedDisconnect with reason ≠ WarningForBeingIdle
        this._triggerReconnect("serverInitiatedDisconnect: " + reason);
      },
      onControlChannelClosed: () => {
        // spec §3.9 — control channel closed while streaming
        if (this._state === "streaming") {
          this._log("Control channel lost during stream — triggering reconnect");
          this._triggerReconnect("controlChannelClosed");
        }
      },
      onLog: (msg: string) => {
        // Track channel open events for diagnostics
        const chanMatch = msg.match(/^Channel OPEN: (\w+)/);
        if (chanMatch) {
          const label = chanMatch[1];
          const now = Date.now();
          if (
            label === "chat" ||
            label === "control" ||
            label === "message" ||
            label === "input"
          ) {
            this._channelOpenedAt[label] = now;
          }
          if (this._firstChannelOpenAt === null) {
            this._firstChannelOpenAt = now;
          }
          this._pushManagerStats();
        }
        this._log(msg);
      },
    });

    // Xbox may also create channels; wire them the same way — app.js:244-247
    this._pc.ondatachannel = (event: RTCDataChannelEvent) => {
      this._log(
        `Xbox created data channel: ${event.channel.label} (id=${event.channel.id})`,
      );
    };

    // ── Transceivers — app.js:250-255 ───────────────────────────────────────
    // spec §3.3: audio sendrecv (for chat/mic), video recvonly
    this._pc.addTransceiver("audio", { direction: "sendrecv" });
    this._pc.addTransceiver("video", { direction: "recvonly" });

    // ── Track + connection state + ICE handlers — app.js:258-260 ────────────
    this._tracksReceived = { video: false, audio: false };
    this._hasStartedPlaying = false;
    this._setupTrackHandler();
    this._setupConnectionStateHandler();
    this._setupIceHandling();

    // ── Create offer — app.js:269-274 ───────────────────────────────────────
    const offer = await this._pc.createOffer();
    this._log(`Created SDP offer (${offer.sdp?.length ?? 0} bytes)`);
    await this._pc.setLocalDescription(offer);

    // Fixed ICE gather wait — spec §3.3, app.js:274 (ICE_GATHER_WAIT_MS = 1000)
    await new Promise<void>((r) => setTimeout(r, ICE_GATHER_WAIT_MS));

    // ── SDP exchange — app.js:277-287 ───────────────────────────────────────
    const sdpAnswer: string = await exchangeSdp(
      this._sessionPath!,
      this._pc.localDescription!.sdp,
    );
    this._log(`Got SDP answer (${sdpAnswer.length} bytes)`);

    await this._pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
    this._log("Set remote description OK");

    // ── ICE candidate polling — app.js:290 ──────────────────────────────────
    await this._pollForIceCandidates();

    // ── Stats sampler — app.js:293 ──────────────────────────────────────────
    this._startStatsSampler();

    if (!this._tracksReceived.video && !this._tracksReceived.audio) {
      this._log("Waiting for video stream...");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: track handling (dual-track gate)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wire the ontrack handler.  Transitions to 'streaming' and starts
   * GamepadPoller ONLY when BOTH video AND audio tracks have arrived.
   *
   * The 250 ms play delay is for the UI layer (Task 10) — here we just expose
   * the stream and set _hasStartedPlaying so the HUD knows timing.
   *
   * spec §3.10; app.js:600-684 (_setupTrackHandler)
   */
  private _setupTrackHandler(): void {
    const pc = this._pc!;

    pc.ontrack = (event: RTCTrackEvent) => {
      this._log(`*** RECEIVED TRACK: ${event.track.kind} ***`);

      // Record arrival time for diagnostics — spec §5 track timing
      const now = Date.now();
      if (event.track.kind === "video" && this._videoArrivedAt === null) {
        this._videoArrivedAt = now;
      }
      if (event.track.kind === "audio" && this._audioArrivedAt === null) {
        this._audioArrivedAt = now;
      }

      this._tracksReceived[event.track.kind as "video" | "audio"] = true;

      // Track lifecycle logging — app.js:609-612
      event.track.onmute = () => this._log(`Track ${event.track.kind} MUTED`);
      event.track.onunmute = () =>
        this._log(`Track ${event.track.kind} UNMUTED`);
      event.track.onended = () =>
        this._log(`Track ${event.track.kind} ENDED`);

      // Build / extend the MediaStream — app.js:614-625
      if (!this._mediaStream) {
        this._mediaStream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream();
        if (!event.streams || !event.streams[0]) {
          this._mediaStream.addTrack(event.track);
        }
        this._log(
          `Set media stream with ${this._mediaStream.getTracks().length} track(s)`,
        );
        // Notify UI so it can wire srcObject early
        this._cb.onMediaStream(this._mediaStream);
      } else {
        if (!this._mediaStream.getTrackById(event.track.id)) {
          this._mediaStream.addTrack(event.track);
          this._log(
            `Added ${event.track.kind} track, total: ${this._mediaStream.getTracks().length}`,
          );
        }
      }

      // Dual-track gate — spec §3.10; app.js:627-666
      // Both tracks negotiated. NOTE: ontrack fires during setRemoteDescription,
      // BEFORE media actually flows. Do NOT go to "streaming" here — arm the
      // media watchdog and let it promote us once frames actually decode.
      if (
        this._tracksReceived.video &&
        this._tracksReceived.audio &&
        !this._hasStartedPlaying
      ) {
        this._hasStartedPlaying = true;
        this._log("Both tracks negotiated — arming media watchdog (awaiting first frame)");
        this._mediaMonitor?.arm(Date.now());
      }

      this._pushManagerStats();
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: connection state handler (reconnect triggers)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wire connectionState change handler with auto-reconnect logic.
   *
   * spec §3.8/§3.9; app.js:688-728 (_setupConnectionStateHandler)
   */
  private _setupConnectionStateHandler(): void {
    const pc = this._pc!;

    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      this._log(`WebRTC connection state: ${connState}`);

      // Report to backend — app.js:696
      setStreamStatus(connState).catch(() => {});

      // Clear any pending disconnect grace timer — app.js:698-700
      if (this._disconnectGraceTimer !== null) {
        clearTimeout(this._disconnectGraceTimer);
        this._disconnectGraceTimer = null;
      }

      if (connState === "failed") {
        // spec §3.9 — immediate reconnect on 'failed'
        this._log("WebRTC connection failed — triggering reconnect");
        this._stopGamepadPoller();
        this._triggerReconnect("connectionStateFailed");
      } else if (connState === "disconnected") {
        // spec §3.9 — 10 s grace before reconnect
        this._log("WebRTC disconnected — 10s grace before reconnect");
        this._disconnectGraceTimer = setTimeout(() => {
          this._disconnectGraceTimer = null;
          if (pc.connectionState === "disconnected") {
            this._log("Still disconnected after grace period — reconnecting");
            this._triggerReconnect("connectionStateDisconnected");
          }
        }, DISCONNECT_GRACE_MS);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      this._log(`ICE connection state: ${iceState}`);
      // spec §3.9 — ICE 'failed' triggers reconnect
      if (iceState === "failed") {
        this._log("ICE failed — triggering reconnect");
        this._triggerReconnect("iceFailed");
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: ICE handling (local candidates)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wire onicecandidate to forward local candidates to xHome API.
   *
   * app.js:740-760 (_setupIceHandling)
   */
  private _setupIceHandling(): void {
    const pc = this._pc!;

    pc.onicecandidate = async (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        this._log(
          `Local ICE: ${event.candidate.candidate.substring(0, 50)}...`,
        );
        try {
          await sendIceCandidate(
            this._sessionPath!,
            JSON.stringify(event.candidate),
          );
        } catch (error) {
          this._log("Failed to send ICE: " + String(error));
        }
      } else {
        this._log("ICE gathering complete");
      }
    };

    pc.onicegatheringstatechange = () => {
      this._log(`ICE gathering state: ${pc.iceGatheringState}`);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: ICE candidate polling (remote candidates)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Poll xHome for server ICE candidates and add them to the peer connection.
   *
   * app.js:763-813 (_pollForIceCandidates)
   * spec §3.11: up to ICE_POLL_MAX_ATTEMPTS × ICE_POLL_INTERVAL_MS
   */
  private async _pollForIceCandidates(): Promise<void> {
    let attempts = 0;
    let totalCandidates = 0;

    this._log("Starting ICE candidate polling...");

    while (attempts < ICE_POLL_MAX_ATTEMPTS && this._pc) {
      try {
        const candidates = await pollIceCandidates(this._sessionPath!);

        if (candidates && candidates.length > 0) {
          this._log(`Got ${candidates.length} remote ICE candidates`);
          for (const candidateObj of candidates) {
            const candidateStr = candidateObj.candidate.trim();
            try {
              await this._pc.addIceCandidate(
                new RTCIceCandidate({
                  candidate: candidateStr,
                  sdpMid: candidateObj.sdpMid,
                  sdpMLineIndex: candidateObj.sdpMLineIndex,
                }),
              );
              totalCandidates++;
            } catch (e) {
              this._log(
                "Failed to add ICE: " +
                  (e instanceof Error ? e.message : String(e)),
              );
            }
          }
        }

        const iceState = this._pc.iceConnectionState;
        if (iceState === "connected" || iceState === "completed") {
          this._log("*** ICE CONNECTED ***");
          break;
        }
        if (iceState === "failed") {
          this._log("*** ICE FAILED ***");
          break;
        }
      } catch (error) {
        this._log("Error polling ICE: " + String(error));
      }

      attempts++;
      await new Promise<void>((r) => setTimeout(r, ICE_POLL_INTERVAL_MS));
    }

    this._remoteCandidatesAdded = totalCandidates;
    this._icePollAttemptsUsed = attempts;
    this._log(`ICE polling done. Added ${totalCandidates} candidates`);
    this._pushManagerStats();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: keepalives
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the API keepalive interval (must be called BEFORE SDP exchange).
   *
   * CRITICAL: session is in "Provisioned" state immediately after creation.
   * Start the interval here; the first tick fires after API_KEEPALIVE_MS (30 s)
   * so we don't send a keepalive before SDP is even exchanged — exactly matching
   * app.js:556-586 (_startApiKeepalive) where the interval is set without an
   * immediate first call.
   *
   * app.js:556-586 (_startApiKeepalive); spec §3.2
   */
  private _startApiKeepalive(): void {
    // Idempotent — app.js:557
    if (this._apiKeepAliveInterval !== null || !this._sessionPath) return;

    this._log(
      `Starting API keepalive every ${API_KEEPALIVE_MS / 1000}s for: ${this._sessionPath}`,
    );

    const sendApiKeepalive = (): void => {
      if (!this._sessionPath) {
        this._stopApiKeepalive();
        return;
      }
      sendSessionKeepalive(this._sessionPath)
        .then((status: string) => {
          this._lastKeepaliveAt = Date.now();
          this._log("API keepalive OK: " + status);
          this._pushManagerStats();
        })
        .catch((e: unknown) => {
          const errStr = String(e);
          // Xbox rejects API keepalives once streaming starts (state machine
          // moves past "Provisioned").  Stop silently — app.js:573-579.
          if (
            errStr.includes("SessionInUnexpectedState") ||
            errStr.includes("400") ||
            this._state === "streaming"
          ) {
            this._log("API keepalive stopped (data channel is keepalive)");
            this._stopApiKeepalive();
          } else {
            this._log("API keepalive FAILED: " + errStr);
          }
        });
    };

    // Don't send immediately — start interval at 30 s — app.js:585
    this._apiKeepAliveInterval = setInterval(sendApiKeepalive, API_KEEPALIVE_MS);
  }

  private _stopApiKeepalive(): void {
    if (this._apiKeepAliveInterval !== null) {
      clearInterval(this._apiKeepAliveInterval);
      this._apiKeepAliveInterval = null;
    }
  }

  private _stopAllKeepalives(): void {
    this._stopApiKeepalive();
    if (this._idleKeepaliveInterval !== null) {
      clearInterval(this._idleKeepaliveInterval);
      this._idleKeepaliveInterval = null;
    }
  }

  /**
   * Send a micro-pulse idle keepalive on the input channel.
   *
   * Sends a 38-byte gamepad packet with LeftThumbX = 4096 (~12.5% deflection,
   * inside most game deadzones) to reset the Xbox idle timer, then recenters
   * after IDLE_PULSE_RECENTER_MS.
   *
   * app.js:891-923 (sendIdleKeepalive); spec §3.2
   */
  private _sendIdleKeepalive(): void {
    const inputCh = this._channels?.input;
    if (!inputCh || inputCh.readyState !== "open") return;

    try {
      // Build micro-pulse packet — app.js:895-911 (setInt16(18, 4096, true))
      const buf = new ArrayBuffer(38);
      const v = new DataView(buf);
      v.setUint16(0, REPORT_TYPE_GAMEPAD, true);     // reportType
      v.setUint32(2, this._inputSeq++ >>> 0, true);  // sequence
      v.setFloat64(6, performance.now(), true);       // timestamp
      v.setUint8(14, 1);                             // frameCount
      v.setUint8(15, 0);                             // gamepadIndex
      v.setUint16(16, 0, true);                      // buttons (none)
      v.setInt16(18, IDLE_PULSE_LEFT_THUMB_X, true); // LeftThumbX tiny pulse
      v.setInt16(20, 0, true);                       // LeftThumbY
      v.setInt16(22, 0, true);                       // RightThumbX
      v.setInt16(24, 0, true);                       // RightThumbY
      v.setUint16(26, 0, true);                      // LeftTrigger
      v.setUint16(28, 0, true);                      // RightTrigger
      v.setUint32(30, 1, true);                      // PhysicalPhysicality LE
      v.setUint32(34, 1, false);                     // VirtualPhysicality BE
      inputCh.send(buf);

      // Immediately recenter so games don't see movement — app.js:914-919
      setTimeout(() => {
        const ch = this._channels?.input;
        if (!ch || ch.readyState !== "open") return;
        // Neutral frame: all zeros after header
        const idle = new ArrayBuffer(38);
        const iv = new DataView(idle);
        iv.setUint16(0, REPORT_TYPE_GAMEPAD, true);
        iv.setUint32(2, this._inputSeq++ >>> 0, true);
        iv.setFloat64(6, performance.now(), true);
        iv.setUint8(14, 1);
        // remaining bytes zero → neutral gamepad state
        iv.setUint32(30, 1, true);   // PhysicalPhysicality LE
        iv.setUint32(34, 1, false);  // VirtualPhysicality BE
        ch.send(idle);
        this._log("Sent idle keepalive (stick micro-pulse + recenter)");
      }, IDLE_PULSE_RECENTER_MS);
    } catch (e) {
      this._log("Idle keepalive failed: " + String(e));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: input polling
  // ─────────────────────────────────────────────────────────────────────────

  private _startGamepadPoller(): void {
    if (this._gamepadPoller !== null) return;

    const send = (bytes: Uint8Array): void => {
      const ch = this._channels?.input;
      if (!ch || ch.readyState !== "open") return;
      // Narrow Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer> for RTCDataChannel.send()
      ch.send(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength));
    };

    this._gamepadPoller = new GamepadPoller(send, null);
    this._gamepadPoller.start();
    this._log("Started gamepad polling (60 Hz)");
  }

  private _stopGamepadPoller(): void {
    if (this._gamepadPoller !== null) {
      this._gamepadPoller.stop();
      this._gamepadPoller = null;
      this._log("Stopped gamepad polling");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: stats sampler
  // ─────────────────────────────────────────────────────────────────────────

  private _startStatsSampler(): void {
    if (!this._pc) return;
    this._sampler = new StatsSampler(
      this._pc,
      (snap: DiagnosticsSnapshot) => {
        this._lastSnapshot = snap;
        this._cb.onDiagnostics(snap);
      },
      2000,
    );
    this._pushManagerStats();
    this._sampler.start();

    // Drive the media watchdog off the latest snapshot's framesDecoded.
    if (this._mediaMonitorTimer === null) {
      this._mediaMonitorTimer = setInterval(() => {
        this._mediaMonitor?.tick(
          this._lastSnapshot?.framesDecoded ?? null,
          Date.now(),
        );
      }, MEDIA_MONITOR_TICK_MS);
    }
  }

  private _stopStatsSampler(): void {
    if (this._sampler !== null) {
      this._sampler.stop();
      this._sampler = null;
    }
  }

  /**
   * Build the current ManagerStats and push them into the StatsSampler so the
   * next snapshot emitted to the HUD contains up-to-date manager-owned fields.
   */
  private _pushManagerStats(): void {
    if (!this._sampler) return;

    const videoAt = this._videoArrivedAt;
    const audioAt = this._audioArrivedAt;
    const skewMs =
      videoAt !== null && audioAt !== null
        ? Math.abs(videoAt - audioAt)
        : null;

    // Per-channel diagnostics
    const channels: ChannelStats[] = [
      "chat",
      "control",
      "message",
      "input",
    ].map((label) => {
      const ch = this._channels?.[label as keyof DataChannelSet];
      return {
        label,
        state: (ch?.readyState ?? "closed") as RTCDataChannelState,
        openedAt: this._channelOpenedAt[label] ?? null,
      };
    });

    const handshakeMs =
      this._firstChannelOpenAt !== null && this._handshakeAckAt !== null
        ? this._handshakeAckAt - this._firstChannelOpenAt
        : null;

    const msSinceLastKeepalive =
      this._lastKeepaliveAt !== null
        ? Date.now() - this._lastKeepaliveAt
        : null;

    // Active keepalive mode
    let activeKeepalive: "api" | "idle" | "none" = "none";
    if (this._apiKeepAliveInterval !== null) {
      activeKeepalive = "api";
    } else if (this._idleKeepaliveInterval !== null) {
      activeKeepalive = "idle";
    }

    const stats: ManagerStats = {
      state: this._state,
      keyframeRequestsSent: this._keyframeRequestsSent,
      remoteCandidatesAdded: this._remoteCandidatesAdded,
      icePollAttemptsUsed: this._icePollAttemptsUsed,
      source: this._iceSource,
      stunCount: this._stunCount,
      turnCount: this._turnCount,
      activeKeepalive,
      msSinceLastKeepalive,
      lastIdleWarningSecondsUntilKick: this._lastIdleWarningSecondsUntilKick,
      channels,
      handshakeMs,
      currentAttempt: this._reconnectAttempts,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
      lastTriggerReason: this._lastTriggerReason,
      backoffMs: this._lastBackoffMs,
      videoArrivedAt: videoAt,
      audioArrivedAt: audioAt,
      skewMs,
      // GamepadPoller exposes no public seq/Hz — provide null for now
      outboundPacketHz: null,
      lastSequence: null,
    };

    this._sampler.setManagerStats(stats);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: reconnect
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Entry point for auto-reconnect.  Idempotent guards match app.js:731-736
   * (onConnectionLost).
   *
   * spec §3.9; app.js:731-737 (onConnectionLost)
   */
  private _triggerReconnect(reason: string): void {
    // Already reconnecting, cleanly idle, or permanently failed — don't stack
    if (
      this._state === "reconnecting" ||
      this._state === "idle" ||
      this._state === "failed"
    ) return;

    this._log(`Connection lost (${reason}) — initiating auto-reconnect`);
    this._lastTriggerReason = reason;
    void this._reconnect();
  }

  /**
   * Silent reconnect loop: up to RECONNECT_MAX_ATTEMPTS attempts with
   * increasing backoff.  Uses a while-loop rather than recursion so that the
   * "already reconnecting" guard at the top does not silently swallow retries.
   *
   * spec §3.8; app.js:72-122 (reconnect)
   */
  private async _reconnect(): Promise<void> {
    // Prevent a second concurrent cycle (e.g. if _triggerReconnect fires twice
    // in quick succession before the guard in _triggerReconnect kicks in).
    // IMPORTANT: compare via a local snapshot so TypeScript's control-flow
    // analysis does NOT narrow `this._state` for the rest of this async method —
    // _setState() can change the property during any `await` below.
    const stateNow = this._state;
    if (stateNow === "reconnecting") {
      this._log("Already reconnecting, skipping");
      return;
    }
    if (!this._serverId) {
      this._log("No serverId stored, cannot reconnect");
      this._setState("failed");
      return;
    }

    this._setState("reconnecting");

    while (this._reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      this._reconnectAttempts++;
      this._log(
        `Reconnect attempt ${this._reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
      );
      this._cb.onReconnectAttempt?.(this._reconnectAttempts, RECONNECT_MAX_ATTEMPTS);

      // Clean up the previous (failed) connection before starting a new one.
      this._cleanupConnection();

      // Increasing backoff: 3 s, 6 s, 9 s — gives Xbox time to expire the old session.
      // spec §3.8: RECONNECT_BASE_DELAY_MS × attemptNumber; app.js:98-100
      const delay = RECONNECT_BASE_DELAY_MS * this._reconnectAttempts;
      this._lastBackoffMs = delay;
      this._log(`Waiting ${delay / 1000}s before reconnect...`);
      await new Promise<void>((r) => setTimeout(r, delay));

      // Bail out if the user disconnected during the backoff wait.
      if (this._state !== "reconnecting") {
        this._log("Reconnect aborted — state changed to " + this._state);
        return;
      }

      try {
        await this._createSessionAndStream();

        // Bail if disconnect was called while _createSessionAndStream was awaiting.
        if (this._state !== "reconnecting") {
          this._cleanupConnection();
          this._log("Reconnect aborted — state changed to " + this._state);
          return;
        }

        // Wait for at least one data channel to open — app.js:106-110
        const channelReady = await this._waitForDataChannels(
          WAIT_FOR_DATA_CHANNELS_MS,
        );
        if (channelReady) {
          this._log("Reconnect successful!");
          this._reconnectAttempts = 0; // Reset counter on success — app.js:109
          return;
        }
        this._log(
          `Data channels did not open within ${WAIT_FOR_DATA_CHANNELS_MS / 1000}s`,
        );
      } catch (error) {
        this._log(
          `Reconnect attempt ${this._reconnectAttempts} failed: ` + String(error),
        );
      }
    }

    this._log("Max reconnect attempts reached — giving up");
    this._setState("failed");
  }

  /**
   * Wait for the message channel to reach 'open' state (proves SCTP works).
   *
   * app.js:125-150 (_waitForDataChannels)
   */
  private _waitForDataChannels(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Already open?
      if (
        this._channels?.message &&
        this._channels.message.readyState === "open"
      ) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => resolve(false), timeoutMs);

      // Poll every 250 ms — app.js:136
      const poll = setInterval(() => {
        if (
          this._channels?.message &&
          this._channels.message.readyState === "open"
        ) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(true);
          return;
        }
        // Bail if connection already died — app.js:142-147
        if (
          !this._pc ||
          this._pc.connectionState === "failed"
        ) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(false);
        }
      }, 250);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: cleanup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Tear down the active connection (keepalives, poller, PC, channels, sampler)
   * without clearing the stored session identity (serverId / consoleName).
   * Called before reconnect and from disconnect().
   *
   * app.js:816-862 (_cleanupConnection)
   */
  private _cleanupConnection(): void {
    this._stopAllKeepalives();
    this._stopGamepadPoller();
    this._stopStatsSampler();

    if (this._mediaMonitorTimer !== null) {
      clearInterval(this._mediaMonitorTimer);
      this._mediaMonitorTimer = null;
    }
    this._mediaMonitor?.reset();

    if (this._disconnectGraceTimer !== null) {
      clearTimeout(this._disconnectGraceTimer);
      this._disconnectGraceTimer = null;
    }

    if (this._pc) {
      // Remove handlers to avoid triggering reconnect during cleanup — app.js:831-836
      this._pc.onconnectionstatechange = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.ontrack = null;
      this._pc.close();
      this._pc = null;
    }

    this._channels = null;
    this._tracksReceived = { video: false, audio: false };
    this._hasStartedPlaying = false;

    // Drop the stale snapshot so the media watchdog can't read the previous
    // session's framesDecoded and flip to "streaming" before real frames arrive.
    this._lastSnapshot = null;

    // Reset input sequence so reconnect re-initialises — app.js:846-848
    this._inputSeq = 0;
    this._remoteCandidatesAdded = 0;
    this._icePollAttemptsUsed = 0;

    // Reset media stream — app.js:853-857
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t) => t.stop());
      this._mediaStream = null;
    }
  }

  /**
   * Stop and clear the media stream (used on user-initiated disconnect).
   *
   * app.js:864-871 (_cleanupMedia)
   */
  private _cleanupMedia(): void {
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t) => t.stop());
      this._mediaStream = null;
    }
  }
}
