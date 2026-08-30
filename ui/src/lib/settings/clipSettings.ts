/**
 * clipSettings.ts — pure types + load/save/validate for clip preferences.
 *
 * No Svelte runes here so the logic is unit-testable in plain Vitest.
 * The reactive wrapper lives in lib/stores/settings.svelte.ts.
 */

export type ClipLength = 15 | 30 | 60;
export type ClipQuality = "low" | "med" | "high";
/** Open enum: only "xbox" in v1; future PC-device capture adds "device:<id>". */
export type ClipAudioSource = "xbox";

export interface ClipSettings {
  enabled: boolean;
  lengthSec: ClipLength;
  quality: ClipQuality;
  audioSource: ClipAudioSource;
}

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  enabled: false,
  lengthSec: 30,
  quality: "med",
  audioSource: "xbox",
};

const STORAGE_KEY = "kite-clip-settings";

/** Minimal subset of the Web Storage API we depend on (for testability). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LENGTHS: readonly ClipLength[] = [15, 30, 60];
const QUALITIES: readonly ClipQuality[] = ["low", "med", "high"];

/** Coerce arbitrary parsed JSON into a valid ClipSettings, repairing bad fields. */
export function validateClipSettings(raw: unknown): ClipSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lengthSec = LENGTHS.includes(r.lengthSec as ClipLength)
    ? (r.lengthSec as ClipLength)
    : DEFAULT_CLIP_SETTINGS.lengthSec;
  const quality = QUALITIES.includes(r.quality as ClipQuality)
    ? (r.quality as ClipQuality)
    : DEFAULT_CLIP_SETTINGS.quality;
  return {
    enabled: r.enabled === true,
    lengthSec,
    quality,
    // v1: always "xbox" regardless of stored value.
    audioSource: "xbox",
  };
}

export function loadClipSettings(storage: StorageLike): ClipSettings {
  const rawStr = storage.getItem(STORAGE_KEY);
  if (rawStr === null) return { ...DEFAULT_CLIP_SETTINGS };
  try {
    return validateClipSettings(JSON.parse(rawStr));
  } catch {
    return { ...DEFAULT_CLIP_SETTINGS };
  }
}

export function saveClipSettings(storage: StorageLike, value: ClipSettings): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
}
