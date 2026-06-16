import { describe, it, expect } from "vitest";
import {
  packClipPayload,
  CLIP_MAGIC,
  type ClipPayloadInput,
} from "./clipPayload.js";

/**
 * Shared byte fixture. The IDENTICAL array is asserted against the Rust parser
 * in `src/clip.rs::tests::parses_bytes_produced_by_the_js_packer`, proving the
 * TS packer and the Rust parser agree byte-for-byte (field order + endianness).
 * If you change the layout, update both.
 */
const FIXTURE = new Uint8Array([
  0x50, 0x4c, 0x43, 0x58, 0x01, // magic 'XCLP' (LE), version 1
  0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, // width 1, height 2, fpsNum 3, fpsDen 4
  0x01, 0x00, 0x00, 0x00, 0xaa, // sps = [0xAA]
  0x01, 0x00, 0x00, 0x00, 0xbb, // pps = [0xBB]
  0x01, 0x00, 0x00, 0x00, 0xcc, // aacConfig = [0xCC]
  0x01, 0x00, 0x00, 0x00, // video_count = 1
  0x01, // keyframe = true
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ptsSec = 0.0
  0x01, 0x00, 0x00, 0x00, 0x65, // nal = [0x65]
  0x01, 0x00, 0x00, 0x00, // audio_count = 1
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ptsSec = 0.0
  0x01, 0x00, 0x00, 0x00, 0xff, // aac = [0xFF]
]);

const FIXTURE_INPUT: ClipPayloadInput = {
  width: 1,
  height: 2,
  fpsNum: 3,
  fpsDen: 4,
  sps: new Uint8Array([0xaa]),
  pps: new Uint8Array([0xbb]),
  aacConfig: new Uint8Array([0xcc]),
  video: [{ bytes: new Uint8Array([0x65]), ptsSec: 0, isKeyframe: true }],
  audio: [{ bytes: new Uint8Array([0xff]), ptsSec: 0 }],
};

describe("packClipPayload", () => {
  it("matches the cross-language byte fixture exactly", () => {
    expect(Array.from(packClipPayload(FIXTURE_INPUT))).toEqual(
      Array.from(FIXTURE),
    );
  });

  it("writes the magic and version header", () => {
    const packed = packClipPayload(FIXTURE_INPUT);
    const view = new DataView(packed.buffer);
    expect(view.getUint32(0, true)).toBe(CLIP_MAGIC);
    expect(view.getUint8(4)).toBe(1);
  });

  it("round-trips a richer payload through a local mirror unpacker", () => {
    const input: ClipPayloadInput = {
      width: 1920,
      height: 1080,
      fpsNum: 60,
      fpsDen: 1,
      sps: new Uint8Array([0x67, 0x42, 0x00]),
      pps: new Uint8Array([0x68, 0xce]),
      aacConfig: new Uint8Array([0x11, 0x90]),
      video: [
        { bytes: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]), ptsSec: 2.5, isKeyframe: true },
        { bytes: new Uint8Array([0, 0, 0, 1, 0x41, 0x9b]), ptsSec: 2.5167, isKeyframe: false },
      ],
      audio: [
        { bytes: new Uint8Array([0xfc, 0x01]), ptsSec: 2.52 },
        { bytes: new Uint8Array([0xfc, 0x02]), ptsSec: 2.54 },
      ],
    };
    expect(unpack(packClipPayload(input))).toEqual(input);
  });
});

/** Local mirror of the Rust parser, used only to prove the packer round-trips. */
function unpack(data: Uint8Array): ClipPayloadInput {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  const u8 = () => view.getUint8(o++);
  const u16 = () => {
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = () => {
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const f64 = () => {
    const v = view.getFloat64(o, true);
    o += 8;
    return v;
  };
  const blob = () => {
    const len = u32();
    const b = data.subarray(o, o + len);
    o += len;
    return new Uint8Array(b);
  };

  const magic = u32();
  if (magic !== CLIP_MAGIC) throw new Error("bad magic");
  u8(); // version
  const width = u16();
  const height = u16();
  const fpsNum = u16();
  const fpsDen = u16();
  const sps = blob();
  const pps = blob();
  const aacConfig = blob();

  const videoCount = u32();
  const video = [];
  for (let i = 0; i < videoCount; i++) {
    const isKeyframe = u8() !== 0;
    const ptsSec = f64();
    const bytes = blob();
    video.push({ bytes, ptsSec, isKeyframe });
  }
  const audioCount = u32();
  const audio = [];
  for (let i = 0; i < audioCount; i++) {
    const ptsSec = f64();
    const bytes = blob();
    audio.push({ bytes, ptsSec });
  }
  return { width, height, fpsNum, fpsDen, sps, pps, aacConfig, video, audio };
}
