/**
 * theme.svelte.ts — Reactive theme store.
 *
 * Persists the selected theme to the durable settings store and reflects it onto
 * <html data-theme="…">, which tokens.css keys its colour palettes off.
 *
 * Usage:
 *   import { themeStore } from '$lib/stores/theme.svelte';
 *   themeStore.init();              // once at startup (main.ts), before mount
 *   themeStore.set('midnight');     // switch live
 *   themeStore.current;             // reactive current id
 */

import { THEME_IDS, DEFAULT_THEME } from "$lib/design/themes.js";
import { persisted } from "../persist/store.js";

const STORAGE_KEY = "xbox-remote-theme";

/** Read the persisted theme id, falling back to the default. */
function readInitial(): string {
  try {
    const saved = persisted.getItem(STORAGE_KEY);
    if (saved && THEME_IDS.includes(saved)) return saved;
  } catch {
    // persistence unavailable — use default
  }
  return DEFAULT_THEME;
}

/** Reflect a theme id onto the document root. */
function applyToDom(id: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = id;
  }
}

class ThemeStore {
  /** Currently active theme id (reactive). */
  current: string = $state(readInitial());

  /** Apply the persisted/initial theme to the DOM. Call once at startup. */
  init(): void {
    applyToDom(this.current);
  }

  /** Switch theme, persist it, and reflect it onto the DOM. */
  set(id: string): void {
    if (!THEME_IDS.includes(id) || id === this.current) {
      if (THEME_IDS.includes(id)) applyToDom(id);
      return;
    }
    this.current = id;
    applyToDom(id);
    try {
      persisted.setItem(STORAGE_KEY, id);
    } catch {
      // best-effort persistence
    }
  }
}

export const themeStore = new ThemeStore();
