/**
 * nativeStats.test.ts — the native StatsSnapshot → DiagnosticsSnapshot mapping.
 */

import { describe, expect, it } from "vitest";

import { completeSnapshot, mapStats } from "./nativeStats.js";

describe("mapStats", () => {
  it("maps the four native counters onto the matching DiagnosticsSnapshot fields", () => {
    const m = mapStats({
      bitrateKbps: 1000,
      fps: 60,
      framesDecoded: 120,
      freezeCount: 1,
    });
    expect(m.inboundVideoKbps).toBe(1000);
    expect(m.fps).toBe(60);
    expect(m.framesDecoded).toBe(120);
    expect(m.freezeCount).toBe(1);
  });
});

describe("completeSnapshot", () => {
  it("sets every required field and applies the overlay", () => {
    const s = completeSnapshot(
      mapStats({ bitrateKbps: 800, fps: 30, framesDecoded: 50, freezeCount: 0 }),
    );
    // overlay applied
    expect(s.inboundVideoKbps).toBe(800);
    expect(s.fps).toBe(30);
    expect(s.framesDecoded).toBe(50);
    expect(s.freezeCount).toBe(0);
    // required (non-nullable) fields all present
    expect(typeof s.capturedAt).toBe("number");
    expect(s.iceConnectionState).toBe("connected");
    expect(s.iceGatheringState).toBe("complete");
    expect(s.connectionState).toBe("connected");
    expect(s.source).toBe("unknown");
    expect(s.state).toBe("streaming");
    expect(s.activeKeepalive).toBe("none");
    expect(s.channels).toEqual([]);
    expect(s.currentAttempt).toBe(0);
    expect(s.maxAttempts).toBe(3);
    // a couple of nullable fields default to null (not undefined)
    expect(s.rttMs).toBeNull();
    expect(s.packetsLost).toBeNull();
    expect(s.consoleName).toBeNull();
  });

  it("lets the overlay override baseline fields", () => {
    const s = completeSnapshot({ state: "reconnecting", currentAttempt: 2 });
    expect(s.state).toBe("reconnecting");
    expect(s.currentAttempt).toBe(2);
    // untouched required field keeps its baseline
    expect(s.maxAttempts).toBe(3);
  });
});
