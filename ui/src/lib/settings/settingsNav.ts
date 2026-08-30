/**
 * settingsNav.ts — the Settings view's category model (pure).
 *
 * Categories are shown in a sidebar in this order; the content pane renders one
 * at a time. Keep in sync with the `{#if active === ...}` branches in
 * SettingsView.svelte.
 */
export interface SettingsCategory {
  id: string;
  label: string;
}

/** Sidebar categories in display order. */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", label: "General" },
  { id: "stream", label: "Stream" },
  { id: "controller", label: "Controller" },
  { id: "about", label: "About" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** Category shown when the view first opens. */
export const DEFAULT_CATEGORY = "general";

/** True if `id` is a known category. */
export function isValidCategory(id: string): boolean {
  return SETTINGS_CATEGORIES.some((c) => c.id === id);
}
