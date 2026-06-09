<script lang="ts">
  /**
   * StreamControls.svelte — Streaming controls bar.
   *
   * Features:
   *   - Focus mode toggle: hides chrome, auto-hides controls after 2.5s of
   *     mouse idle (ported from app.js toggleFocusMode / onFocusMouseMove logic).
   *   - Fullscreen toggle: requestFullscreen on the stream container element.
   *   - Keyframe button: connectionStore.requestKeyframe().
   *   - Volume slider (0–100): persisted to localStorage under 'xbox-remote-volume'
   *     (same key as app.js line 1103).  Applied to the video element directly.
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

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    video: HTMLVideoElement | null;
    fullscreenEl?: HTMLElement | null;
    focusMode?: boolean;
    floating?: boolean;
    onDisconnect: () => void;
  }

  let {
    video = null,
    fullscreenEl = null,
    focusMode = $bindable(false),
    floating = false,
    onDisconnect,
  }: Props = $props();

  // ── Volume state ──────────────────────────────────────────────────────────────

  const VOLUME_KEY = "xbox-remote-volume";

  /** 0–100 integer; initialised from localStorage if a saved value exists. */
  let volumePct = $state<number>((() => {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null) {
      const v = parseFloat(saved);
      if (!Number.isNaN(v)) return Math.round(v * 100);
    }
    return 80;
  })());

  /** Apply the current volumePct to the video element and persist. */
  function applyVolume(pct: number) {
    volumePct = pct;
    if (video) {
      video.volume = pct / 100;
      video.muted = pct === 0;
    }
    localStorage.setItem(VOLUME_KEY, String(pct / 100));
  }

  /** Sync video element when it becomes available (also called from Stream.svelte after mount). */
  $effect(() => {
    if (video && !video.muted) {
      const saved = localStorage.getItem(VOLUME_KEY);
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

  /** Controls bar is visible when not in focus mode, or temporarily when mouse moves. */
  let controlsVisible = $state(true);
  let focusMouseTimer: ReturnType<typeof setTimeout> | null = null;

  function showControls() {
    controlsVisible = true;
    if (focusMouseTimer) clearTimeout(focusMouseTimer);
    focusMouseTimer = setTimeout(() => {
      if (focusMode) controlsVisible = false;
    }, 2500);
  }

  function toggleFocusMode() {
    focusMode = !focusMode;
    if (focusMode) {
      // Auto-hide after brief show
      controlsVisible = true;
      focusMouseTimer = setTimeout(() => { controlsVisible = false; }, 2000);
      document.addEventListener("mousemove", showControls);
    } else {
      // Restore controls
      controlsVisible = true;
      if (focusMouseTimer) { clearTimeout(focusMouseTimer); focusMouseTimer = null; }
      document.removeEventListener("mousemove", showControls);
    }
  }

  // ── Keyframe ──────────────────────────────────────────────────────────────────

  function requestKeyframe() {
    connectionStore.requestKeyframe();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  onDestroy(() => {
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    document.removeEventListener("mousemove", showControls);
    if (focusMouseTimer) clearTimeout(focusMouseTimer);
  });
</script>

<div
  class="stream-controls"
  class:stream-controls--focus={focusMode}
  class:stream-controls--floating={floating}
  class:stream-controls--visible={!focusMode || controlsVisible}
  aria-label="Stream controls"
>
  <!-- Volume: speaker glyph (accent) + slider + value -->
  <div class="ctrl-volume" title="Volume">
    <!-- Speaker glyph -->
    <span class="ctrl-volume__icon" aria-hidden="true" style="color: var(--accent);">
      {#if volumePct === 0}
        🔇
      {:else if volumePct < 50}
        🔉
      {:else}
        🔊
      {/if}
    </span>

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

  <!-- Focus mode toggle (ghost button) -->
  <button
    class="ctrl-btn"
    onclick={toggleFocusMode}
    aria-pressed={focusMode}
    title={focusMode ? "Exit Focus Mode (Esc)" : "Focus Mode"}
  >
    {focusMode ? "Exit Focus" : "Focus"}
  </button>

  <!-- Fullscreen toggle (ghost button) -->
  <button
    class="ctrl-btn"
    onclick={toggleFullscreen}
    aria-pressed={isFullscreen}
    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
  >
    {isFullscreen ? "Exit FS" : "Fullscreen"}
  </button>

  <!-- Keyframe request (ghost button) -->
  <button
    class="ctrl-btn"
    onclick={requestKeyframe}
    title="Request keyframe (fix corruption)"
  >
    Keyframe
  </button>

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

  /* In focus mode (docked variant), hide the bar when not hovered / mouse moving. */
  .stream-controls--focus:not(.stream-controls--floating) {
    opacity: 0;
    pointer-events: none;
  }

  .stream-controls--focus:not(.stream-controls--floating).stream-controls--visible {
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

  /* Auto-hide: fade out when focus + not visible */
  .stream-controls--floating.stream-controls--focus {
    opacity: 0;
    pointer-events: none;
  }

  .stream-controls--floating.stream-controls--focus.stream-controls--visible {
    opacity: 1;
    pointer-events: auto;
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

  .ctrl-volume__icon {
    font-size: var(--text-base);
    line-height: 1;
    min-width: 20px;
    text-align: center;
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
