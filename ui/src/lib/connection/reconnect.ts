/**
 * reconnect.ts — ReconnectController for ConnectionManager (Task 4 of the
 * ConnectionManager decomposition — the HIGHEST-RISK extraction, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md
 * §reconnect.ts).
 *
 * Extracted verbatim from ConnectionManager's _triggerReconnect/_reconnect/
 * _waitForDataChannels plus the disconnect-grace timer previously inline in
 * _setupConnectionStateHandler. Owns `_reconnectAttempts`, `_lastBackoffMs`,
 * `_disconnectGraceTimer`.
 *
 * This module is STANDALONE — it does NOT import ConnectionManager. The
 * ladder never HOLDS a `pc`/`channels`/`state` value across an `await`: every
 * read that the monolith performed lazily inside the loop or the 250ms poll
 * crosses the seam as a THUNK (`getPc()`/`getChannels()`/`getState()`), called
 * fresh at each point the original code read `this._pc`/`this._channels`/
 * `this._state`. This preserves late-binding exactly — a `setState("failed")`
 * mid-ladder, a user disconnect() during a backoff wait, or cleanup() nulling
 * `_pc` mid-poll must all be observed the instant they happen, not a value
 * captured when the attempt began. Writes to shared state cross as the
 * `setState` callback only — this controller never mutates ConnectionManager
 * fields directly (state stays single-writer in the host).
 *
 * Grace-timer precision (spec risk #1): the ORIGINAL code's grace-timer
 * re-check reads the connection-state HANDLER's own captured `pc`
 * (`pc.connectionState === "disconnected"`), not `this._pc`. This module does
 * NOT capture a `pc` itself — `armDisconnectGrace(isStillDisconnected)` takes
 * the already-bound predicate from the caller (the manager arms it with
 * `() => pc.connectionState === "disconnected"`, capturing the SAME `pc` the
 * handler was wired on), so that exact late-binding quirk lives entirely on
 * the caller side and is preserved by construction.
 *
 * Source of truth for behaviour: ui/public/app.js (ConnectionManager class).
 */

import {
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  WAIT_FOR_DATA_CHANNELS_MS,
  DISCONNECT_GRACE_MS,
} from "./constants.js";

import type { SessionState } from "./types.js";
import type { DataChannelSet } from "./dataChannels.js";

/**
 * Dependencies ReconnectController needs from its host (ConnectionManager).
 * Reads are thunks (late-bound, matching the monolith's field reads inside
 * the loop/poll); writes are named callbacks (state stays single-writer in
 * the host).
 */
export interface ReconnectDeps {
  /** Re-run the manager's session-creation + WebRTC setup pipeline (reassigns the host's pc/channels). */
  runAttempt(): Promise<void>;
  /** Tear down the previous (failed) connection before starting a new attempt. */
  cleanup(): void;
  /** Current SessionState — read FRESH after every await; never captured across one. */
  getState(): SessionState;
  /** Transition SessionState — funnels through the host's single-writer state setter. */
  setState(s: SessionState): void;
  /** Whether the host still has a stored session identity (serverId) to reconnect to. */
  hasIdentity(): boolean;
  /** Current RTCPeerConnection, or null — late-bound thunk for the data-channel wait poll. */
  getPc(): RTCPeerConnection | null;
  /** Current DataChannelSet, or null — late-bound thunk for the data-channel wait poll. */
  getChannels(): DataChannelSet | null;
  /** Report the current/max attempt count to the host's diagnostics callback. */
  onAttempt(current: number, max: number): void;
  /**
   * Report that a trigger() call is ABOUT TO PROCEED past the entry guard
   * (i.e. the ladder is actually starting for this reason) — lets the host
   * record its own `_lastTriggerReason` diagnostics field exactly once per
   * honoured trigger, from a SINGLE call site inside this controller. This
   * matters because trigger() has two callers: the host's own
   * `_triggerReconnect(reason)` wrapper AND this controller's internal
   * armDisconnectGrace() expiry (which self-invokes `trigger()` with the
   * hardcoded "connectionStateDisconnected" reason) — without this callback
   * the grace-timer path would never surface its reason to the host's
   * diagnostics, exactly like the original app.js code did via
   * `this._triggerReconnect("connectionStateDisconnected")`.
   */
  onTriggerAccepted(reason: string): void;
  /** Route a log line through the host's logger + onLog callback. */
  log(msg: string): void;
}

/**
 * ReconnectController — owns the auto-reconnect ladder (trigger guards,
 * increasing backoff, per-attempt cleanup, data-channel wait) and the
 * WebRTC-disconnect grace timer.
 *
 * app.js:72-122 (reconnect), app.js:125-150 (_waitForDataChannels),
 * app.js:731-737 (onConnectionLost); spec §3.8/§3.9.
 */
export class ReconnectController {
  /** app.js:14 */
  private _reconnectAttempts = 0;
  /** Backoff used in the last reconnect (ms). */
  private _lastBackoffMs: number | null = null;
  /** app.js:16 */
  private _disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ReconnectDeps) {}

  /**
   * Entry point for auto-reconnect.  Idempotent guards match app.js:731-736
   * (onConnectionLost). The ONLY call site that decides whether a reason is
   * "honoured" — both the host's external `_triggerReconnect(reason)` wrapper
   * AND this controller's own internal armDisconnectGrace() expiry funnel
   * through here, so `onTriggerAccepted` fires exactly once per honoured
   * trigger regardless of caller.
   *
   * spec §3.9; app.js:731-737 (onConnectionLost)
   */
  trigger(reason: string): void {
    // Already reconnecting, cleanly idle, or permanently failed — don't stack
    const stateNow = this.deps.getState();
    if (
      stateNow === "reconnecting" ||
      stateNow === "idle" ||
      stateNow === "failed"
    ) return;

    this.deps.onTriggerAccepted(reason);
    this.deps.log(`Connection lost (${reason}) — initiating auto-reconnect`);
    void this._reconnect();
  }

  /**
   * Silent reconnect loop: up to RECONNECT_MAX_ATTEMPTS attempts with
   * increasing backoff.  Uses a while-loop rather than recursion so that the
   * "already reconnecting" guard at the top does not silently swallow retries.
   *
   * spec §3.8; app.js:72-122 (reconnect)
   */
  private async _reconnect(): Promise<void> {
    // Prevent a second concurrent cycle (e.g. if trigger() fires twice in
    // quick succession before the guard in trigger() kicks in).
    // IMPORTANT: read getState() fresh here rather than caching a value —
    // deps.setState() below can change the host's state during any `await`
    // in this method, and every subsequent check must observe that live value.
    const stateNow = this.deps.getState();
    if (stateNow === "reconnecting") {
      this.deps.log("Already reconnecting, skipping");
      return;
    }
    if (!this.deps.hasIdentity()) {
      this.deps.log("No serverId stored, cannot reconnect");
      this.deps.setState("failed");
      return;
    }

    this.deps.setState("reconnecting");

    while (this._reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      this._reconnectAttempts++;
      this.deps.log(
        `Reconnect attempt ${this._reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
      );
      this.deps.onAttempt(this._reconnectAttempts, RECONNECT_MAX_ATTEMPTS);

      // Clean up the previous (failed) connection before starting a new one.
      this.deps.cleanup();

      // Increasing backoff: 3 s, 6 s, 9 s — gives Xbox time to expire the old session.
      // spec §3.8: RECONNECT_BASE_DELAY_MS × attemptNumber; app.js:98-100
      const delay = RECONNECT_BASE_DELAY_MS * this._reconnectAttempts;
      this._lastBackoffMs = delay;
      this.deps.log(`Waiting ${delay / 1000}s before reconnect...`);
      await new Promise<void>((r) => setTimeout(r, delay));

      // Bail out if the user disconnected during the backoff wait. Read
      // getState() fresh — this is the FIRST abort-check after an await.
      if (this.deps.getState() !== "reconnecting") {
        this.deps.log("Reconnect aborted — state changed to " + this.deps.getState());
        return;
      }

      try {
        await this.deps.runAttempt();

        // Bail if disconnect was called while runAttempt() was awaiting.
        // Read getState() fresh again — the SECOND abort-check after an await.
        if (this.deps.getState() !== "reconnecting") {
          this.deps.cleanup();
          this.deps.log("Reconnect aborted — state changed to " + this.deps.getState());
          return;
        }

        // Wait for at least one data channel to open — app.js:106-110
        const channelReady = await this._waitForDataChannels(
          WAIT_FOR_DATA_CHANNELS_MS,
        );
        if (channelReady) {
          this.deps.log("Reconnect successful!");
          this._reconnectAttempts = 0; // Reset counter on success — app.js:109
          return;
        }
        this.deps.log(
          `Data channels did not open within ${WAIT_FOR_DATA_CHANNELS_MS / 1000}s`,
        );
      } catch (error) {
        this.deps.log(
          `Reconnect attempt ${this._reconnectAttempts} failed: ` + String(error),
        );
      }
    }

    this.deps.log("Max reconnect attempts reached — giving up");
    this.deps.setState("failed");
  }

  /**
   * Wait for the message channel to reach 'open' state (proves SCTP works).
   *
   * app.js:125-150 (_waitForDataChannels)
   */
  private _waitForDataChannels(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Already open?
      const channelsNow = this.deps.getChannels();
      if (
        channelsNow?.message &&
        channelsNow.message.readyState === "open"
      ) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => resolve(false), timeoutMs);

      // Poll every 250 ms — app.js:136
      const poll = setInterval(() => {
        const channels = this.deps.getChannels();
        if (
          channels?.message &&
          channels.message.readyState === "open"
        ) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(true);
          return;
        }
        // Bail if connection already died — app.js:142-147
        const pc = this.deps.getPc();
        if (
          !pc ||
          pc.connectionState === "failed"
        ) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(false);
        }
      }, 250);
    });
  }

  /**
   * Arm the WebRTC-disconnect grace timer: after DISCONNECT_GRACE_MS, if
   * `isStillDisconnected()` is still true, trigger a reconnect with the
   * hardcoded reason "connectionStateDisconnected" (matches app.js exactly —
   * the reason string is NOT a caller-supplied parameter).
   *
   * Re-arming replaces any previously pending grace timer.
   *
   * Formerly inline in ConnectionManager._setupConnectionStateHandler's
   * onconnectionstatechange handler ("disconnected" branch); app.js:698-718.
   */
  armDisconnectGrace(isStillDisconnected: () => boolean): void {
    this.clearDisconnectGrace();
    this._disconnectGraceTimer = setTimeout(() => {
      this._disconnectGraceTimer = null;
      if (isStillDisconnected()) {
        this.deps.log("Still disconnected after grace period — reconnecting");
        this.trigger("connectionStateDisconnected");
      }
    }, DISCONNECT_GRACE_MS);
  }

  /**
   * Cancel any pending disconnect-grace timer. Safe no-op if none is armed.
   *
   * Formerly the unconditional clear at the top of every
   * onconnectionstatechange event (app.js:698-700) and in
   * ConnectionManager._cleanupConnection (app.js:816-862's grace-timer clear).
   */
  clearDisconnectGrace(): void {
    if (this._disconnectGraceTimer !== null) {
      clearTimeout(this._disconnectGraceTimer);
      this._disconnectGraceTimer = null;
    }
  }

  /** Zero the attempt counter. Mirrors ConnectionManager.connect() (app.js:60 equivalent). */
  resetAttempts(): void {
    this._reconnectAttempts = 0;
  }

  /** Current reconnect attempt index (0 = not reconnecting). */
  get attempts(): number {
    return this._reconnectAttempts;
  }

  /** Backoff delay (ms) used for the last reconnect attempt, or null before any. */
  get lastBackoffMs(): number | null {
    return this._lastBackoffMs;
  }
}
