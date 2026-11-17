import { describe, it, expect } from "vitest";
import { applyVideoBitrateCap } from "./sdpBitrate.js";

const SDP = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:96 H264/90000",
  "",
].join("\r\n");

describe("applyVideoBitrateCap", () => {
  it("inserts b=AS + b=TIAS right after the video c= line", () => {
    const out = applyVideoBitrateCap(SDP, 8000);
    const lines = out.split("\r\n");
    const vIdx = lines.indexOf("m=video 9 UDP/TLS/RTP/SAVPF 96");
    const cIdx = lines.indexOf("c=IN IP4 0.0.0.0", vIdx);
    expect(lines[cIdx + 1]).toBe("b=AS:8000");
    expect(lines[cIdx + 2]).toBe("b=TIAS:8000000");
  });

  it("does not touch the audio section", () => {
    const out = applyVideoBitrateCap(SDP, 8000);
    const lines = out.split("\r\n");
    const aIdx = lines.indexOf("m=audio 9 UDP/TLS/RTP/SAVPF 111");
    const vIdx = lines.indexOf("m=video 9 UDP/TLS/RTP/SAVPF 96");
    expect(lines.slice(aIdx, vIdx).some((l) => l.startsWith("b="))).toBe(false);
  });

  it("replaces an existing cap instead of stacking", () => {
    const twice = applyVideoBitrateCap(applyVideoBitrateCap(SDP, 8000), 4000);
    expect(twice).toContain("b=AS:4000");
    expect(twice).not.toContain("b=AS:8000");
    expect((twice.match(/b=AS:/g) ?? []).length).toBe(1);
  });

  it("null strips any existing cap (Auto)", () => {
    const stripped = applyVideoBitrateCap(applyVideoBitrateCap(SDP, 8000), null);
    expect(stripped).not.toContain("b=AS:");
    expect(stripped).not.toContain("b=TIAS:");
  });

  it("is idempotent", () => {
    expect(applyVideoBitrateCap(applyVideoBitrateCap(SDP, 8000), 8000))
      .toBe(applyVideoBitrateCap(SDP, 8000));
  });

  it("fails open when the video section has no c= line", () => {
    const noC = SDP.replace("m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0", "m=video 9 UDP/TLS/RTP/SAVPF 96");
    expect(applyVideoBitrateCap(noC, 8000)).not.toContain("b=AS:");
  });
});
