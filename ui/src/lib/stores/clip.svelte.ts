/**
 * clip.svelte.ts — reactive orchestration for clipping.
 *
 * Picks a capture strategy when attached to a live stream:
 *   - **EncodedTap** (primary) when WebRTC Insertable Streams are available:
 *     taps already-encoded H.264, transcodes audio to AAC on Clip, and remuxes
 *     to a native MP4 in Rust. Lossless, never disturbs the stream.
 *   - **ClipBuffer** (fallback) otherwise: HW-H.264 MediaRecorder (v1 path).
 *
 * Attach/detach is driven by an $effect in App.svelte that watches the media
 * stream + settings, so the strategy is re-selected after a reconnect too.
 */

import { ClipBuffer } from "../clip/ClipBuffer.js";
import { EncodedTap } from "../clip/EncodedTap.js";
import { clipFileName } from "../clip/clipBufferLogic.js";
import { packClipPayload } from "../clip/clipPayload.js";
import { transcodeOpusToAac, type AacResult } from "../clip/audioTranscode.js";
import { saveClip, revealClip } from "../ipc/commands.js";
import { connectionStore } from "./connection.svelte.js";
import type { ClipQuality } from "../settings/clipSettings.js";

export interface ClipToast {
  message: string;
  /** Saved file path when successful (enables the Reveal action); null otherwise. */
  path: string | null;
  tone: "ok" | "bad";
}

const TOAST_TIMEOUT_MS = 6000;

class ClipStore {
  /** Current toast, or null. Rendered by Toast.svelte. */
  toast: ClipToast | null = $state(null);
  /** True while a capture strategy is active. */
  buffering: boolean = $state(false);

  private _buffer: ClipBuffer | null = null; // fallback (MediaRecorder)
  private _tap: EncodedTap | null = null; // primary (encoded frames)
  private _lengthSec = 30;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)select a capture strategy for a stream. Tears down any previous one first. */
  attach(
    stream: MediaStream,
    opts: { lengthSec: number; quality: ClipQuality },
  ): void {
    this.detach();
    this._lengthSec = opts.lengthSec;

    if (connectionStore.encodedStreamsAvailable) {
      const videoTrack = stream.getVideoTracks()[0];
      const tap = new EncodedTap({
        lengthSec: opts.lengthSec,
        videoTrackSettings: videoTrack?.getSettings(),
      });
      connectionStore.setEncodedTap(tap);
      this._tap = tap;
    } else {
      this._buffer = new ClipBuffer(stream, opts);
      this._buffer.start();
    }
    this.buffering = true;
  }

  /** Stop and release the active strategy. */
  detach(): void {
    if (this._tap) {
      connectionStore.setEncodedTap(null);
      this._tap = null;
    }
    if (this._buffer) {
      this._buffer.stop();
      this._buffer = null;
    }
    this.buffering = false;
  }

  /** Assemble the current clip, save it, and toast the result. */
  async saveClip(): Promise<void> {
    if (this._tap) return this._saveEncodedClip(this._tap);
    if (this._buffer) return this._saveBufferClip(this._buffer);
  }

  /** Primary path: encoded H.264 + AAC → packed payload → Rust remux to MP4. */
  private async _saveEncodedClip(tap: EncodedTap): Promise<void> {
    const clip = tap.assemble(this._lengthSec);
    if (!clip || clip.video.length === 0) {
      this._showToast("Clip not ready yet", null, "bad");
      return;
    }
    try {
      let aac: AacResult = { config: new Uint8Array(), frames: [] };
      let audioOk = true;
      try {
        aac = await transcodeOpusToAac(clip.audio);
      } catch (e) {
        // WebCodecs AAC failed → ship a video-only clip rather than failing (spec §7).
        audioOk = false;
        console.warn("clip: AAC transcode failed, saving video-only:", e);
      }

      const payload = packClipPayload({
        width: clip.width,
        height: clip.height,
        fpsNum: clip.fpsNum,
        fpsDen: clip.fpsDen,
        sps: clip.sps,
        pps: clip.pps,
        aacConfig: aac.config,
        video: clip.video,
        audio: aac.frames,
      });
      const path = await saveClip(payload, clipFileName(new Date(), "mp4"));
      this._showToast(audioOk ? "Clip saved" : "Clip saved (no audio)", path, "ok");
    } catch (e) {
      this._showToast("Clip failed: " + String(e), null, "bad");
    }
  }

  /** Fallback path: MediaRecorder blob written as-is. */
  private async _saveBufferClip(buffer: ClipBuffer): Promise<void> {
    const blob = buffer.assemble();
    if (!blob) {
      this._showToast("Clip not ready yet", null, "bad");
      return;
    }
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const path = await saveClip(bytes, clipFileName(new Date(), ext));
      this._showToast("Clip saved", path, "ok");
    } catch (e) {
      this._showToast("Clip failed: " + String(e), null, "bad");
    }
  }

  /**
   * Surface the result of a native-engine clip save as a toast.
   * Called by `connectionStore.saveClip()` after `rtcSaveClip()` resolves.
   *
   * @param path  Saved MP4 path on success, or null on failure.
   * @param err   Error string when path is null.
   */
  showNativeClipToast(path: string | null, err?: string): void {
    if (path !== null) {
      this._showToast("Clip saved", path, "ok");
    } else {
      this._showToast("Clip failed: " + (err ?? "unknown error"), null, "bad");
    }
  }

  /** Reveal the most recent saved clip in the OS file manager. */
  async reveal(): Promise<void> {
    const path = this.toast?.path;
    if (!path) return;
    try {
      await revealClip(path);
    } catch {
      /* reveal is best-effort */
    }
  }

  /** Manually dismiss the toast. */
  dismiss(): void {
    this.toast = null;
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
  }

  private _showToast(
    message: string,
    path: string | null,
    tone: "ok" | "bad",
  ): void {
    this.toast = { message, path, tone };
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toast = null;
    }, TOAST_TIMEOUT_MS);
  }
}

export const clipStore = new ClipStore();
