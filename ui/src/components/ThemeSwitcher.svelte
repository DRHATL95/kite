<script lang="ts">
  /**
   * ThemeSwitcher.svelte — live theme picker.
   *
   * Two variants:
   *   "dots"  — compact swatch dots (used on the Login screen).
   *   "chips" — labelled swatch chips (used in Settings).
   *
   * Each option previews the theme's [bg, surface, accent] and switches the
   * app theme instantly via themeStore.
   */

  import { THEMES } from "$lib/design/themes.js";
  import { themeStore } from "$lib/stores/theme.svelte.js";

  interface Props {
    variant?: "dots" | "chips";
  }

  let { variant = "chips" }: Props = $props();
</script>

<div class="theme-switcher theme-switcher--{variant}" role="radiogroup" aria-label="Theme">
  {#each THEMES as theme (theme.id)}
    {@const active = themeStore.current === theme.id}
    <button
      type="button"
      class="theme-opt"
      class:theme-opt--active={active}
      role="radio"
      aria-checked={active}
      title={theme.label}
      onclick={() => themeStore.set(theme.id)}
    >
      <span
        class="theme-opt__swatch"
        style="--c-bg: {theme.swatch[0]}; --c-surface: {theme.swatch[1]}; --c-accent: {theme.swatch[2]};"
        aria-hidden="true"
      ></span>
      {#if variant === "chips"}
        <span class="theme-opt__label">{theme.label}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .theme-switcher {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .theme-switcher--dots {
    gap: var(--space-3);
    justify-content: center;
  }

  /* ── Option button ──────────────────────────────────────────────────── */
  .theme-opt {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    background: transparent;
    border: none;
    cursor: pointer;
    border-radius: var(--radius-pill);
  }

  .theme-opt:focus-visible {
    box-shadow: var(--focus-ring);
  }

  /* The swatch: a layered disc previewing bg / surface / accent. */
  .theme-opt__swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    flex-shrink: 0;
    background:
      conic-gradient(var(--c-accent) 0 33%, var(--c-surface) 0 66%, var(--c-bg) 0);
    border: 1px solid color-mix(in srgb, var(--text-dim) 40%, transparent);
    box-shadow: var(--shadow-sm);
    transition: transform 160ms var(--ease-out), box-shadow 160ms var(--ease-out);
  }

  .theme-opt:hover .theme-opt__swatch {
    transform: scale(1.12);
  }

  /* Active: accent ring around the swatch. */
  .theme-opt--active .theme-opt__swatch {
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
  }

  /* ── Chips variant ──────────────────────────────────────────────────── */
  .theme-switcher--chips .theme-opt {
    padding: var(--space-1) var(--space-3) var(--space-1) var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    transition: border-color 140ms ease, background 140ms ease;
  }

  .theme-switcher--chips .theme-opt:hover {
    background: var(--surface-2);
    border-color: var(--text-dim);
  }

  .theme-switcher--chips .theme-opt--active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .theme-opt__label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
  }

  /* In chips, the swatch is a touch smaller. */
  .theme-switcher--chips .theme-opt__swatch {
    width: 18px;
    height: 18px;
  }
</style>
