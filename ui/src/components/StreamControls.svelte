<script lang="ts">
  /**
   * StreamControls.svelte — Streaming controls bar.
   *
   * Features:
   *   - Auto-hide controls after 2.5s of mouse idle while streaming (and in
   *     focus mode), revealing them again on mouse movement.
   *   - Focus mode toggle: hides chrome and uses floating controls.
   *   - Fullscreen toggle: requestFullscreen on the stream container element.
   *   - Keyframe button: connectionStore.requestKeyframe().
   *   - Volume slider (0–100): persisted to the durable settings store under
   *     'kite-volume'.  Applied to the video element directly.
   *   - Disconnect button: calls onDisconnect prop.
   *
   * Props:
   *   video          — the HTMLVideoElement to control volume / mute on.
   *   fullscreenEl   — element to call requestFullscreen() on (usually the
   *                    stream container div).
   *   focusMode      — bindable boolean; parent reads it to apply focus-mode class.
   *   floating       — when true (Stage mode), renders as a floating translucent
   *                    pill at the bottom of the viewport with auto-hide.
   *                    when false (Player mode), renders as a docked bottom bar.
   *   onDisconnect   — called when the user clicks Disconnect.
   */

  import { onDestroy } from "svelte";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { persisted } from "$lib/persist/store.js";
  import { shouldAutoHideControls, CONTROLS_AUTO_HIDE_MS } from "./streamControlsVisibility.js";

  const showClip = $derived(
    settings.clip.enabled &&
      connectionStore.state === "streaming" &&
      !connectionStore.audioOnly,
  );

  // Video-oriented controls (Fix Video / Immersive / Clip) are meaningless in
  // audio-only mode, where no video track is streamed — hide them.
  const showVideoControls = $derived(!connectionStore.audioOnly);

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    video: HTMLVideoElement | null;
    fullscreenEl?: HTMLElement | null;
    focusMode?: boolean;
    floating?: boolean;
    /**
     * When true, the volume control is hidden entirely. Defaults to false.
     */
    hideVolume?: boolean;
    /**
     * Native mode: there is no DOM <video> to set `.volume` on (audio plays via
     * Rust/cpal), so the slider routes its gain (0–1) here instead. Called on the
     * initial saved level, slider input, and mute toggle. Omitted on the browser
     * path (where `video.volume` is used directly).
     */
    onVolumeChange?: (gain: number) => void;
    onDisconnect: () => void;
  }

  let {
    video = null,
    fullscreenEl = null,
    focusMode = $bindable(false),
    floating = false,
    hideVolume = false,
    onVolumeChange,
    onDisconnect,
  }: Props = $props();

  // ── Volume state ──────────────────────────────────────────────────────────────

  const VOLUME_KEY = "kite-volume";

  /** Read the persisted volume as a 0–100 integer, defaulting to 80. */
  function readSavedVolumePct(): number {
    const saved = persisted.getItem(VOLUME_KEY);
    if (saved !== null) {
      const v = parseFloat(saved);
      if (!Number.isNaN(v)) return Math.round(v * 100);
    }
    return 80;
  }

  /** 0–100 integer; initialised from the persisted store if a saved value exists. */
  let volumePct = $state<number>(readSavedVolumePct());

  /**
   * Last non-zero volume, used to restore audio when un-muting.
   * Seeded from the initial volume (or a sensible 80% default if we start muted).
   */
  let lastNonZeroVolume = $state<number>(readSavedVolumePct() || 80);

  /** Apply the current volumePct to the video element and persist. */
  function applyVolume(pct: number) {
    volumePct = pct;
    if (pct > 0) lastNonZeroVolume = pct;
    if (video) {
      video.volume = pct / 100;
      video.muted = pct === 0;
    }
    persisted.setItem(VOLUME_KEY, String(pct / 100));
  }

  /**
   * Toggle mute by clicking the speaker icon.
   *   - If audio is playing, drop to 0 (and remember the level we left).
   *   - If already muted, restore the last non-zero level.
   */
  function toggleMute() {
    if (volumePct > 0) {
      applyVolume(0);
    } else {
      applyVolume(lastNonZeroVolume > 0 ? lastNonZeroVolume : 80);
    }
  }

  /** Sync video element when it becomes available (also called from Stream.svelte after mount). */
  $effect(() => {
    if (video && !video.muted) {
      const saved = persisted.getItem(VOLUME_KEY);
      if (saved !== null) {
        const v = parseFloat(saved);
        if (!Number.isNaN(v)) {
          video.volume = v;
          video.muted = v === 0;
          volumePct = Math.round(v * 100);
        }
      }
    }
  });

  function handleVolumeInput(e: Event) {
    const target = e.target as HTMLInputElement;
    applyVolume(parseInt(target.value, 10));
  }

  // Native mode: push the gain to the Rust audio sink (no DOM <video> to set).
  // Runs on the initial saved level and every volumePct change (slider / mute);
  // a no-op on the browser path where onVolumeChange is undefined.
  $effect(() => {
    onVolumeChange?.(volumePct / 100);
  });

  // ── Fullscreen ────────────────────────────────────────────────────────────────

  let isFullscreen = $state(document.fullscreenElement != null);

  function handleFullscreenChange() {
    isFullscreen = document.fullscreenElement != null;
  }

  document.addEventListener("fullscreenchange", handleFullscreenChange);

  function toggleFullscreen() {
    const el = fullscreenEl ?? document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ── Focus mode ────────────────────────────────────────────────────────────────

  /** Controls bar visibility (auto-hides while streaming / focus mode). */
  let controlsVisible = $state(true);
  const autoHideEnabled = $derived(shouldAutoHideControls(connectionStore.state, focusMode));
  let focusMouseTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFocusMouseTimer() {
    if (focusMouseTimer) {
      clearTimeout(focusMouseTimer);
      focusMouseTimer = null;
    }
  }

  function showControls() {
    controlsVisible = true;
    clearFocusMouseTimer();
    if (!autoHideEnabled) return;
    focusMouseTimer = setTimeout(() => {
      if (shouldAutoHideControls(connectionStore.state, focusMode)) controlsVisible = false;
    }, CONTROLS_AUTO_HIDE_MS);
  }

  function toggleFocusMode() {
    focusMode = !focusMode;
    showControls();
  }

  $effect(() => {
    if (autoHideEnabled) {
      showControls();
      document.removeEventListener("mousemove", showControls);
      document.addEventListener("mousemove", showControls);
      return () => {
        document.removeEventListener("mousemove", showControls);
        clearFocusMouseTimer();
      };
    }
    controlsVisible = true;
  });

  // ── Keyframe ──────────────────────────────────────────────────────────────────

  function requestKeyframe() {
    connectionStore.requestKeyframe();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  onDestroy(() => {
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    document.removeEventListener("mousemove", showControls);
    clearFocusMouseTimer();
  });
</script>

<div
  class="stream-controls"
  class:stream-controls--focus={focusMode}
  class:stream-controls--floating={floating}
  class:stream-controls--autohide={autoHideEnabled}
  class:stream-controls--visible={controlsVisible}
  aria-label="Stream controls"
>
  <!-- Volume: clickable speaker glyph (mute toggle) + slider + value -->
  <!-- Hidden in native mode — audio is played by Rust/cpal, not a DOM <video>. -->
  {#if !hideVolume}
    <div class="ctrl-volume">
      <!-- Speaker glyph — click to mute / unmute -->
      <button
        type="button"
        class="ctrl-volume__icon"
        onclick={toggleMute}
        aria-pressed={volumePct === 0}
        aria-label={volumePct === 0 ? "Unmute" : "Mute"}
        title={volumePct === 0 ? "Unmute" : "Mute"}
      >
        {#if volumePct === 0}
          🔇
        {:else if volumePct < 50}
          🔉
        {:else}
          🔊
        {/if}
      </button>

      <!-- Slider — CSS custom property drives the accent fill via background gradient -->
      <input
        type="range"
        class="ctrl-volume__slider"
        min="0"
        max="100"
        value={volumePct}
        style="--fill: {volumePct}%;"
        oninput={handleVolumeInput}
        aria-label="Volume"
      />

      <span class="ctrl-volume__value">{volumePct}%</span>
    </div>

    <!-- Separator -->
    <span class="ctrl-sep" aria-hidden="true"></span>
  {/if}

  <!-- Immersive (focus) mode toggle (ghost button) — video only -->
  {#if showVideoControls}
    <button
      class="ctrl-btn"
      onclick={toggleFocusMode}
      aria-pressed={focusMode}
      title={focusMode
        ? "Exit immersive mode (Esc) — bring back the app controls"
        : "Immersive mode — hide the app controls for a distraction-free view (Esc to exit)"}
    >
      {focusMode ? "Exit Immersive" : "Immersive"}
    </button>
  {/if}

  <!-- Fullscreen toggle (ghost button) -->
  <button
    class="ctrl-btn"
    onclick={toggleFullscreen}
    aria-pressed={isFullscreen}
    title={isFullscreen
      ? "Exit fullscreen"
      : "Fullscreen — make the window fill your whole screen"}
  >
    {isFullscreen ? "Exit FS" : "Fullscreen"}
  </button>

  <!-- Fix Video / keyframe request (ghost button) — video only -->
  {#if showVideoControls}
    <button
      class="ctrl-btn"
      onclick={requestKeyframe}
      title="Fix Video — refresh the picture if it looks blocky, smeared, or frozen"
    >
      Fix Video
    </button>
  {/if}

  <!-- Clip (only when clipping is enabled + streaming) -->
  {#if showClip}
    <button
      class="ctrl-btn"
      onclick={() => void connectionStore.saveClip()}
      title="Save the last few seconds as a clip"
    >
      Clip
    </button>
  {/if}

  <!-- Separator -->
  <span class="ctrl-sep" aria-hidden="true"></span>

  <!-- Disconnect (bad/danger tone) -->
  <button
    class="ctrl-btn ctrl-btn--disconnect"
    onclick={onDisconnect}
    title="Disconnect from Xbox"
  >
    Disconnect
  </button>
</div>

<style>
  /* ── Controls bar — base (Player/docked mode) ──────────────────────────── */

  .stream-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
    transition: opacity 200ms ease;
  }

  /* Auto-hide in any mode when enabled. */
  .stream-controls--autohide {
    opacity: 0;
    pointer-events: none;
  }

  .stream-controls--autohide.stream-controls--visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* ── Floating variant (Stage/focus mode) ────────────────────────────────── */

  .stream-controls--floating {
    /* Override docked styles */
    position: absolute;
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100vw - var(--space-6));
    flex-wrap: nowrap;

    /* Translucent surface */
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    border: 1px solid var(--border);
    border-top: 1px solid var(--border);
    border-radius: var(--radius-md);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);

    z-index: 30;
    transition: opacity 200ms ease;
  }

  /* ── Separator ──────────────────────────────────────────────────────────── */

  .ctrl-sep {
    display: inline-block;
    width: 1px;
    height: 18px;
    background: var(--border);
    flex-shrink: 0;
  }

  /* ── Ghost buttons (focus / fullscreen / keyframe) ──────────────────────── */

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-1) var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background 120ms ease,
      border-color 120ms ease;
    user-select: none;
  }

  .ctrl-btn:hover {
    background: var(--surface-2);
    border-color: var(--text-dim);
  }

  .ctrl-btn:focus-visible {
    box-shadow: var(--focus-ring);
  }

  /* Disconnect — bad/danger tone */
  .ctrl-btn--disconnect {
    border-color: var(--bad);
    color: var(--bad);
  }

  .ctrl-btn--disconnect:hover {
    background: color-mix(in srgb, var(--bad) 12%, transparent);
    border-color: var(--bad);
  }

  /* ── Volume section ─────────────────────────────────────────────────────── */

  .ctrl-volume {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Speaker glyph is a button (mute toggle) — reset native button chrome */
  .ctrl-volume__icon {
    font-size: var(--text-base);
    line-height: 1;
    min-width: 24px;
    height: 24px;
    text-align: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent);
    cursor: pointer;
    transition: background 120ms ease;
    user-select: none;
  }

  .ctrl-volume__icon:hover {
    background: var(--surface-2);
  }

  .ctrl-volume__icon:focus-visible {
    box-shadow: var(--focus-ring);
  }

  /* Volume slider — custom accent fill via CSS gradient trick */
  .ctrl-volume__slider {
    width: 88px;
    height: 4px;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    border-radius: 2px;
    /* fill up to --fill, then dim for the rest */
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent) var(--fill, 80%),
      var(--surface-2) var(--fill, 80%),
      var(--surface-2) 100%
    );
    outline: none;
    border: none;
  }

  .ctrl-volume__slider::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: none;
    box-shadow: var(--shadow-sm);
  }

  .ctrl-volume__slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: none;
    box-shadow: var(--shadow-sm);
  }

  .ctrl-volume__slider:focus-visible {
    box-shadow: var(--focus-ring);
  }

  .ctrl-volume__value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 32px;
  }
</style>
