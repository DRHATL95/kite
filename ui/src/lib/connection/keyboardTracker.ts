/**
 * keyboardTracker.ts — keyboard-as-gamepad capture for the live input path.
 *
 * Maintains the set of currently-held *mapped* keys (`KeyboardEvent.code`) so
 * `GamepadPoller` can translate them via `mapKeyboardToGamepad` when no physical
 * controller is present (the poller prefers a real pad, so keyboard is a pure
 * fallback). The pure mapping lives in `input.ts`; this module is the thin DOM
 * glue around it, with three behaviours a naive listener would miss:
 *
 *   1. Ignore keys while a text field is focused, so typing in Settings / the
 *      diagnostics HUD is never hijacked.
 *   2. Release every key on window blur / tab-hidden, so a key held during an
 *      alt-tab doesn't stay "down" forever (runaway movement).
 *   3. preventDefault only on mapped keys, so Space/arrows don't scroll the page
 *      while other shortcuts (F5, Ctrl+C, …) keep working.
 */

import { isMappedKey } from "./input.js";

/** True when `target` is a text-entry element whose typing we must not capture. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // `isContentEditable` covers inherited editing hosts; the attribute is a
  // robust fallback (empty / "true" / "plaintext-only" all mean editable, and
  // it works even where the computed property isn't available).
  if (target.isContentEditable) return true;
  const ce = target.getAttribute("contenteditable");
  if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class KeyboardTracker {
  private readonly keys = new Set<string>();
  private readonly target: EventTarget | null;
  private attached = false;

  /**
   * @param target  Event source for key/blur listeners. Defaults to `window`,
   *                or `null` in a non-DOM environment (SSR / node tests), where
   *                the tracker is simply inert. Injectable for tests.
   */
  constructor(
    target: EventTarget | null = typeof window !== "undefined" ? window : null,
  ) {
    this.target = target;
  }

  /** Live set of currently-held mapped key codes (read by the poller each tick). */
  get pressed(): Set<string> {
    return this.keys;
  }

  /** Begin capturing. Idempotent. */
  attach(): void {
    if (this.attached || !this.target) return;
    this.attached = true;
    this.target.addEventListener("keydown", this.onKeyDown as EventListener);
    this.target.addEventListener("keyup", this.onKeyUp as EventListener);
    // Clear on focus loss so keys never stick after an alt-tab / minimise.
    this.target.addEventListener("blur", this.onClear);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  /** Stop capturing and release all keys. Idempotent. */
  detach(): void {
    this.keys.clear();
    if (!this.attached || !this.target) return;
    this.attached = false;
    this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
    this.target.removeEventListener("keyup", this.onKeyUp as EventListener);
    this.target.removeEventListener("blur", this.onClear);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target)) return; // don't hijack text entry
    if (!isMappedKey(e.code)) return; // leave unmapped keys to the browser
    e.preventDefault();
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onClear = (): void => {
    this.keys.clear();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.keys.clear();
  };
}
