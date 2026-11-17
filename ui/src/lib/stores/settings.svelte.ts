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
import { isQualityPreset, type QualityPreset } from "../connection/streamQuality.js";
import {
  loadMapping, saveMapping, OUTPUTS_BY_ID, sourcesEqual,
  type ControllerMapping, type Source,
} from "../connection/controllerMapping.js";
import { persisted } from "../persist/store.js";

export type UpdateChannel = "stable" | "nightly";

const CHANNEL_KEY = "kite:update-channel";
const DEFAULT_CHANNEL: UpdateChannel = "stable";

const LOG_VERBOSE_KEY = "kite:log-verbose";

function readLogVerbose(): boolean {
  try {
    return persisted.getItem(LOG_VERBOSE_KEY) === "true";
  } catch {
    return false;
  }
}

const AUDIO_ONLY_KEY = "kite:audio-only";

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

const STREAM_QUALITY_KEY = "kite:stream-quality";

function readStreamQuality(): QualityPreset {
  try {
    const saved = persisted.getItem(STREAM_QUALITY_KEY);
    if (isQualityPreset(saved)) return saved;
  } catch {
    // persistence unavailable — use default
  }
  return "auto";
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

  /** Stream quality preset (resolution + bitrate cap). Applies on the next connect. */
  streamQuality: QualityPreset = $state(readStreamQuality());

  /** Hide the window to the system tray on close instead of quitting, persisted. */
  minimizeToTray: boolean = $state(readMinimizeToTray());

  /** Show the diagnostics HUD (default on for nightly, off for stable), persisted. */
  showDiagnosticsHud: boolean = $state(readShowDiagnosticsHud());

  /** Controller remap (sparse overrides). Snapshotted at connect; applies next connect. */
  controllerMapping: ControllerMapping = $state(loadMapping(persisted));

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

  /** Set the stream quality preset and persist it. Applies on the next connect. */
  setStreamQuality(p: QualityPreset): void {
    this.streamQuality = p;
    try {
      persisted.setItem(STREAM_QUALITY_KEY, p);
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

  /** Bind an output to a source (or delete it if it equals the default). */
  setControllerBinding(outputId: string, src: Source): void {
    const def = OUTPUTS_BY_ID[outputId]?.defaultSource;
    const next = { ...this.controllerMapping };
    if (def && sourcesEqual(src, def)) delete next[outputId];
    else next[outputId] = src;
    this.controllerMapping = next;
    saveMapping(persisted, next);
  }

  /** Reset a single output to its default. */
  resetControllerBinding(outputId: string): void {
    const next = { ...this.controllerMapping };
    delete next[outputId];
    this.controllerMapping = next;
    saveMapping(persisted, next);
  }

  /** Reset the whole mapping to default. */
  resetControllerMapping(): void {
    this.controllerMapping = {};
    saveMapping(persisted, {});
  }
}

export const settings = new SettingsStore();
