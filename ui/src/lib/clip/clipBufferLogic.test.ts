import { describe, it, expect } from "vitest";
import {
  selectAnchorIndex,
  pruneChunks,
  assembleClipBlob,
  clipFileName,
  pickBitrate,
  type BufferedChunk,
} from "./clipBufferLogic.js";

/** Build a chunk; data size encodes which chunk it is for assertions. */
function chunk(timestamp: number, isHeader: boolean, size = 1): BufferedChunk {
  return { data: new Blob([new Uint8Array(size)]), timestamp, isHeader };
}

describe("selectAnchorIndex", () => {
  it("returns 0 for an empty buffer", () => {
    expect(selectAnchorIndex([], 1000, 500)).toBe(0);
  });

  it("anchors on the newest header at least retainMs old", () => {
    // headers at t=0, t=400, t=900; now=1000, retain=500 → cutoff=500
    const chunks = [
      chunk(0, true),
      chunk(200, false),
      chunk(400, true),
      chunk(600, false),
      chunk(900, true),
    ];
    // newest header with ts <= 500 is index 2 (t=400)
    expect(selectAnchorIndex(chunks, 1000, 500)).toBe(2);
  });

  it("falls back to the earliest header during warm-up", () => {
    // only header is t=800; now=1000, retain=500 → cutoff=500, none old enough
    const chunks = [chunk(800, true), chunk(900, false)];
    expect(selectAnchorIndex(chunks, 1000, 500)).toBe(0);
  });
});

describe("pruneChunks", () => {
  it("drops chunks before the anchor", () => {
    const chunks = [
      chunk(0, true),
      chunk(400, true),
      chunk(600, false),
      chunk(900, true),
    ];
    // anchor at index 1 (t=400) → keep from there
    const pruned = pruneChunks(chunks, 1000, 500);
    expect(pruned).toHaveLength(3);
    expect(pruned[0].timestamp).toBe(400);
    expect(pruned[0].isHeader).toBe(true);
  });

  it("keeps everything from the earliest header during warm-up", () => {
    // No header is retainMs old yet (all chunks newer than cutoff=500); the
    // prune timer must fall back to the earliest header and drop NOTHING.
    const chunks = [
      chunk(600, true),
      chunk(700, false),
      chunk(900, false),
    ];
    const pruned = pruneChunks(chunks, 1000, 500);
    expect(pruned).toHaveLength(3);
    expect(pruned[0].timestamp).toBe(600);
    expect(pruned[0].isHeader).toBe(true);
  });
});

describe("assembleClipBlob", () => {
  it("includes the anchor header through the latest chunk and is non-empty", () => {
    const chunks = [
      chunk(0, true, 10),
      chunk(400, true, 20),
      chunk(600, false, 30),
      chunk(900, false, 40),
    ];
    // anchor index 1 → sizes 20+30+40 = 90
    const blob = assembleClipBlob(chunks, 1000, 500, "video/webm");
    expect(blob.size).toBe(90);
    expect(blob.type).toBe("video/webm");
  });
});

describe("clipFileName", () => {
  it("formats a sortable timestamped webm name", () => {
    const d = new Date(2026, 5, 16, 9, 5, 3); // 2026-06-16 09:05:03 local
    expect(clipFileName(d)).toBe("xbox-clip-20260616-090503.webm");
  });
});

describe("pickBitrate", () => {
  it("maps quality tiers to ascending bitrates", () => {
    expect(pickBitrate("low")).toBeLessThan(pickBitrate("med"));
    expect(pickBitrate("med")).toBeLessThan(pickBitrate("high"));
  });
});
