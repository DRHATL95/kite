/**
 * closeToTray.ts — hide the window to the system tray on close instead of
 * quitting, when the user has enabled the setting.
 *
 * `handleCloseRequest` is the pure decision (dependency-injected window ops, so
 * it unit-tests without a real window). `registerCloseToTray` is the thin glue
 * that wires it to the live Tauri window's close-requested event.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settings } from "$lib/stores/settings.svelte.js";

export interface CloseOps {
  /** Swallow the OS close so the window stays alive. */
  preventDefault: () => void;
  /** Hide the window (webview keeps running — audio/keepalive continue). */
  hide: () => void | Promise<void>;
}

/**
 * When minimize-to-tray is on, swallow the close and hide the window; otherwise
 * do nothing and let the close proceed (the app quits).
 */
export function handleCloseRequest(minimizeToTray: boolean, ops: CloseOps): void {
  if (!minimizeToTray) return;
  ops.preventDefault();
  void ops.hide();
}

/** Wire the real window's close-requested event once. Call on app mount. */
export async function registerCloseToTray(): Promise<void> {
  const win = getCurrentWindow();
  await win.onCloseRequested((event) => {
    handleCloseRequest(settings.minimizeToTray, {
      preventDefault: () => event.preventDefault(),
      hide: () => win.hide(),
    });
  });
}
