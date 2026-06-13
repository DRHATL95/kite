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
