<script lang="ts">
  import Toggle from "$lib/design/Toggle.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { onMount } from "svelte";
  import {
    isOutputSelectionSupported,
    hasNativeOutputPicker,
    savedOutputDeviceId,
    saveOutputDeviceId,
    pickOutputDevice,
    listOutputDevices,
  } from "$lib/connection/audioOutput.js";
  import { streamAudio } from "$lib/connection/streamAudio.js";

  const CLIP_LENGTHS = [15, 30, 60] as const;
  const CLIP_QUALITIES = ["low", "med", "high"] as const;
  const STREAM_QUALITIES = [
    { id: "auto", label: "Auto" },
    { id: "high", label: "High" },
    { id: "medium", label: "Medium" },
    { id: "low", label: "Low" },
  ] as const;

  const outputSupported = isOutputSelectionSupported();
  const nativePicker = hasNativeOutputPicker();
  let outputDeviceId = $state(savedOutputDeviceId());
  let outputLabel = $state("");
  let devices = $state<{ deviceId: string; label: string }[]>([]);

  onMount(async () => {
    if (!outputSupported || nativePicker) return;
    devices = await listOutputDevices();
    outputLabel = devices.find((d) => d.deviceId === outputDeviceId)?.label ?? "";
  });

  async function chooseDevice() {
    const picked = await pickOutputDevice();
    if (!picked) return;
    outputDeviceId = picked.deviceId;
    outputLabel = picked.label;
    saveOutputDeviceId(picked.deviceId);
    void streamAudio.setSinkId(picked.deviceId);
  }

  function selectDevice(id: string) {
    outputDeviceId = id;
    outputLabel = devices.find((d) => d.deviceId === id)?.label ?? "";
    saveOutputDeviceId(id);
    void streamAudio.setSinkId(id);
  }
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Stream quality</span>
    <span class="settings-row__desc">
      Target resolution + max bitrate for the stream. Auto adapts to your network;
      Low (720p) saves bandwidth. Applies on the next connect.
    </span>
    {#if settings.audioOnly}
      <span class="settings-row__desc">Stream quality applies to video — unavailable in audio-only mode.</span>
    {/if}
  </div>
  <div class="clip-chips">
    {#each STREAM_QUALITIES as q (q.id)}
      <button
        type="button"
        class="clip-chip"
        class:clip-chip--on={settings.streamQuality === q.id}
        disabled={settings.audioOnly}
        onclick={() => settings.setStreamQuality(q.id)}
      >{q.label}</button>
    {/each}
  </div>
</div>

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

{#if outputSupported}
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="settings-row__title">Audio output</span>
      <span class="settings-row__desc">
        Send the console's audio to a specific device (e.g. headphones) instead of
        your system default. Applies immediately while streaming.
      </span>
    </div>
    {#if nativePicker}
      <button type="button" class="clip-chip" onclick={chooseDevice}>
        {outputLabel || "System default"} · Change
      </button>
    {:else}
      <select
        class="audio-output-select"
        aria-label="Audio output device"
        value={outputDeviceId}
        onchange={(e) => selectDevice((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">System default</option>
        {#each devices as d (d.deviceId)}
          <option value={d.deviceId}>{d.label}</option>
        {/each}
      </select>
    {/if}
  </div>
{/if}

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

<style>
  /* The enumerate-fallback output <select> (native-picker runtimes render the
     .clip-chip button above and never hit this). Mirrors ControllerSettings'
     .remap-select so it matches the rest of Settings. */
  .audio-output-select {
    padding: var(--space-1) var(--space-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }
  .audio-output-select:focus-visible { box-shadow: var(--focus-ring); }
</style>
