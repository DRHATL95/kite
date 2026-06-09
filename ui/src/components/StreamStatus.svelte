<script lang="ts">
  /**
   * StreamStatus.svelte — Top strip: live dot, console name, at-a-glance stats.
   *
   * Reads connectionStore.state (SessionState) and connectionStore.snapshot
   * (DiagnosticsSnapshot) and maps them to semantic colour tokens:
   *   streaming        → var(--accent)     (good/active/healthy)
   *   connecting/reconnecting → var(--warn)
   *   failed           → var(--bad)
   *   idle             → var(--text-dim)
   *
   * At-a-glance stats (fps / loss / rtt) are shown from the snapshot.
   * Loss thresholds:
   *   > LOSS_WARN_PCT (2%)  → var(--warn)
   *   > LOSS_BAD_PCT  (5%)  → var(--bad)
   *   otherwise             → var(--accent)  (healthy key value)
   */

  import { connectionStore } from "$lib/stores/connection.svelte.js";

  // ── Loss thresholds (named constants) ─────────────────────────────────────────
  const LOSS_WARN_PCT = 2;
  const LOSS_BAD_PCT  = 5;

  // ── Derived helpers ───────────────────────────────────────────────────────────

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

  function lossColor(pct: number): string {
    if (pct > LOSS_BAD_PCT)  return "var(--bad)";
    if (pct > LOSS_WARN_PCT) return "var(--warn)";
    return "var(--accent)";
  }
</script>

<div class="stream-status" role="status" aria-live="polite" aria-atomic="true">
  <!-- Left group: live dot + state label -->
  <div class="status-left">
    <!-- Live dot -->
    <span
      class="live-dot"
      style="background: {dotColor(connectionStore.state)};"
      aria-hidden="true"
    ></span>

    <!-- State label -->
    <span class="state-label">{stateLabel(connectionStore.state)}</span>

    <!-- Reconnect attempt count (warn tone) -->
    {#if connectionStore.state === "reconnecting" && connectionStore.snapshot}
      <span class="reconnect-info" style="color: var(--warn);">
        attempt {connectionStore.snapshot.currentAttempt}/{connectionStore.snapshot.maxAttempts}
        {#if connectionStore.snapshot.lastTriggerReason}
          &mdash; {connectionStore.snapshot.lastTriggerReason}
        {/if}
      </span>
    {/if}
  </div>

  <!-- Centre group: at-a-glance stats -->
  {#if connectionStore.snapshot}
    {@const snap = connectionStore.snapshot}
    <div class="stats-group" aria-label="Stream statistics">
      <!-- FPS -->
      {#if snap.fps !== null}
        <span class="stat">
          <span class="stat-label">fps</span>
          <span class="stat-value" style="color: var(--accent);">{Math.round(snap.fps)}</span>
        </span>
      {/if}

      <!-- Loss % -->
      {#if snap.lossPct !== null}
        <span class="stat">
          <span class="stat-label">loss</span>
          <span class="stat-value" style="color: {lossColor(snap.lossPct)};">{snap.lossPct.toFixed(1)}%</span>
        </span>
      {/if}

      <!-- RTT -->
      {#if snap.rttMs !== null}
        <span class="stat">
          <span class="stat-label">rtt</span>
          <span class="stat-value" style="color: var(--accent);">{Math.round(snap.rttMs)}ms</span>
        </span>
      {/if}
    </div>
  {/if}

  <!-- Right: HUD hint -->
  <span class="hud-hint" aria-label="Press backtick to toggle diagnostics HUD">` HUD</span>
</div>

<style>
  .stream-status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* ── Left group ─────────────────────────────────────────────────────────── */

  .status-left {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 300ms ease;
  }

  .state-label {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
  }

  .reconnect-info {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  /* ── Stats group ────────────────────────────────────────────────────────── */

  .stats-group {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
  }

  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }

  .stat-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: lowercase;
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  /* ── HUD hint (right-aligned) ───────────────────────────────────────────── */

  .hud-hint {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    white-space: nowrap;
    user-select: none;
  }
</style>
