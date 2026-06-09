<script lang="ts">
  /**
   * UpdateBanner.svelte — Thin "Update available" strip (Carbon+Green).
   *
   * Driven entirely by updateStore.  Renders nothing when no update is
   * available, so it's safe to mount above any screen.  When an update is
   * available it shows the version with an Install (primary) / Later (ghost)
   * action pair; while installing it swaps the actions for an accent progress
   * bar + percent readout.  Any install error is shown on its own line in the
   * bad/red tone.
   *
   * Semantic colour: an available update is a positive, actionable state →
   * accent (green) for the strip cue + progress fill; --bad is used ONLY for
   * the error line.
   */

  import { updateStore } from "$lib/update/updateStore.svelte.js";
  import Button from "$lib/design/Button.svelte";
</script>

{#if updateStore.available}
  <div class="update-banner" role="status">
    <div class="update-banner__row">
      <div class="update-banner__info">
        <span class="update-banner__label">Update available</span>
        <span class="update-banner__version">v{updateStore.available.version}</span>
      </div>

      <div class="update-banner__actions">
        {#if updateStore.installing}
          <div
            class="update-banner__progress"
            role="progressbar"
            aria-valuenow={updateStore.progress}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Installing update"
          >
            <div class="update-banner__track">
              <div
                class="update-banner__fill"
                style="width: {updateStore.progress}%"
              ></div>
            </div>
            <span class="update-banner__pct">{updateStore.progress}%</span>
          </div>
        {:else}
          <Button onclick={() => updateStore.install()}>Install</Button>
          <Button variant="ghost" onclick={() => updateStore.dismiss()}>Later</Button>
        {/if}
      </div>
    </div>

    {#if updateStore.error}
      <p class="update-banner__error" role="alert">{updateStore.error}</p>
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: var(--space-2) var(--space-3);
  }

  .update-banner__row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }

  .update-banner__info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .update-banner__label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .update-banner__version {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .update-banner__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .update-banner__progress {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 160px;
  }

  .update-banner__track {
    flex: 1;
    height: 4px;
    background: var(--surface);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .update-banner__fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-sm);
    transition: width 150ms ease;
  }

  .update-banner__pct {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 3ch;
    text-align: right;
  }

  .update-banner__error {
    margin: var(--space-2) 0 0;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--bad);
  }
</style>
