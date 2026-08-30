/**
 * reconnect.test.ts — TDD for ReconnectController (Task 4 of the
 * ConnectionManager decomposition, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md
 * §reconnect.ts — the HIGHEST-RISK extraction: async loop + abort races +
 * grace timer).
 *
 * Pins the behaviour extracted verbatim from ConnectionManager's
 * _triggerReconnect/_reconnect/_waitForDataChannels plus the disconnect-grace
 * timer previously inline in _setupConnectionStateHandler. Every assertion
 * here is cross-checked against ConnectionManager.test.ts Group 2 ("reconnect
 * ladder"), which exercises the identical behaviour through the full manager
 * and must stay green unmodified — this file is the focused, fake-timer unit
 * -test counterpart.
 *
 * CRITICAL care points this file exists to pin (see the task brief):
 *   1. Every getPc()/getChannels()/getState() read inside the loop or the
 *      channel-wait poll is a FRESH thunk call, never a captured value.
 *   2. Abort-checks read getState() FRESH after EVERY await — a state flip to
 *      idle/disconnected mid-backoff or mid-attempt aborts the ladder WITHOUT
 *      calling setState("failed").
 *   3. armDisconnectGrace's predicate is supplied AT ARM TIME by the caller
 *      (the manager captures the connection-state handler's own `pc` — this
 *      unit test only proves the controller invokes the predicate it was
 *      given after the grace delay; the pc-capture itself is a manager-side
 *      concern proven by ConnectionManager.test.ts Group 2).
 *   4. Backoff is RECONNECT_BASE_DELAY_MS × attempt (3/6/9s); cleanup() runs
 *      BEFORE each backoff wait; onAttempt(current, max) fires synchronously
 *      at the top of each loop iteration.
 *   5. Writes happen ONLY via the setState callback — the controller never
 *      mutates any shared field directly.
 *
 * Mocking recipe copied from keepalive.test.ts / signaling.test.ts:
 * `vi.useFakeTimers()` in beforeEach, `vi.useRealTimers()` in afterEach.
 * ReconnectDeps is a plain object of `vi.fn()`s with controllable
 * getState/getPc/getChannels so tests can flip state mid-flight exactly like
 * a user disconnect() or a cleanup() would.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

import { ReconnectController, type ReconnectDeps } from "./reconnect.js";
import {
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  WAIT_FOR_DATA_CHANNELS_MS,
  DISCONNECT_GRACE_MS,
} from "./constants.js";
import type { SessionState } from "./types.js";
import type { DataChannelSet } from "./dataChannels.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes: minimal duck-typed RTCPeerConnection / RTCDataChannel
// ─────────────────────────────────────────────────────────────────────────────

class FakePc {
  connectionState: RTCPeerConnectionState = "new";
}

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
}

function makeChannels(messageState: RTCDataChannelState = "connecting"): DataChannelSet {
  const message = new FakeChannel() as unknown as RTCDataChannel;
  (message as unknown as FakeChannel).readyState = messageState;
  return {
    chat: new FakeChannel() as unknown as RTCDataChannel,
    control: new FakeChannel() as unknown as RTCDataChannel,
    message,
    input: new FakeChannel() as unknown as RTCDataChannel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps harness
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  deps: ReconnectDeps;
  ctrl: ReconnectController;
  logs: string[];
  state: SessionState;
  pc: FakePc | null;
  channels: DataChannelSet | null;
  hasIdentity: boolean;
  runAttempt: Mock;
  cleanup: Mock;
  setState: Mock;
  onAttempt: Mock;
  onTriggerAccepted: Mock;
  /** Each call records the state value getState() returned, in order. */
  getStateCalls: SessionState[];
}

function makeHarness(
  overrides: Partial<{
    state: SessionState;
    hasIdentity: boolean;
    pc: FakePc | null;
    channels: DataChannelSet | null;
  }> = {},
): Harness {
  const logs: string[] = [];
  const getStateCalls: SessionState[] = [];

  const h: Harness = {
    deps: null as unknown as ReconnectDeps,
    ctrl: null as unknown as ReconnectController,
    logs,
    state: overrides.state ?? "reconnecting",
    pc: "pc" in overrides ? overrides.pc! : new FakePc(),
    channels: "channels" in overrides ? overrides.channels! : makeChannels(),
    hasIdentity: overrides.hasIdentity ?? true,
    runAttempt: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    setState: vi.fn(),
    onAttempt: vi.fn(),
    onTriggerAccepted: vi.fn(),
    getStateCalls,
  };

  h.setState.mockImplementation((s: SessionState) => {
    h.state = s;
  });

  h.deps = {
    runAttempt: () => h.runAttempt(),
    cleanup: () => h.cleanup(),
    getState: () => {
      getStateCalls.push(h.state);
      return h.state;
    },
    setState: (s: SessionState) => h.setState(s),
    hasIdentity: () => h.hasIdentity,
    getPc: () => h.pc as unknown as RTCPeerConnection | null,
    getChannels: () => h.channels,
    onAttempt: (current: number, max: number) => h.onAttempt(current, max),
    onTriggerAccepted: (reason: string) => h.onTriggerAccepted(reason),
    log: (msg: string) => logs.push(msg),
  };

  h.ctrl = new ReconnectController(h.deps);
  return h;
}

/** Drain the microtask queue without advancing fake time. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite setup
// ─────────────────────────────────────────────────────────────────────────────

describe("ReconnectController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // trigger() guards
  // ═══════════════════════════════════════════════════════════════════════

  describe("trigger()", () => {
    it("is ignored when state is 'reconnecting' (already in-flight)", async () => {
      const h = makeHarness({ state: "reconnecting" });
      h.ctrl.trigger("someReason");
      await flushMicrotasks();
      expect(h.runAttempt).not.toHaveBeenCalled();
      expect(h.setState).not.toHaveBeenCalled();
      expect(h.onTriggerAccepted).not.toHaveBeenCalled();
    });

    it("is ignored when state is 'idle'", async () => {
      const h = makeHarness({ state: "idle" });
      h.ctrl.trigger("someReason");
      await flushMicrotasks();
      expect(h.runAttempt).not.toHaveBeenCalled();
      expect(h.setState).not.toHaveBeenCalled();
      expect(h.onTriggerAccepted).not.toHaveBeenCalled();
    });

    it("is ignored when state is 'failed'", async () => {
      const h = makeHarness({ state: "failed" });
      h.ctrl.trigger("someReason");
      await flushMicrotasks();
      expect(h.runAttempt).not.toHaveBeenCalled();
      expect(h.setState).not.toHaveBeenCalled();
      expect(h.onTriggerAccepted).not.toHaveBeenCalled();
    });

    it("proceeds when state is 'connecting' or 'streaming' — transitions to 'reconnecting'", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.setState).toHaveBeenCalledWith("reconnecting");
    });

    it("reports the reason via onTriggerAccepted() exactly once when the guard passes (host records lastTriggerReason from this)", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.trigger("iceFailed");
      await flushMicrotasks();
      expect(h.onTriggerAccepted).toHaveBeenCalledTimes(1);
      expect(h.onTriggerAccepted).toHaveBeenCalledWith("iceFailed");
    });

    it("requires hasIdentity() — sets 'failed' and does not attempt when identity is missing", async () => {
      const h = makeHarness({ state: "streaming", hasIdentity: false });
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.setState).toHaveBeenCalledWith("failed");
      expect(h.runAttempt).not.toHaveBeenCalled();
    });

    it("logs the reason when triggering", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.trigger("iceFailed");
      await flushMicrotasks();
      expect(h.logs.some((l) => l.includes("iceFailed"))).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The ladder — attempts, backoff, cleanup ordering, onAttempt
  // ═══════════════════════════════════════════════════════════════════════

  describe("the reconnect ladder", () => {
    it("attempts 1..3 with 3s/6s/9s backoff, cleanup() before each backoff, onAttempt(n,3), and setState('failed') only after max", async () => {
      const h = makeHarness({ state: "streaming" });
      // Every attempt's runAttempt succeeds, but the channel never opens —
      // so _waitForDataChannels times out and the ladder must continue.
      h.channels = makeChannels("connecting");

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.state).toBe("reconnecting");

      // ── Attempt 1 ────────────────────────────────────────────────────────
      expect(h.onAttempt).toHaveBeenNthCalledWith(1, 1, RECONNECT_MAX_ATTEMPTS);
      expect(h.cleanup).toHaveBeenCalledTimes(1); // cleanup BEFORE the backoff wait
      expect(h.runAttempt).not.toHaveBeenCalled(); // not yet — still backing off

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 1 - 1);
      expect(h.runAttempt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(h.runAttempt).toHaveBeenCalledTimes(1);

      // Channel never opens → _waitForDataChannels(15s) times out, which
      // immediately loops into attempt 2's onAttempt()/cleanup() (synchronous,
      // no further timer needed) and THEN starts attempt 2's own 6s backoff
      // wait. Advance EXACTLY to the timeout boundary (no overshoot) so
      // attempt 2's backoff has not started ticking within this same window —
      // any slop here would double-count into the next boundary's math since
      // fake-timer advances compound from wherever "now" currently sits.
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS);
      await flushMicrotasks();

      // ── Attempt 2 ────────────────────────────────────────────────────────
      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
      expect(h.cleanup).toHaveBeenCalledTimes(2);
      expect(h.runAttempt).toHaveBeenCalledTimes(1); // attempt 2 hasn't run yet — still backing off
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2 - 1);
      expect(h.runAttempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(h.runAttempt).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS);
      await flushMicrotasks();

      // ── Attempt 3 ────────────────────────────────────────────────────────
      expect(h.onAttempt).toHaveBeenNthCalledWith(3, 3, RECONNECT_MAX_ATTEMPTS);
      expect(h.cleanup).toHaveBeenCalledTimes(3);
      expect(h.runAttempt).toHaveBeenCalledTimes(2); // attempt 3 hasn't run yet — still backing off
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 3 - 1);
      expect(h.runAttempt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(h.runAttempt).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS);
      await flushMicrotasks();

      // Max attempts reached — NOW (and only now) 'failed'.
      expect(h.setState).toHaveBeenCalledWith("failed");
      expect(h.onAttempt).toHaveBeenCalledTimes(3); // never a 4th attempt
      expect(h.runAttempt).toHaveBeenCalledTimes(3);
    });

    it("exact backoff delays are RECONNECT_BASE_DELAY_MS × attempt (3000/6000/9000ms) and are recorded via lastBackoffMs", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();

      expect(h.ctrl.lastBackoffMs).toBe(RECONNECT_BASE_DELAY_MS * 1);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS + 300);
      await flushMicrotasks();

      expect(h.ctrl.lastBackoffMs).toBe(RECONNECT_BASE_DELAY_MS * 2);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS + 300);
      await flushMicrotasks();

      expect(h.ctrl.lastBackoffMs).toBe(RECONNECT_BASE_DELAY_MS * 3);
    });

    it("exposes the current attempt count via the attempts getter, incrementing per iteration", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");
      expect(h.ctrl.attempts).toBe(0);

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.ctrl.attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS + 300);
      await flushMicrotasks();
      expect(h.ctrl.attempts).toBe(2);
    });

    it("a second concurrent trigger() while already reconnecting is a no-op (prevents a duplicate ladder cycle)", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.state).toBe("reconnecting");

      h.cleanup.mockClear();
      h.onAttempt.mockClear();
      // Second trigger — guarded by the state check (state is now "reconnecting").
      h.ctrl.trigger("iceFailed");
      await flushMicrotasks();
      expect(h.cleanup).not.toHaveBeenCalled();
      expect(h.onAttempt).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Abort windows — getState() read FRESH after every await
  // ═══════════════════════════════════════════════════════════════════════

  describe("abort windows (fresh getState() reads)", () => {
    it("aborts mid-backoff when state flips to 'idle' (user disconnect) WITHOUT calling setState('failed')", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.state).toBe("reconnecting");

      h.setState.mockClear();
      // Simulate disconnect() flipping state mid-backoff (NOT via the
      // controller's own setState — an external actor, exactly like the
      // manager's disconnect() does).
      h.state = "idle";

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100);
      await flushMicrotasks();

      // The loop's abort-check must observe the externally-flipped state and
      // return WITHOUT ever calling setState("failed").
      expect(h.setState).not.toHaveBeenCalledWith("failed");
      expect(h.runAttempt).not.toHaveBeenCalled(); // never got past the backoff
    });

    it("aborts mid-backoff when state flips to 'disconnected' WITHOUT calling setState('failed')", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();

      h.setState.mockClear();
      h.state = "idle"; // SessionState has no literal "disconnected"; idle is the
      // real-world equivalent of "no longer reconnecting" used by disconnect().

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100);
      await flushMicrotasks();

      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });

    it("aborts AFTER a successful runAttempt() if state flipped during the await, calling cleanup() again and NOT waiting for data channels", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");

      // runAttempt() itself flips state away from "reconnecting" while it is
      // in flight — exactly like a user calling disconnect() concurrently
      // with _createSessionAndStream() awaiting.
      h.runAttempt.mockImplementation(async () => {
        h.state = "idle";
      });

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      expect(h.state).toBe("reconnecting");

      h.setState.mockClear();
      h.cleanup.mockClear();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      expect(h.runAttempt).toHaveBeenCalledTimes(1);
      // Post-attempt abort-check: cleanup() runs AGAIN (post-attempt teardown)
      // and the loop returns without ever polling for data channels or
      // calling setState("failed").
      expect(h.cleanup).toHaveBeenCalledTimes(1);
      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });

    it("a runAttempt() rejection is caught, logged, and the ladder continues to the next attempt (not an abort)", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");
      h.runAttempt.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      expect(h.runAttempt).toHaveBeenCalledTimes(1);
      expect(h.logs.some((l) => l.includes("boom"))).toBe(true);

      // Loop continues to attempt 2 rather than aborting or failing early.
      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _waitForDataChannels — polling via thunks, success path
  // ═══════════════════════════════════════════════════════════════════════

  describe("waiting for data channels", () => {
    it("resolves immediately (no poll) if the message channel is ALREADY open when runAttempt() resolves", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("open"); // already open before the attempt even starts

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      // Success — resets attempts to 0, no setState("failed").
      expect(h.ctrl.attempts).toBe(0);
      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });

    it("polls getChannels()/getPc() every 250ms and resolves true the tick the message channel opens", async () => {
      const h = makeHarness({ state: "streaming" });
      const channels = makeChannels("connecting");
      h.channels = channels;

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      // Still polling — not yet resolved.
      await vi.advanceTimersByTimeAsync(500);
      expect(h.ctrl.attempts).toBe(1); // not yet reset — still mid-attempt

      // Flip the SAME channels object's message channel open (mirrors
      // simulateOpen() in the manager harness) and cross the next 250ms tick.
      (channels.message as unknown as { readyState: RTCDataChannelState }).readyState = "open";
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      expect(h.ctrl.attempts).toBe(0); // reset on success
    });

    it("reads getChannels() and getPc() FRESH on every 250ms poll tick — a channel swap mid-poll (fresh session object) is observed", async () => {
      const h = makeHarness({ state: "streaming" });
      const staleChannels = makeChannels("connecting");
      h.channels = staleChannels;

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(250); // one poll tick against staleChannels

      // Swap in a freshly-opened channel set — the poll must observe THIS,
      // not a value captured back when the attempt started (proves the poll
      // calls getChannels() as a thunk, not a captured parameter).
      h.channels = makeChannels("open");
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      expect(h.ctrl.attempts).toBe(0); // resolved true off the fresh getChannels() read
    });

    it("bails false (and the ladder continues) if getPc() becomes null mid-poll", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      h.pc = null; // cleanup() nulled the pc field mid-poll
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      // _waitForDataChannels resolved false — the ladder logs the timeout-ish
      // failure and moves on to attempt 2 (not treated as a hard abort).
      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
    });

    it("bails false (and the ladder continues) if getPc().connectionState becomes 'failed' mid-poll", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      h.pc!.connectionState = "failed";
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
    });

    it("times out at WAIT_FOR_DATA_CHANNELS_MS if the channel never opens and getPc() stays healthy", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS - 100);
      expect(h.onAttempt).not.toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();

      expect(h.logs.some((l) => l.includes(`${WAIT_FOR_DATA_CHANNELS_MS / 1000}s`))).toBe(true);
      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Success — reset attempts to 0
  // ═══════════════════════════════════════════════════════════════════════

  describe("success", () => {
    it("resets attempts to 0 after a mid-ladder success (attempt 2 succeeds after attempt 1 failed)", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting"); // attempt 1: never opens → timeout

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      // Advance EXACTLY to attempt 1's channel-wait timeout boundary — no
      // overshoot — so attempt 2's own 6s backoff has not started ticking
      // within this same window (it loops in synchronously at the timeout,
      // then awaits its own fresh setTimeout starting from THIS instant).
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS);
      await flushMicrotasks();
      // Attempt 1 has just timed out and the loop has ALREADY advanced
      // synchronously into attempt 2 (increment + onAttempt(2,3) happen at
      // the top of the next iteration, before attempt 2's own cleanup/backoff)
      // — so `attempts` legitimately reads 2 here, not 1.
      expect(h.ctrl.attempts).toBe(2);
      expect(h.onAttempt).toHaveBeenNthCalledWith(2, 2, RECONNECT_MAX_ATTEMPTS);

      // Attempt 2: open the channel before the attempt's wait begins.
      h.channels = makeChannels("open");
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
      await flushMicrotasks();

      // Attempt 2's _waitForDataChannels resolves true (channel already
      // open) — success resets the counter to 0.
      expect(h.ctrl.attempts).toBe(0);
      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });

    it("does NOT itself transition state away from 'reconnecting' on success — only resets the counter (mirrors the monolith)", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("open");

      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();

      expect(h.ctrl.attempts).toBe(0);
      // setState was called with "reconnecting" (entry) but never anything
      // else — leaving "reconnecting" is the manager/MediaMonitor's job.
      expect(h.setState).toHaveBeenCalledWith("reconnecting");
      expect(h.setState).not.toHaveBeenCalledWith("streaming");
      expect(h.setState).not.toHaveBeenCalledWith("failed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // resetAttempts()
  // ═══════════════════════════════════════════════════════════════════════

  describe("resetAttempts()", () => {
    it("zeroes the attempt counter (called by connect())", async () => {
      const h = makeHarness({ state: "streaming" });
      h.channels = makeChannels("connecting");
      h.ctrl.trigger("connectionStateFailed");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      expect(h.ctrl.attempts).toBe(1);

      h.ctrl.resetAttempts();
      expect(h.ctrl.attempts).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // armDisconnectGrace() / clearDisconnectGrace()
  // ═══════════════════════════════════════════════════════════════════════

  describe("armDisconnectGrace()", () => {
    it("fires trigger() after DISCONNECT_GRACE_MS only if the predicate is STILL true at that moment", async () => {
      const h = makeHarness({ state: "streaming" });
      let stillDisconnected = true;
      h.ctrl.armDisconnectGrace(() => stillDisconnected);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 100);
      expect(h.state).not.toBe("reconnecting"); // not yet — grace hasn't elapsed

      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(h.state).toBe("reconnecting"); // predicate true → trigger() fired
    });

    it("reports 'connectionStateDisconnected' via onTriggerAccepted() when the grace expiry fires — the host's lastTriggerReason must be recorded for THIS internal auto-trigger too, not just externally-called trigger()s", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.armDisconnectGrace(() => true);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 100);
      await flushMicrotasks();

      expect(h.onTriggerAccepted).toHaveBeenCalledWith("connectionStateDisconnected");
    });

    it("does NOT fire trigger() if the predicate is false when the grace delay elapses (recovered within the window)", async () => {
      const h = makeHarness({ state: "streaming" });
      const stillDisconnected = () => false; // e.g. pc.connectionState flipped back to "connected"
      h.ctrl.armDisconnectGrace(stillDisconnected);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 100);
      await flushMicrotasks();

      expect(h.state).toBe("streaming"); // unchanged — no reconnect triggered
      expect(h.runAttempt).not.toHaveBeenCalled();
    });

    it("evaluates the predicate at fire time, not arm time (a predicate closing over a mutable ref reflects its LATEST value)", async () => {
      const h = makeHarness({ state: "streaming" });
      let disconnected = true;
      h.ctrl.armDisconnectGrace(() => disconnected);

      // Recovers well before the grace timer fires.
      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2);
      disconnected = false;

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2 + 100);
      await flushMicrotasks();

      expect(h.state).toBe("streaming");
      expect(h.runAttempt).not.toHaveBeenCalled();
    });

    it("clearDisconnectGrace() cancels a pending grace timer so it never fires", async () => {
      const h = makeHarness({ state: "streaming" });
      h.ctrl.armDisconnectGrace(() => true);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 100);
      h.ctrl.clearDisconnectGrace();

      await vi.advanceTimersByTimeAsync(1_000); // well past the original DISCONNECT_GRACE_MS mark
      await flushMicrotasks();

      expect(h.state).toBe("streaming");
      expect(h.runAttempt).not.toHaveBeenCalled();
    });

    it("clearDisconnectGrace() is a safe no-op when no grace timer is pending", () => {
      const h = makeHarness({ state: "streaming" });
      expect(() => h.ctrl.clearDisconnectGrace()).not.toThrow();
    });

    it("re-arming replaces any previously pending grace timer (only the latest predicate/delay applies)", async () => {
      const h = makeHarness({ state: "streaming" });
      // First arm — would fire true, but gets replaced before it can.
      h.ctrl.armDisconnectGrace(() => true);
      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2);

      // Second arm resets the DISCONNECT_GRACE_MS window from THIS point and
      // its own predicate is false.
      h.ctrl.armDisconnectGrace(() => false);
      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 100);
      await flushMicrotasks();

      expect(h.state).toBe("streaming");
      expect(h.runAttempt).not.toHaveBeenCalled();
    });
  });
});
