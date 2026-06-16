<script lang="ts">
  /**
   * Settings.svelte — modal overlay for app preferences (clipping in v1).
   * Reads/writes settingsStore; closes via the onClose prop or backdrop click.
   */
  import Panel from "$lib/design/Panel.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte.js";
  import type { ClipLength, ClipQuality } from "$lib/settings/clipSettings.js";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const clip = $derived(settingsStore.clip);

  const LENGTHS: ClipLength[] = [15, 30, 60];
  const QUALITIES: ClipQuality[] = ["low", "med", "high"];

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="settings-backdrop" onclick={onClose}>
  <!-- Stop propagation so clicks inside the panel don't close it -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="settings-modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">
    <Panel title="Clipping">
      <div class="row">
        <label class="row__label" for="clip-enabled">Enable clipping</label>
        <input
          id="clip-enabled"
          type="checkbox"
          checked={clip.enabled}
          onchange={(e) => settingsStore.setClip({ enabled: (e.target as HTMLInputElement).checked })}
        />
      </div>
      <p class="hint">Off by default. When enabled, the last few seconds are buffered so you can save the moment that just happened.</p>

      {#if clip.enabled}
        <div class="row">
          <span class="row__label">Clip length</span>
          <div class="seg">
            {#each LENGTHS as len (len)}
              <button
                class="seg__btn"
                class:seg__btn--on={clip.lengthSec === len}
                onclick={() => settingsStore.setClip({ lengthSec: len })}
              >{len}s</button>
            {/each}
          </div>
        </div>

        <div class="row">
          <span class="row__label">Quality</span>
          <div class="seg">
            {#each QUALITIES as q (q)}
              <button
                class="seg__btn"
                class:seg__btn--on={clip.quality === q}
                onclick={() => settingsStore.setClip({ quality: q })}
              >{q}</button>
            {/each}
          </div>
        </div>

        <div class="row">
          <span class="row__label">Audio</span>
          <span class="row__static">Xbox stream audio</span>
        </div>
        <p class="hint">Captures the console's own audio. PC-device capture (e.g. a Voicemeeter bus) is planned for a later version.</p>
      {/if}
    </Panel>

    <div class="settings-actions">
      <button class="close-btn" onclick={onClose}>Done</button>
    </div>
  </div>
</div>

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(3px);
  }

  .settings-modal {
    width: min(440px, calc(100vw - var(--space-6)));
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }

  .row__label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .row__static {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .hint {
    margin: 0 0 var(--space-2);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .seg { display: inline-flex; gap: var(--space-1); }

  .seg__btn {
    padding: var(--space-1) var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .seg__btn--on {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: var(--accent);
    color: var(--text);
  }

  .settings-actions { display: flex; justify-content: flex-end; }

  .close-btn {
    padding: var(--space-2) var(--space-4);
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-weight: 600;
    cursor: pointer;
  }

  .close-btn:hover { background: var(--accent-press); }
  .close-btn:focus-visible { box-shadow: var(--focus-ring); }
</style>
