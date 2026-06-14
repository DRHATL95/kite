/**
 * settings.svelte.ts — small persisted app settings (Svelte 5 runes).
 * Currently: the auto-update channel (stable | nightly), default stable.
 */

export type UpdateChannel = "stable" | "nightly";

const CHANNEL_KEY = "xbox-remote:update-channel";
const DEFAULT_CHANNEL: UpdateChannel = "stable";

function readChannel(): UpdateChannel {
  try {
    const saved = localStorage.getItem(CHANNEL_KEY);
    if (saved === "stable" || saved === "nightly") return saved;
  } catch {
    // localStorage unavailable — use default
  }
  return DEFAULT_CHANNEL;
}

class SettingsStore {
  /** Active auto-update channel (reactive). */
  updateChannel: UpdateChannel = $state(readChannel());

  /** Switch channel and persist it. */
  setChannel(c: UpdateChannel): void {
    this.updateChannel = c;
    try {
      localStorage.setItem(CHANNEL_KEY, c);
    } catch {
      // best-effort persistence
    }
  }
}

export const settings = new SettingsStore();
