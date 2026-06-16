/**
 * encodedTapLogic.ts — pure ring-buffer slicing/eviction for the encoded tap.
 *
 * No DOM dependency, so it's fully unit-tested. The stateful EncodedTap
 * (Task 8) owns the actual buffers and delegates the tricky retention/keyframe
 * decisions here.
 *
 * Invariant: a clip must begin at a keyframe (H.264 can't decode mid-GOP), so
 * eviction never drops past the keyframe that leads the retained window, and a
 * slice always starts at a keyframe.
 */

export interface EncodedFrame {
  /** Encoded bytes (Annex-B H.264 for video; raw Opus for audio). */
  bytes: Uint8Array;
  /** Presentation time in seconds (from this stream's RtpClock). */
  ptsSec: number;
  /** True for an H.264 keyframe; always false for audio. */
  isKeyframe: boolean;
}

export interface ClipSlice {
  video: EncodedFrame[];
  audio: EncodedFrame[];
  /** PTS of the leading keyframe — the clip's t=0 reference. */
  startSec: number;
}

/**
 * Index of the anchor keyframe: the NEWEST keyframe with `ptsSec <= cutoff`, or
 * (warm-up, when none is that old) the EARLIEST keyframe. `-1` if there are no
 * keyframes at all.
 */
function anchorKeyframeIndex(video: EncodedFrame[], cutoff: number): number {
  let anchor = -1;
  for (let i = 0; i < video.length; i++) {
    if (video[i].isKeyframe && video[i].ptsSec <= cutoff) anchor = i;
  }
  if (anchor >= 0) return anchor;
  for (let i = 0; i < video.length; i++) {
    if (video[i].isKeyframe) return i;
  }
  return -1;
}

/**
 * Build a clip ending at "now" and covering ~`retainSec`: video from the newest
 * keyframe at least `retainSec` old (warm-up: earliest keyframe) through the end,
 * with audio aligned to that keyframe's PTS. Empty video slice if no keyframe.
 */
export function sliceForClip(
  video: EncodedFrame[],
  audio: EncodedFrame[],
  nowSec: number,
  retainSec: number,
): ClipSlice {
  const anchor = anchorKeyframeIndex(video, nowSec - retainSec);
  if (anchor < 0) return { video: [], audio: [], startSec: nowSec };
  const startSec = video[anchor].ptsSec;
  return {
    video: video.slice(anchor),
    audio: audio.filter((a) => a.ptsSec >= startSec),
    startSec,
  };
}

/**
 * Drop video frames older than `nowSec - retainSec`, but keep back to the
 * keyframe that leads the window so the buffer can always produce a decodable
 * clip. Returns the retained suffix (input is not mutated).
 */
export function evictVideo(
  frames: EncodedFrame[],
  nowSec: number,
  retainSec: number,
): EncodedFrame[] {
  const anchor = anchorKeyframeIndex(frames, nowSec - retainSec);
  if (anchor < 0) return frames;
  return frames.slice(anchor);
}

/** Drop audio frames older than `nowSec - retainSec` (no keyframe constraint). */
export function evictAudio(
  frames: EncodedFrame[],
  nowSec: number,
  retainSec: number,
): EncodedFrame[] {
  const cutoff = nowSec - retainSec;
  return frames.filter((f) => f.ptsSec >= cutoff);
}
