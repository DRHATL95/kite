import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLIP_SETTINGS,
  loadClipSettings,
  saveClipSettings,
  validateClipSettings,
  type StorageLike,
} from "./clipSettings.js";

/** In-memory StorageLike for tests. */
function memStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("clipSettings", () => {
  it("returns defaults when storage is empty", () => {
    expect(loadClipSettings(memStorage())).toEqual(DEFAULT_CLIP_SETTINGS);
  });

  it("round-trips saved settings", () => {
    const s = memStorage();
    const value = { enabled: true, lengthSec: 60, quality: "high", audioSource: "xbox" } as const;
    saveClipSettings(s, value);
    expect(loadClipSettings(s)).toEqual(value);
  });

  it("falls back per-field on invalid values", () => {
    expect(validateClipSettings({ enabled: "yes", lengthSec: 7, quality: "ultra", audioSource: "device:1" }))
      .toEqual(DEFAULT_CLIP_SETTINGS);
  });

  it("keeps valid fields and repairs invalid ones", () => {
    expect(validateClipSettings({ enabled: true, lengthSec: 15, quality: "nope" }))
      .toEqual({ enabled: true, lengthSec: 15, quality: "med", audioSource: "xbox" });
  });

  it("returns defaults on corrupt JSON", () => {
    expect(loadClipSettings(memStorage({ "kite-clip-settings": "{not json" })))
      .toEqual(DEFAULT_CLIP_SETTINGS);
  });
});
