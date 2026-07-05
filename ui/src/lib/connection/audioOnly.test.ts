import { describe, it, expect } from "vitest";
import {
  videoTransceiverDirection,
  tracksReadyToStream,
  audioViewActive,
  videoControlsActive,
  setVideoReceiverEnabled,
} from "./audioOnly.js";

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

describe("audioViewActive / videoControlsActive", () => {
  it("audioViewActive is true when audioOnly OR videoHidden", () => {
    expect(audioViewActive(false, false)).toBe(false);
    expect(audioViewActive(true, false)).toBe(true);
    expect(audioViewActive(false, true)).toBe(true);
    expect(audioViewActive(true, true)).toBe(true);
  });
  it("videoControlsActive is true only when neither audioOnly nor videoHidden", () => {
    expect(videoControlsActive(false, false)).toBe(true);
    expect(videoControlsActive(true, false)).toBe(false);
    expect(videoControlsActive(false, true)).toBe(false);
    expect(videoControlsActive(true, true)).toBe(false);
  });
});

describe("setVideoReceiverEnabled", () => {
  it("toggles the video receiver's track.enabled, leaves audio untouched, returns true", () => {
    const v = { track: { kind: "video", enabled: true } };
    const a = { track: { kind: "audio", enabled: true } };
    expect(setVideoReceiverEnabled([a, v], false)).toBe(true);
    expect(v.track.enabled).toBe(false);
    expect(a.track.enabled).toBe(true);
    expect(setVideoReceiverEnabled([a, v], true)).toBe(true);
    expect(v.track.enabled).toBe(true);
  });
  it("returns false and mutates nothing when there is no video receiver", () => {
    const a = { track: { kind: "audio", enabled: true } };
    expect(setVideoReceiverEnabled([a], false)).toBe(false);
    expect(a.track.enabled).toBe(true);
  });
  it("skips receivers with a null track", () => {
    const nullTrack = { track: null };
    const v = { track: { kind: "video", enabled: true } };
    expect(setVideoReceiverEnabled([nullTrack, v], false)).toBe(true);
    expect(v.track.enabled).toBe(false);
  });
});
