<script lang="ts">
  /**
   * Stream.svelte — Streaming screen: video element + controls overlay + status.
   *
   * Responsibilities:
   *   1. Binds connectionStore.mediaStream → video.srcObject reactively via
   *      $effect so any stream change (including reconnect) is picked up.
   *   2. Dual-track playback (ported from app.js §3.10):
   *      - When mediaStream is set, waits ~250ms then calls video.play().
   *      - If the browser muted the video due to autoplay policy, surfaces
   *        an "Unmute" button that unmutes + replays on user click.
   *   3. Composes StreamControls and StreamStatus.
   *   4. Leaves a placeholder slot for the diagnostics HUD (Task 11).
   *
   * Props:
   *   onDisconnect — required; called when the user clicks Disconnect.
   */

  import { onDestroy } from "svelte";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import StreamControls from "../components/StreamControls.svelte";
  import StreamStatus from "../components/StreamStatus.svelte";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    /** Called when the user requests a disconnect (parent navigates away). */
    onDisconnect: () => void;
  }

  let { onDisconnect }: Props = $props();

  // ── Element refs ──────────────────────────────────────────────────────────────

  let videoEl = $state<HTMLVideoElement | null>(null);
  let containerEl = $state<HTMLElement | null>(null);

  // ── Autoplay / mute state ─────────────────────────────────────────────────────

  /**
   * True when the browser blocked unmuted autoplay.
   * Surfaced as an "Unmute" affordance the user must click.
   */
  let needsUnmute = $state(false);

  // ── Playback timer ref (cleaned up on destroy) ────────────────────────────────

  let playTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Reactive srcObject binding ────────────────────────────────────────────────
  //
  // We use $effect so this re-runs whenever connectionStore.mediaStream changes.
  // Setting srcObject is a DOM side-effect and must be done imperatively —
  // Svelte bind:srcObject is not a standard binding.

  $effect(() => {
    const stream = connectionStore.mediaStream;

    if (!videoEl) return;

    // Assign srcObject.  Assigning null clears the video.
    videoEl.srcObject = stream ?? null;

    if (!stream) {
      needsUnmute = false;
      if (playTimer) { clearTimeout(playTimer); playTimer = null; }
      return;
    }

    // ── 250ms-delayed play + Unmute fallback (ported from app.js lines 634–662) ──

    if (playTimer) clearTimeout(playTimer);

    playTimer = setTimeout(() => {
      if (!videoEl || videoEl.srcObject !== stream) return;

      const ensurePlay = videoEl.paused ? videoEl.play() : Promise.resolve();

      ensurePlay
        .then(() => {
          // Attempt to unmute — browser may refuse if no user gesture occurred
          videoEl!.muted = false;
          if (!videoEl!.muted) {
            // Fully unmuted — no affordance needed
            needsUnmute = false;
          } else {
            // Autoplay policy kept it muted — show Unmute button
            needsUnmute = true;
          }
        })
        .catch((err: Error) => {
          // Play itself was blocked (very restrictive policy)
          if (!err.message.includes("interrupted")) {
            needsUnmute = true;
          }
        });
    }, 250);
  });

  // ── Unmute button handler ─────────────────────────────────────────────────────

  function handleUnmute() {
    if (!videoEl) return;
    videoEl.muted = false;
    if (videoEl.paused) {
      videoEl.play().catch(() => {});
    }
    needsUnmute = false;
  }

  // ── Focus mode state (shared with StreamControls via bind) ────────────────────

  let focusMode = $state(false);

  // ── Escape key exits focus mode ───────────────────────────────────────────────

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && focusMode) {
      focusMode = false;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  onDestroy(() => {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  });
</script>

<svelte:window onkeydown={handleKeyDown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="stream-screen"
  class:stream-screen--focus={focusMode}
  bind:this={containerEl}
  role="region"
  aria-label="Xbox stream"
>
  <!-- ── Video ─────────────────────────────────────────────────────────────── -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    class="stream-video"
    autoplay
    playsinline
    bind:this={videoEl}
    aria-label="Xbox console stream"
  ></video>

  <!-- ── Unmute affordance (autoplay policy fallback) ──────────────────────── -->
  {#if needsUnmute}
    <div class="unmute-overlay" aria-live="assertive">
      <button class="unmute-btn" onclick={handleUnmute}>
        Unmute &amp; Play
      </button>
      <p class="unmute-hint">Click to enable audio (browser autoplay policy)</p>
    </div>
  {/if}

  <!-- ── Status overlay (top-left) ─────────────────────────────────────────── -->
  <div class="overlay overlay--top-left">
    <StreamStatus />
  </div>

  <!-- HUD mounts here (Task 11) -->

  <!-- ── Controls bar (bottom) ─────────────────────────────────────────────── -->
  <div class="overlay overlay--bottom">
    <StreamControls
      video={videoEl}
      fullscreenEl={containerEl}
      bind:focusMode
      {onDisconnect}
    />
  </div>
</div>

<style>
  /* ── Root container — fills the whole viewport ─────────────────────────── */

  .stream-screen {
    position: relative;
    width: 100%;
    height: 100vh;
    background: #000;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* In focus mode, hide the native window cursor after the controls fade */
  .stream-screen--focus {
    cursor: none;
  }

  /* ── Video element ──────────────────────────────────────────────────────── */

  .stream-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: #000;
  }

  /* ── Overlay positioning helpers ────────────────────────────────────────── */

  .overlay {
    position: absolute;
    z-index: 10;
    pointer-events: none; /* children opt-in via pointer-events: auto */
  }

  .overlay--top-left {
    top: var(--space-3);
    left: var(--space-3);
    pointer-events: auto;
  }

  .overlay--bottom {
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    pointer-events: auto;
  }

  /* ── Unmute overlay ─────────────────────────────────────────────────────── */

  .unmute-overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
  }

  .unmute-btn {
    padding: var(--space-3) var(--space-5);
    background: var(--color-accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-size: var(--text-lg);
    font-weight: 700;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .unmute-btn:hover {
    background: var(--color-accent-hover);
  }

  .unmute-btn:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  .unmute-hint {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text-dim);
  }
</style>
