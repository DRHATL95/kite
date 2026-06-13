/**
 * themes.ts — Theme registry for the Signal Deck design system.
 *
 * Each entry maps to a `:root[data-theme="<id>"]` block in tokens.css. The
 * `swatch` triple ([bg, surface, accent]) drives the theme picker chips so the
 * picker stays in sync without re-reading CSS.
 */

export interface ThemeDef {
  /** Value written to <html data-theme="…">. */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  /** [background, surface, accent] preview colours for the picker chip. */
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "carbon", label: "Carbon", swatch: ["#0c0e0c", "#1d211d", "#46cf68"] },
  { id: "midnight", label: "Midnight", swatch: ["#080b12", "#161e2b", "#36cfe8"] },
  { id: "synth", label: "Synthwave", swatch: ["#120a1f", "#271843", "#ff48c4"] },
  { id: "ember", label: "Ember", swatch: ["#0d0a07", "#1f1710", "#ffa53a"] },
  { id: "paper", label: "Paper", swatch: ["#f3efe7", "#e0d8c8", "#c1452c"] },
];

export const DEFAULT_THEME = "carbon";
export const THEME_IDS: string[] = THEMES.map((t) => t.id);
