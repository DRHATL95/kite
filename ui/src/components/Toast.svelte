<script lang="ts">
  /**
   * Toast.svelte — bottom-centre toast driven by clipStore.toast.
   * Shows a message; on success offers a Reveal action; dismissable.
   */
  import { clipStore } from "$lib/stores/clip.svelte.js";

  const toast = $derived(clipStore.toast);
</script>

{#if toast}
  <div class="toast" class:toast--bad={toast.tone === "bad"} role="status" aria-live="polite">
    <span class="toast__msg">{toast.message}</span>
    {#if toast.path}
      <button class="toast__action" onclick={() => clipStore.reveal()}>Reveal</button>
    {/if}
    <button class="toast__close" aria-label="Dismiss" onclick={() => clipStore.dismiss()}>×</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    bottom: var(--space-5);
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .toast--bad {
    border-color: var(--bad);
  }

  .toast__msg { white-space: nowrap; }

  .toast__action {
    padding: var(--space-1) var(--space-3);
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .toast__action:hover { background: var(--accent-press); }
  .toast__action:focus-visible { box-shadow: var(--focus-ring); }

  .toast__close {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--space-1);
  }

  .toast__close:hover { color: var(--text); }
</style>
