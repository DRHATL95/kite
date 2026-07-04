<script lang="ts">
  import { settings } from "$lib/stores/settings.svelte.js";
  import {
    OUTPUTS, GROUPS, OUTPUTS_BY_ID, SOURCE_OPTION_GROUPS,
    sourceToOptionKey, optionKeyToSource, describeSource,
    type Source,
  } from "$lib/connection/controllerMapping.js";

  function effective(id: string): Source {
    return settings.controllerMapping[id] ?? OUTPUTS_BY_ID[id].defaultSource;
  }
  function isOverridden(id: string): boolean {
    return id in settings.controllerMapping;
  }
  function onSelect(id: string, e: Event): void {
    settings.setControllerBinding(id, optionKeyToSource((e.currentTarget as HTMLSelectElement).value));
  }
  const hasOverrides = $derived(Object.keys(settings.controllerMapping).length > 0);
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Controller remapping</span>
    <span class="settings-row__desc">
      Rebind any physical control to any Xbox output. Applies on the next connect.
    </span>
  </div>
  <button
    type="button"
    class="clip-chip"
    disabled={!hasOverrides}
    onclick={() => settings.resetControllerMapping()}
  >Reset all</button>
</div>

{#each GROUPS as group (group)}
  <h3 class="remap-group">{group}</h3>
  {#each OUTPUTS.filter((o) => o.group === group) as out (out.id)}
    <div class="settings-row remap-row">
      <span class="settings-row__title remap-row__label" id={`remap-label-${out.id}`}>{out.label}</span>
      <div class="remap-row__controls">
        <select
          class="remap-select"
          aria-labelledby={`remap-label-${out.id}`}
          value={sourceToOptionKey(effective(out.id))}
          onchange={(e) => onSelect(out.id, e)}
        >
          {#each SOURCE_OPTION_GROUPS as og (og.label)}
            <optgroup label={og.label}>
              {#each og.sources as src (sourceToOptionKey(src))}
                <option value={sourceToOptionKey(src)}>{describeSource(src)}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        {#if isOverridden(out.id)}
          <button
            type="button"
            class="remap-icon"
            aria-label={`Reset ${out.label} to default`}
            title="Reset to default"
            onclick={() => settings.resetControllerBinding(out.id)}
          >⟳</button>
        {/if}
      </div>
    </div>
  {/each}
{/each}

<style>
  .remap-group {
    margin: var(--space-3) 0 0;
    font-family: var(--font-display);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .remap-row { gap: var(--space-3); }
  .remap-row__label { flex-shrink: 0; }
  .remap-row__controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    justify-content: flex-end;
  }
  .remap-select {
    flex: 1;
    min-width: 12rem;
    max-width: 20rem;
    padding: var(--space-1) var(--space-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }
  .remap-select:focus-visible { box-shadow: var(--focus-ring); }
  .remap-icon {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .remap-icon:hover { background: var(--surface-2); color: var(--text); }
  .remap-icon:focus-visible { box-shadow: var(--focus-ring); }

  @media (max-width: 520px) {
    .remap-row { flex-direction: column; align-items: stretch; }
    .remap-row__controls { justify-content: flex-start; }
    .remap-select { max-width: none; }
  }
</style>
