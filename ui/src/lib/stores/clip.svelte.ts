/**
 * clip.svelte.ts — reactive orchestration for clipping.
 *
 * Owns the ClipBuffer instance, exposes attach/detach (driven by an $effect in
 * App.svelte that watches the media stream + settings), saveClip(), reveal(),
 * and the toast state the Toast component renders.
 */

import { ClipBuffer } from "../clip/ClipBuffer.js";
import { clipFileName } from "../clip/clipBufferLogic.js";
import { saveClip, revealClip } from "../ipc/commands.js";
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
  /** True while a ClipBuffer is actively recording. */
  buffering: boolean = $state(false);

  private _buffer: ClipBuffer | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)build the buffer for a stream. Tears down any previous buffer first. */
  attach(stream: MediaStream, opts: { lengthSec: number; quality: ClipQuality }): void {
    this.detach();
    this._buffer = new ClipBuffer(stream, opts);
    this._buffer.start();
    this.buffering = true;
  }

  /** Stop and release the buffer. */
  detach(): void {
    if (this._buffer) {
      this._buffer.stop();
      this._buffer = null;
    }
    this.buffering = false;
  }

  /** Assemble the current clip, save it, and toast the result. */
  async saveClip(): Promise<void> {
    if (!this._buffer) return;
    const blob = this._buffer.assemble();
    if (!blob) {
      this._showToast("Clip not ready yet", null, "bad");
      return;
    }
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = clipFileName(new Date());
      const path = await saveClip(bytes, name);
      this._showToast("Clip saved", path, "ok");
    } catch (e) {
      this._showToast("Clip failed: " + String(e), null, "bad");
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
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
  }

  private _showToast(message: string, path: string | null, tone: "ok" | "bad"): void {
    this.toast = { message, path, tone };
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = null; }, TOAST_TIMEOUT_MS);
  }
}

export const clipStore = new ClipStore();
