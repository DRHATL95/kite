import { describe, it, expect } from "vitest";
import { pctToGain, VOLUME_MAX_PCT } from "./streamVolume.js";

describe("streamVolume", () => {
  it("caps the slider at unity (100%)", () => {
    expect(VOLUME_MAX_PCT).toBe(100);
  });

  it("maps percent to a linear gain", () => {
    expect(pctToGain(0)).toBe(0);
    expect(pctToGain(80)).toBeCloseTo(0.8);
    expect(pctToGain(100)).toBe(1);
  });

  it("clamps out-of-range input to [0, 1]", () => {
    expect(pctToGain(150)).toBe(1);
    expect(pctToGain(200)).toBe(1);
    expect(pctToGain(-10)).toBe(0);
  });
});
