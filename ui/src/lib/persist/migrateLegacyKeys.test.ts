import { describe, it, expect } from "vitest";
import { migrateLegacyKeys, LEGACY_KEY_MAP } from "./migrateLegacyKeys.js";

describe("migrateLegacyKeys", () => {
  it("copies a legacy value to the new key and removes the legacy key", () => {
    const snap = new Map([["xbox-remote-theme", "midnight"]]);
    const migrations = migrateLegacyKeys(snap);

    expect(snap.get("kite-theme")).toBe("midnight");
    expect(snap.has("xbox-remote-theme")).toBe(false);
    expect(migrations).toEqual([
      { oldKey: "xbox-remote-theme", newKey: "kite-theme", value: "midnight", copied: true },
    ]);
  });

  it("does not clobber an existing new-key value; drops the legacy key", () => {
    const snap = new Map([
      ["xbox-remote-theme", "carbon"], // stale legacy
      ["kite-theme", "midnight"], // already migrated / newer
    ]);
    const migrations = migrateLegacyKeys(snap);

    expect(snap.get("kite-theme")).toBe("midnight"); // untouched
    expect(snap.has("xbox-remote-theme")).toBe(false); // still removed
    expect(migrations).toEqual([
      { oldKey: "xbox-remote-theme", newKey: "kite-theme", value: "carbon", copied: false },
    ]);
  });

  it("leaves unrelated keys untouched", () => {
    const snap = new Map([["kite:minimize-to-tray", "true"]]);
    const migrations = migrateLegacyKeys(snap);

    expect(snap.get("kite:minimize-to-tray")).toBe("true");
    expect(migrations).toEqual([]);
  });

  it("is a no-op when no legacy keys are present", () => {
    const snap = new Map<string, string>();
    expect(migrateLegacyKeys(snap)).toEqual([]);
    expect(snap.size).toBe(0);
  });

  it("migrates every mapped legacy key", () => {
    const snap = new Map(LEGACY_KEY_MAP.map(([oldKey], i) => [oldKey, `v${i}`]));
    const migrations = migrateLegacyKeys(snap);

    expect(migrations).toHaveLength(LEGACY_KEY_MAP.length);
    for (const [oldKey, newKey] of LEGACY_KEY_MAP) {
      expect(snap.has(oldKey)).toBe(false);
      expect(snap.has(newKey)).toBe(true);
    }
  });

  it("never maps a legacy key onto another legacy key (self-consistent map)", () => {
    const oldKeys = new Set(LEGACY_KEY_MAP.map(([o]) => o));
    for (const [, newKey] of LEGACY_KEY_MAP) {
      expect(oldKeys.has(newKey)).toBe(false);
    }
  });
});
