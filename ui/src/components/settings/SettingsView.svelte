<script lang="ts">
  /**
   * SettingsView.svelte — full-window settings surface. Left category sidebar +
   * right content pane (one category at a time), replacing the too-tall modal.
   * Mounted from the ConsoleList gear. Back arrow / Escape close it.
   */
  import { SETTINGS_CATEGORIES, DEFAULT_CATEGORY } from "$lib/settings/settingsNav.js";
  import StreamingSettings from "./StreamingSettings.svelte";
  import ControllerSettings from "./ControllerSettings.svelte";
  import GeneralSettings from "./GeneralSettings.svelte";
  import DiagnosticsSettings from "./DiagnosticsSettings.svelte";
  import AboutSettings from "./AboutSettings.svelte";

  interface Props {
    open?: boolean;
    onClose: () => void;
  }
  let { open = false, onClose }: Props = $props();

  let active = $state(DEFAULT_CATEGORY);

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if open}
  <div class="settings-view" role="dialog" aria-modal="true" aria-label="Settings">
    <header class="settings-view__header">
      <button type="button" class="settings-view__back" onclick={onClose} aria-label="Back" title="Back">←</button>
      <h2 class="settings-view__title">Settings</h2>
    </header>

    <div class="settings-view__body">
      <nav class="settings-nav" aria-label="Settings categories">
        {#each SETTINGS_CATEGORIES as cat (cat.id)}
          <button
            type="button"
            class="settings-nav__item"
            class:settings-nav__item--active={active === cat.id}
            aria-current={active === cat.id ? "page" : undefined}
            onclick={() => (active = cat.id)}
          >{cat.label}</button>
        {/each}
      </nav>

      <div class="settings-content">
        {#if active === "stream"}
          <StreamingSettings />
        {:else if active === "controller"}
          <ControllerSettings />
        {:else if active === "general"}
          <GeneralSettings />
        {:else if active === "diagnostics"}
          <DiagnosticsSettings />
        {:else if active === "about"}
          <AboutSettings {onClose} />
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-view {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .settings-view__header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .settings-view__back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: var(--text-lg);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .settings-view__back:hover { background: var(--surface-2); color: var(--text); }
  .settings-view__back:focus-visible { box-shadow: var(--focus-ring); }

  .settings-view__title {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text);
  }

  .settings-view__body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 200px;
    flex-shrink: 0;
    padding: var(--space-3);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .settings-nav__item {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .settings-nav__item:hover { background: var(--surface-2); color: var(--text); }
  .settings-nav__item--active { background: var(--surface-2); color: var(--text); font-weight: 500; }
  .settings-nav__item:focus-visible { box-shadow: var(--focus-ring); }

  .settings-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    max-width: 640px;
  }

  /* Shared row/chip styles for the category components (descendant-scoped
     globals so each category component stays style-free and DRY). */
  .settings-content :global(.settings-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .settings-content :global(.settings-row--stack) {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }
  .settings-content :global(.settings-row__text) {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .settings-content :global(.settings-row__title) {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--text);
  }
  .settings-content :global(.settings-row__desc) {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: 1.5;
  }
  .settings-content :global(.clip-chips) {
    display: inline-flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }
  .settings-content :global(.clip-chip) {
    padding: var(--space-1) var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .settings-content :global(.clip-chip:hover:not(:disabled)) { background: var(--surface-2); }
  .settings-content :global(.clip-chip--on) {
    background: color-mix(in srgb, var(--accent, var(--text)) 16%, transparent);
    border-color: var(--accent, var(--text));
  }
  .settings-content :global(.clip-chip:focus-visible) { box-shadow: var(--focus-ring); }
  .settings-content :global(.clip-chip:disabled) {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
