import type { SessionState } from "$lib/connection/types.js";

export const CONTROLS_AUTO_HIDE_MS = 2500;

export function shouldAutoHideControls(state: SessionState, focusMode: boolean): boolean {
  return focusMode || state === "streaming";
}
