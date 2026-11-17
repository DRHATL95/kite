/**
 * keepalive.ts — KeepaliveController for ConnectionManager
 *
 * Extracted verbatim from ConnectionManager's
 * _startApiKeepalive/_stopApiKeepalive/_stopAllKeepalives/_sendIdleKeepalive
 * (ConnectionManager.ts:941-1049, as of the `keepalive.ts` extraction step —
 * see docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md
 * §keepalive.ts) plus the idle-warning reaction previously inline in the
 * `onIdleWarning` message-channel callback (ConnectionManager.ts:498-512).
 * Owns `_apiKeepAliveInterval`, `_idleKeepaliveInterval`, `_lastKeepaliveAt`,
 * `_lastIdleWarningSecondsUntilKick`, and `_inputSeq` (used only by the idle
 * pulse — the gamepad poller has its own local `seq`, untouched by this move).
 *
 * This module is STANDALONE — it does NOT import ConnectionManager. Reads
 * that the monolith performed lazily inside a timer/event callback (session
 * path, input channel, streaming state) cross the seam as thunks so the
 * late-binding behaviour is preserved exactly; writes to shared manager state
 * cross as named callbacks (`log`, `onStatsChanged`) — this controller never
 * writes ConnectionManager fields directly.
 *
 * The 38-byte idle micro-pulse + recenter frame are ported BYTE-VERBATIM from
 * app.js:891-923 (_sendIdleKeepalive) — do NOT re-route onto
 * `encodeInputEmit`/`encodeGamepadFrame` in this pass.
 *
 * Source of truth for behaviour: ui/public/app.js (ConnectionManager class).
 */

import { sendSessionKeepalive } from "../ipc/commands.js";

import {
  API_KEEPALIVE_MS,
  IDLE_KEEPALIVE_INTERVAL_MS,
  IDLE_PULSE_LEFT_THUMB_X,
  IDLE_PULSE_RECENTER_MS,
  REPORT_TYPE_GAMEPAD,
} from "./constants.js";

import type { KeepaliveMode } from "./types.js";

/**
 * Dependencies KeepaliveController needs from its host (ConnectionManager).
 * Reads are thunks (late-bound, matching the monolith's field reads inside
 * timers); writes are named callbacks (state stays single-writer in the host).
 */
export interface KeepaliveDeps {
  /** Current xHome session path, or null if no session exists yet. */
  getSessionPath(): string | null;
  /** Current WebRTC `input` data channel, or null if not yet created. */
  getInputChannel(): RTCDataChannel | null;
  /** Whether the manager's SessionState is currently "streaming" — catch-branch stop rule (app.js:573-579 equivalent). */
  isStreaming(): boolean;
  /** Route a log line through the host's logger + onLog callback. */
  log(msg: string): void;
  /** Notify the host that manager-owned stats changed (replaces the host's own `_pushManagerStats()` at the "API keepalive OK" call site). */
  onStatsChanged(): void;
}

/**
 * KeepaliveController — owns the API keepalive interval (xHome REST
 * keepalive, active immediately after session creation) and the idle
 * keepalive (data-channel micro-pulse, armed only after Xbox sends an
 * idle warning).
 *
 * app.js:556-586 (_startApiKeepalive), app.js:891-923 (sendIdleKeepalive);
 * spec §3.2.
 */
export class KeepaliveController {
  /** API keepalive timer; app.js:12 */
  private _apiKeepAliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic idle keepalive interval (after idle warning); app.js:424-428 */
  private _idleKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Tracks when the last keepalive was sent (ms since epoch), for diagnostics. NEVER reset — see reset matrix. */
  private _lastKeepaliveAt: number | null = null;
  /** Last "seconds until kick" reported by an idle warning. NEVER reset — see reset matrix. */
  private _lastIdleWarningSecondsUntilKick: number | null = null;
  /** Shared with the idle keepalive encoder; app.js:1544 */
  private _inputSeq = 0;

  constructor(private readonly deps: KeepaliveDeps) {}

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
  startApi(): void {
    // Idempotent — app.js:557
    if (this._apiKeepAliveInterval !== null || !this.deps.getSessionPath()) return;

    const sessionPath = this.deps.getSessionPath();
    this.deps.log(
      `Starting API keepalive every ${API_KEEPALIVE_MS / 1000}s for: ${sessionPath}`,
    );

    const sendApiKeepalive = (): void => {
      const currentSessionPath = this.deps.getSessionPath();
      if (!currentSessionPath) {
        this._stopApiKeepalive();
        return;
      }
      sendSessionKeepalive(currentSessionPath)
        .then((status: string) => {
          this._lastKeepaliveAt = Date.now();
          this.deps.log("API keepalive OK: " + status);
          this.deps.onStatsChanged();
        })
        .catch((e: unknown) => {
          const errStr = String(e);
          // Xbox rejects API keepalives once streaming starts (state machine
          // moves past "Provisioned").  Stop silently — app.js:573-579.
          if (
            errStr.includes("SessionInUnexpectedState") ||
            errStr.includes("400") ||
            this.deps.isStreaming()
          ) {
            this.deps.log("API keepalive stopped (data channel is keepalive)");
            this._stopApiKeepalive();
          } else {
            this.deps.log("API keepalive FAILED: " + errStr);
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

  /**
   * React to an Xbox idle warning: record the value, send an immediate
   * micro-pulse, and arm the periodic 30s idle-keepalive interval (once).
   *
   * Moved verbatim from the `onIdleWarning` message-channel callback inline
   * in ConnectionManager._setupWebRTC (ConnectionManager.ts:498-512); app.js:425-429.
   */
  onIdleWarning(secondsUntilKick: number): void {
    this._lastIdleWarningSecondsUntilKick = secondsUntilKick;
    this.deps.log(
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
    const inputCh = this.deps.getInputChannel();
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
        const ch = this.deps.getInputChannel();
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
        this.deps.log("Sent idle keepalive (stick micro-pulse + recenter)");
      }, IDLE_PULSE_RECENTER_MS);
    } catch (e) {
      this.deps.log("Idle keepalive failed: " + String(e));
    }
  }

  /**
   * Stop both keepalive intervals (timers only). Mirrors
   * _stopAllKeepalives() called from _cleanupConnection (app.js:816-862).
   *
   * Does NOT reset `lastKeepaliveAt` or `lastIdleWarningSecondsUntilKick` —
   * those are session-crossing diagnostics quirks preserved exactly per the
   * reset matrix (they survive across reconnects). Kept separate from
   * resetInputSeq() (see ConnectionManager._cleanupConnection:1364-1365,
   * which resets `_inputSeq` alongside but as its own statement).
   */
  stopAll(): void {
    this._stopApiKeepalive();
    if (this._idleKeepaliveInterval !== null) {
      clearInterval(this._idleKeepaliveInterval);
      this._idleKeepaliveInterval = null;
    }
  }

  /**
   * Reset the idle-pulse sequence counter. Mirrors
   * ConnectionManager._cleanupConnection's `this._inputSeq = 0` (line 1365) —
   * kept as a SEPARATE method from stopAll() because the monolith resets it
   * as its own statement, not as part of stopping the timers.
   */
  resetInputSeq(): void {
    this._inputSeq = 0;
  }

  /** Which keepalive mode is currently active — mirrors buildManagerStats' api > idle precedence. */
  get mode(): KeepaliveMode {
    if (this._apiKeepAliveInterval !== null) return "api";
    if (this._idleKeepaliveInterval !== null) return "idle";
    return "none";
  }

  /** Timestamp (ms since epoch) of the last successful API keepalive send, or null. NEVER reset. */
  get lastKeepaliveAt(): number | null {
    return this._lastKeepaliveAt;
  }

  /** Last "seconds until kick" reported by an idle warning, or null. NEVER reset. */
  get lastIdleWarningSecondsUntilKick(): number | null {
    return this._lastIdleWarningSecondsUntilKick;
  }
}
