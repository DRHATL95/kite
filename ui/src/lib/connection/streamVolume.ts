/**
 * streamVolume — pure slider-percent → linear-gain mapping.
 *
 * Kept dependency-free (no DOM / no AudioContext) so the gain math is unit
 * tested in isolation. Used by StreamControls (browser Web Audio gain) and by
 * the native volume path.
 */

/** Volume slider ceiling in percent. Above 100% amplifies via a Web Audio gain. */
export const VOLUME_MAX_PCT = 150;

/**
 * Convert a slider percent to a linear gain, clamped to `[0, VOLUME_MAX_PCT/100]`.
 * `0 → 0.0` (silent), `100 → 1.0` (unity), `150 → 1.5` (max boost).
 */
export function pctToGain(pct: number): number {
  const clamped = Math.max(0, Math.min(VOLUME_MAX_PCT, pct));
  return clamped / 100;
}
