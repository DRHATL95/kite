/**
 * annexB.ts — H.264 NAL byte-format helpers (pure, unit-tested).
 *
 * WebRTC Insertable Streams hand us encoded H.264 frames whose byte format may
 * be Annex-B (start-code prefixed) or AVCC (4-byte length prefixed). muxide wants
 * Annex-B with SPS/PPS available, so we normalize here. On this project's target
 * (WebView2) frames are already Annex-B — verified by the Task 1 spike — so
 * `toAnnexB` is usually a passthrough; the AVCC branch keeps us correct elsewhere.
 */

/** True if `data` begins with a 3- or 4-byte Annex-B start code. */
export function isAnnexB(data: Uint8Array): boolean {
  if (
    data.length >= 4 &&
    data[0] === 0 &&
    data[1] === 0 &&
    data[2] === 0 &&
    data[3] === 1
  ) {
    return true;
  }
  return (
    data.length >= 3 && data[0] === 0 && data[1] === 0 && data[2] === 1
  );
}

/**
 * Return `data` as Annex-B. Annex-B input is returned unchanged; AVCC input
 * (a sequence of `[4-byte big-endian length][NAL]`) is rewritten with each
 * length prefix replaced by a `00 00 00 01` start code. Malformed AVCC stops
 * at the first inconsistent length rather than throwing.
 */
export function toAnnexB(data: Uint8Array): Uint8Array {
  if (isAnnexB(data)) return data;

  const out: number[] = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const len =
      ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>>
      0;
    i += 4;
    if (len === 0 || i + len > data.length) break; // malformed → stop cleanly
    out.push(0, 0, 0, 1);
    for (let j = 0; j < len; j++) out.push(data[i + j]);
    i += len;
  }
  return new Uint8Array(out);
}

/**
 * Extract the first SPS (NAL type 7) and PPS (NAL type 8) from an Annex-B frame.
 * Either may be absent (returns `undefined` for it).
 */
export function extractSpsPps(annexB: Uint8Array): {
  sps?: Uint8Array;
  pps?: Uint8Array;
} {
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  for (const nal of iterateNals(annexB)) {
    if (nal.length === 0) continue;
    const type = nal[0] & 0x1f;
    if (type === 7 && !sps) sps = nal;
    else if (type === 8 && !pps) pps = nal;
  }
  return { sps, pps };
}

/**
 * Yield each NAL unit's bytes (without its start code). A 4-byte start code is
 * recognized as a 3-byte `00 00 01` preceded by an extra `00`; the preceding NAL
 * must end *before* that extra zero, so we track each start code's true start.
 */
function* iterateNals(data: Uint8Array): Generator<Uint8Array> {
  const codes: { scStart: number; payloadStart: number }[] = [];
  let i = 0;
  while (i + 3 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const scStart = i > 0 && data[i - 1] === 0 ? i - 1 : i;
      codes.push({ scStart, payloadStart: i + 3 });
      i += 3;
    } else {
      i += 1;
    }
  }
  for (let k = 0; k < codes.length; k++) {
    const start = codes[k].payloadStart;
    const end = k + 1 < codes.length ? codes[k + 1].scStart : data.length;
    if (end > start) yield data.subarray(start, end);
  }
}
