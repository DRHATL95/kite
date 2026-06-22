/**
 * connection.svelte.ts — Svelte 5 reactive store wrapping a ConnectionBackend.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  All four backend
 * callbacks are wired to reactive fields so any component that reads them will
 * re-render automatically on updates.
 *
 * Backend selection
 * -----------------
 * `init()` MUST be called on app mount (see App.svelte) before the first
 * connect.  It awaits `rtcNativeAvailable()` once and sets `_impl` to either
 * `NativeConnection` (native Rust engine) or `ConnectionManager` (browser
 * WebRTC path).  A `backendReady` flag signals when selection is complete so
 * the UI can gate the Connect action until then.
 *
 * Until `init()` resolves, `_impl` is a browser `ConnectionManager` (safe
 * placeholder — on a native build the user cannot press Connect before
 * `backendReady` is true).
 *
 * Usage:
 *   import { connectionStore } from '$lib/stores/connection.svelte';
 *   await connectionStore.init();          // App.svelte onMount
 *   connectionStore.connect(console);      // ConsoleList (gated on backendReady)
 *   // Read: connectionStore.state, connectionStore.snapshot, etc.
 */

import { ConnectionManager } from "../connection/ConnectionManager.js";
import { NativeConnection } from "../connection/NativeConnection.js";
import type { ConnectionBackend } from "../connection/backend.js";
import type { ConnectionManagerCallbacks } from "../connection/ConnectionManager.js";
import type { SessionState, DiagnosticsSnapshot } from "../connection/types.js";
import type { XHomeConsole } from "../ipc/types.js";
import type { EncodedTap } from "../clip/EncodedTap.js";
import { rtcNativeAvailable } from "../ipc/commands.js";

/**
 * Map an internal reconnect/trigger reason to a user-facing failure message.
 * Media reasons point the user at the real-world fix (restart the console).
 */
function mapFailureReason(reason: string | null): string {
  if (reason === "mediaNeverStarted" || reason === "mediaStalled") {
    return "Couldn't get video from the console. It may be unresponsive — try restarting the console.";
  }
  return "The connection failed. Please try again.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Store class — reactive fields via $state runes
// ─────────────────────────────────────────────────────────────────────────────

class ConnectionStore {
  /** Current session lifecycle state. Updated by onStateChange. */
  state: SessionState = $state("idle");

  /** Latest diagnostics snapshot. Updated by onDiagnostics. null before first sample. */
  snapshot: DiagnosticsSnapshot | null = $state(null);

  /**
   * Active MediaStream once tracks arrive.  Set by onMediaStream.
   * Bind the <video> element's srcObject to this.
   */
  mediaStream: MediaStream | null = $state(null);

  /**
   * The console currently being connected to / streamed. Set on connect(),
   * cleared on disconnect(). Drives the connecting splash artwork + name.
   */
  currentConsole: XHomeConsole | null = $state(null);

  /**
   * Current reconnect attempt number (1-based), 0 when not reconnecting.
   * Updated by onReconnectAttempt — does NOT depend on the StatsSampler snapshot
   * so it stays accurate even while the sampler is stopped between attempts.
   */
  reconnectAttempt: number = $state(0);

  /**
   * Human-readable reason for the last failure, or null. Set when state becomes
   * "failed", cleared on a fresh connect(). Drives the ConsoleList failure banner.
   */
  failureReason: string | null = $state(null);

  /**
   * True once `init()` has resolved and the correct backend has been selected.
   * Gate the Connect action on this flag to prevent accidental connects on the
   * wrong backend (e.g. browser path on a native build before init completes).
   */
  backendReady: boolean = $state(false);

  // ── Private: backend implementation ──────────────────────────────────────

  /**
   * The active backend. Default-constructed as a browser ConnectionManager
   * (safe placeholder) until init() replaces it with the correct implementation.
   */
  private _impl: ConnectionBackend;

  /**
   * The shared callbacks object.  Built once; passed to whichever backend
   * init() constructs.  Kept as a field so init() can reuse it when building
   * the NativeConnection without duplicating the callback wiring.
   */
  private readonly _callbacks: ConnectionManagerCallbacks;

  constructor() {
    // Build callbacks once — reused by both possible backends.
    this._callbacks = {
      onStateChange: (s: SessionState) => {
        this.state = s;
        // Reset the live counter whenever we leave reconnecting state.
        if (s !== "reconnecting") this.reconnectAttempt = 0;
        // Capture a user-facing failure reason when we give up.
        if (s === "failed") {
          this.failureReason = mapFailureReason(this._impl.lastTriggerReason);
        }
      },

      onDiagnostics: (snap: DiagnosticsSnapshot) => {
        this.snapshot = snap;
      },

      onLog: (_msg: string) => {
        // Logging is owned by the logger facade (file + ring + viewer).
        // Retained because ConnectionManagerCallbacks requires onLog.
      },

      onMediaStream: (stream: MediaStream) => {
        this.mediaStream = stream;
      },

      onReconnectAttempt: (current: number) => {
        this.reconnectAttempt = current;
      },
    };

    // Default: browser path — safe placeholder until init() resolves.
    this._impl = new ConnectionManager(this._callbacks);
  }

  // ── Backend initialisation ─────────────────────────────────────────────────

  /**
   * Resolve the correct backend ONCE before the first connect.
   *
   * Awaits `rtcNativeAvailable()` (a fast Tauri IPC call) and replaces the
   * placeholder ConnectionManager with either NativeConnection (native Rust
   * engine) or keeps the browser ConnectionManager.  Sets `backendReady = true`
   * when done so the UI can ungate the Connect action.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.backendReady) return;

    const native = await rtcNativeAvailable();
    if (native) {
      // Replace the placeholder with the native backend.
      this._impl = new NativeConnection(this._callbacks);
    }
    // else: browser ConnectionManager (already in place) — no-op.

    this.backendReady = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Initiate a connection to the given Xbox console.
   * Idempotent while already connecting/reconnecting (handled inside the backend).
   */
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    this.failureReason = null;
    this.currentConsole = xboxConsole;
    await this._impl.connect(xboxConsole);
  }

  /**
   * User-initiated disconnect.  Resets state to 'idle' and clears the stream.
   */
  async disconnect(): Promise<void> {
    await this._impl.disconnect();
    // Clear media stream reference so UI can clean up srcObject
    this.mediaStream = null;
    this.currentConsole = null;
  }

  /**
   * Send a manual keyframe request on the WebRTC control data channel.
   */
  requestKeyframe(): void {
    this._impl.requestKeyframe();
  }

  /** Attach (or detach with null) the encoded-frame clip tap on the backend. */
  setEncodedTap(tap: EncodedTap | null): void {
    this._impl.setEncodedTap(tap);
  }

  /** Whether WebRTC Insertable Streams are usable (else MediaRecorder fallback). */
  get encodedStreamsAvailable(): boolean {
    return this._impl.encodedStreamsAvailable;
  }

  /**
   * Access the last DiagnosticsSnapshot directly from the backend
   * (synchronous, no reactive subscription needed).
   */
  get lastSnapshot(): DiagnosticsSnapshot | null {
    return this._impl.lastSnapshot;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export — one backend per app lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const connectionStore = new ConnectionStore();
