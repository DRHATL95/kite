import { describe, it, expect } from "vitest";
import { toAnnexB, extractSpsPps, isAnnexB } from "./annexB.js";

describe("annexB", () => {
  it("detects an Annex-B start code", () => {
    expect(isAnnexB(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe(true);
    expect(isAnnexB(new Uint8Array([0, 0, 0, 5, 0x67]))).toBe(false); // AVCC length prefix
  });
  it("converts AVCC (4-byte length) to Annex-B", () => {
    // one NAL of length 3: bytes 0x67,0x01,0x02
    const avcc = new Uint8Array([0, 0, 0, 3, 0x67, 0x01, 0x02]);
    expect(Array.from(toAnnexB(avcc))).toEqual([0, 0, 0, 1, 0x67, 0x01, 0x02]);
  });
  it("converts multi-NAL AVCC to Annex-B", () => {
    // NAL A (len 2): 0x67,0x10 ; NAL B (len 1): 0x68
    const avcc = new Uint8Array([0, 0, 0, 2, 0x67, 0x10, 0, 0, 0, 1, 0x68]);
    expect(Array.from(toAnnexB(avcc))).toEqual([
      0, 0, 0, 1, 0x67, 0x10, 0, 0, 0, 1, 0x68,
    ]);
  });
  it("passes Annex-B through unchanged", () => {
    const ab = new Uint8Array([0, 0, 0, 1, 0x65, 0x09]);
    expect(Array.from(toAnnexB(ab))).toEqual(Array.from(ab));
  });
  it("extracts SPS (type 7) and PPS (type 8) from a keyframe", () => {
    const sps = [0x67, 0x42, 0x00];
    const pps = [0x68, 0xce];
    const idr = [0x65, 0x88];
    const frame = new Uint8Array([
      0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr,
    ]);
    const { sps: s, pps: p } = extractSpsPps(frame);
    expect(Array.from(s!)).toEqual(sps);
    expect(Array.from(p!)).toEqual(pps);
  });
  it("handles 3-byte start codes when extracting", () => {
    const frame = new Uint8Array([0, 0, 1, 0x67, 0x10, 0, 0, 1, 0x68, 0x20]);
    const { sps, pps } = extractSpsPps(frame);
    expect(Array.from(sps!)).toEqual([0x67, 0x10]);
    expect(Array.from(pps!)).toEqual([0x68, 0x20]);
  });
});
