/**
 * settings.svelte.ts — small persisted app settings (Svelte 5 runes).
 * - updateChannel: the auto-update channel (stable | nightly), default stable.
 * - clip: opt-in clipping preferences (pure model in lib/settings/clipSettings.ts).
 */

import {
  loadClipSettings,
  saveClipSettings,
  type ClipSettings,
} from "../settings/clipSettings.js";
import { persisted } from "../persist/store.js";

export type UpdateChannel = "stable" | "nightly";

const CHANNEL_KEY = "xbox-remote:update-channel";
const DEFAULT_CHANNEL: UpdateChannel = "stable";

const LOG_VERBOSE_KEY = "xbox-remote:log-verbose";

function readLogVerbose(): boolean {
  try {
    return persisted.getItem(LOG_VERBOSE_KEY) === "true";
  } catch {
    return false;
  }
}

function readChannel(): UpdateChannel {
  try {
    const saved = persisted.getItem(CHANNEL_KEY);
    if (saved === "stable" || saved === "nightly") return saved;
  } catch {
    // persistence unavailable — use default
  }
  return DEFAULT_CHANNEL;
}

class SettingsStore {
  /** Active auto-update channel (reactive). */
  updateChannel: UpdateChannel = $state(readChannel());

  /** Opt-in clipping preferences (reactive). */
  clip: ClipSettings = $state(loadClipSettings(persisted));

  /** Verbose ("diagnostic") logging, persisted across launches. */
  logVerbose: boolean = $state(readLogVerbose());

  /** Switch channel and persist it. */
  setChannel(c: UpdateChannel): void {
    this.updateChannel = c;
    try {
      persisted.setItem(CHANNEL_KEY, c);
    } catch {
      // best-effort persistence
    }
  }

  /** Set verbose logging and persist it. */
  setLogVerbose(v: boolean): void {
    this.logVerbose = v;
    try {
      persisted.setItem(LOG_VERBOSE_KEY, String(v));
    } catch {
      // best-effort persistence
    }
  }

  /** Apply a partial clip-settings update, persist, and trigger reactivity. */
  setClip(patch: Partial<ClipSettings>): void {
    this.clip = { ...this.clip, ...patch };
    saveClipSettings(persisted, this.clip);
  }
}

export const settings = new SettingsStore();
