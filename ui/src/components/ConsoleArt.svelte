<script lang="ts">
  /**
   * ConsoleArt.svelte — Flat, themed SVG illustration of an Xbox console.
   *
   * Picks the silhouette from `consoleType` via resolveConsoleModel(). Body
   * colours are model-correct (black towers/slabs vs. white boxes); the power
   * ring / dot uses --accent so it tints with the active theme. The element
   * carrying class `console-art__pulse` is the accent highlight — the
   * connecting splash animates it via a :global selector.
   */
  import { resolveConsoleModel } from "$lib/console/consoleArt.js";

  interface Props {
    /** Xbox consoleType string (e.g. "XboxSeriesX"). */
    consoleType: string;
    /** Rendered size in px (square). */
    size?: number;
    /** Dim the art (used for standby consoles). */
    dimmed?: boolean;
  }

  let { consoleType, size = 48, dimmed = false }: Props = $props();

  const model = $derived(resolveConsoleModel(consoleType));
</script>

<span
  class="console-art"
  class:console-art--dimmed={dimmed}
  style="--art-size: {size}px"
  aria-hidden="true"
>
  {#if model === "seriesX"}
    <svg viewBox="0 0 64 64">
      <rect x="23" y="5" width="18" height="54" rx="4" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <circle cx="32" cy="14" r="6" fill="var(--console-dark)" stroke="var(--accent)" stroke-width="1.6" />
      <circle class="console-art__pulse" cx="32" cy="14" r="2.3" fill="var(--accent)" />
    </svg>
  {:else if model === "seriesS"}
    <svg viewBox="0 0 64 64">
      <rect x="14" y="17" width="36" height="30" rx="4" fill="var(--console-light)" stroke="var(--console-edge-light)" />
      <circle cx="24" cy="32" r="7" fill="var(--console-dark)" />
      <circle class="console-art__pulse" cx="44" cy="42" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "one"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="22" width="50" height="20" rx="3" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <line x1="32" y1="22" x2="32" y2="42" stroke="var(--console-edge)" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "oneS"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="22" width="50" height="20" rx="3" fill="var(--console-light)" stroke="var(--console-edge-light)" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "oneX"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="23" width="50" height="18" rx="3" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <path d="M40 27 H52 M40 31 H52 M40 35 H52" stroke="var(--console-edge)" stroke-width="1" fill="none" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else}
    <svg viewBox="0 0 64 64">
      <rect x="12" y="22" width="40" height="20" rx="4" fill="var(--surface-2)" stroke="var(--border)" />
      <circle class="console-art__pulse" cx="20" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {/if}
</span>

<style>
  .console-art {
    display: inline-flex;
    width: var(--art-size);
    height: var(--art-size);
    flex-shrink: 0;
  }
  .console-art svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .console-art--dimmed {
    opacity: 0.55;
  }
</style>
