import { describe, it, expect } from "vitest";
import {
  sliceForClip,
  evictVideo,
  evictAudio,
  type EncodedFrame,
} from "./encodedTapLogic.js";

const vf = (pts: number, key: boolean): EncodedFrame => ({
  bytes: new Uint8Array([key ? 0x65 : 0x61]),
  ptsSec: pts,
  isKeyframe: key,
});
const af = (pts: number): EncodedFrame => ({
  bytes: new Uint8Array([0xff]),
  ptsSec: pts,
  isKeyframe: false,
});

describe("sliceForClip", () => {
  it("starts at the newest keyframe at least retainSec old", () => {
    const video = [vf(0, true), vf(1, false), vf(2, true), vf(3, false), vf(4, false)];
    const audio = [af(0.5), af(2.5), af(3.5)];
    const r = sliceForClip(video, audio, 5, 3); // cutoff = 2 → keyframe at pts=2
    expect(r.startSec).toBe(2);
    expect(r.video[0].ptsSec).toBe(2);
    expect(r.audio.map((a) => a.ptsSec)).toEqual([2.5, 3.5]);
  });
  it("falls back to the earliest keyframe during warm-up", () => {
    const video = [vf(4, true), vf(4.5, false)];
    const r = sliceForClip(video, [], 5, 3);
    expect(r.startSec).toBe(4);
    expect(r.video[0].ptsSec).toBe(4);
  });
  it("returns an empty slice when there is no keyframe", () => {
    const r = sliceForClip([vf(0, false), vf(1, false)], [af(0.5)], 5, 3);
    expect(r.video).toHaveLength(0);
  });
});

describe("evictVideo", () => {
  it("keeps the keyframe preceding the window", () => {
    const video = [vf(0, true), vf(1, false), vf(2, true), vf(3, false)];
    const kept = evictVideo(video, 4, 1.5); // window start ~2.5 → keep from keyframe at 2
    expect(kept[0].ptsSec).toBe(2);
    expect(kept).toHaveLength(2);
  });
  it("does not strand frames when every keyframe is inside the window", () => {
    const video = [vf(3, true), vf(3.5, false)];
    const kept = evictVideo(video, 4, 1.5); // window start 2.5; only keyframe at 3 (inside)
    expect(kept[0].ptsSec).toBe(3);
  });
});

describe("evictAudio", () => {
  it("drops audio older than the retained window", () => {
    const audio = [af(0), af(1), af(2.6), af(3.5)];
    const kept = evictAudio(audio, 4, 1.5); // window start 2.5
    expect(kept.map((a) => a.ptsSec)).toEqual([2.6, 3.5]);
  });
});
