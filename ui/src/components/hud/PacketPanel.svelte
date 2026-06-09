<script lang="ts">
  /**
   * PacketPanel.svelte — Packet-level health metrics from DiagnosticsSnapshot.
   *
   * Shows: packetsLost, lossPct (tone by severity), jitter, jitterBufferDelay,
   * nackCount, pliCount (highlighted as keyframe-recovery signal), keyframeRequestsSent,
   * msSinceLastKeyframe.
   *
   * Semantic colour rule:
   *   - lossPct <= 2  → good; lossPct > 2 → warn; lossPct > 5 → bad
   *   - pliCount > 0  → warn
   *   - jitter > 30ms → warn
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  // ── Thresholds ───────────────────────────────────────────────────────────────
  const LOSS_WARN_PCT  = 2;
  const LOSS_BAD_PCT   = 5;
  const PLI_WARN       = 1;   // any PLI is noteworthy
  const JITTER_WARN_MS = 30;

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Loss % tone: good ≤ 2%, warn 2–5%, bad > 5% ─────────────────────────────
  const lossTone = $derived((): "good" | "warn" | "bad" | "neutral" => {
    const pct = snapshot?.lossPct;
    if (pct == null) return "neutral";
    if (pct > LOSS_BAD_PCT)  return "bad";
    if (pct > LOSS_WARN_PCT) return "warn";
    return "good";
  });

  /** Display lossPct as a string like "2.1" (1 decimal place). */
  const lossPctDisplay = $derived(
    snapshot?.lossPct != null ? snapshot.lossPct.toFixed(1) : null,
  );

  /** Jitter in ms (raw field is in seconds). */
  const jitterMs = $derived(
    snapshot?.jitter != null ? Math.round(snapshot.jitter * 1000) : null,
  );

  /** Jitter tone: warn if > JITTER_WARN_MS. */
  const jitterTone = $derived((): "warn" | "neutral" => {
    const ms = jitterMs;
    if (ms == null) return "neutral";
    return ms > JITTER_WARN_MS ? "warn" : "neutral";
  });

  /** Jitter buffer delay in ms. */
  const jitterBufMs = $derived(
    snapshot?.jitterBufferDelay != null
      ? Math.round(snapshot.jitterBufferDelay * 1000)
      : null,
  );

  /**
   * pliCount tone: 0 = neutral, any PLI = warn.
   * PLI indicates the decoder requested a full keyframe — elevated counts mean
   * the stream is corrupting more often than usual.
   */
  const pliTone = $derived((): "warn" | "neutral" => {
    const n = snapshot?.pliCount;
    if (n == null || n < PLI_WARN) return "neutral";
    return "warn";
  });
</script>

<Panel title="Packets">
  <div class="grid">
    <Stat label="Lost"      value={snapshot?.packetsLost ?? null} />
    <Stat label="Loss %"    value={lossPctDisplay} unit="%" tone={lossTone()} />
    <Stat label="Received"  value={snapshot?.packetsReceived ?? null} />
    <Stat label="Jitter"    value={jitterMs} unit="ms" tone={jitterTone()} />
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
