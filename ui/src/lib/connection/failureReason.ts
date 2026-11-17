/**
 * failureReason.ts — pure mapping of internal trigger/failure reasons to
 * user-facing messages, plus the marker for a deliberate server-initiated
 * disconnect. No Svelte/DOM so it is unit-testable in isolation.
 */

/** Marks a deliberate server-initiated disconnect (the console ended the session). */
export const SERVER_DISCONNECT_PREFIX = "consoleDisconnected";

/** Build the internal trigger-reason marker for a server-initiated disconnect. */
export function serverDisconnectReason(rawReason: string): string {
  return rawReason ? `${SERVER_DISCONNECT_PREFIX}: ${rawReason}` : SERVER_DISCONNECT_PREFIX;
}

/**
 * Map an internal reconnect/trigger reason to a user-facing message.
 * - A server-initiated disconnect is a deliberate end (power-off / standby / …).
 * - Media reasons point the user at the real-world fix (restart the console).
 */
export function mapFailureReason(reason: string | null): string {
  if (reason?.startsWith(SERVER_DISCONNECT_PREFIX)) {
    return "Console disconnected — it may have been powered off, put in standby, or taken over by another user.";
  }
  if (reason === "mediaNeverStarted" || reason === "mediaStalled") {
    return "Couldn't get video from the console. It may be unresponsive — try restarting the console.";
  }
  return "The connection failed. Please try again.";
}
