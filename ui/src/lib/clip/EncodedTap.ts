/**
 * EncodedTap.ts — holds the encoded video/audio ring buffers for clipping.
 *
 * Wired into the WebRTC receivers by ConnectionManager (Task 9): each encoded
 * frame is copied in here (the source ArrayBuffer is reused after `enqueue`),
 * normalized to Annex-B, and timestamped via a per-stream RtpClock. On Clip,
 * `assemble()` slices a keyframe-aligned window. All the tricky retention/slice
 * decisions live in the pure `encodedTapLogic` module (unit-tested separately).
 */
import { toAnnexB, extractSpsPps } from "./annexB.js";
import { RtpClock } from "./rtpTime.js";
import {
  sliceForClip,
  evictVideo,
  evictAudio,
  type EncodedFrame,
} from "./encodedTapLogic.js";

const VIDEO_CLOCK_HZ = 90_000;
const AUDIO_CLOCK_HZ = 48_000;
/** Buffer a little beyond the target length so a clip always has a leading keyframe. */
const EVICT_HEADROOM_SEC = 2;
/** Cap eviction churn: prune at most ~once per second of stream time. */
const EVICT_INTERVAL_SEC = 1;

export interface EncodedTapOptions {
  /** Target clip length in seconds. */
  lengthSec: number;
  /** Video track settings (from `MediaStreamTrack.getSettings()`) for w/h/fps. */
  videoTrackSettings?: MediaTrackSettings;
  /** Wall-clock source in ms; injectable for tests. Defaults to performance.now. */
  now?: () => number;
}

export interface AssembledClip {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sps: Uint8Array;
  pps: Uint8Array;
  video: EncodedFrame[];
  audio: EncodedFrame[];
  startSec: number;
}

export class EncodedTap {
  private video: EncodedFrame[] = [];
  private audio: EncodedFrame[] = [];
  private videoClock = new RtpClock(VIDEO_CLOCK_HZ);
  private audioClock = new RtpClock(AUDIO_CLOCK_HZ);
  private sps?: Uint8Array;
  private pps?: Uint8Array;
  private lastEvictSec = -Infinity;
  // Shared-timeline anchoring: the first frame of EITHER stream sets the common
  // wall-clock origin; each stream records its own offset to it exactly once.
  private _originMs: number | null = null;
  private _videoWallOffsetSec = 0;
  private _audioWallOffsetSec = 0;
  private _videoStarted = false;
  private _audioStarted = false;
  private readonly lengthSec: number;
  private readonly settings: MediaTrackSettings;
  private readonly _now: () => number;

  constructor(opts: EncodedTapOptions) {
    this.lengthSec = opts.lengthSec;
    this.settings = opts.videoTrackSettings ?? {};
    this._now = opts.now ?? (() => performance.now());
  }

  /** Buffer one encoded video frame. `rtpTs` is the frame's uint32 RTP timestamp. */
  pushVideo(data: Uint8Array, isKeyframe: boolean, rtpTs: number): void {
    const wallOffset = this._streamOffsetSec("video");
    const norm = toAnnexB(data);
    // Copy: the WebRTC frame's ArrayBuffer is reused after enqueue. The AVCC
    // branch of toAnnexB already returns a fresh array; the passthrough doesn't.
    const bytes = norm === data ? data.slice() : norm;
    // Shared timeline: this stream's offset from the common origin + its smooth
    // within-stream RTP delta. Keeps A/V aligned across the two clocks (spec §6.3).
    const ptsSec = wallOffset + this.videoClock.toSeconds(rtpTs);

    if (isKeyframe && (!this.sps || !this.pps)) {
      const { sps, pps } = extractSpsPps(bytes);
      if (sps && !this.sps) this.sps = sps.slice();
      if (pps && !this.pps) this.pps = pps.slice();
    }

    this.video.push({ bytes, ptsSec, isKeyframe });
    this.maybeEvict(ptsSec);
  }

  /** Buffer one encoded audio (Opus) frame. */
  pushAudio(data: Uint8Array, rtpTs: number): void {
    const wallOffset = this._streamOffsetSec("audio");
    const ptsSec = wallOffset + this.audioClock.toSeconds(rtpTs);
    this.audio.push({ bytes: data.slice(), ptsSec, isKeyframe: false });
  }

  /**
   * Wall-clock offset (seconds) from the shared origin to this stream's first
   * frame. The first frame of EITHER stream sets the shared origin; each stream
   * then captures its own offset exactly once. Anchoring both RTP timelines to a
   * single instant is what keeps audio and video in sync (spec §6.3).
   */
  private _streamOffsetSec(kind: "video" | "audio"): number {
    const nowMs = this._now();
    if (this._originMs === null) this._originMs = nowMs;
    if (kind === "video") {
      if (!this._videoStarted) {
        this._videoStarted = true;
        this._videoWallOffsetSec = (nowMs - this._originMs) / 1000;
      }
      return this._videoWallOffsetSec;
    }
    if (!this._audioStarted) {
      this._audioStarted = true;
      this._audioWallOffsetSec = (nowMs - this._originMs) / 1000;
    }
    return this._audioWallOffsetSec;
  }

  /**
   * Slice a keyframe-aligned clip covering the last `retainSec` seconds, or
   * `null` if no keyframe has been buffered yet.
   */
  assemble(retainSec: number = this.lengthSec): AssembledClip | null {
    const nowSec = this.video.length
      ? this.video[this.video.length - 1].ptsSec
      : 0;
    const slice = sliceForClip(this.video, this.audio, nowSec, retainSec);
    if (slice.video.length === 0) return null;

    const { fpsNum, fpsDen } = this.fps();
    return {
      width: this.settings.width ?? 1920,
      height: this.settings.height ?? 1080,
      fpsNum,
      fpsDen,
      sps: this.sps ?? new Uint8Array(),
      pps: this.pps ?? new Uint8Array(),
      video: slice.video,
      audio: slice.audio,
      startSec: slice.startSec,
    };
  }

  /** Drop all buffered state (e.g. on disconnect / reconnect). */
  clear(): void {
    this.video = [];
    this.audio = [];
    this.videoClock = new RtpClock(VIDEO_CLOCK_HZ);
    this.audioClock = new RtpClock(AUDIO_CLOCK_HZ);
    this.sps = undefined;
    this.pps = undefined;
    this.lastEvictSec = -Infinity;
    this._originMs = null;
    this._videoWallOffsetSec = 0;
    this._audioWallOffsetSec = 0;
    this._videoStarted = false;
    this._audioStarted = false;
  }

  private maybeEvict(nowSec: number): void {
    if (nowSec - this.lastEvictSec < EVICT_INTERVAL_SEC) return;
    this.lastEvictSec = nowSec;
    const retain = this.lengthSec + EVICT_HEADROOM_SEC;
    this.video = evictVideo(this.video, nowSec, retain);
    this.audio = evictAudio(this.audio, nowSec, retain);
  }

  /** Frame rate as a simple rational from track settings (default 60/1). */
  private fps(): { fpsNum: number; fpsDen: number } {
    const r = this.settings.frameRate;
    if (typeof r === "number" && r > 0) return { fpsNum: Math.round(r), fpsDen: 1 };
    return { fpsNum: 60, fpsDen: 1 };
  }
}
