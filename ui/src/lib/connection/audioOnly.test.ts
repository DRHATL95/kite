import { describe, it, expect } from "vitest";
import { videoTransceiverDirection, tracksReadyToStream } from "./audioOnly.js";

describe("videoTransceiverDirection", () => {
  it("declines video (inactive) when audio-only", () => {
    expect(videoTransceiverDirection(true)).toBe("inactive");
  });
  it("receives video (recvonly) normally", () => {
    expect(videoTransceiverDirection(false)).toBe("recvonly");
  });
});

describe("tracksReadyToStream", () => {
  it("normal mode needs BOTH video and audio", () => {
    expect(tracksReadyToStream(false, true, true)).toBe(true);
    expect(tracksReadyToStream(false, false, true)).toBe(false);
    expect(tracksReadyToStream(false, true, false)).toBe(false);
  });
  it("audio-only needs only audio (video never arrives)", () => {
    expect(tracksReadyToStream(true, false, true)).toBe(true);
    expect(tracksReadyToStream(true, false, false)).toBe(false);
  });
});
