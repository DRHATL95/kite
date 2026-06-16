/**
 * ui.svelte.ts — small transient UI flags shared across screens.
 *
 * Keeps the Settings modal open-state out of prop-threading so StreamControls
 * can open it without editing Stream.svelte.
 */

class UiStore {
  /** Whether the Settings modal is open. */
  settingsOpen: boolean = $state(false);

  openSettings(): void { this.settingsOpen = true; }
  closeSettings(): void { this.settingsOpen = false; }
}

export const uiStore = new UiStore();
