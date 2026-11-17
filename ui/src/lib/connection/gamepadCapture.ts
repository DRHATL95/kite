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

/**
 * Capture the next physical input. Baseline is taken on the first observed frame,
 * so an already-held control does not capture. Escape (capture-phase,
 * stopImmediatePropagation) cancels without also closing SettingsView. Returns a
 * cancel function. Resolves onResult(null) on cancel/timeout.
 */
export function startCapture(onResult: (s: Source | null) => void, timeoutMs = 10_000): () => void {
  let raf = 0;
  let baseline: GamepadSnapshot | null = null;
  let done = false;
  let startTs = -1;
  let sawPadAtStart = false;
  let firstFrame = true;

  const zeroLike = (pad: Gamepad): GamepadSnapshot => ({
    buttons: Array.from(pad.buttons).map(() => 0),
    axes: Array.from(pad.axes).map(() => 0),
  });

  const finish = (s: Source | null): void => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    onResult(s);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      e.preventDefault();
      finish(null);
    }
  };
  const firstPad = (): Gamepad | null => {
    const gps = typeof navigator !== "undefined" ? navigator.getGamepads() : null;
    if (!gps) return null;
    return gps[0] || gps[1] || gps[2] || gps[3] || null;
  };
  const loop = (ts: number): void => {
    if (done) return;
    if (startTs < 0) startTs = ts;
    if (ts - startTs > timeoutMs) { finish(null); return; }
    const pad = firstPad();
    if (firstFrame) { sawPadAtStart = !!pad; firstFrame = false; }
    if (pad) {
      const s = snapshotOf(pad);
      if (!baseline) {
        // Warm pad (visible at t0): baseline = its current state, so a control
        // already held when Detect started is ignored. Cold pad (WebView2 gates
        // gamepad visibility behind a gesture, so it only appears once the user
        // presses): that first press IS the intended input — baseline against
        // zero and capture it on this very frame.
        baseline = sawPadAtStart ? s : zeroLike(pad);
        if (!sawPadAtStart) {
          const found = detectActiveSource(s, baseline);
          if (found) { finish(found); return; }
        }
      } else {
        const found = detectActiveSource(s, baseline);
        if (found) { finish(found); return; }
      }
    }
    raf = requestAnimationFrame(loop);
  };

  window.addEventListener("keydown", onKey, true);
  raf = requestAnimationFrame(loop);
  return () => finish(null);
}
