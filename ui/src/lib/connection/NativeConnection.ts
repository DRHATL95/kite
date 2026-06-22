/**
 * NativeConnection.ts — ConnectionBackend implementation for the native Rust
 * WebRTC engine (Phase 6 / 6c.6).
 *
 * Presents the SAME contract as the browser `ConnectionManager` (i.e.
 * `ConnectionBackend`) so that the connection store, HUD, and screens are
 * entirely path-agnostic: they hold one `_impl: ConnectionBackend` and never
 * need to know which transport is active.
 *
 * Architecture summary
 * ─────────────────────
 * - `connect(console)` → `rtcConnect(serverId)` + `subscribeRtcEvents(cb)` +
 *   start a `GamepadPoller` whose emit cb forwards `gamepad` states via
 *   `rtcSendInput`; ignores `metadata` (the native engine handles that itself).
 * - Event mapping guards against stale sessions via a monotonically-increasing
 *   `_generation` counter: if the counter changes between when an event was
 *   registered and when it fires, the event is dropped.
 * - A `_synth` partial (handshakeMs, videoArrivedAt) is merged into every
 *   emitted `DiagnosticsSnapshot` so the connecting-splash and streaming-phase
 *   HUD fields advance naturally without RTCStats.
 * - `setEncodedTap` / `encodedStreamsAvailable` are stubs — native clips go
 *   through `rtc_save_clip` (task 6c.8), not Insertable Streams.
 * - `onMediaStream` is never called: no `MediaStream` exists in native mode.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  rtcConnect,
  rtcDisconnect,
  rtcRequestKeyframe,
  rtcSendInput,
  subscribeRtcEvents,
} from "../ipc/commands.js";

import type { XHomeConsole } from "../ipc/types.js";
import type { EncodedTap } from "../clip/EncodedTap.js";
import type { ConnectionBackend } from "./backend.js";
import type { ConnectionManagerCallbacks } from "./ConnectionManager.js";
import type { DiagnosticsSnapshot, SessionState } from "./types.js";

import { GamepadPoller } from "./input.js";
import { mapStats, completeSnapshot } from "./nativeStats.js";
import { RECONNECT_MAX_ATTEMPTS } from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// NativeConnection
// ─────────────────────────────────────────────────────────────────────────────

export class NativeConnection implements ConnectionBackend {
  // ── Callbacks ──────────────────────────────────────────────────────────────
  private readonly _cbs: ConnectionManagerCallbacks;

  // ── Observable state ───────────────────────────────────────────────────────
  private _state: SessionState = "idle";
  private _lastSnapshot: DiagnosticsSnapshot | null = null;
  private _lastTriggerReason: string | null = null;

  // ── Session bookkeeping ────────────────────────────────────────────────────
  /** Monotonically increasing. Incremented on connect/disconnect so stale
   *  event callbacks from a previous session are silently dropped. */
  private _generation = 0;
  private _unlisten: UnlistenFn | null = null;
  private _poller: GamepadPoller | null = null;
  private _console: XHomeConsole | null = null;

  // ── Synthesised snapshot fields ────────────────────────────────────────────
  /** Fields we synthesise from lifecycle events (no RTCStats in native mode). */
  private _synth: Partial<DiagnosticsSnapshot> = {};
  /** Timestamp (Date.now()) when connect() was called — used to compute handshakeMs. */
  private _connectStartedAt = 0;
  /** Current reconnect attempt index (updated on 'reconnecting' events). */
  private _currentAttempt = 0;

  // ── Constructor ────────────────────────────────────────────────────────────

  constructor(callbacks: ConnectionManagerCallbacks) {
    this._cbs = callbacks;
  }

  // ── ConnectionBackend API ─────────────────────────────────────────────────

  /**
   * Begin a native streaming session.
   *
   * Does not throw; failures arrive as a terminal `disconnected` event which
   * transitions state to "failed" and fires `onStateChange("failed")`.
   */
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    this._console = xboxConsole;
    this._connectStartedAt = Date.now();
    this._synth = {};
    this._currentAttempt = 0;

    // Bump generation: any in-flight callbacks from a previous session are now stale.
    const myGeneration = ++this._generation;

    // Start the native engine.
    await rtcConnect(xboxConsole.serverId, undefined);

    // Subscribe to engine events — capturing the generation in the closure.
    this._unlisten = await subscribeRtcEvents((event) => {
      if (this._generation !== myGeneration) return; // stale — discard
      this._handleEvent(event);
    });

    // Start the gamepad poller. On 'gamepad' emits forward state to the engine;
    // 'metadata' emits are ignored (the native engine handles client-metadata itself).
    this._poller = new GamepadPoller((emit) => {
      if (emit.kind === "gamepad") {
        rtcSendInput(emit.state).catch(() => {
          // Best-effort; drop silently (engine may have exited)
        });
      }
      // metadata → no-op
    });
    this._poller.start();
  }

  /**
   * Tear down the active session and return to idle.
   */
  async disconnect(): Promise<void> {
    // Bump generation so any pending events from the current session are ignored.
    this._generation++;

    await rtcDisconnect();

    if (this._unlisten) {
      this._unlisten();
      this._unlisten = null;
    }

    if (this._poller) {
      this._poller.stop();
      this._poller = null;
    }

    this._setState("idle");
  }

  /**
   * Request a keyframe (IDR) from the console ("Fix Video" in the HUD).
   */
  requestKeyframe(): void {
    rtcRequestKeyframe().catch(() => {
      // Best-effort
    });
  }

  /**
   * Attach/detach the encoded-frame clip tap.
   * NO-OP in native mode: clips go through `rtc_save_clip` (task 6c.8).
   */
  setEncodedTap(_tap: EncodedTap | null): void {
    // Native clips do not use Insertable Streams — intentional no-op.
  }

  /** Whether Insertable Streams clip tapping is available. Always false natively. */
  get encodedStreamsAvailable(): boolean {
    return false;
  }

  get lastSnapshot(): DiagnosticsSnapshot | null {
    return this._lastSnapshot;
  }

  get lastTriggerReason(): string | null {
    return this._lastTriggerReason;
  }

  get state(): SessionState {
    return this._state;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _setState(next: SessionState): void {
    this._state = next;
    this._cbs.onStateChange(next);
  }

  private _handleEvent(event: import("./types.js").RtcEvent): void {
    switch (event.kind) {
      case "connecting": {
        this._setState("connecting");
        break;
      }

      case "connected": {
        // Record handshake latency for the next diagnostics snapshot.
        // Does NOT emit onStateChange — streaming begins on 'firstFrame'.
        this._synth = {
          ...this._synth,
          handshakeMs: Date.now() - this._connectStartedAt,
        };
        break;
      }

      case "firstFrame": {
        this._synth = {
          ...this._synth,
          videoArrivedAt: Date.now(),
        };
        this._setState("streaming");
        break;
      }

      case "reconnecting": {
        this._currentAttempt = event.attempt;
        this._cbs.onReconnectAttempt?.(event.attempt, RECONNECT_MAX_ATTEMPTS);
        this._setState("reconnecting");
        break;
      }

      case "stats": {
        const partial: Partial<DiagnosticsSnapshot> = {
          ...mapStats({
            bitrateKbps: event.bitrateKbps,
            fps: event.fps,
            framesDecoded: event.framesDecoded,
            freezeCount: event.freezeCount,
          }),
          ...this._synth,
          state: this._state,
          consoleName: this._console?.deviceName ?? null,
          consoleType: this._console?.consoleType ?? null,
          currentAttempt: this._currentAttempt,
          lastTriggerReason: this._lastTriggerReason,
        };
        const snapshot = completeSnapshot(partial);
        this._lastSnapshot = snapshot;
        this._cbs.onDiagnostics(snapshot);
        break;
      }

      case "disconnected": {
        this._lastTriggerReason = event.reason;
        this._setState("failed");
        break;
      }

      case "ended": {
        this._setState("idle");
        break;
      }
    }
  }
}
