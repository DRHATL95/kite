import { describe, it, expect } from "vitest";
import { detectActiveSource, type GamepadSnapshot } from "./gamepadCapture.js";

const snap = (over: Partial<GamepadSnapshot> = {}): GamepadSnapshot => ({
  buttons: over.buttons ?? Array.from({ length: 17 }, () => 0),
  axes: over.axes ?? [0, 0, 0, 0],
});

describe("detectActiveSource", () => {
  it("returns null when nothing changed", () => {
    expect(detectActiveSource(snap(), snap())).toBeNull();
  });
  it("captures a newly-pressed button (buttons before axes)", () => {
    const now = snap({ buttons: (() => { const b = Array.from({ length: 17 }, () => 0); b[3] = 1; return b; })() });
    expect(detectActiveSource(now, snap())).toEqual({ kind: "button", index: 3 });
  });
  it("ignores a button already active in the baseline", () => {
    const held = (() => { const b = Array.from({ length: 17 }, () => 0); b[3] = 1; return b; })();
    expect(detectActiveSource(snap({ buttons: held }), snap({ buttons: held }))).toBeNull();
  });
  it("captures a newly-deflected axis with the correct sign", () => {
    expect(detectActiveSource(snap({ axes: [0, -0.9, 0, 0] }), snap())).toEqual({ kind: "axis", axis: 1, sign: -1 });
    expect(detectActiveSource(snap({ axes: [0.8, 0, 0, 0] }), snap())).toEqual({ kind: "axis", axis: 0, sign: 1 });
  });
  it("respects the 0.5 boundary (>= active)", () => {
    const b = (() => { const a = Array.from({ length: 17 }, () => 0); a[0] = 0.5; return a; })();
    expect(detectActiveSource(snap({ buttons: b }), snap())).toEqual({ kind: "button", index: 0 });
    const b2 = (() => { const a = Array.from({ length: 17 }, () => 0); a[0] = 0.49; return a; })();
    expect(detectActiveSource(snap({ buttons: b2 }), snap())).toBeNull();
  });
});
