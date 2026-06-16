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

  it("puts audio and video on one shared timeline (no A/V desync)", () => {
    // Simulate the real ordering: audio flows ~0.5s before the first video
    // keyframe (video waits for an IDR). A video frame and an audio frame that
    // arrive at the SAME wall-clock instant must get the SAME pts.
    let clock = 1000;
    const tap = new EncodedTap({ lengthSec: 30, now: () => clock });

    clock = 1000;
    tap.pushAudio(new Uint8Array([0xa1]), 48000); // first frame overall → shared origin
    clock = 1500;
    tap.pushVideo(keyframe, true, 90000); // first video, 0.5s later (90kHz)
    clock = 1500;
    tap.pushAudio(new Uint8Array([0xa2]), 72000); // same instant as the keyframe (+0.5s @ 48kHz)

    const a = tap.assemble(30)!;
    const sameInstantAudio = a.audio.find((f) => f.bytes[0] === 0xa2)!;
    expect(sameInstantAudio).toBeDefined();
    expect(sameInstantAudio.ptsSec).toBeCloseTo(a.video[0].ptsSec, 6);
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
