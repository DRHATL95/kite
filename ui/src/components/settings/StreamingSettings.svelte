<script lang="ts">
  import Toggle from "$lib/design/Toggle.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import {
    isOutputSelectionSupported,
    hasNativeOutputPicker,
    saveOutputDeviceId,
    savedOutputLabel,
    saveOutputLabel,
    pickOutputDevice,
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

  // The output-device picker only appears where the browser offers the native,
  // no-prompt selectAudioOutput() picker (and setSinkId can route). Elsewhere the
  // row is hidden — we never fall back to a getUserMedia mic prompt to list
  // devices (asking for a microphone to choose speakers is unacceptable).
  const showOutputPicker = isOutputSelectionSupported() && hasNativeOutputPicker();
  let outputLabel = $state(savedOutputLabel());

  async function chooseDevice() {
    const picked = await pickOutputDevice();
    if (!picked) return;
    outputLabel = picked.label;
    saveOutputDeviceId(picked.deviceId);
    saveOutputLabel(picked.label);
    void streamAudio.setSinkId(picked.deviceId);
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

{#if showOutputPicker}
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="settings-row__title">Audio output</span>
      <span class="settings-row__desc">
        Send the console's audio to a specific device (e.g. headphones) instead of
        your system default. Applies immediately while streaming.
      </span>
    </div>
    <button type="button" class="clip-chip" onclick={chooseDevice}>
      {outputLabel || "System default"} · Change
    </button>
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
