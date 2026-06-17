<script lang="ts">
  /**
   * SessionPanel.svelte — Session lifecycle and reconnect diagnostics.
   *
   * Shows: state, activeKeepalive, msSinceLastKeepalive,
   * lastIdleWarningSecondsUntilKick; reconnect info: currentAttempt /
   * maxAttempts, lastTriggerReason, backoffMs.
   *
   * Semantic colour rule:
   *   - state: streaming → good; connecting/reconnecting → warn; failed → bad
   *   - keepalive: api → good; idle → warn; none → neutral
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import Badge from "$lib/design/Badge.svelte";
  import { consoleTypeLabel } from "$lib/console/consoleArt.js";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Session state badge tone ─────────────────────────────────────────────────

  type BadgeTone = "good" | "success" | "warn" | "bad" | "danger" | "neutral";

  function stateTone(s: string | undefined): BadgeTone {
    switch (s) {
      case "streaming":    return "good";
      case "connecting":   return "warn";
      case "reconnecting": return "warn";
      case "failed":       return "bad";
      default:             return "neutral";
    }
  }

  // ── Keepalive tone ───────────────────────────────────────────────────────────

  function keepaliveTone(mode: string | undefined): BadgeTone {
    switch (mode) {
      case "api":  return "good";
      case "idle": return "warn";
      case "none": return "neutral";
      default:     return "neutral";
    }
  }

  // ── Idle-kick warning ────────────────────────────────────────────────────────

  const kickWarning = $derived(snapshot?.lastIdleWarningSecondsUntilKick);

  // ── Reconnect: only show section when reconnecting or there is a reason ──────
  const showReconnect = $derived(
    snapshot != null &&
    (snapshot.currentAttempt > 0 || snapshot.lastTriggerReason != null),
  );
</script>

<Panel title="Session">
  {#if snapshot?.consoleName}
    <div class="identity">
      <span class="identity__name">{snapshot.consoleName}</span>
      <span class="identity__type">{consoleTypeLabel(snapshot.consoleType ?? "")}</span>
    </div>
  {/if}
  <!-- State + keepalive badges -->
  <div class="badge-row">
    {#if snapshot != null}
      <Badge tone={stateTone(snapshot.state)}>{snapshot.state}</Badge>
      <Badge tone={keepaliveTone(snapshot.activeKeepalive)}>
        keepalive: {snapshot.activeKeepalive}
      </Badge>
    {:else}
      <span class="placeholder">awaiting connection</span>
    {/if}
  </div>

  <!-- Idle kick warning (shown only when present) -->
  {#if kickWarning != null}
    <div class="kick-warn">
      Idle kick in {kickWarning}s
    </div>
  {/if}

  <!-- Timing -->
  <div class="grid">
    <Stat label="Last keepalive" value={snapshot?.msSinceLastKeepalive ?? null} unit="ms" />
  </div>

  <!-- Reconnect section -->
  {#if showReconnect}
    <div class="reconnect">
      <span class="section-label">Reconnect</span>
      <div class="grid reconnect-grid">
        <Stat label="Attempt"  value={snapshot?.currentAttempt ?? null} />
        <Stat label="Max"      value={snapshot?.maxAttempts ?? null} />
        <Stat label="Backoff"  value={snapshot?.backoffMs ?? null} unit="ms" />
      </div>
      {#if snapshot?.lastTriggerReason}
        <div class="trigger-reason">
          <span class="section-label">Trigger</span>
          <span class="reason-text">{snapshot.lastTriggerReason}</span>
        </div>
      {/if}
    </div>
  {/if}
</Panel>

<style>
  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .identity__name {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  .identity__type {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .kick-warn {
    margin-bottom: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--warn) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--warn);
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }

  .reconnect {
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
    margin-top: var(--space-3);
  }

  .reconnect-grid {
    grid-template-columns: 1fr 1fr 1fr;
    margin-top: var(--space-2);
  }

  .section-label {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: var(--space-1);
  }

  .trigger-reason {
    margin-top: var(--space-2);
  }

  .reason-text {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    word-break: break-word;
  }

  .placeholder {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
