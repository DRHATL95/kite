/**
 * settings.svelte.ts — reactive wrapper around clipSettings (localStorage-backed).
 *
 * Mirrors the ConnectionManager ← connection.svelte.ts pattern: pure logic in
 * clipSettings.ts, thin reactive shell here.
 */

import {
  loadClipSettings,
  saveClipSettings,
  type ClipSettings,
} from "../settings/clipSettings.js";

class SettingsStore {
  /** Reactive clip preferences. Read e.g. settingsStore.clip.enabled. */
  clip: ClipSettings = $state(loadClipSettings(localStorage));

  /** Apply a partial update, persist, and trigger reactivity. */
  setClip(patch: Partial<ClipSettings>): void {
    this.clip = { ...this.clip, ...patch };
    saveClipSettings(localStorage, this.clip);
  }
}

export const settingsStore = new SettingsStore();
