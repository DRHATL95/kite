/**
 * store.ts — durable settings persistence.
 *
 * tauri-plugin-store is async; our settings stores read synchronously at
 * construction. This adapter loads the store once at startup (initPersistence),
 * hydrates an in-memory snapshot, and exposes a synchronous StorageLike
 * (`persisted`) over it with write-through persistence. Swapping `localStorage`
 * for `persisted` is the only change each store needs.
 */

import type { StorageLike } from "../settings/clipSettings.js";
import { migrateLegacyKeys } from "./migrateLegacyKeys.js";

/** Minimal backend the adapter persists through (injectable for tests). */
export interface PersistBackend {
  entries(): Promise<[string, string][]>;
  set(key: string, value: string): Promise<void>;
  /** Remove a key. Optional so lightweight test backends need not implement it;
   *  used by the one-time legacy-key migration to drop renamed keys. */
  delete?(key: string): Promise<void>;
}

const STORE_FILE = "settings.json";

const snapshot = new Map<string, string>();
let backend: PersistBackend | null = null;

/** Synchronous StorageLike over the hydrated snapshot, with write-through. */
export const persisted: StorageLike = {
  getItem(key: string): string | null {
    return snapshot.has(key) ? snapshot.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    snapshot.set(key, value);
    // Fire-and-forget; the plugin debounces the actual disk save.
    void backend?.set(key, value);
  },
};

/** Build the real tauri-plugin-store backend (loaded lazily so tests/jsdom
 *  never need the Tauri runtime). */
async function createTauriBackend(): Promise<PersistBackend> {
  const { Store } = await import("@tauri-apps/plugin-store");
  const store = await Store.load(STORE_FILE);
  return {
    entries: () => store.entries() as Promise<[string, string][]>,
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key).then(() => undefined),
  };
}

/**
 * Load persisted settings into the snapshot. Call once before mount.
 * Falls back to an empty in-memory backend if the store can't load, so the
 * app still runs with defaults rather than crashing.
 */
export async function initPersistence(injected?: PersistBackend): Promise<void> {
  try {
    backend = injected ?? (await createTauriBackend());
    const entries = await backend.entries();
    snapshot.clear();
    for (const [k, v] of entries) snapshot.set(k, v);

    // One-time rebrand migration: rename any surviving `xbox-remote*` keys to
    // their `kite*` equivalents in the snapshot, then write the change through
    // (persist the new key when copied, drop the legacy key either way).
    for (const m of migrateLegacyKeys(snapshot)) {
      if (m.copied) void backend?.set(m.newKey, m.value);
      void backend?.delete?.(m.oldKey);
    }
  } catch (err) {
    console.warn("persistence init failed; using in-memory defaults", err);
    backend = null;
    snapshot.clear();
  }
}

/** Test seam: inject a backend (or null) and reset the snapshot. */
export function __setBackendForTests(b: PersistBackend | null): void {
  backend = b;
  snapshot.clear();
}
