/**
 * migrateLegacyKeys.ts — one-time rename of pre-"Kite" persisted settings keys.
 *
 * The app was formerly "Xbox Remote", so early builds wrote settings under
 * `xbox-remote*` keys in the tauri-plugin-store file. After the rebrand those
 * became `kite*`. This migration renames any surviving legacy keys in the
 * hydrated snapshot so existing users keep their theme, volume, channel, and
 * clip preferences instead of silently reverting to defaults.
 *
 * The rename logic is a pure function over the snapshot Map (no I/O, no Tauri
 * runtime) so it is trivially unit-testable; `initPersistence` owns the
 * write-through (persist the new key, delete the legacy one).
 */

/** Legacy persisted-store keys → their current (`kite*`) names. */
export const LEGACY_KEY_MAP: ReadonlyArray<readonly [string, string]> = [
  ["xbox-remote-theme", "kite-theme"],
  ["xbox-remote:update-channel", "kite:update-channel"],
  ["xbox-remote:log-verbose", "kite:log-verbose"],
  ["xbox-remote:audio-only", "kite:audio-only"],
  ["xbox-remote-clip-settings", "kite-clip-settings"],
  ["xbox-remote-volume", "kite-volume"],
];

export interface KeyMigration {
  oldKey: string;
  newKey: string;
  value: string;
  /**
   * true when the value was copied to newKey; false when newKey already held a
   * (newer) value and the legacy key was simply dropped without clobbering it.
   */
  copied: boolean;
}

/**
 * Rename legacy keys in a hydrated snapshot, in place.
 *
 * For each legacy key present in the snapshot: if the new key is absent, copy
 * the value across; either way, remove the legacy key. An existing new-key
 * value is never overwritten. Returns the migrations performed so the caller
 * can write them through to the persistence backend.
 */
export function migrateLegacyKeys(snapshot: Map<string, string>): KeyMigration[] {
  const migrations: KeyMigration[] = [];
  for (const [oldKey, newKey] of LEGACY_KEY_MAP) {
    if (!snapshot.has(oldKey)) continue;
    const value = snapshot.get(oldKey)!;
    const copied = !snapshot.has(newKey);
    if (copied) snapshot.set(newKey, value);
    snapshot.delete(oldKey);
    migrations.push({ oldKey, newKey, value, copied });
  }
  return migrations;
}
