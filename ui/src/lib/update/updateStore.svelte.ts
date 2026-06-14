/**
 * updateStore.svelte.ts — Svelte 5 reactive store for app self-update state.
 *
 * Uses Svelte 5 runes ($state) for reactive state.  Wraps the thin updater
 * helpers in ui/src/lib/update/updater.ts (which call the Rust check_update /
 * install_update commands).
 *
 * Update flow:
 *   1. On app launch: updateStore.checkOnLaunch()  — silent check on the persisted
 *      channel; sets `available` if a newer version exists, otherwise no-ops
 *      (offline / no update / error).
 *   2. If available:   the banner shows; user clicks "Install".
 *   3. updateStore.install()                       — downloads + installs with
 *      progress, then relaunches the app.
 *   4. updateStore.dismiss()                       — hides the banner without
 *      installing.
 *   5. updateStore.switchChannel(next)             — persists the channel and checks
 *      the new channel allowing a downgrade (explicit user action).
 *
 * Usage:
 *   import { updateStore } from '$lib/update/updateStore.svelte';
 *   updateStore.checkOnLaunch();
 *   // Read: updateStore.available, updateStore.installing, updateStore.progress
 */

import { checkForUpdate, applyUpdate, type UpdateInfo } from "./updater.js";
import { settings, type UpdateChannel } from "$lib/stores/settings.svelte.js";

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

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Called once on launch. Checks the persisted channel, upgrade-only. Silent no-op on none/offline/error. */
  async checkOnLaunch(): Promise<void> {
    const info = await checkForUpdate(settings.updateChannel, false);
    if (info) this.available = info;
  }

  /** Switch channels (persist) and check the new channel allowing a downgrade,
   *  so picking a lower channel immediately offers that channel's latest. */
  async switchChannel(next: UpdateChannel): Promise<void> {
    settings.setChannel(next);
    const info = await checkForUpdate(next, true);
    this.available = info; // null clears any stale banner; non-null offers the switch target
  }

  /** Download + install the pending update, then relaunch. */
  async install(): Promise<void> {
    this.installing = true;
    this.error = null;
    try {
      await applyUpdate((p) => (this.progress = p));
    } catch (e) {
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
