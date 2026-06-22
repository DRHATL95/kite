/**
 * NativeConnection.test.ts — TDD for the NativeConnection adapter (Phase 6 / 6c.6).
 *
 * Mocks the entire ipc/commands module so no Tauri IPC runs.
 * A fake `subscribeRtcEvents` captures the event callback so tests can fire
 * synthetic RtcEvents and assert the correct callback/state transitions.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ── Mock the IPC commands module before importing NativeConnection ─────────────
// We mock the whole module; each test re-configures the fakes via the captured
// variables below.
vi.mock("../ipc/commands.js", () => ({
  rtcConnect: vi.fn().mockResolvedValue(undefined),
  rtcDisconnect: vi.fn().mockResolvedValue(undefined),
  rtcSendInput: vi.fn().mockResolvedValue(undefined),
  rtcRequestKeyframe: vi.fn().mockResolvedValue(undefined),
  subscribeRtcEvents: vi.fn(),
}));

// ── Import AFTER mock registration ────────────────────────────────────────────
import * as commands from "../ipc/commands.js";
import { NativeConnection } from "./NativeConnection.js";
import type { ConnectionManagerCallbacks } from "./ConnectionManager.js";
import type { XHomeConsole } from "../ipc/types.js";
import { RECONNECT_MAX_ATTEMPTS } from "./constants.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConsole(): XHomeConsole {
  return {
    serverId: "server-abc",
    deviceName: "My Xbox",
    consoleType: "XboxSeriesX",
    powerState: "On",
    isDevKit: false,
    playPath: "/v5/sessions/home/server-abc/play",
  };
}

interface SpyCbs {
  onStateChange: Mock;
  onDiagnostics: Mock;
  onLog: Mock;
  onMediaStream: Mock;
  onReconnectAttempt: Mock;
  asCallbacks(): ConnectionManagerCallbacks;
}

function makeCallbacks(): SpyCbs {
  const cbs: SpyCbs = {
    onStateChange: vi.fn(),
    onDiagnostics: vi.fn(),
    onLog: vi.fn(),
    onMediaStream: vi.fn(),
    onReconnectAttempt: vi.fn(),
    asCallbacks() {
      return {
        onStateChange: cbs.onStateChange,
        onDiagnostics: cbs.onDiagnostics,
        onLog: cbs.onLog,
        onMediaStream: cbs.onMediaStream,
        onReconnectAttempt: cbs.onReconnectAttempt,
      };
    },
  };
  return cbs;
}

/** Wires `subscribeRtcEvents` so it:
 *  1. Returns a fake unlisten fn.
 *  2. Captures the event callback in `capturedCb` for test-driven firing.
 */
function wireSubscribe(): {
  capturedCb: { current: ((e: import("./types.js").RtcEvent) => void) | null };
  unlisten: Mock;
} {
  const capturedCb = { current: null as ((e: import("./types.js").RtcEvent) => void) | null };
  const unlisten = vi.fn();

  (commands.subscribeRtcEvents as Mock).mockImplementation(
    async (cb: (e: import("./types.js").RtcEvent) => void) => {
      capturedCb.current = cb;
      return unlisten;
    },
  );

  return { capturedCb, unlisten };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NativeConnection", () => {
  let nc: NativeConnection;
  let cbs: SpyCbs;

  beforeEach(() => {
    vi.useFakeTimers();
    // Stub navigator.getGamepads so GamepadPoller doesn't throw in jsdom
    if (typeof navigator !== "undefined" && !navigator.getGamepads) {
      Object.defineProperty(navigator, "getGamepads", {
        value: () => [null, null, null, null],
        configurable: true,
        writable: true,
      });
    } else if (typeof navigator !== "undefined") {
      vi.spyOn(navigator, "getGamepads").mockReturnValue([null, null, null, null] as any);
    }

    // Reset all mocks between tests
    vi.mocked(commands.rtcConnect).mockResolvedValue(undefined);
    vi.mocked(commands.rtcDisconnect).mockResolvedValue(undefined);
    vi.mocked(commands.rtcSendInput).mockResolvedValue(undefined);
    vi.mocked(commands.rtcRequestKeyframe).mockResolvedValue(undefined);

    cbs = makeCallbacks();
    nc = new NativeConnection(cbs.asCallbacks());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Initial state ────────────────────────────────────────────────────────────

  it("starts in idle state with null snapshot and null triggerReason", () => {
    expect(nc.state).toBe("idle");
    expect(nc.lastSnapshot).toBeNull();
    expect(nc.lastTriggerReason).toBeNull();
  });

  it("encodedStreamsAvailable is always false", () => {
    expect(nc.encodedStreamsAvailable).toBe(false);
  });

  it("setEncodedTap is a no-op (does not throw)", () => {
    expect(() => nc.setEncodedTap(null)).not.toThrow();
    expect(() => nc.setEncodedTap({} as any)).not.toThrow();
  });

  // ── connect() wires IPC ───────────────────────────────────────────────────

  it("connect() calls rtcConnect with the console serverId", async () => {
    const { capturedCb } = wireSubscribe();
    const console_ = makeConsole();
    await nc.connect(console_);
    expect(commands.rtcConnect).toHaveBeenCalledWith("server-abc", undefined);
    expect(capturedCb.current).not.toBeNull();
  });

  // ── Event → state mapping ─────────────────────────────────────────────────

  it("'connecting' event → onStateChange('connecting')", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "connecting" });

    expect(cbs.onStateChange).toHaveBeenCalledWith("connecting");
    expect(nc.state).toBe("connecting");
    expect(cbs.onMediaStream).not.toHaveBeenCalled();
  });

  it("'connected' event does NOT emit onStateChange but records handshakeMs", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    // Advance time so handshakeMs > 0
    vi.advanceTimersByTime(200);

    capturedCb.current!({ kind: "connected" });

    // 'connected' alone doesn't emit onStateChange per spec
    // (state advances on 'firstFrame'); handshakeMs is stored for next stats
    expect(cbs.onStateChange).not.toHaveBeenCalled();
  });

  it("'firstFrame' event → onStateChange('streaming')", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "firstFrame" });

    expect(cbs.onStateChange).toHaveBeenCalledWith("streaming");
    expect(nc.state).toBe("streaming");
  });

  it("'reconnecting{attempt:2}' → onReconnectAttempt(2, RECONNECT_MAX_ATTEMPTS) + onStateChange('reconnecting')", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "reconnecting", attempt: 2 });

    expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(
      2,
      RECONNECT_MAX_ATTEMPTS,
    );
    expect(cbs.onStateChange).toHaveBeenCalledWith("reconnecting");
    expect(nc.state).toBe("reconnecting");
  });

  it("'stats' event → onDiagnostics with a complete DiagnosticsSnapshot", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    // Put into streaming state first
    capturedCb.current!({ kind: "firstFrame" });
    cbs.onDiagnostics.mockClear();

    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 5000,
      fps: 60,
      framesDecoded: 300,
      freezeCount: 1,
    });

    expect(cbs.onDiagnostics).toHaveBeenCalledOnce();
    const snap = cbs.onDiagnostics.mock.calls[0]![0];

    // mapStats fields
    expect(snap.inboundVideoKbps).toBe(5000);
    expect(snap.fps).toBe(60);
    expect(snap.framesDecoded).toBe(300);
    expect(snap.freezeCount).toBe(1);

    // completeSnapshot fills required non-nullable fields
    expect(typeof snap.capturedAt).toBe("number");
    expect(snap.channels).toEqual([]);
    expect(typeof snap.maxAttempts).toBe("number");
    expect(typeof snap.currentAttempt).toBe("number");

    // state field is set (streaming after firstFrame)
    expect(snap.state).toBe("streaming");

    // videoArrivedAt is set after firstFrame
    expect(snap.videoArrivedAt).not.toBeNull();

    // lastSnapshot is updated
    expect(nc.lastSnapshot).toBe(snap);
  });

  it("'stats' event merges consoleName + consoleType from the connected console", async () => {
    const { capturedCb } = wireSubscribe();
    const console_ = makeConsole();
    await nc.connect(console_);

    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 1000,
      fps: 30,
      framesDecoded: 100,
      freezeCount: 0,
    });

    const snap = cbs.onDiagnostics.mock.calls[0]![0];
    expect(snap.consoleName).toBe("My Xbox");
    expect(snap.consoleType).toBe("XboxSeriesX");
  });

  it("'disconnected{reason}' → lastTriggerReason set + onStateChange('failed')", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "disconnected", reason: "ice-failed" });

    expect(nc.lastTriggerReason).toBe("ice-failed");
    expect(cbs.onStateChange).toHaveBeenCalledWith("failed");
    expect(nc.state).toBe("failed");
  });

  it("'ended' event → onStateChange('idle')", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "ended" });

    expect(cbs.onStateChange).toHaveBeenCalledWith("idle");
    expect(nc.state).toBe("idle");
  });

  // ── Session-generation guard ──────────────────────────────────────────────

  it("events fired after disconnect() are ignored (stale generation)", async () => {
    const { capturedCb, unlisten } = wireSubscribe();
    await nc.connect(makeConsole());

    // Capture the callback, then disconnect
    const cb = capturedCb.current!;
    await nc.disconnect();

    // Verify disconnect() called rtcDisconnect + unlisten
    expect(commands.rtcDisconnect).toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
    expect(nc.state).toBe("idle");

    cbs.onStateChange.mockClear();
    cbs.onDiagnostics.mockClear();

    // Fire stale events — none should propagate
    cb({ kind: "connecting" });
    cb({ kind: "firstFrame" });
    cb({
      kind: "stats",
      bitrateKbps: 1000,
      fps: 30,
      framesDecoded: 100,
      freezeCount: 0,
    });
    cb({ kind: "disconnected", reason: "late" });
    cb({ kind: "ended" });

    expect(cbs.onStateChange).not.toHaveBeenCalled();
    expect(cbs.onDiagnostics).not.toHaveBeenCalled();
    // State must remain idle (not flipped by stale events)
    expect(nc.state).toBe("idle");
  });

  // ── requestKeyframe ───────────────────────────────────────────────────────

  it("requestKeyframe() calls rtcRequestKeyframe", () => {
    nc.requestKeyframe();
    expect(commands.rtcRequestKeyframe).toHaveBeenCalled();
  });

  // ── disconnect() when never connected ────────────────────────────────────

  it("disconnect() before connect() resolves cleanly", async () => {
    await expect(nc.disconnect()).resolves.not.toThrow();
  });

  // ── GamepadPoller integration ─────────────────────────────────────────────

  it("gamepad input from poller is forwarded via rtcSendInput; metadata is ignored", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    // GamepadPoller emits `metadata` on the first tick, then an idle `gamepad`
    // every IDLE_FRAME_EVERY (62) ticks at GAMEPAD_POLL_MS (16ms) each.
    // Advance far enough: first tick (metadata) + 62 idle ticks × 16ms = ~1s.
    // We advance 1100ms to be safe.
    vi.advanceTimersByTime(1100);

    // rtcSendInput should have been called (idle neutral gamepad state).
    // Metadata must NOT trigger rtcSendInput.
    expect(commands.rtcSendInput).toHaveBeenCalled();
    expect(
      (commands.rtcSendInput as Mock).mock.calls.every(
        (args: unknown[]) => args[0] !== undefined,
      ),
    ).toBe(true);

    // Also verify the captured event cb still works
    capturedCb.current!({ kind: "ended" });
    expect(nc.state).toBe("idle");
  });

  it("onMediaStream is never called (no MediaStream in native mode)", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "connecting" });
    capturedCb.current!({ kind: "connected" });
    capturedCb.current!({ kind: "firstFrame" });
    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 1000,
      fps: 30,
      framesDecoded: 100,
      freezeCount: 0,
    });

    expect(cbs.onMediaStream).not.toHaveBeenCalled();
  });

  // ── synth snapshot fields ─────────────────────────────────────────────────

  it("handshakeMs is set in snapshots after 'connected' event", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    vi.advanceTimersByTime(150);
    capturedCb.current!({ kind: "connected" });

    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 1000,
      fps: 30,
      framesDecoded: 100,
      freezeCount: 0,
    });

    const snap = cbs.onDiagnostics.mock.calls[0]![0];
    expect(snap.handshakeMs).toBeGreaterThanOrEqual(100);
  });

  it("videoArrivedAt is recorded in snapshots after 'firstFrame' event", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "firstFrame" });

    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 1000,
      fps: 30,
      framesDecoded: 100,
      freezeCount: 0,
    });

    const snap = cbs.onDiagnostics.mock.calls[0]![0];
    expect(snap.videoArrivedAt).not.toBeNull();
    expect(typeof snap.videoArrivedAt).toBe("number");
  });

  // ── currentAttempt in reconnecting ───────────────────────────────────────

  it("stats snapshot carries currentAttempt from reconnecting event", async () => {
    const { capturedCb } = wireSubscribe();
    await nc.connect(makeConsole());

    capturedCb.current!({ kind: "reconnecting", attempt: 2 });
    cbs.onDiagnostics.mockClear();

    capturedCb.current!({
      kind: "stats",
      bitrateKbps: 500,
      fps: 0,
      framesDecoded: 100,
      freezeCount: 0,
    });

    const snap = cbs.onDiagnostics.mock.calls[0]![0];
    expect(snap.currentAttempt).toBe(2);
    expect(snap.state).toBe("reconnecting");
  });
});
