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
   *   onDisconnect   — called when the user clicks Disconnect.
   */

  import { onDestroy } from "svelte";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import Button from "$lib/design/Button.svelte";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    video: HTMLVideoElement | null;
    fullscreenEl?: HTMLElement | null;
    focusMode?: boolean;
    onDisconnect: () => void;
  }

  let {
    video = null,
    fullscreenEl = null,
    focusMode = $bindable(false),
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
  class:stream-controls--visible={!focusMode || controlsVisible}
  aria-label="Stream controls"
>
  <!-- Focus mode toggle -->
  <button
    class="ctrl-btn"
    onclick={toggleFocusMode}
    aria-pressed={focusMode}
    title={focusMode ? "Exit Focus Mode (Esc)" : "Focus Mode"}
  >
    {focusMode ? "Exit Focus" : "Focus"}
  </button>

  <!-- Fullscreen toggle -->
  <button
    class="ctrl-btn"
    onclick={toggleFullscreen}
    aria-pressed={isFullscreen}
    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
  >
    {isFullscreen ? "Exit FS" : "Fullscreen"}
  </button>

  <!-- Keyframe request -->
  <button
    class="ctrl-btn"
    onclick={requestKeyframe}
    title="Request keyframe (fix corruption)"
  >
    Keyframe
  </button>

  <!-- Volume slider -->
  <div class="ctrl-volume" title="Volume">
    <span class="ctrl-volume__icon" aria-hidden="true">
      {#if volumePct === 0}
        Muted
      {:else if volumePct < 50}
        Vol-
      {:else}
        Vol
      {/if}
    </span>
    <input
      type="range"
      class="ctrl-volume__slider"
      min="0"
      max="100"
      value={volumePct}
      oninput={handleVolumeInput}
      aria-label="Volume"
    />
    <span class="ctrl-volume__value">{volumePct}%</span>
  </div>

  <!-- Disconnect -->
  <Button variant="danger" onclick={onDisconnect}>
    Disconnect
  </Button>
</div>

<style>
  .stream-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(0, 0, 0, 0.70);
    backdrop-filter: blur(6px);
    border-radius: var(--radius-md);
    transition: opacity var(--transition-base);
    flex-wrap: wrap;
  }

  /* In focus mode, hide the bar when not hovered / mouse moving. */
  .stream-controls--focus {
    opacity: 0;
    pointer-events: none;
  }

  .stream-controls--focus.stream-controls--visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Shared control button style (lightweight, no design component overhead). */
  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-1) var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast);
    user-select: none;
  }

  .ctrl-btn:hover {
    background: var(--color-border);
    border-color: var(--color-text-dim);
  }

  .ctrl-btn:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  /* Volume section */
  .ctrl-volume {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ctrl-volume__icon {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    min-width: 28px;
    text-align: right;
  }

  .ctrl-volume__slider {
    width: 80px;
    accent-color: var(--color-accent);
    cursor: pointer;
  }

  .ctrl-volume__value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    min-width: 32px;
  }
</style>
