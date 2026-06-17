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
   *   4. Focus/"Stage" mode (focusMode=true): video goes full-bleed (position:fixed
   *      inset:0), status strip and controls bar replaced by floating overlays:
   *      a status pill top-left, a HUD hint top-right, and a floating auto-hiding
   *      controls bar at the bottom. Player mode (focusMode=false) keeps the
   *      normal flex-column layout (status strip / stage / controls bar).
   *
   * Props:
   *   onDisconnect — required; called when the user clicks Disconnect.
   */

  import { onDestroy } from "svelte";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import StreamControls from "../components/StreamControls.svelte";
  import StreamStatus from "../components/StreamStatus.svelte";
  import DiagnosticsHud from "../components/DiagnosticsHud.svelte";
  import ConnectingSplash from "../components/ConnectingSplash.svelte";
  import { connectingSteps, shouldShowSplash } from "$lib/console/connectingSplash.js";

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

  /** True once the <video> element is actually rendering frames. */
  let videoPlaying = $state(false);

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
    videoPlaying = false;

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

  // ── Stage: dot colour helper (mirrors StreamStatus logic for the pill) ─────────

  function dotColor(state: string): string {
    switch (state) {
      case "streaming":    return "var(--accent)";
      case "connecting":
      case "reconnecting": return "var(--warn)";
      case "failed":       return "var(--bad)";
      default:             return "var(--text-dim)";
    }
  }

  function stateLabel(state: string): string {
    switch (state) {
      case "idle":         return "Idle";
      case "connecting":   return "Connecting";
      case "streaming":    return "Streaming";
      case "reconnecting": return "Reconnecting";
      case "failed":       return "Failed";
      default:             return state;
    }
  }

  // ── Connecting splash ──────────────────────────────────────────────────────────
  const showSplash = $derived(
    shouldShowSplash(connectionStore.state, videoPlaying),
  );
  const splashSteps = $derived(
    connectingSteps({
      handshakeComplete: connectionStore.snapshot?.handshakeMs != null,
      videoArrived: connectionStore.snapshot?.videoArrivedAt != null,
    }),
  );

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
  {#if !focusMode}
    <!-- ── PLAYER MODE: flex-column layout (status strip / stage / controls bar) ── -->

    <!-- ── Status strip (top) ──────────────────────────────────────────────── -->
    <StreamStatus />

    <!-- ── Video stage (middle, flex: 1) ───────────────────────────────────── -->
    <div class="video-stage">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="stream-video"
        autoplay
        playsinline
        bind:this={videoEl}
        onplaying={() => (videoPlaying = true)}
        aria-label="Xbox console stream"
      ></video>

      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}

      <!-- ── Unmute affordance (autoplay policy fallback) ────────────────── -->
      {#if needsUnmute}
        <div class="unmute-overlay" aria-live="assertive">
          <button class="unmute-btn" onclick={handleUnmute}>
            Unmute &amp; Play
          </button>
          <p class="unmute-hint">Click to enable audio (browser autoplay policy)</p>
        </div>
      {/if}

      <!-- ── Diagnostics HUD (floats inside the stage) ─────────────────── -->
      <DiagnosticsHud />
    </div>

    <!-- ── Controls bar (bottom) ───────────────────────────────────────────── -->
    <StreamControls
      video={videoEl}
      fullscreenEl={containerEl}
      bind:focusMode
      {onDisconnect}
    />
  {:else}
    <!-- ── STAGE MODE: full-bleed video + floating overlays ─────────────────── -->

    <!-- Full-bleed video stage (position:fixed inset:0) -->
    <div class="stage-fullbleed">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="stage-video"
        autoplay
        playsinline
        bind:this={videoEl}
        onplaying={() => (videoPlaying = true)}
        aria-label="Xbox console stream"
      ></video>

      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}

      <!-- ── Unmute affordance (autoplay policy fallback) ────────────────── -->
      {#if needsUnmute}
        <div class="unmute-overlay" aria-live="assertive">
          <button class="unmute-btn" onclick={handleUnmute}>
            Unmute &amp; Play
          </button>
          <p class="unmute-hint">Click to enable audio (browser autoplay policy)</p>
        </div>
      {/if}

      <!-- ── Diagnostics HUD (floats inside the stage) ─────────────────── -->
      <DiagnosticsHud />

      <!-- ── Floating status pill — top-left ─────────────────────────────── -->
      <div class="stage-pill" role="status" aria-live="polite" aria-atomic="true">
        <span
          class="stage-pill__dot"
          style="background: {dotColor(connectionStore.state)};"
          aria-hidden="true"
        ></span>
        <span class="stage-pill__label">{stateLabel(connectionStore.state)}</span>
      </div>

      <!-- ── HUD hint — top-right ─────────────────────────────────────────── -->
      <span class="stage-hud-hint" aria-label="Press backtick to toggle diagnostics HUD">` HUD</span>

      <!-- ── Floating controls bar — bottom-centre ─────────────────────────── -->
      <StreamControls
        video={videoEl}
        fullscreenEl={containerEl}
        bind:focusMode
        floating={true}
        {onDisconnect}
      />
    </div>
  {/if}
</div>

<style>
  /* ── Root container — flex column filling the whole viewport ───────────── */

  .stream-screen {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: transparent;
    overflow: hidden;
  }

  /* In focus/Stage mode, hide the native window cursor after the controls fade */
  .stream-screen--focus {
    cursor: none;
  }

  /* ── Video stage — bordered area that grows to fill available space ─────── */

  .video-stage {
    position: relative;
    flex: 1;
    min-height: 0; /* allow flex shrink below intrinsic height */
    background: var(--video-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  /* ── Video element fills the Player stage ──────────────────────────────── */

  .stream-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: var(--video-bg);
  }

  /* ── Stage (full-bleed) ─────────────────────────────────────────────────── */

  .stage-fullbleed {
    position: fixed;
    inset: 0;
    background: var(--video-bg);
    z-index: 10;
    overflow: hidden;
  }

  /* Stage video fills wall-to-wall */
  .stage-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: var(--video-bg);
  }

  /* ── Floating status pill — top-left ────────────────────────────────────── */

  .stage-pill {
    position: absolute;
    top: var(--space-3);
    left: var(--space-3);
    z-index: 20;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    border: 1px solid var(--border);
    border-radius: 999px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    pointer-events: none;
  }

  .stage-pill__dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 300ms ease;
  }

  .stage-pill__label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
  }

  /* ── HUD hint — top-right ───────────────────────────────────────────────── */

  .stage-hud-hint {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 20;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: color-mix(in srgb, var(--text-dim) 70%, transparent);
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
  }

  /* ── Unmute overlay (shared between Player and Stage) ───────────────────── */

  .unmute-overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: color-mix(in srgb, var(--bg) 65%, transparent);
    backdrop-filter: blur(4px);
  }

  .unmute-btn {
    padding: var(--space-3) var(--space-5);
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-size: var(--text-lg);
    font-weight: 700;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .unmute-btn:hover {
    background: var(--accent-press);
  }

  .unmute-btn:focus-visible {
    box-shadow: var(--focus-ring);
  }

  .unmute-hint {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
