/**
 * authFlowLogic.ts — pure decision logic for the sign-in polling loop.
 *
 * Kept separate from the (reactive, IPC-bound) auth store so the state-machine
 * rules are unit-testable without Tauri or timers — same pattern as the clip
 * module's `encodedTapLogic` / `clipBufferLogic`.
 */

/** One poll's observations: token validity, any backend flow error, progress. */
export interface PollObservation {
  /** Result of `check_auth_status` — true once tokens are stored. */
  signedIn: boolean;
  /** A one-shot sign-in *flow* failure reported by the backend, else null. */
  flowError: string | null;
  /** 1-based count of polls performed so far (this one included). */
  attempts: number;
  /** Give-up cap; at/over this with no result we stop and report a timeout. */
  maxAttempts: number;
}

/** What the polling loop should do next. */
export type PollDecision =
  | { kind: "continue" }
  | { kind: "signedIn" }
  | { kind: "failed"; error: string };

/**
 * Decide the next step from one poll. Success wins over a (possibly stale)
 * error; a reported flow error ends the loop with that message; otherwise we
 * keep polling until the attempt cap, then fail with a timeout.
 */
export function decidePollOutcome(o: PollObservation): PollDecision {
  if (o.signedIn) return { kind: "signedIn" };
  if (o.flowError) return { kind: "failed", error: o.flowError };
  if (o.attempts >= o.maxAttempts) {
    return { kind: "failed", error: "Sign-in timed out. Please try again." };
  }
  return { kind: "continue" };
}
