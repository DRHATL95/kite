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

const AUDIO_ONLY_KEY = "xbox-remote:audio-only";

function readAudioOnly(): boolean {
  try {
    return persisted.getItem(AUDIO_ONLY_KEY) === "true";
  } catch {
    return false;
  }
}

const MINIMIZE_TO_TRAY_KEY = "kite:minimize-to-tray";

function readMinimizeToTray(): boolean {
  try {
    return persisted.getItem(MINIMIZE_TO_TRAY_KEY) === "true";
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

const SHOW_HUD_KEY = "kite:show-diagnostics-hud";

/**
 * Whether the diagnostics HUD (button + panel) is shown. The HUD is a developer
 * tool, so when the user has never set it, default it ON for nightly builds and
 * OFF for stable — but an explicit choice always wins.
 */
function readShowDiagnosticsHud(): boolean {
  try {
    const saved = persisted.getItem(SHOW_HUD_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
    return readChannel() === "nightly";
  } catch {
    return false;
  }
}

class SettingsStore {
  /** Active auto-update channel (reactive). */
  updateChannel: UpdateChannel = $state(readChannel());

  /** Opt-in clipping preferences (reactive). */
  clip: ClipSettings = $state(loadClipSettings(persisted));

  /** Verbose ("diagnostic") logging, persisted across launches. */
  logVerbose: boolean = $state(readLogVerbose());

  /** Decline video on the next connect (audio-only mode), persisted. */
  audioOnly: boolean = $state(readAudioOnly());

  /** Hide the window to the system tray on close instead of quitting, persisted. */
  minimizeToTray: boolean = $state(readMinimizeToTray());

  /** Show the diagnostics HUD (default on for nightly, off for stable), persisted. */
  showDiagnosticsHud: boolean = $state(readShowDiagnosticsHud());

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

  /** Set audio-only mode and persist it. Applies on the next connect. */
  setAudioOnly(v: boolean): void {
    this.audioOnly = v;
    try {
      persisted.setItem(AUDIO_ONLY_KEY, String(v));
    } catch {
      // best-effort persistence
    }
  }

  /** Set minimize-to-tray and persist it. */
  setMinimizeToTray(v: boolean): void {
    this.minimizeToTray = v;
    try {
      persisted.setItem(MINIMIZE_TO_TRAY_KEY, String(v));
    } catch {
      // best-effort persistence
    }
  }

  /** Set diagnostics-HUD visibility and persist it. */
  setShowDiagnosticsHud(v: boolean): void {
    this.showDiagnosticsHud = v;
    try {
      persisted.setItem(SHOW_HUD_KEY, String(v));
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
