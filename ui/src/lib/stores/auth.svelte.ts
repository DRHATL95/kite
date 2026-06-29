/**
 * auth.svelte.ts — Svelte 5 reactive store for Xbox authentication state.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  Wraps the typed IPC
 * command functions from ui/src/lib/ipc/commands.ts.
 *
 * Auth flow:
 *   1. On app start: authStore.loadCached()       — try keychain, set signedIn/signedOut
 *   2. If signedOut:  authStore.signIn()          — auth-code flow, sets awaitingCode
 *   3. While waiting: authStore.startPollingLoop() — detect completion or failure
 *   4. After signedIn: authStore.loadConsoles()   — fetch console list
 *
 * Usage:
 *   import { authStore } from '$lib/stores/auth.svelte';
 *   authStore.loadCached();
 *   // Read: authStore.authState, authStore.deviceCode, authStore.consoles
 */

import {
  tryLoadCachedAuth,
  checkAuthStatus,
  takeAuthFlowError,
  startXboxAuth,
  discoverXhomeConsoles,
  signOut as signOutCmd,
  openExternalUrl,
} from "../ipc/commands.js";
import type { XHomeConsole } from "../ipc/types.js";
import { decidePollOutcome, type PollDecision } from "./authFlowLogic.js";

// ─────────────────────────────────────────────────────────────────────────────
// Auth state type
// ─────────────────────────────────────────────────────────────────────────────

export type AuthState =
  | "unknown"
  | "signedOut"
  | "awaitingCode"
  | "signedIn"
  /** A sign-in attempt failed (e.g. token exchange couldn't reach Microsoft);
   *  `error` holds the reason. The DeviceCode screen shows it with a retry. */
  | "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Store class — reactive fields via $state runes
// ─────────────────────────────────────────────────────────────────────────────

class AuthStore {
  /** Current auth lifecycle state. */
  authState: AuthState = $state("unknown");

  /**
   * Authorize URL for the in-progress browser sign-in.
   * Non-null only while authState === 'awaitingCode' (for the manual re-open button).
   */
  signInUrl: string | null = $state(null);

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
   * Start the OAuth authorization-code sign-in flow.
   * Stores the authorize URL (signInUrl), sets authState to 'awaitingCode',
   * and opens the browser to the consent page.
   *
   * A Rust background task completes sign-in via the loopback redirect;
   * startPollingLoop() detects completion or failure.
   */
  async signIn(): Promise<void> {
    this.error = null;
    try {
      const url = await startXboxAuth();
      this.signInUrl = url;
      this.authState = "awaitingCode";
      // Auto-open the browser to the consent page. Failures are non-fatal —
      // the awaitingCode screen keeps a manual "Open sign-in page" button.
      try {
        await openExternalUrl(url);
      } catch {
        // ignore — user can use the manual button
      }
    } catch (e) {
      this.error = String(e);
    }
  }

  /**
   * One poll: check token validity, then (only if not yet signed in) drain any
   * one-shot backend flow error, and decide what the loop should do next. The
   * decision rules live in the pure, unit-tested `decidePollOutcome`.
   *
   * A transient IPC error is swallowed (treated as "no result yet") so a single
   * failed `invoke` doesn't abort the whole sign-in wait; the attempt cap still
   * guarantees the loop terminates.
   */
  private async pollOnce(attempts: number, maxAttempts: number): Promise<PollDecision> {
    try {
      const signedIn = await checkAuthStatus();
      const flowError = signedIn ? null : await takeAuthFlowError();
      return decidePollOutcome({ signedIn, flowError, attempts, maxAttempts });
    } catch {
      return decidePollOutcome({ signedIn: false, flowError: null, attempts, maxAttempts });
    }
  }

  /**
   * Start a polling loop that watches for sign-in completion every `intervalMs`
   * milliseconds. The loop ends — transitioning authState to 'signedIn' or
   * 'failed' — when the backend reports success, reports a flow error, or the
   * attempt cap is reached (a timeout backstop just past the backend's own
   * 300 s loopback timeout). The returned function cancels the loop, as does
   * leaving the 'awaitingCode' state.
   *
   * @param intervalMs   Polling interval in milliseconds (default 3000).
   * @param maxAttempts  Give-up cap; default 110 (~5.5 min at 3 s).
   */
  startPollingLoop(intervalMs = 3000, maxAttempts = 110): () => void {
    // Cancel any existing loop
    this._pollAbortController?.abort();
    this._pollAbortController = new AbortController();
    const signal = this._pollAbortController.signal;

    const loop = async () => {
      let attempts = 0;
      while (!signal.aborted && this.authState === "awaitingCode") {
        attempts++;
        const decision = await this.pollOnce(attempts, maxAttempts);
        if (signal.aborted) break;
        if (decision.kind === "signedIn") {
          this.authState = "signedIn";
          this.signInUrl = null;
          break;
        }
        if (decision.kind === "failed") {
          this.error = decision.error;
          this.signInUrl = null;
          this.authState = "failed";
          break;
        }
        // continue → wait for the interval, but abort early if cancelled
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
   * Abandon an in-progress or failed sign-in and return to the login screen.
   * Cancels the polling loop and clears the URL/error; does NOT touch the
   * keychain (nothing was stored yet).
   */
  cancelSignIn(): void {
    this.resetLocal();
  }

  /**
   * Reset local auth state back to signedOut (e.g. after token expiry).
   * Does NOT touch the keychain — for a full sign-out use signOut().
   */
  private resetLocal(): void {
    this._pollAbortController?.abort();
    this._pollAbortController = null;
    this.authState = "signedOut";
    this.signInUrl = null;
    this.consoles = [];
    this.error = null;
  }

  /**
   * Full sign-out: clear the persisted tokens from the OS keychain on the
   * backend, then reset local state so the app returns to the login screen.
   * The local reset runs even if the backend clear fails, so the user is never
   * stuck "signed in" in the UI.
   */
  async signOut(): Promise<void> {
    try {
      await signOutCmd();
    } catch (e) {
      // Surface but don't block the UI reset — the session is being abandoned.
      this.error = String(e);
    }
    this.resetLocal();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const authStore = new AuthStore();
