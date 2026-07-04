/**
 * gamepadCapture.ts — press-to-bind capture for the Controller settings pane.
 * detectActiveSource is pure; startCapture is a thin rAF shell (added in Task 10).
 */
import { AXIS_ACTIVE_THRESHOLD, type Source } from "./controllerMapping.js";

export interface GamepadSnapshot {
  /** Per-button magnitude: pressed digital → 1, else analog value. */
  buttons: number[];
  axes: number[];
}

/** Snapshot a live Gamepad. Uses pressed||value so a pressed digital button (value 0) still reads 1. */
export function snapshotOf(gp: Gamepad): GamepadSnapshot {
  return {
    buttons: Array.from(gp.buttons).map((b) => (b.pressed ? 1 : b.value)),
    axes: Array.from(gp.axes),
  };
}

/** First source active NOW but inactive in `baseline`, else null. Buttons scanned before axes. */
export function detectActiveSource(now: GamepadSnapshot, baseline: GamepadSnapshot): Source | null {
  for (let i = 0; i < now.buttons.length; i++) {
    const v = now.buttons[i] ?? 0;
    const b = baseline.buttons[i] ?? 0;
    if (v >= AXIS_ACTIVE_THRESHOLD && b < AXIS_ACTIVE_THRESHOLD) return { kind: "button", index: i };
  }
  for (let a = 0; a < now.axes.length && a < 4; a++) {
    const v = now.axes[a] ?? 0;
    const b = baseline.axes[a] ?? 0;
    if (Math.abs(v) >= AXIS_ACTIVE_THRESHOLD && Math.abs(b) < AXIS_ACTIVE_THRESHOLD) {
      return { kind: "axis", axis: a as 0 | 1 | 2 | 3, sign: v > 0 ? 1 : -1 };
    }
  }
  return null;
}
