/**
 * streamVolume — pure slider-percent → linear-gain mapping.
 *
 * Kept dependency-free (no DOM / no AudioContext) so the gain math is unit
 * tested in isolation. Used by StreamControls (browser Web Audio gain) and by
 * the native volume path.
 */

/**
 * Volume slider ceiling in percent. Unity is the maximum — the slider attenuates
 * only, it never amplifies. Drive the slider's `max` AND its track fill from this
 * constant: with a ceiling of 100 "percent of value" and "percent of track width"
 * coincide, and hardcoding either one silently desyncs the fill from the thumb if
 * the ceiling ever moves again.
 */
export const VOLUME_MAX_PCT = 100;

/**
 * Convert a slider percent to a linear gain, clamped to `[0, VOLUME_MAX_PCT/100]`.
 * `0 → 0.0` (silent), `100 → 1.0` (unity).
 */
export function pctToGain(pct: number): number {
  const clamped = Math.max(0, Math.min(VOLUME_MAX_PCT, pct));
  return clamped / 100;
}
