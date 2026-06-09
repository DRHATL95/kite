<script lang="ts">
  /**
   * ChannelPanel.svelte — WebRTC data-channel diagnostics and track timing.
   *
   * Shows:
   *   - Per-channel (chat/control/message/input) open/closed Badge + openedAt
   *   - handshakeMs
   *   - Track arrival skew (videoArrivedAt / audioArrivedAt / skewMs)
   *   - Input telemetry: outboundPacketHz / lastSequence
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import Badge from "$lib/design/Badge.svelte";
  import type { DiagnosticsSnapshot, ChannelStats } from "$lib/connection/types.js";

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Placeholder channels when snapshot is null ───────────────────────────────

  const EXPECTED_CHANNELS = ["chat", "control", "message", "input"] as const;

  /** Returns a display list: merges snapshot channels with expected labels so
   *  we always show all four rows in a stable order. */
  const channelRows = $derived((): Array<{ label: string; stats: ChannelStats | null }> => {
    return EXPECTED_CHANNELS.map((label) => {
      const stats =
        snapshot?.channels.find((c) => c.label === label) ?? null;
      return { label, stats };
    });
  });

  type BadgeTone = "success" | "warn" | "danger" | "neutral";

  function channelTone(state: RTCDataChannelState | undefined): BadgeTone {
    switch (state) {
      case "open":     return "success";
      case "closing":  return "warn";
      case "closed":   return "danger";
      case "connecting": return "warn";
      default:         return "neutral";
    }
  }

  /** Format a ms-since-epoch timestamp into a relative "Xs ago" string. */
  function relativeAgo(ts: number | null): string {
    if (ts == null) return "—";
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    return `${min}m ${sec % 60}s ago`;
  }

  // ── Track skew tone ──────────────────────────────────────────────────────────

  const skewTone = $derived((): "default" | "warn" | "danger" => {
    const ms = snapshot?.skewMs;
    if (ms == null) return "default";
    if (ms < 100) return "default";
    if (ms < 500) return "warn";
    return "danger";
  });
</script>

<Panel title="Channels">
  <!-- Per-channel badges -->
  <div class="channels">
    {#each channelRows() as row (row.label)}
      <div class="channel-row">
        <span class="channel-label">{row.label}</span>
        <Badge tone={channelTone(row.stats?.state)}>
          {row.stats?.state ?? "—"}
        </Badge>
        <span class="channel-time">
          {relativeAgo(row.stats?.openedAt ?? null)}
        </span>
      </div>
    {/each}
  </div>

  <!-- Handshake time -->
  <div class="grid">
    <Stat label="Handshake" value={snapshot?.handshakeMs ?? null} unit="ms" />
  </div>

  <!-- Track arrival skew -->
  <div class="section">
    <span class="section-label">Track arrival</span>
    <div class="grid">
      <Stat label="Video arrived"  value={snapshot?.videoArrivedAt != null ? relativeAgo(snapshot.videoArrivedAt) : null} />
      <Stat label="Audio arrived"  value={snapshot?.audioArrivedAt != null ? relativeAgo(snapshot.audioArrivedAt) : null} />
      <Stat label="A/V skew"       value={snapshot?.skewMs ?? null} unit="ms" tone={skewTone()} />
    </div>
  </div>

  <!-- Input telemetry -->
  <div class="section">
    <span class="section-label">Input</span>
    <div class="grid">
      <Stat label="Packet rate" value={snapshot?.outboundPacketHz != null ? snapshot.outboundPacketHz.toFixed(1) : null} unit="Hz" />
      <Stat label="Last seq"    value={snapshot?.lastSequence ?? null} />
    </div>
  </div>
</Panel>

<style>
  .channels {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .channel-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .channel-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    min-width: 52px;
  }

  .channel-time {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    margin-left: auto;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }

  .section {
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    margin-top: var(--space-3);
  }

  .section-label {
    display: block;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: var(--space-2);
  }
</style>
