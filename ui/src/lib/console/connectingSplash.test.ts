import { describe, it, expect } from "vitest";
import { connectingSteps, shouldShowSplash } from "./connectingSplash.js";

describe("connectingSteps", () => {
  it("starts with session done, handshake active, video pending", () => {
    expect(connectingSteps({ handshakeComplete: false, videoArrived: false })).toEqual({
      session: "done",
      handshake: "active",
      video: "pending",
    });
  });

  it("advances to video active once the handshake completes", () => {
    expect(connectingSteps({ handshakeComplete: true, videoArrived: false })).toEqual({
      session: "done",
      handshake: "done",
      video: "active",
    });
  });

  it("marks all steps done once video arrives", () => {
    expect(connectingSteps({ handshakeComplete: true, videoArrived: true })).toEqual({
      session: "done",
      handshake: "done",
      video: "done",
    });
  });
});

describe("shouldShowSplash", () => {
  it("hides as soon as the video is playing, regardless of state", () => {
    expect(shouldShowSplash("connecting", true)).toBe(false);
    expect(shouldShowSplash("streaming", true)).toBe(false);
  });

  it("shows while connecting / reconnecting / streaming with no frame yet", () => {
    expect(shouldShowSplash("connecting", false)).toBe(true);
    expect(shouldShowSplash("reconnecting", false)).toBe(true);
    expect(shouldShowSplash("streaming", false)).toBe(true);
  });

  it("never shows when idle or failed", () => {
    expect(shouldShowSplash("idle", false)).toBe(false);
    expect(shouldShowSplash("failed", false)).toBe(false);
  });
});
