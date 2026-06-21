import type { SessionState } from "$lib/connection/types.js";

export const CONTROLS_AUTO_HIDE_MS = 2500;

/**
 * Controls auto-hide while actively streaming or when immersive/focus mode is enabled.
 */
export function shouldAutoHideControls(state: SessionState, focusMode: boolean): boolean {
  return focusMode || state === "streaming";
}
