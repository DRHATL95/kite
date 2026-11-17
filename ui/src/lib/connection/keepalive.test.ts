/**
 * keepalive.test.ts — TDD for KeepaliveController (Task 2 of the
 * ConnectionManager decomposition, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md).
 *
 * Pins the behaviour extracted verbatim from ConnectionManager's
 * _startApiKeepalive/_stopApiKeepalive/_stopAllKeepalives/_sendIdleKeepalive
 * (ConnectionManager.ts:941-1049) plus the onIdleWarning reaction inline in
 * the message-channel callback (ConnectionManager.ts:498-512). Every
 * assertion here is cross-checked against ConnectionManager.test.ts Groups 3
 * ("keepalive stop rules") and 4 ("idle warning micro-pulse"), which exercise
 * the identical behaviour through the full manager and must stay green
 * unmodified — this file is the focused, fake-timer unit-test counterpart.
 *
 * Mocking recipe copied from NativeConnection.test.ts / ConnectionManager.test.ts:
 * `vi.mock("../ipc/commands.js")` BEFORE importing KeepaliveController,
 * `vi.useFakeTimers()` in beforeEach, `vi.useRealTimers()` in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the IPC commands module before importing KeepaliveController ──────
vi.mock("../ipc/commands.js", () => ({
  sendSessionKeepalive: vi.fn(),
}));

// ── Import AFTER mock registration ──────────────────────────────────────────
import * as commands from "../ipc/commands.js";
import { KeepaliveController, type KeepaliveDeps } from "./keepalive.js";
import {
  API_KEEPALIVE_MS,
  IDLE_KEEPALIVE_INTERVAL_MS,
  IDLE_PULSE_LEFT_THUMB_X,
  IDLE_PULSE_RECENTER_MS,
  REPORT_TYPE_GAMEPAD,
} from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake input channel (minimal duck-typed RTCDataChannel)
// ─────────────────────────────────────────────────────────────────────────────

class FakeInputChannel {
  readyState: RTCDataChannelState = "open";
  sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps harness
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  deps: KeepaliveDeps;
  ctrl: KeepaliveController;
  logs: string[];
  statsChangedCount: number;
  sessionPath: string | null;
  inputCh: FakeInputChannel | null;
  streaming: boolean;
}

function makeHarness(overrides: Partial<{ sessionPath: string | null; inputCh: FakeInputChannel | null; streaming: boolean }> = {}): Harness {
  const logs: string[] = [];
  // NOTE: use `"key" in overrides` rather than `??` — an override explicitly
  // passing `null` (e.g. `{ sessionPath: null }`) must be honored, but `??`
  // cannot distinguish "explicitly null" from "key omitted" since both are
  // nullish. `in` checks presence, so an explicit `null` sticks.
  const h: Harness = {
    deps: null as unknown as KeepaliveDeps,
    ctrl: null as unknown as KeepaliveController,
    logs,
    statsChangedCount: 0,
    sessionPath: "sessionPath" in overrides ? overrides.sessionPath! : "/v5/sessions/home/server-abc/session-1",
    inputCh: "inputCh" in overrides ? overrides.inputCh! : new FakeInputChannel(),
    streaming: overrides.streaming ?? false,
  };
  h.deps = {
    getSessionPath: () => h.sessionPath,
    getInputChannel: () => (h.inputCh as unknown as RTCDataChannel | null),
    isStreaming: () => h.streaming,
    log: (msg: string) => logs.push(msg),
    onStatsChanged: () => {
      h.statsChangedCount++;
    },
  };
  h.ctrl = new KeepaliveController(h.deps);
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite setup
// ─────────────────────────────────────────────────────────────────────────────

describe("KeepaliveController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(commands.sendSessionKeepalive).mockResolvedValue("200");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // startApi() — cadence
  // ═══════════════════════════════════════════════════════════════════════

  describe("startApi()", () => {
    it("arms a 30s interval with NO immediate send; first send fires at exactly +30s reading getSessionPath() at send time", async () => {
      const h = makeHarness();
      h.ctrl.startApi();

      // No immediate send.
      expect(commands.sendSessionKeepalive).not.toHaveBeenCalled();

      // Still nothing just short of the 30s mark.
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS - 100);
      expect(commands.sendSessionKeepalive).not.toHaveBeenCalled();

      // Crossing the 30s mark fires exactly one send, using the CURRENT
      // getSessionPath() (thunk, not a captured value at startApi() time).
      await vi.advanceTimersByTimeAsync(100);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledWith(
        "/v5/sessions/home/server-abc/session-1",
      );
    });

    it("reads getSessionPath() freshly at each tick (late-bound thunk, not captured at arm time)", async () => {
      const h = makeHarness({ sessionPath: "/path/A" });
      h.ctrl.startApi();

      // Mutate the underlying session path AFTER arming but BEFORE the first tick.
      h.sessionPath = "/path/B";

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledWith("/path/B");
    });

    it("is idempotent — calling startApi() twice does not arm a second interval", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      h.ctrl.startApi(); // second call must be a no-op

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
    });

    it("does nothing if getSessionPath() returns null at arm time", async () => {
      const h = makeHarness({ sessionPath: null });
      h.ctrl.startApi();

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS * 2);
      expect(commands.sendSessionKeepalive).not.toHaveBeenCalled();
    });

    it("mode is 'api' once armed, 'none' before", () => {
      const h = makeHarness();
      expect(h.ctrl.mode).toBe("none");
      h.ctrl.startApi();
      expect(h.ctrl.mode).toBe("api");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // startApi() — stop rules (mirrors ConnectionManager.test.ts Group 3)
  // ═══════════════════════════════════════════════════════════════════════

  describe("startApi() stop rules", () => {
    it("stops the interval when sendSessionKeepalive rejects with a '400' error", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(new Error("HTTP 400 Bad Request"));

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1); // no further sends
      expect(h.ctrl.mode).toBe("none");
    });

    it("stops the interval when sendSessionKeepalive rejects with 'SessionInUnexpectedState'", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(
        new Error("SessionInUnexpectedState: already streaming"),
      );

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
      expect(h.ctrl.mode).toBe("none");
    });

    it("stops the interval once isStreaming() === true, even on an unrelated rejection", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      h.streaming = true; // flips AFTER arming — read fresh via the thunk each tick
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(
        new Error("unrelated transient network error"),
      );

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1); // stopped
      expect(h.ctrl.mode).toBe("none");
    });

    it("keeps retrying (does NOT stop) on a plain transient failure while not streaming", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(new Error("network blip"));

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(3);
      expect(h.ctrl.mode).toBe("api"); // still armed
    });

    it("calls onStatsChanged() and records lastKeepaliveAt on a successful send", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      const before = h.statsChangedCount;

      const t0 = Date.now();
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);

      expect(h.statsChangedCount).toBeGreaterThan(before);
      expect(h.ctrl.lastKeepaliveAt).not.toBeNull();
      expect(h.ctrl.lastKeepaliveAt).toBeGreaterThanOrEqual(t0);
    });

    it("stops silently on the session-rejected path — the interval is cleared without extra onStatsChanged() firing for the failure itself", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(new Error("400"));

      const before = h.statsChangedCount;
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      // onStatsChanged() is only wired to the SUCCESS path (replacing the
      // manager's _pushManagerStats() call at the "API keepalive OK" site) —
      // the catch-branch never calls it.
      expect(h.statsChangedCount).toBe(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // onIdleWarning() — byte-level pulse (mirrors ConnectionManager.test.ts Group 4)
  // ═══════════════════════════════════════════════════════════════════════

  describe("onIdleWarning()", () => {
    it("sends an immediate 38-byte pulse with LeftThumbX=4096 at byte offset 18, then a recenter frame at +32ms, and arms the 30s interval exactly once", async () => {
      const h = makeHarness();
      const inputCh = h.inputCh!;

      h.ctrl.onIdleWarning(45);

      // Immediate pulse — sent synchronously inside onIdleWarning.
      expect(inputCh.sent.length).toBe(1);
      const pulse = inputCh.sent[0]!;
      expect(pulse.length).toBe(38);

      const pulseView = new DataView(pulse.buffer, pulse.byteOffset, pulse.byteLength);
      expect(pulseView.getUint16(0, true)).toBe(REPORT_TYPE_GAMEPAD);
      expect(pulseView.getUint8(14)).toBe(1); // frameCount
      expect(pulseView.getUint8(15)).toBe(0); // gamepadIndex
      expect(pulseView.getUint16(16, true)).toBe(0); // buttons: none
      expect(pulseView.getInt16(18, true)).toBe(IDLE_PULSE_LEFT_THUMB_X); // LeftThumbX
      expect(pulseView.getInt16(18, true)).toBe(4096);
      expect(pulseView.getInt16(20, true)).toBe(0); // LeftThumbY
      expect(pulseView.getInt16(22, true)).toBe(0); // RightThumbX
      expect(pulseView.getInt16(24, true)).toBe(0); // RightThumbY
      expect(pulseView.getUint16(26, true)).toBe(0); // LeftTrigger
      expect(pulseView.getUint16(28, true)).toBe(0); // RightTrigger
      expect(pulseView.getUint32(30, true)).toBe(1); // PhysicalPhysicality LE
      expect(pulseView.getUint32(34, false)).toBe(1); // VirtualPhysicality BE

      // Records the value.
      expect(h.ctrl.lastIdleWarningSecondsUntilKick).toBe(45);

      // Recenter frame at +32ms (IDLE_PULSE_RECENTER_MS) — all-zero after header.
      expect(inputCh.sent.length).toBe(1);
      await vi.advanceTimersByTimeAsync(IDLE_PULSE_RECENTER_MS);
      expect(inputCh.sent.length).toBe(2);
      const recenter = inputCh.sent[1]!;
      expect(recenter.length).toBe(38);
      const recenterView = new DataView(recenter.buffer, recenter.byteOffset, recenter.byteLength);
      expect(recenterView.getUint16(0, true)).toBe(REPORT_TYPE_GAMEPAD);
      expect(recenterView.getUint8(14)).toBe(1);
      expect(recenterView.getInt16(18, true)).toBe(0); // LeftThumbX recentred to 0
      expect(recenterView.getUint32(30, true)).toBe(1); // PhysicalPhysicality LE
      expect(recenterView.getUint32(34, false)).toBe(1); // VirtualPhysicality BE

      // The periodic 30s idle-keepalive interval is armed — advancing by
      // IDLE_KEEPALIVE_INTERVAL_MS sends exactly one more pulse (+ its own
      // +32ms recenter, since 32ms << 30s).
      await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
      expect(inputCh.sent.length).toBe(4);
    });

    it("arms the periodic interval exactly once across repeated warnings (does NOT stack a second interval)", async () => {
      const h = makeHarness();
      const inputCh = h.inputCh!;

      h.ctrl.onIdleWarning(45);
      await vi.advanceTimersByTimeAsync(IDLE_PULSE_RECENTER_MS);
      expect(inputCh.sent.length).toBe(2); // pulse + recenter

      // A second idle-warning while the interval is already armed must NOT
      // create a SECOND interval, but it DOES still send its own immediate
      // pulse (+ own +32ms recenter) — onIdleWarning always micro-pulses.
      h.ctrl.onIdleWarning(30);
      expect(inputCh.sent.length).toBe(3); // + immediate pulse
      expect(h.ctrl.lastIdleWarningSecondsUntilKick).toBe(30);
      const countAfterSecondWarning = inputCh.sent.length;

      await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
      // Within this 30s window: (a) the second warning's own pending +32ms
      // recenter fires (+1), (b) the ALREADY-ARMED periodic interval fires
      // once more at +30s (+1 pulse), and (c) THAT pulse's own +32ms recenter
      // also falls inside the same 30s window (+1) — so +3 total. A SECOND
      // interval would show +4 instead.
      expect(inputCh.sent.length).toBe(countAfterSecondWarning + 3);
    });

    it("does nothing if the input channel is null", () => {
      const h = makeHarness({ inputCh: null });
      expect(() => h.ctrl.onIdleWarning(45)).not.toThrow();
      // Still records the value even though no channel exists to send on —
      // matches the manager's `this._lastIdleWarningSecondsUntilKick =
      // secondsUntilKick` assignment happening BEFORE the channel-readyState
      // guard inside _sendIdleKeepalive.
      expect(h.ctrl.lastIdleWarningSecondsUntilKick).toBe(45);
    });

    it("does nothing if the input channel is not 'open'", () => {
      const inputCh = new FakeInputChannel();
      inputCh.readyState = "connecting";
      const h = makeHarness({ inputCh });
      h.ctrl.onIdleWarning(45);
      expect(inputCh.sent.length).toBe(0);
    });

    it("reads getInputChannel() freshly at send time (thunk, not captured)", () => {
      const h = makeHarness({ inputCh: null });
      const laterCh = new FakeInputChannel();
      // Swap in a channel AFTER construction but the thunk should still see it.
      h.inputCh = laterCh;
      h.ctrl.onIdleWarning(45);
      expect(laterCh.sent.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // stopAll() — never-reset quirks
  // ═══════════════════════════════════════════════════════════════════════

  describe("stopAll()", () => {
    it("clears both the API and idle intervals", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      h.ctrl.onIdleWarning(45);
      await vi.advanceTimersByTimeAsync(IDLE_PULSE_RECENTER_MS);

      expect(h.ctrl.mode).toBe("api"); // api takes precedence per buildManagerStats ordering
      h.ctrl.stopAll();
      expect(h.ctrl.mode).toBe("none");

      const sentCountAtStop = h.inputCh!.sent.length;
      const apiCallsAtStop = vi.mocked(commands.sendSessionKeepalive).mock.calls.length;

      // Neither timer fires again after stopAll().
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS * 2);
      expect(vi.mocked(commands.sendSessionKeepalive).mock.calls.length).toBe(apiCallsAtStop);
      expect(h.inputCh!.sent.length).toBe(sentCountAtStop);
    });

    it("does NOT reset lastKeepaliveAt (never-reset quirk)", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      const recordedAt = h.ctrl.lastKeepaliveAt;
      expect(recordedAt).not.toBeNull();

      h.ctrl.stopAll();
      expect(h.ctrl.lastKeepaliveAt).toBe(recordedAt); // untouched by stopAll()
    });

    it("does NOT reset lastIdleWarningSecondsUntilKick (never-reset quirk)", () => {
      const h = makeHarness();
      h.ctrl.onIdleWarning(45);
      expect(h.ctrl.lastIdleWarningSecondsUntilKick).toBe(45);

      h.ctrl.stopAll();
      expect(h.ctrl.lastIdleWarningSecondsUntilKick).toBe(45); // untouched by stopAll()
    });

    it("is idempotent — calling stopAll() when nothing is armed does not throw", () => {
      const h = makeHarness();
      expect(() => h.ctrl.stopAll()).not.toThrow();
      expect(h.ctrl.mode).toBe("none");
    });

    it("allows startApi() to re-arm cleanly after stopAll()", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      h.ctrl.stopAll();

      h.ctrl.startApi();
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // resetInputSeq() — kept separate from stopAll()
  // ═══════════════════════════════════════════════════════════════════════

  describe("resetInputSeq()", () => {
    it("zeroes the pulse sequence so the next pulse's sequence number restarts at 0", () => {
      const h = makeHarness();
      h.ctrl.onIdleWarning(45); // sequence 0 (pulse), 1 (recenter, scheduled)
      const firstPulse = h.inputCh!.sent[0]!;
      const firstView = new DataView(firstPulse.buffer, firstPulse.byteOffset, firstPulse.byteLength);
      expect(firstView.getUint32(2, true)).toBe(0);

      h.ctrl.resetInputSeq();

      const inputCh2 = new FakeInputChannel();
      h.inputCh = inputCh2;
      h.ctrl.onIdleWarning(30);
      const secondPulse = inputCh2.sent[0]!;
      const secondView = new DataView(secondPulse.buffer, secondPulse.byteOffset, secondPulse.byteLength);
      expect(secondView.getUint32(2, true)).toBe(0); // restarted at 0, not continuing from 2
    });

    it("does not clear the armed intervals (kept separate from stopAll())", async () => {
      const h = makeHarness();
      h.ctrl.startApi();
      h.ctrl.resetInputSeq();

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1); // still armed
      expect(h.ctrl.mode).toBe("api");
    });
  });
});
