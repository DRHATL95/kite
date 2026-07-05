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
import { rtcNativeAvailable, rtcSaveClip } from "../ipc/commands.js";
import {
  CONNECT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MESSAGE,
  isConnectSettled,
} from "../connection/connectTimeout.js";
import { settings } from "./settings.svelte.js";
import { paramsForQuality } from "../connection/streamQuality.js";
import { mapFailureReason } from "../connection/failureReason.js";

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

  /** Whether the active/last session was started in audio-only mode (snapshot at connect). */
  audioOnly: boolean = $state(false);

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
   * True when init() selected the native Rust engine (NativeConnection).
   * False (default) means the browser ConnectionManager is in use.
   */
  private _native: boolean = false;

  /**
   * Watchdog timer for the initial connect. Armed in connect(), cleared once the
   * connect settles (isConnectSettled). If it fires while still in progress the
   * store forces a `failed` state, so an unresponsive console can't hang the
   * connecting splash forever — including the native path, which has no timeout
   * of its own.
   */
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;

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
        // The connect either succeeded or ended — disarm the connect watchdog.
        if (isConnectSettled(s)) this._clearConnectTimer();
        // Reset the live counter whenever we leave reconnecting state.
        if (s !== "reconnecting") this.reconnectAttempt = 0;
        // Capture a user-facing failure reason when we give up.
        if (s === "failed") {
          this.failureReason = mapFailureReason(this._impl.lastTriggerReason);
        }
        // Make the HUD transparent only while actually streaming (see helper).
        this._syncNativeRenderClass();
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

  /**
   * Toggle the `native-render` body class that makes the HUD (and its atmosphere
   * layers) transparent so the GTK GLArea video shows through.
   *
   * Only transparent while `native && state === "streaming"`. On the
   * login / console-list / connecting / reconnecting / failed screens the HUD
   * stays OPAQUE: WebKit compositing is disabled under XWayland (required, or the
   * HUD renders black), so a transparent webview would let the *previous* screen
   * ghost through the un-repainted GL surface. An opaque HUD covers that, so the
   * "warped/overlapping" connecting phase is clean. Video screens are unaffected
   * (frames fill the surface).
   */
  private _syncNativeRenderClass(): void {
    if (typeof document === "undefined") return;
    const transparent = this._native && this.state === "streaming";
    document.body.classList.toggle("native-render", transparent);
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

    try {
      const native = await rtcNativeAvailable();
      if (native) {
        // Replace the placeholder with the native backend.
        this._impl = new NativeConnection(this._callbacks);
        this._native = true;
      }
      // else: browser ConnectionManager (already in place) — no-op.
    } catch (e) {
      // IPC probe failed — keep the browser ConnectionManager (safe fallback).
      console.warn(`rtc_native_available probe failed; using browser path: ${String(e)}`);
    } finally {
      // Set the initial transparency state (opaque until streaming begins).
      this._syncNativeRenderClass();
      this.backendReady = true;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * True when the native Rust WebRTC engine is active (set after init() resolves).
   * False means the browser ConnectionManager is in use.
   * Used to gate browser-only code paths (e.g. EncodedTap clip attachment).
   */
  get nativeMode(): boolean {
    return this._native;
  }

  /**
   * Save a retroactive clip.
   *
   * - Native mode: delegates to `rtcSaveClip()` (engine ClipRing is always
   *   recording) and surfaces the result via `clipStore`'s toast mechanism.
   * - Browser mode: delegates to the existing `clipStore.saveClip()` path
   *   (EncodedTap / ClipBuffer).
   *
   * Call this from the "Clip" button instead of `clipStore.saveClip()` directly
   * so native mode is handled transparently.
   */
  async saveClip(): Promise<void> {
    if (this._native) {
      // Lazy import to avoid a circular-module issue (clipStore imports
      // connectionStore; we import clipStore only at call time here).
      const { clipStore } = await import("./clip.svelte.js");
      try {
        const path = await rtcSaveClip();
        clipStore.showNativeClipToast(path);
      } catch (e) {
        clipStore.showNativeClipToast(null, String(e));
      }
    } else {
      const { clipStore } = await import("./clip.svelte.js");
      await clipStore.saveClip();
    }
  }

  /**
   * Initiate a connection to the given Xbox console.
   * Idempotent while already connecting/reconnecting (handled inside the backend).
   */
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    this.failureReason = null;
    this.currentConsole = xboxConsole;
    // Show the connecting screen immediately, before the backend's own first
    // "connecting" event — which (natively) is gated behind a chain of IPC
    // round-trips + the engine's signaling connect, so without this the loading
    // screen lags a beat after Stream is pressed (feels like a freeze). The
    // backend re-asserts "connecting" shortly after; this just front-runs it.
    this.audioOnly = settings.audioOnly;
    const quality = paramsForQuality(settings.streamQuality);
    this.state = "connecting";
    // Arm the connect watchdog: if we never reach a settled state within
    // CONNECT_TIMEOUT_MS, _onConnectTimeout forces a failure.
    this._armConnectTimer();
    try {
      await this._impl.connect(xboxConsole, { audioOnly: this.audioOnly, quality });
    } catch (e) {
      // The backend normally surfaces failure via onStateChange("failed"); guard
      // the optimistic transition in case connect() rejects before any event.
      this._clearConnectTimer();
      if (this.state === "connecting") {
        this.state = "failed";
        this.failureReason = mapFailureReason(this._impl.lastTriggerReason);
      }
      throw e;
    }
  }

  // ── Connect watchdog ────────────────────────────────────────────────────────
  //
  // A single timer guards the initial connect. The user-visible "connecting"
  // state lives here in the store, but the backends' own timeouts are uneven
  // (the native engine path has none), so this store-level net catches a connect
  // that never progresses — regardless of backend.

  private _armConnectTimer(): void {
    this._clearConnectTimer();
    this._connectTimer = setTimeout(() => this._onConnectTimeout(), CONNECT_TIMEOUT_MS);
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  private _onConnectTimeout(): void {
    this._clearConnectTimer();
    // Race guard: the connect may have settled between the timer firing and this
    // callback running.
    if (isConnectSettled(this.state)) return;
    // Present a failure. Teardown + navigation are handled by App.svelte's 3s
    // failed→console-list auto-return (the same path a backend-reported failure
    // takes), so we deliberately do NOT disconnect here — that would emit an
    // intermediate "idle" and flicker the router.
    this.state = "failed";
    this.failureReason = CONNECT_TIMEOUT_MESSAGE;
  }

  /**
   * User-initiated disconnect.  Resets state to 'idle' and clears the stream.
   */
  async disconnect(): Promise<void> {
    // Cancel any in-flight connect watchdog (covers the splash "Cancel" button).
    this._clearConnectTimer();
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
