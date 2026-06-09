<script lang="ts">
  /**
   * DiagnosticsHud.svelte — Read-only telemetry overlay.
   *
   * Consumes connectionStore.snapshot (or a `snapshot` prop override for dev/test).
   * Toggleable via an internal `open` $state and an optional external `visible` prop.
   *
   * Sub-panels:
   *   VideoPanel   — fps, resolution, frames, freezes, bitrate
   *   NetworkPanel — RTT, candidate types, ICE states, ICE provenance (Spec-3 key)
   *   PacketPanel  — loss %, jitter, NACK/PLI, keyframe requests
   *   SessionPanel — lifecycle state, keepalive, reconnect
   *   ChannelPanel — per-channel open/closed, handshake, track skew, input rate
   *
   * Dev affordance: pass `snapshot={mockSnapshot}` to render with fully-populated
   * data without a live Xbox session.  Defaults to connectionStore.snapshot.
   *
   * Usage:
   *   <DiagnosticsHud />
   *   <DiagnosticsHud snapshot={mockSnapshot} />           <!-- dev override -->
   *   <DiagnosticsHud bind:visible={hudOpen} />
   */

  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  import VideoPanel   from "./hud/VideoPanel.svelte";
  import NetworkPanel from "./hud/NetworkPanel.svelte";
  import PacketPanel  from "./hud/PacketPanel.svelte";
  import SessionPanel from "./hud/SessionPanel.svelte";
  import ChannelPanel from "./hud/ChannelPanel.svelte";

  // ── Props ────────────────────────────────────────────────────────────────────

  interface Props {
    /**
     * Optional snapshot override — used for dev/test to inject a mockSnapshot
     * without a live Xbox session.  When omitted, falls back to connectionStore.snapshot.
     */
    snapshot?: DiagnosticsSnapshot | null;
    /**
     * External visibility control.  When provided the parent can show/hide the
     * HUD.  The internal toggle button also flips this via bind.
     */
    visible?: boolean;
  }

  let {
    snapshot: snapshotProp = undefined,
    visible = $bindable(false),
  }: Props = $props();

  // ── Active snapshot ──────────────────────────────────────────────────────────

  /** Resolves to the prop override if provided, otherwise the store value. */
  const activeSnapshot = $derived(
    snapshotProp !== undefined ? snapshotProp : connectionStore.snapshot,
  );

  // ── Toggle ───────────────────────────────────────────────────────────────────

  function toggle() {
    visible = !visible;
  }

  // ── Keyboard shortcut: backtick ` opens/closes the HUD ──────────────────────

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "`" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggle();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Toggle button — always visible, unobtrusive pill in the corner -->
<button
  class="hud-toggle"
  class:hud-toggle--active={visible}
  onclick={toggle}
  aria-expanded={visible}
  aria-controls="diagnostics-hud"
  title="Toggle diagnostics HUD (` key)"
>
  HUD
</button>

<!-- HUD overlay panel -->
{#if visible}
  <aside
    id="diagnostics-hud"
    class="hud"
    aria-label="Diagnostics HUD"
  >
    <header class="hud__header">
      <span class="hud__title">Diagnostics</span>
      {#if activeSnapshot == null}
        <span class="hud__status">awaiting connection</span>
      {:else}
        <span class="hud__status hud__status--live">live</span>
      {/if}
      <button class="hud__close" onclick={toggle} aria-label="Close HUD">✕</button>
    </header>

    <div class="hud__grid">
      <VideoPanel   snapshot={activeSnapshot} />
      <NetworkPanel snapshot={activeSnapshot} />
      <PacketPanel  snapshot={activeSnapshot} />
      <SessionPanel snapshot={activeSnapshot} />
      <ChannelPanel snapshot={activeSnapshot} />
    </div>
  </aside>
{/if}

<style>
  /* ── Toggle button ─────────────────────────────────────────────────────────── */

  .hud-toggle {
    position: fixed;
    bottom: var(--space-3);
    right: var(--space-3);
    z-index: 900;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px var(--space-2);
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      color var(--transition-fast),
      border-color var(--transition-fast);
    user-select: none;
  }

  .hud-toggle:hover {
    background: rgba(0, 0, 0, 0.75);
    color: var(--color-text);
    border-color: var(--color-text-dim);
  }

  .hud-toggle--active {
    background: color-mix(in srgb, var(--color-accent) 20%, transparent);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .hud-toggle:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  /* ── HUD overlay ───────────────────────────────────────────────────────────── */

  .hud {
    position: fixed;
    top: var(--space-4);
    right: var(--space-4);
    z-index: 910;
    width: min(580px, calc(100vw - var(--space-8, 32px)));
    max-height: calc(100vh - var(--space-8, 32px));
    overflow-y: auto;
    background: color-mix(in srgb, var(--color-surface) 92%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.4));
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── HUD header ────────────────────────────────────────────────────────────── */

  .hud__header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .hud__title {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--color-text);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex: 1;
  }

  .hud__status {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
  }

  .hud__status--live {
    color: var(--color-success);
  }

  .hud__close {
    background: none;
    border: none;
    color: var(--color-text-dim);
    font-size: var(--text-sm);
    line-height: 1;
    cursor: pointer;
    padding: 2px var(--space-1);
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast);
  }

  .hud__close:hover {
    color: var(--color-text);
  }

  .hud__close:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  /* ── Panel grid ────────────────────────────────────────────────────────────── */

  .hud__grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  /* ChannelPanel spans both columns since it has more vertical content. */
  .hud__grid > :global(:last-child) {
    grid-column: 1 / -1;
  }
</style>
