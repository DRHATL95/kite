<script lang="ts">
  /**
   * SettingsModal.svelte — App settings dialog.
   *
   * A lightweight modal overlay opened from the console list. Currently exposes:
   *   - Account → Sign out (clears the saved Microsoft login from this device)
   *   - About   → app version
   *
   * Structured in labelled sections so future settings (e.g. keybinds) can be
   * added without reworking the shell.
   *
   * Props:
   *   open    — bindable; whether the dialog is shown.
   *   onClose — called when the dialog should close (backdrop, Esc, or ✕).
   */

  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import Button from "$lib/design/Button.svelte";
  import ThemeSwitcher from "./ThemeSwitcher.svelte";

  interface Props {
    open?: boolean;
    onClose: () => void;
  }

  let { open = $bindable(false), onClose }: Props = $props();

  // ── App version (self-contained; resolved once) ───────────────────────────────
  let appVersion = $state("");
  onMount(() => {
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });

  // ── Sign out ───────────────────────────────────────────────────────────────────
  let signingOut = $state(false);

  async function handleSignOut() {
    signingOut = true;
    await authStore.signOut();
    signingOut = false;
    // authState is now 'signedOut' → App routes back to Login. Close the dialog.
    onClose();
  }

  // ── Dismissal ───────────────────────────────────────────────────────────────────
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if open}
  <!-- Backdrop: click outside the panel closes the dialog -->
  <div
    class="settings-backdrop"
    role="presentation"
    onclick={onClose}
  >
    <!-- Dialog panel: stop propagation so inner clicks don't close it -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="settings-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="settings-header">
        <h2 id="settings-title" class="settings-title">Settings</h2>
        <button
          type="button"
          class="settings-close"
          onclick={onClose}
          aria-label="Close settings"
          title="Close"
        >
          ✕
        </button>
      </header>

      <!-- ── Appearance ──────────────────────────────────────────────────── -->
      <section class="settings-section">
        <span class="settings-section__label">APPEARANCE</span>
        <div class="settings-row settings-row--stack">
          <div class="settings-row__text">
            <span class="settings-row__title">Theme</span>
            <span class="settings-row__desc">Switches instantly and is remembered.</span>
          </div>
          <ThemeSwitcher variant="chips" />
        </div>
      </section>

      <!-- ── Account ─────────────────────────────────────────────────────── -->
      <section class="settings-section">
        <span class="settings-section__label">ACCOUNT</span>
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Sign out</span>
            <span class="settings-row__desc">
              Clears your saved Microsoft login from this device. You'll need to
              sign in again next time.
            </span>
          </div>
          <Button variant="danger" onclick={handleSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </section>

      <!-- ── About ───────────────────────────────────────────────────────── -->
      <section class="settings-section">
        <span class="settings-section__label">ABOUT</span>
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Xbox Remote</span>
            <span class="settings-row__desc">
              {appVersion ? `Version ${appVersion}` : "Version unavailable"}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--bg) 65%, transparent);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }

  .settings-panel {
    width: 100%;
    max-width: 440px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md, var(--shadow-sm));
    overflow: hidden;
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .settings-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text);
  }

  .settings-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: var(--text-base);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .settings-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .settings-close:focus-visible {
    box-shadow: var(--focus-ring);
  }

  .settings-section {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .settings-section + .settings-section {
    border-top: 1px solid var(--border);
  }

  .settings-section__label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  /* Stacked variant: label above, controls wrap below (theme chips). */
  .settings-row--stack {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .settings-row__text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .settings-row__title {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--text);
  }

  .settings-row__desc {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: 1.5;
  }
</style>
