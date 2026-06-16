/**
 * clipBufferLogic.ts — pure retention/assembly helpers for the clip buffer.
 *
 * No DOM/MediaRecorder dependencies (Blob is available in Node ≥18 + the
 * browser), so this is fully unit-testable. The stateful glue lives in
 * ClipBuffer.ts.
 */

import type { ClipQuality } from "../settings/clipSettings.js";

export interface BufferedChunk {
  /** The raw chunk bytes from MediaRecorder. */
  data: Blob;
  /** Monotonic time (ms) when the chunk was captured. */
  timestamp: number;
  /** True for the first chunk of each recorder generation (carries the header). */
  isHeader: boolean;
}

/**
 * Index of the chunk a clip should start from: the NEWEST header chunk whose
 * timestamp is at least `retainMs` old (so the clip covers ≥ retainMs and ends
 * at "now"). During warm-up, when no header is that old, fall back to the
 * earliest header (a shorter but still valid clip). Empty buffer → 0.
 */
export function selectAnchorIndex(
  chunks: BufferedChunk[],
  nowMs: number,
  retainMs: number,
): number {
  if (chunks.length === 0) return 0;
  const cutoff = nowMs - retainMs;

  let anchor = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].isHeader && chunks[i].timestamp <= cutoff) anchor = i;
  }
  if (anchor >= 0) return anchor;

  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].isHeader) return i;
  }
  return 0;
}

/** Drop chunks before the current anchor, bounding memory. */
export function pruneChunks(
  chunks: BufferedChunk[],
  nowMs: number,
  retainMs: number,
): BufferedChunk[] {
  return chunks.slice(selectAnchorIndex(chunks, nowMs, retainMs));
}

/** Assemble one valid WebM Blob from the anchor through the latest chunk. */
export function assembleClipBlob(
  chunks: BufferedChunk[],
  nowMs: number,
  retainMs: number,
  mimeType: string,
  BlobCtor: typeof Blob = Blob,
): Blob {
  const parts = chunks
    .slice(selectAnchorIndex(chunks, nowMs, retainMs))
    .map((c) => c.data);
  return new BlobCtor(parts, { type: mimeType });
}

/** Sortable, filesystem-safe clip file name from a Date. Defaults to `.mp4`. */
export function clipFileName(d: Date, ext = "mp4"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `xbox-clip-${date}-${time}.${ext}`;
}

/** Map a quality tier to a target video bitrate (bits/s). Tunable. */
export function pickBitrate(quality: ClipQuality): number {
  switch (quality) {
    case "low":
      return 4_000_000;
    case "high":
      return 12_000_000;
    case "med":
    default:
      return 8_000_000;
  }
}
