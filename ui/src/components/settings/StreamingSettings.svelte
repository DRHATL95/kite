<script lang="ts">
  import Toggle from "$lib/design/Toggle.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";

  const CLIP_LENGTHS = [15, 30, 60] as const;
  const CLIP_QUALITIES = ["low", "med", "high"] as const;
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Audio-only mode</span>
    <span class="settings-row__desc">
      Stream sound and input without video — Xbox sends no picture, saving
      bandwidth and CPU. Applies on the next connect.
    </span>
  </div>
  <Toggle checked={settings.audioOnly} label="" onchange={(on) => settings.setAudioOnly(on)} />
</div>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Save recent gameplay</span>
    <span class="settings-row__desc">
      Buffers the last few seconds while you play so you can save the moment
      that just happened. Off by default; only runs while enabled.
    </span>
    {#if settings.audioOnly}
      <span class="settings-row__desc">Clipping needs video — unavailable in audio-only mode.</span>
    {/if}
  </div>
  <Toggle
    checked={settings.clip.enabled}
    label=""
    disabled={settings.audioOnly}
    onchange={(on) => settings.setClip({ enabled: on })}
  />
</div>
{#if settings.clip.enabled}
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="settings-row__title">Clip length</span>
      <span class="settings-row__desc">How many seconds to keep buffered.</span>
    </div>
    <div class="clip-chips">
      {#each CLIP_LENGTHS as len (len)}
        <button
          type="button"
          class="clip-chip"
          class:clip-chip--on={settings.clip.lengthSec === len}
          onclick={() => settings.setClip({ lengthSec: len })}
        >{len}s</button>
      {/each}
    </div>
  </div>
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="settings-row__title">Quality</span>
      <span class="settings-row__desc">Higher quality = larger files.</span>
    </div>
    <div class="clip-chips">
      {#each CLIP_QUALITIES as q (q)}
        <button
          type="button"
          class="clip-chip"
          class:clip-chip--on={settings.clip.quality === q}
          onclick={() => settings.setClip({ quality: q })}
        >{q}</button>
      {/each}
    </div>
  </div>
{/if}
