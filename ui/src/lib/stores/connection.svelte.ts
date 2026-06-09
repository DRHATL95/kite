/**
 * connection.svelte.ts — Svelte 5 reactive store wrapping ConnectionManager.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  All four ConnectionManager
 * callbacks are wired to reactive fields so any component that reads them will
 * re-render automatically on updates.
 *
 * Usage:
 *   import { connectionStore } from '$lib/stores/connection.svelte';
 *   connectionStore.connect(console);
 *   // Read: connectionStore.state, connectionStore.snapshot, etc.
 */

import { ConnectionManager } from "../connection/ConnectionManager.js";
import type { SessionState, DiagnosticsSnapshot } from "../connection/types.js";
import type { XHomeConsole } from "../ipc/types.js";

/** Maximum number of log entries to keep in memory. */
const LOG_CAP = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Store class — reactive fields via $state runes
// ─────────────────────────────────────────────────────────────────────────────

class ConnectionStore {
  /** Current session lifecycle state. Updated by onStateChange. */
  state: SessionState = $state("idle");

  /** Latest diagnostics snapshot. Updated by onDiagnostics. null before first sample. */
  snapshot: DiagnosticsSnapshot | null = $state(null);

  /**
   * Human-readable log lines, newest-last, capped at LOG_CAP entries.
   * Updated by onLog.
   */
  log: string[] = $state([]);

  /**
   * Active MediaStream once tracks arrive.  Set by onMediaStream.
   * Bind the <video> element's srcObject to this.
   */
  mediaStream: MediaStream | null = $state(null);

  // ── Private: single ConnectionManager instance ────────────────────────────

  private readonly _manager: ConnectionManager;

  constructor() {
    this._manager = new ConnectionManager({
      onStateChange: (s: SessionState) => {
        this.state = s;
      },

      onDiagnostics: (snap: DiagnosticsSnapshot) => {
        this.snapshot = snap;
      },

      onLog: (msg: string) => {
        // Append with timestamp prefix; cap at LOG_CAP
        const entry = `[${new Date().toISOString()}] ${msg}`;
        if (this.log.length >= LOG_CAP) {
          // Trim from the front — keep the newest entries
          this.log = [...this.log.slice(this.log.length - LOG_CAP + 1), entry];
        } else {
          this.log = [...this.log, entry];
        }
      },

      onMediaStream: (stream: MediaStream) => {
        this.mediaStream = stream;
      },
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Initiate a connection to the given Xbox console.
   * Idempotent while already connecting/reconnecting (handled inside manager).
   */
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    await this._manager.connect(xboxConsole);
  }

  /**
   * User-initiated disconnect.  Resets state to 'idle' and clears the stream.
   */
  async disconnect(): Promise<void> {
    await this._manager.disconnect();
    // Clear media stream reference so UI can clean up srcObject
    this.mediaStream = null;
  }

  /**
   * Send a manual keyframe request on the WebRTC control data channel.
   */
  requestKeyframe(): void {
    this._manager.requestKeyframe();
  }

  /**
   * Access the last DiagnosticsSnapshot directly from the manager
   * (synchronous, no reactive subscription needed).
   */
  get lastSnapshot(): DiagnosticsSnapshot | null {
    return this._manager.lastSnapshot;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export — one ConnectionManager per app lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const connectionStore = new ConnectionStore();
