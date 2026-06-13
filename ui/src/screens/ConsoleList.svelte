<script lang="ts">
  /**
   * ConsoleList.svelte — Xbox console discovery and selection screen.
   *
   * On mount, calls authStore.loadConsoles() to fetch the console list from
   * the xHome API.  Renders each console as a card showing deviceName,
   * consoleType, powerState (as a Badge), and isDevKit flag.
   *
   * Each card has a "Connect" button that calls the onConnect prop with the
   * chosen XHomeConsole.  The parent App wires this to the connection store
   * (Task 12); this component stays purely presentational.
   *
   * Props:
   *   onConnect — required callback invoked with the selected XHomeConsole.
   *
   * Handles: empty list, loading, and error states.
   */

  import { onMount } from "svelte";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import type { XHomeConsole } from "$lib/ipc/types.js";
  import Button from "$lib/design/Button.svelte";
  import Badge from "$lib/design/Badge.svelte";
  import SettingsModal from "../components/SettingsModal.svelte";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    /** Called with the chosen console when the user clicks Connect. */
    onConnect: (console: XHomeConsole) => void;
  }

  let { onConnect }: Props = $props();

  // ── Local state ───────────────────────────────────────────────────────────────

  let loading = $state(false);
  let settingsOpen = $state(false);

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onMount(async () => {
    loading = true;
    await authStore.loadConsoles();
    loading = false;
  });

  async function handleRefresh() {
    loading = true;
    await authStore.loadConsoles();
    loading = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  type BadgeTone = "success" | "warn" | "danger" | "neutral";

  /**
   * True when Xbox reports the console as powered on and available.
   * Xbox powerState values: "On", "ConnectedStandby", "Off".
   * Treat exactly "On" (case-insensitive) as ON; everything else as STANDBY.
   */
  function isOn(powerState: string): boolean {
    return powerState.toLowerCase() === "on";
  }

  /** Map Xbox powerState strings to Badge tone. */
  function powerStateTone(powerState: string): BadgeTone {
    return isOn(powerState) ? "success" : "neutral";
  }

  /** Human-friendly power state label for the Badge. */
  function powerStateLabel(powerState: string): string {
    return isOn(powerState) ? "ON" : "STANDBY";
  }

  /** Friendly console type label. */
  function consoleTypeLabel(consoleType: string): string {
    const map: Record<string, string> = {
      XboxSeriesX: "Xbox Series X",
      XboxSeriesS: "Xbox Series S",
      XboxOne: "Xbox One",
      XboxOneS: "Xbox One S",
      XboxOneX: "Xbox One X",
    };
    return map[consoleType] ?? consoleType;
  }
</script>

<div class="console-list-screen">
  {#if connectionStore.failureReason}
    <div class="failure-banner" role="alert">
      <span class="failure-banner__text">{connectionStore.failureReason}</span>
      <button
        class="failure-banner__dismiss"
        onclick={() => (connectionStore.failureReason = null)}
        aria-label="Dismiss"
      >✕</button>
    </div>
  {/if}

  <!-- ── Header row ── -->
  <header class="screen-header">
    <div class="header-identity">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="signed-in-label">signed in</span>
    </div>
    <div class="header-right">
      <span class="wordmark">XBOX REMOTE</span>
      <button
        type="button"
        class="settings-gear"
        onclick={() => (settingsOpen = true)}
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
    </div>
  </header>

  <!-- ── Console list panel ── -->
  <div class="console-panel">
    <!-- Section label + refresh -->
    <div class="section-row">
      <span class="section-label">YOUR CONSOLES</span>
      <Button variant="ghost" onclick={handleRefresh} disabled={loading}>
        Refresh
      </Button>
    </div>

    <div class="console-list-body">
      {#if loading}
        <div class="center-state">
          <div class="spinner" role="status" aria-label="Loading consoles"></div>
          <p class="state-text">Loading consoles…</p>
        </div>

      {:else if authStore.error}
        <div class="center-state">
          <p class="error-message" role="alert">{authStore.error}</p>
          <Button onclick={handleRefresh}>Try again</Button>
        </div>

      {:else if authStore.consoles.length === 0}
        <div class="center-state">
          <p class="state-text">No consoles found.</p>
          <p class="state-subtext">
            Make sure Remote Play is enabled on your Xbox and you're signed in
            with the same Microsoft account.
          </p>
          <Button onclick={handleRefresh}>Refresh</Button>
        </div>

      {:else}
        <ul class="console-cards" role="list">
          {#each authStore.consoles as console (console.serverId)}
            <li
              class="console-card"
              class:console-card--standby={!isOn(console.powerState)}
            >
              <div class="console-card__info">
                <div class="console-card__header">
                  <span class="console-card__name">{console.deviceName}</span>
                  {#if console.isDevKit}
                    <Badge tone="warn">Dev Kit</Badge>
                  {/if}
                </div>
                <div class="console-card__meta">
                  <span class="console-card__type">
                    {consoleTypeLabel(console.consoleType)}
                  </span>
                  <Badge tone={powerStateTone(console.powerState)}>
                    {powerStateLabel(console.powerState)}
                  </Badge>
                </div>
              </div>
              <Button onclick={() => onConnect(console)}>Connect →</Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <SettingsModal bind:open={settingsOpen} onClose={() => (settingsOpen = false)} />
</div>

<style>
  /* ── Screen shell ─────────────────────────────────────────────────────────── */

  .console-list-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: var(--space-5);
    background: transparent;
    gap: var(--space-4);
  }

  /* ── Header row ───────────────────────────────────────────────────────────── */

  .screen-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    max-width: 560px;
    padding: var(--space-2) 0;
  }

  .header-identity {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  /* Settings gear — quiet ghost icon button */
  .settings-gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .settings-gear:hover {
    background: var(--surface-2);
    border-color: var(--text-dim);
    color: var(--text);
  }

  .settings-gear:focus-visible {
    box-shadow: var(--focus-ring);
  }

  /* Pulsing green dot — signals "signed in / live" */
  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  .signed-in-label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .wordmark {
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: 700;
    color: var(--text);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  /* ── Console panel ────────────────────────────────────────────────────────── */

  .console-panel {
    width: 100%;
    max-width: 560px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    overflow: hidden;
    animation: panel-rise 600ms var(--ease-out) backwards;
    animation-delay: 80ms;
  }

  @keyframes panel-rise {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Section header row ───────────────────────────────────────────────────── */

  .section-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .section-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  /* ── Body ─────────────────────────────────────────────────────────────────── */

  .console-list-body {
    padding: var(--space-4);
  }

  /* ── Center states (loading / empty / error) ──────────────────────────────── */

  .center-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5) 0;
    text-align: center;
  }

  .state-text {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    color: var(--text-dim);
  }

  .state-subtext {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
    max-width: 360px;
    line-height: 1.6;
  }

  .error-message {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    width: 100%;
    box-sizing: border-box;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Console cards ────────────────────────────────────────────────────────── */

  .console-cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .console-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color 150ms ease, background 150ms ease;
  }

  .console-card:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, var(--surface-2));
  }

  /* Dim standby rows — still legible but visually de-emphasised */
  .console-card--standby {
    opacity: 0.6;
  }

  .console-card__info {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .console-card__header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .console-card__name {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .console-card__meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .console-card__type {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  /* ── Failure banner ───────────────────────────────────────────────────────── */

  .failure-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: color-mix(in srgb, var(--bad) 14%, var(--surface));
    border: 1px solid var(--bad);
    border-radius: var(--radius-md);
    color: var(--text);
    width: 100%;
    max-width: 560px;
    box-sizing: border-box;
  }

  .failure-banner__text {
    flex: 1;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .failure-banner__dismiss {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-sm);
    line-height: 1;
    cursor: pointer;
    padding: 2px var(--space-1);
    border-radius: var(--radius-sm);
  }

  .failure-banner__dismiss:hover {
    color: var(--text);
  }

  .failure-banner__dismiss:focus-visible {
    box-shadow: var(--focus-ring);
  }
</style>
