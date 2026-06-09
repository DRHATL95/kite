/**
 * updateStore.svelte.ts — Svelte 5 reactive store for app self-update state.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  Wraps the thin updater
 * helpers in ui/src/lib/update/updater.ts (which call the Tauri updater /
 * process plugins).
 *
 * Update flow:
 *   1. On app launch: updateStore.checkOnLaunch()  — silent check; sets `available`
 *      if a newer version exists, otherwise no-ops (offline / no update / error).
 *   2. If available:   the banner shows; user clicks "Install".
 *   3. updateStore.install()                       — downloads + installs with
 *      progress, then relaunches the app.
 *   4. updateStore.dismiss()                       — hides the banner without
 *      installing.
 *
 * Usage:
 *   import { updateStore } from '$lib/update/updateStore.svelte';
 *   updateStore.checkOnLaunch();
 *   // Read: updateStore.available, updateStore.installing, updateStore.progress
 */

import { checkForUpdate, applyUpdate, type UpdateInfo } from "./updater.js";
import type { Update } from "@tauri-apps/plugin-updater";

// ─────────────────────────────────────────────────────────────────────────────
// Store class — reactive fields via $state runes
// ─────────────────────────────────────────────────────────────────────────────

class UpdateStore {
  /** Set when an update is available; null otherwise. Drives the banner visibility. */
  available: UpdateInfo | null = $state(null);

  /** True while a download+install is in progress. */
  installing: boolean = $state(false);

  /** Download progress 0–100. */
  progress: number = $state(0);

  /** Human-readable error from the last failed install, if any. */
  error: string | null = $state(null);

  // ── Private: the pending Update handle (not reactive) ────────────────────────

  private _pending: Update | null = null;

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Called once on launch. Silently no-ops if no update / offline / check fails. */
  async checkOnLaunch(): Promise<void> {
    const u = await checkForUpdate();
    if (u) {
      this._pending = u;
      this.available = { version: u.version, notes: u.body ?? undefined };
    }
  }

  /** Download + install the pending update, then relaunch. */
  async install(): Promise<void> {
    if (!this._pending) return;
    this.installing = true;
    this.error = null;
    try {
      await applyUpdate(this._pending, (p) => (this.progress = p));
      // applyUpdate ends by calling relaunch(), which terminates this process,
      // so execution never returns here on success — no state reset needed.
    } catch (e) {
      // Any failure (download, install, OR relaunch) lands here.
      this.error = String(e);
      this.installing = false;
    }
  }

  /** Dismiss the banner without installing. */
  dismiss(): void {
    this.available = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const updateStore = new UpdateStore();
