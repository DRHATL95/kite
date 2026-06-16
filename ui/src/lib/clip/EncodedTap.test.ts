import { describe, it, expect } from "vitest";
import { EncodedTap } from "./EncodedTap.js";

const keyframe = new Uint8Array([
  0, 0, 0, 1, 0x67, 0x42, 0x00, // SPS (type 7)
  0, 0, 0, 1, 0x68, 0xce, // PPS (type 8)
  0, 0, 0, 1, 0x65, 0x88, // IDR (type 5)
]);
const delta = new Uint8Array([0, 0, 0, 1, 0x41, 0x9b]);
const opus = new Uint8Array([0xfc, 0x01]);

describe("EncodedTap", () => {
  it("buffers, captures SPS/PPS, and assembles a keyframe-aligned clip", () => {
    const tap = new EncodedTap({
      lengthSec: 30,
      videoTrackSettings: { width: 1280, height: 720, frameRate: 60 },
    });
    tap.pushVideo(keyframe, true, 0);
    tap.pushVideo(delta, false, 1500); // +1500/90000 s
    tap.pushAudio(opus, 0);

    const a = tap.assemble(0);
    expect(a).not.toBeNull();
    expect(a!.width).toBe(1280);
    expect(a!.height).toBe(720);
    expect(a!.fpsNum).toBe(60);
    expect(Array.from(a!.sps)).toEqual([0x67, 0x42, 0x00]);
    expect(Array.from(a!.pps)).toEqual([0x68, 0xce]);
    expect(a!.video).toHaveLength(2);
    expect(a!.video[0].isKeyframe).toBe(true);
    expect(a!.audio).toHaveLength(1);
    expect(a!.startSec).toBe(0);
  });

  it("returns null before any keyframe is buffered", () => {
    const tap = new EncodedTap({ lengthSec: 30 });
    tap.pushVideo(delta, false, 0);
    expect(tap.assemble(0)).toBeNull();
  });

  it("clear() resets all buffered state", () => {
    const tap = new EncodedTap({ lengthSec: 30 });
    tap.pushVideo(keyframe, true, 0);
    tap.clear();
    expect(tap.assemble(0)).toBeNull();
  });

  it("copies frame bytes so reuse of the source buffer is not observed", () => {
    const tap = new EncodedTap({ lengthSec: 30 });
    const src = keyframe.slice();
    tap.pushVideo(src, true, 0);
    src.fill(0); // simulate the WebRTC frame buffer being reused after enqueue
    const a = tap.assemble(0)!;
    expect(a.video[0].bytes.some((b) => b !== 0)).toBe(true);
  });
});
