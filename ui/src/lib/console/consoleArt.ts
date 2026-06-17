/**
 * consoleArt.ts — Pure presentation logic for console identity.
 *
 * The xHome API returns no console image, only a `consoleType` enum string.
 * We map that string to a model key (which artwork to draw) and to a friendly
 * label. Both are pure functions so they can be unit-tested without mounting
 * the Svelte component (the .svelte file is validated by svelte-check).
 */

/** Which bundled illustration to render. */
export type ConsoleModelKey =
  | "seriesX"
  | "seriesS"
  | "one"
  | "oneS"
  | "oneX"
  | "generic";

const MODEL_BY_TYPE: Record<string, ConsoleModelKey> = {
  XboxSeriesX: "seriesX",
  XboxSeriesS: "seriesS",
  XboxOne: "one",
  XboxOneS: "oneS",
  XboxOneX: "oneX",
};

/** Resolve a console type string to its artwork model key (fallback: generic). */
export function resolveConsoleModel(consoleType: string): ConsoleModelKey {
  return MODEL_BY_TYPE[consoleType] ?? "generic";
}

const LABEL_BY_TYPE: Record<string, string> = {
  XboxSeriesX: "Xbox Series X",
  XboxSeriesS: "Xbox Series S",
  XboxOne: "Xbox One",
  XboxOneS: "Xbox One S",
  XboxOneX: "Xbox One X",
};

/** Friendly display label for a console type (fallback: the raw string). */
export function consoleTypeLabel(consoleType: string): string {
  return LABEL_BY_TYPE[consoleType] ?? consoleType;
}
