import { describe, it, expect } from "vitest";
import { RtpClock } from "./rtpTime.js";

describe("RtpClock", () => {
  it("converts deltas from the first timestamp at the given rate", () => {
    const c = new RtpClock(90000); // video clock
    expect(c.toSeconds(1000)).toBe(0); // first ts = origin
    expect(c.toSeconds(1000 + 90000)).toBeCloseTo(1.0, 6);
  });
  it("handles uint32 wraparound", () => {
    const c = new RtpClock(90000);
    c.toSeconds(0xffffffff - 100); // near max
    expect(c.toSeconds(0x00000000 + 800)).toBeCloseTo((100 + 800 + 1) / 90000, 6);
  });
  it("accumulates monotonically across many steps", () => {
    const c = new RtpClock(48000); // audio clock
    c.toSeconds(5000);
    c.toSeconds(5000 + 48000); // +1.0s
    expect(c.toSeconds(5000 + 96000)).toBeCloseTo(2.0, 6); // +2.0s total
  });
  it("rejects a non-positive rate", () => {
    expect(() => new RtpClock(0)).toThrow();
  });
});
