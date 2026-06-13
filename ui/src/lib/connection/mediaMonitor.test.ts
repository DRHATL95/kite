import { describe, it, expect, vi } from "vitest";
import { MediaMonitor, type MediaMonitorCallbacks } from "./mediaMonitor.js";

function makeCallbacks(): MediaMonitorCallbacks & {
  starts: number;
  nudges: Array<"starting" | "stalled">;
  recovers: Array<"mediaNeverStarted" | "mediaStalled">;
} {
  const rec = {
    starts: 0,
    nudges: [] as Array<"starting" | "stalled">,
    recovers: [] as Array<"mediaNeverStarted" | "mediaStalled">,
    onMediaStart: () => { rec.starts++; },
    onNudge: (c: "starting" | "stalled") => { rec.nudges.push(c); },
    onRecover: (r: "mediaNeverStarted" | "mediaStalled") => { rec.recovers.push(r); },
  };
  return rec;
}

describe("MediaMonitor — first frame", () => {
  it("fires onMediaStart exactly once when frames start decoding", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 1_000);   // no frames yet
    expect(cb.starts).toBe(0);

    m.tick(3, 2_000);   // first decoded frames
    expect(cb.starts).toBe(1);

    m.tick(10, 3_000);  // still flowing — no second start
    expect(cb.starts).toBe(1);
    expect(cb.recovers).toEqual([]);
    expect(cb.nudges).toEqual([]);
  });

  it("is a no-op before arm()", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.tick(5, 1_000);
    expect(cb.starts).toBe(0);
    expect(cb.nudges).toEqual([]);
    expect(cb.recovers).toEqual([]);
  });
});

describe("MediaMonitor — start escalation", () => {
  it("nudges at 4s and 7s, then reconnects at 10s when no frames arrive", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 1_000);
    m.tick(0, 3_000);
    expect(cb.nudges).toEqual([]);

    m.tick(0, 4_000);                       // nudge #1
    expect(cb.nudges).toEqual(["starting"]);

    m.tick(0, 5_000);                       // no extra nudge
    expect(cb.nudges).toEqual(["starting"]);

    m.tick(0, 7_000);                       // nudge #2
    expect(cb.nudges).toEqual(["starting", "starting"]);

    m.tick(0, 9_000);
    expect(cb.recovers).toEqual([]);

    m.tick(0, 10_000);                      // reconnect
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);

    m.tick(0, 11_000);                      // idle after recover — no repeats
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);
  });

  it("treats null framesDecoded as no-progress (same escalation)", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(null, 4_000);
    m.tick(null, 7_000);
    m.tick(null, 10_000);

    expect(cb.nudges).toEqual(["starting", "starting"]);
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);
    expect(cb.starts).toBe(0);
  });

  it("starts streaming if frames arrive before the timeout (no recover)", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 4_000);     // nudge #1
    m.tick(2, 5_000);     // frames! -> streaming
    m.tick(8, 11_000);    // well past 10s but flowing

    expect(cb.starts).toBe(1);
    expect(cb.recovers).toEqual([]);
  });
});
