<script lang="ts">
  /**
   * Stream.svelte — Streaming screen: video element + controls overlay + status.
   *
   * Responsibilities:
   *   1. Binds connectionStore.mediaStream → video.srcObject reactively via
   *      $effect so any stream change (including reconnect) is picked up.
   *      (Browser path only — nativeMode skips the <video> element entirely;
   *       video renders natively behind the transparent HUD.)
   *   2. Dual-track playback (ported from app.js §3.10):
   *      - When mediaStream is set, waits ~250ms then calls video.play().
   *      - If the browser muted the video due to autoplay policy, surfaces
   *        an "Unmute" button that unmutes + replays on user click.
   *      (Browser path only — inert when nativeMode.)
   *   3. Composes StreamControls and StreamStatus.
   *   4. Focus/"Stage" mode (focusMode=true): video goes full-bleed (position:fixed
   *      inset:0), status strip and controls bar replaced by floating overlays:
   *      a status pill top-left, a HUD hint top-right, and a floating auto-hiding
   *      controls bar at the bottom. Player mode (focusMode=false) keeps the
   *      normal flex-column layout (status strip / stage / controls bar).
   *
   * Native mode (nativeMode = connectionStore.nativeMode):
   *   - No <video> element rendered (video surface is the native GTK GL area
   *     composited behind the transparent HUD).
   *   - srcObject / autoplay / needsUnmute / playTimer $effect returns early.
   *   - Splash dismissal is driven by connectionStore.state === "streaming"
   *     rather than videoPlaying (which never fires natively).
   *   - Volume control is hidden (audio played by Rust/cpal, no DOM video).
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
  import { rtcSetVolume } from "$lib/ipc/commands.js";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    /** Called when the user requests a disconnect (parent navigates away). */
    onDisconnect: () => void;
  }

  let { onDisconnect }: Props = $props();

  // ── Native mode gate ──────────────────────────────────────────────────────────

  const nativeMode = connectionStore.nativeMode;

  // Audio-only (browser path): no video track was negotiated. The <video> element
  // is still rendered — it's the audio sink and drives the unmute/volume logic —
  // but a minimal panel overlays its (black) surface, and splash dismissal keys
  // off store state (like native), since onplaying may not fire for audio-only.
  const audioOnly = $derived(connectionStore.audioOnly);

  // Native mode has no DOM <video>; route the volume slider's gain (0–1) to the
  // Rust audio sink. No-ops until the engine is connected (the command buffers).
  const onVolumeChange = nativeMode
    ? (gain: number) => {
        void rtcSetVolume(gain);
      }
    : undefined;

  // ── Element refs ──────────────────────────────────────────────────────────────

  let videoEl = $state<HTMLVideoElement | null>(null);
  let containerEl = $state<HTMLElement | null>(null);

  // ── Autoplay / mute state ─────────────────────────────────────────────────────

  /**
   * True when the browser blocked unmuted autoplay.
   * Surfaced as an "Unmute" affordance the user must click.
   * Always false in native mode (no <video>).
   */
  let needsUnmute = $state(false);

  /**
   * True once the <video> element is actually rendering frames (browser path).
   * Never set in native mode — splash dismissal uses store state instead.
   */
  let videoPlaying = $state(false);

  // ── Playback timer ref (cleaned up on destroy) ────────────────────────────────

  let playTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Reactive srcObject binding ────────────────────────────────────────────────
  //
  // We use $effect so this re-runs whenever connectionStore.mediaStream changes.
  // Setting srcObject is a DOM side-effect and must be done imperatively —
  // Svelte bind:srcObject is not a standard binding.
  //
  // In native mode: returns early immediately (no <video> exists; the native
  // GTK surface handles video). All guards are kept so no null-deref occurs.

  $effect(() => {
    // Native path: video is rendered by Rust behind the HUD — nothing to do.
    if (nativeMode) return;

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
  //
  // Browser path: hide once <video>.onplaying fires (videoPlaying=true), matching
  //   the original behaviour (shouldShowSplash checks videoPlaying).
  // Native path:  hide once the store state reaches "streaming" — the <video>
  //   element never fires `playing`, so we key off store state instead.
  //   NativeConnection synthesises handshakeMs/videoArrivedAt into the snapshot
  //   (6c.6) so the step indicators (session→handshake→video) still advance.
  const showSplash = $derived(
    nativeMode || audioOnly
      ? (connectionStore.state === "connecting" || connectionStore.state === "reconnecting")
      : shouldShowSplash(connectionStore.state, videoPlaying),
  );
  const splashSteps = $derived(
    connectingSteps({
      handshakeComplete: connectionStore.snapshot?.handshakeMs != null,
      videoArrived: connectionStore.snapshot?.videoArrivedAt != null,
      audioOnly,
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
    <div class="video-stage" class:native={nativeMode}>
      {#if !nativeMode}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="stream-video"
          autoplay
          playsinline
          bind:this={videoEl}
          onplaying={() => (videoPlaying = true)}
          aria-label="Xbox console stream"
        ></video>
      {/if}

      {#if audioOnly && !showSplash}
        <div class="audio-only-stage" role="status" aria-label="Audio-only stream">
          <span class="audio-only-badge">AUDIO ONLY</span>
          <p class="audio-only-name">{connectionStore.currentConsole?.deviceName ?? "Xbox"}</p>
          <div class="audio-only-indicator">
            <span class="audio-only-dot" aria-hidden="true"></span>
            <span>Connected · audio flowing</span>
          </div>
        </div>
      {/if}

      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}

      <!-- ── Unmute affordance (autoplay policy fallback — browser path only) ── -->
      {#if !nativeMode && needsUnmute}
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
      video={nativeMode ? null : videoEl}
      fullscreenEl={containerEl}
      bind:focusMode
      {onVolumeChange}
      {onDisconnect}
    />
  {:else}
    <!-- ── STAGE MODE: full-bleed video + floating overlays ─────────────────── -->

    <!-- Full-bleed video stage (position:fixed inset:0) -->
    <div class="stage-fullbleed" class:native={nativeMode}>
      {#if !nativeMode}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="stage-video"
          autoplay
          playsinline
          bind:this={videoEl}
          onplaying={() => (videoPlaying = true)}
          aria-label="Xbox console stream"
        ></video>
      {/if}

      {#if audioOnly && !showSplash}
        <div class="audio-only-stage" role="status" aria-label="Audio-only stream">
          <span class="audio-only-badge">AUDIO ONLY</span>
          <p class="audio-only-name">{connectionStore.currentConsole?.deviceName ?? "Xbox"}</p>
          <div class="audio-only-indicator">
            <span class="audio-only-dot" aria-hidden="true"></span>
            <span>Connected · audio flowing</span>
          </div>
        </div>
      {/if}

      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}

      <!-- ── Unmute affordance (autoplay policy fallback — browser path only) ── -->
      {#if !nativeMode && needsUnmute}
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
        video={nativeMode ? null : videoEl}
        fullscreenEl={containerEl}
        bind:focusMode
        floating={true}
        {onVolumeChange}
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

  /* ── Native-mode transparent stage backgrounds ──────────────────────────
   * In native mode the GTK GLArea sits behind the WebKit HUD and renders
   * Xbox video directly.  The stage containers must be transparent so the
   * GL surface shows through.  The browser path keeps its opaque #000 stage
   * (var(--video-bg)) and is completely unaffected by these rules.         */
  .video-stage.native,
  .stage-fullbleed.native {
    background: transparent;
    border-color: transparent;
  }

  /* ── Audio-only panel (overlays the black <video> when no video track) ───── */
  .audio-only-stage {
    position: absolute;
    inset: 0;
    z-index: 5; /* above the video, below splash / unmute / HUD / pill (z 20) */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: var(--video-bg);
    text-align: center;
    padding: var(--space-5);
  }

  .audio-only-badge {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.22em;
    color: var(--text-dim);
  }

  .audio-only-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    color: var(--text);
  }

  .audio-only-indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .audio-only-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: audio-only-pulse 2s ease-in-out infinite;
  }

  @keyframes audio-only-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
