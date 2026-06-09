<script lang="ts">
  /**
   * PacketPanel.svelte — Packet-level health metrics from DiagnosticsSnapshot.
   *
   * Shows: packetsLost, lossPct (tone by severity), jitter, jitterBufferDelay,
   * nackCount, pliCount (highlighted as keyframe-recovery signal), keyframeRequestsSent,
   * msSinceLastKeyframe.
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Loss % tone: success < 1%, warn 1–5%, danger > 5% ──────────────────────
  const lossTone = $derived((): "default" | "success" | "warn" | "danger" => {
    const pct = snapshot?.lossPct;
    if (pct == null) return "default";
    if (pct < 1)  return "success";
    if (pct < 5)  return "warn";
    return "danger";
  });

  /** Display lossPct as a string like "2.1" (1 decimal place). */
  const lossPctDisplay = $derived(
    snapshot?.lossPct != null ? snapshot.lossPct.toFixed(1) : null,
  );

  /** Jitter in ms (raw field is in seconds). */
  const jitterMs = $derived(
    snapshot?.jitter != null ? Math.round(snapshot.jitter * 1000) : null,
  );

  /** Jitter buffer delay in ms. */
  const jitterBufMs = $derived(
    snapshot?.jitterBufferDelay != null
      ? Math.round(snapshot.jitterBufferDelay * 1000)
      : null,
  );

  /**
   * pliCount tone: 0 = default, 1–2 = warn, 3+ = danger.
   * PLI indicates the decoder requested a full keyframe — elevated counts mean
   * the stream is corrupting more often than usual.
   */
  const pliTone = $derived((): "default" | "warn" | "danger" => {
    const n = snapshot?.pliCount;
    if (n == null || n === 0) return "default";
    if (n <= 2) return "warn";
    return "danger";
  });
</script>

<Panel title="Packets">
  <div class="grid">
    <Stat label="Lost"      value={snapshot?.packetsLost ?? null} />
    <Stat label="Loss %"    value={lossPctDisplay} unit="%" tone={lossTone()} />
    <Stat label="Received"  value={snapshot?.packetsReceived ?? null} />
    <Stat label="Jitter"    value={jitterMs} unit="ms" />
    <Stat label="Jitter buf" value={jitterBufMs} unit="ms" />
    <Stat label="NACK"      value={snapshot?.nackCount ?? null} />
    <Stat label="PLI"       value={snapshot?.pliCount ?? null} tone={pliTone()} />
    <Stat label="KF req"    value={snapshot?.keyframeRequestsSent ?? null} />
    <Stat label="Last KF"   value={snapshot?.msSinceLastKeyframe ?? null} unit="ms" />
  </div>
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }
</style>
