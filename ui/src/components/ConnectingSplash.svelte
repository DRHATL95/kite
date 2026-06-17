<script lang="ts">
  /**
   * ConnectingSplash.svelte — Animated overlay shown during the WebRTC
   * handshake, before the first video frame. Shows the target console
   * "powering on" with the step indicators driven by real progress.
   *
   * Pure CSS keyframes (opacity/transform) so it stays smooth while the main
   * thread negotiates SDP/ICE. Freezes under prefers-reduced-motion.
   */
  import ConsoleArt from "./ConsoleArt.svelte";
  import { consoleTypeLabel } from "$lib/console/consoleArt.js";
  import type { ConnectingSteps } from "$lib/console/connectingSplash.js";
  import type { XHomeConsole } from "$lib/ipc/types.js";

  interface Props {
    console: XHomeConsole | null;
    steps: ConnectingSteps;
  }

  let { console: xc, steps }: Props = $props();

  const name = $derived(xc?.deviceName || "Xbox");
  const type = $derived(xc?.consoleType ?? "");
</script>

<div class="splash" role="status" aria-live="polite">
  <div class="splash__glow" aria-hidden="true"></div>
  <div class="splash__art"><ConsoleArt consoleType={type} size={96} /></div>
  <div class="splash__title">Waking {name}</div>
  <div class="splash__sub">{consoleTypeLabel(type)} · negotiating connection</div>
  <div class="splash__bar" aria-hidden="true"><div class="splash__bar-fill"></div></div>
  <div class="splash__steps">
    <span class="step step--{steps.session}"><i class="dot"></i>session</span>
    <span class="step step--{steps.handshake}"><i class="dot"></i>handshake</span>
    <span class="step step--{steps.video}"><i class="dot"></i>video</span>
  </div>
</div>

<style>
  .splash {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: var(--video-bg);
    text-align: center;
    padding: var(--space-5);
  }

  .splash__glow {
    position: absolute;
    width: 200px;
    height: 200px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.18;
    animation: splashGlow 2.6s ease-in-out infinite;
  }

  .splash__art {
    position: relative;
    animation: splashFloat 3.4s ease-in-out infinite;
  }

  .splash :global(.console-art__pulse) {
    animation: splashRing 1.6s ease-in-out infinite;
  }

  .splash__title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 500;
    color: var(--text);
  }

  .splash__sub {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .splash__bar {
    position: relative;
    width: 220px;
    height: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .splash__bar-fill {
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-pill);
    animation: splashSweep 1.5s ease-in-out infinite;
  }

  .splash__steps {
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-1);
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .step .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border);
  }

  .step--done {
    color: var(--accent);
  }
  .step--done .dot {
    background: var(--accent);
  }

  .step--active {
    color: var(--text);
  }
  .step--active .dot {
    background: var(--accent);
    animation: splashDot 1.2s ease-in-out infinite;
  }

  .step--pending {
    opacity: 0.6;
  }

  @keyframes splashFloat {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-6px); }
  }
  @keyframes splashRing {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 1; }
  }
  @keyframes splashGlow {
    0%, 100% { opacity: 0.14; transform: scale(0.85); }
    50%      { opacity: 0.4;  transform: scale(1.12); }
  }
  @keyframes splashSweep {
    0%   { left: -40%; }
    100% { left: 100%; }
  }
  @keyframes splashDot {
    0%, 100% { opacity: 0.3; }
    50%      { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .splash__art,
    .splash__glow,
    .splash__bar-fill,
    .step--active .dot,
    .splash :global(.console-art__pulse) {
      animation: none;
    }
  }
</style>
