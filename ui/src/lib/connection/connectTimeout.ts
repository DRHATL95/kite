/**
 * connectTimeout.ts — policy for the store-level connect watchdog.
 *
 * The user-visible "connecting" state lives in the connection store, but the
 * timeouts that would end a stuck connect live (unevenly) inside the backends —
 * the native engine path has none at all. So a connect to an unresponsive
 * console can leave the splash spinning forever.
 *
 * The store arms a single watchdog when a connect begins and disarms it the
 * moment the connect settles. If it fires while still in progress, the store
 * forces a `failed` state with {@link CONNECT_TIMEOUT_MESSAGE}. This module
 * holds the pure, backend-agnostic pieces so they can be unit-tested without a
 * store or Tauri runtime.
 */
import type { SessionState } from "./types.js";

/**
 * How long the initial connect may sit pre-stream before the store forces a
 * failure. Generous enough not to false-trip a slow-but-working connect, short
 * enough that an unresponsive console doesn't hang the splash indefinitely.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

/** User-facing failure reason shown when the connect watchdog fires. */
export const CONNECT_TIMEOUT_MESSAGE =
  "Couldn't reach the console in time. It may be offline or unresponsive — try restarting it.";

/**
 * A "settled" state ends the watchdog: the connect either succeeded
 * (`streaming`) or is over (`failed`/`idle`). While `connecting`/`reconnecting`
 * it stays armed. Reconnect only happens after a successful stream — which is a
 * settled state that already disarmed the watchdog — so the watchdog only ever
 * governs the initial connect and never fights the reconnect loop.
 */
export function isConnectSettled(state: SessionState): boolean {
  return state === "streaming" || state === "failed" || state === "idle";
}
