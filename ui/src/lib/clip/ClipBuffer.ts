/**
 * ClipBuffer.ts — continuous MediaRecorder that retains the last N seconds.
 *
 * Pure retention/assembly math lives in clipBufferLogic.ts; this class is the
 * DOM glue (MediaRecorder lifecycle + segment rotation) and is verified by
 * build + manual/hardware testing rather than unit tests.
 *
 * Rotation: every `segmentMs` we stop() then start() a fresh recorder so each
 * generation begins with a header/keyframe. The first chunk after each start()
 * is tagged isHeader=true. assemble() anchors on a header ≥ retainMs old.
 */

import {
  assembleClipBlob,
  pruneChunks,
  pickBitrate,
  type BufferedChunk,
} from "./clipBufferLogic.js";
import type { ClipQuality } from "../settings/clipSettings.js";

const TIMESLICE_MS = 1000;
const PRUNE_INTERVAL_MS = 2000;
/** Max rotation interval; smaller = tighter clip length, more rotations. */
const MAX_SEGMENT_MS = 10_000;

export interface ClipBufferOptions {
  lengthSec: number;
  quality: ClipQuality;
  onLog?: (msg: string) => void;
}

/**
 * Pick the best-supported mime type for recording.
 *
 * Prefer hardware-accelerated H.264 in an MP4 container: the encode runs on the
 * GPU (not the CPU, which would starve the WebRTC pipeline and drop the stream),
 * and MP4/H.264 is natively playable by the Xbox media player (WebM is not).
 * Falls back to H.264-in-WebM, then VP8 (software) as a last resort.
 */
function pickMimeType(): string {
  const prefs = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // H.264 + AAC (hardware encode, MP4)
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=h264,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of prefs) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "video/webm";
}

export class ClipBuffer {
  private readonly _stream: MediaStream;
  private readonly _opts: ClipBufferOptions;
  private readonly _mimeType: string;
  private readonly _retainMs: number;
  private readonly _segmentMs: number;

  private _recorder: MediaRecorder | null = null;
  private _chunks: BufferedChunk[] = [];
  private _expectHeader = true;
  private _rotating = false;
  private _stopped = false;
  private _rotateTimer: ReturnType<typeof setInterval> | null = null;
  private _pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(stream: MediaStream, opts: ClipBufferOptions) {
    this._stream = stream;
    this._opts = opts;
    this._mimeType = pickMimeType();
    this._retainMs = opts.lengthSec * 1000;
    this._segmentMs = Math.min(MAX_SEGMENT_MS, this._retainMs);
  }

  /** Begin continuous recording + rotation. */
  start(): void {
    this._stopped = false;
    this._startRecorder();
    this._rotateTimer = setInterval(() => this._rotate(), this._segmentMs);
    this._pruneTimer = setInterval(() => {
      this._chunks = pruneChunks(this._chunks, performance.now(), this._retainMs);
    }, PRUNE_INTERVAL_MS);
    this._log(`ClipBuffer started (${this._mimeType}, retain ${this._opts.lengthSec}s)`);
  }

  /** Stop recording and release all buffered chunks. */
  stop(): void {
    this._stopped = true;
    if (this._rotateTimer) { clearInterval(this._rotateTimer); this._rotateTimer = null; }
    if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
    if (this._recorder && this._recorder.state !== "inactive") {
      try { this._recorder.stop(); } catch { /* already stopping */ }
    }
    this._recorder = null;
    this._chunks = [];
    this._log("ClipBuffer stopped");
  }

  /** True once at least one header chunk has been captured. */
  isReady(): boolean {
    return this._chunks.some((c) => c.isHeader);
  }

  /** Assemble a clip Blob ending at "now", or null if nothing buffered yet. */
  assemble(): Blob | null {
    if (!this.isReady()) return null;
    return assembleClipBlob(this._chunks, performance.now(), this._retainMs, this._mimeType);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _startRecorder(): void {
    this._expectHeader = true;
    const rec = new MediaRecorder(this._stream, {
      mimeType: this._mimeType,
      videoBitsPerSecond: pickBitrate(this._opts.quality),
    });
    rec.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      this._chunks.push({
        data: e.data,
        timestamp: performance.now(),
        isHeader: this._expectHeader,
      });
      this._expectHeader = false;
    };
    rec.onstop = () => {
      // If this stop was a rotation (not a teardown), start the next generation.
      if (!this._stopped && this._rotating) {
        this._rotating = false;
        this._startRecorder();
      }
    };
    rec.start(TIMESLICE_MS);
    this._recorder = rec;
  }

  private _rotate(): void {
    if (!this._recorder || this._recorder.state !== "recording") return;
    this._rotating = true;
    try { this._recorder.stop(); } catch { this._rotating = false; }
  }

  private _log(msg: string): void {
    this._opts.onLog?.(msg);
  }
}
