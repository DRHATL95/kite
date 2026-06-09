/**
 * auth.svelte.ts — Svelte 5 reactive store for Xbox authentication state.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  Wraps the typed IPC
 * command functions from ui/src/lib/ipc/commands.ts.
 *
 * Auth flow:
 *   1. On app start: authStore.loadCached()     — try keychain, set signedIn/signedOut
 *   2. If signedOut:  authStore.signIn()         — device-code flow, sets awaitingCode
 *   3. While waiting: authStore.pollAuth()       — check if user completed sign-in
 *   4. After signedIn: authStore.loadConsoles()  — fetch console list
 *
 * Usage:
 *   import { authStore } from '$lib/stores/auth.svelte';
 *   authStore.loadCached();
 *   // Read: authStore.authState, authStore.deviceCode, authStore.consoles
 */

import {
  tryLoadCachedAuth,
  checkAuthStatus,
  startXboxAuth,
  discoverXhomeConsoles,
} from "../ipc/commands.js";
import type { DeviceCodeInfo, XHomeConsole } from "../ipc/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Auth state type
// ─────────────────────────────────────────────────────────────────────────────

export type AuthState = "unknown" | "signedOut" | "awaitingCode" | "signedIn";

// ─────────────────────────────────────────────────────────────────────────────
// Store class — reactive fields via $state runes
// ─────────────────────────────────────────────────────────────────────────────

class AuthStore {
  /** Current auth lifecycle state. */
  authState: AuthState = $state("unknown");

  /**
   * Device code info from startXboxAuth().
   * Non-null only while authState === 'awaitingCode'.
   */
  deviceCode: DeviceCodeInfo | null = $state(null);

  /** Consoles discovered after successful sign-in. */
  consoles: XHomeConsole[] = $state([]);

  /** Human-readable error from the last failed operation, if any. */
  error: string | null = $state(null);

  // ── Private: polling cancellation ────────────────────────────────────────

  private _pollAbortController: AbortController | null = null;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Try to load cached auth from the OS keychain.
   * Sets authState to 'signedIn' or 'signedOut' based on the result.
   */
  async loadCached(): Promise<void> {
    this.error = null;
    try {
      const ok = await tryLoadCachedAuth();
      this.authState = ok ? "signedIn" : "signedOut";
    } catch (e) {
      this.error = String(e);
      this.authState = "signedOut";
    }
  }

  /**
   * Start the OAuth device-code sign-in flow.
   * Sets deviceCode so the UI can display the code and verification URL.
   * Sets authState to 'awaitingCode'.
   *
   * Rust background task polls for completion; call pollAuth() to detect it.
   */
  async signIn(): Promise<void> {
    this.error = null;
    try {
      const info = await startXboxAuth();
      this.deviceCode = info;
      this.authState = "awaitingCode";
    } catch (e) {
      this.error = String(e);
    }
  }

  /**
   * Check whether the user has completed sign-in in their browser.
   * Returns true (and updates authState to 'signedIn') if auth is valid.
   */
  async pollAuth(): Promise<boolean> {
    try {
      const ok = await checkAuthStatus();
      if (ok) {
        this.authState = "signedIn";
        this.deviceCode = null;
      }
      return ok;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  /**
   * Start a polling loop that calls checkAuthStatus() every `intervalMs`
   * milliseconds until auth succeeds or `cancel()` is called.
   *
   * The returned cancel function stops the loop.  The loop also stops
   * automatically once authState reaches 'signedIn'.
   *
   * @param intervalMs  Polling interval in milliseconds (default 3000).
   */
  startPollingLoop(intervalMs = 3000): () => void {
    // Cancel any existing loop
    this._pollAbortController?.abort();
    this._pollAbortController = new AbortController();
    const signal = this._pollAbortController.signal;

    const loop = async () => {
      while (!signal.aborted && this.authState === "awaitingCode") {
        const ok = await this.pollAuth();
        if (ok || signal.aborted) break;
        // Wait for the interval, but abort early if cancelled
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, intervalMs);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
    };

    void loop();

    return () => {
      this._pollAbortController?.abort();
      this._pollAbortController = null;
    };
  }

  /**
   * Fetch the list of Xbox consoles from the xHome API.
   * Requires authState === 'signedIn'.
   */
  async loadConsoles(): Promise<void> {
    this.error = null;
    try {
      this.consoles = await discoverXhomeConsoles();
    } catch (e) {
      this.error = String(e);
    }
  }

  /**
   * Reset back to signedOut state (e.g. after token expiry).
   */
  signOut(): void {
    this._pollAbortController?.abort();
    this._pollAbortController = null;
    this.authState = "signedOut";
    this.deviceCode = null;
    this.consoles = [];
    this.error = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const authStore = new AuthStore();
