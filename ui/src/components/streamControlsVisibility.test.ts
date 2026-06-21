import { describe, expect, it } from "vitest";
import { CONTROLS_AUTO_HIDE_MS, shouldAutoHideControls } from "./streamControlsVisibility.js";

describe("streamControlsVisibility", () => {
  it("auto-hides while streaming in player mode", () => {
    expect(shouldAutoHideControls("streaming", false)).toBe(true);
  });

  it("auto-hides in immersive mode even before streaming", () => {
    expect(shouldAutoHideControls("connecting", true)).toBe(true);
  });

  it("keeps controls visible when not streaming and not immersive", () => {
    expect(shouldAutoHideControls("connecting", false)).toBe(false);
  });

  it("keeps helper delay value in sync with controls behavior", () => {
    expect(CONTROLS_AUTO_HIDE_MS).toBeGreaterThan(0);
  });
});
