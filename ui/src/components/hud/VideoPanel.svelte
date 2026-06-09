<script lang="ts">
  /**
   * VideoPanel.svelte — Video quality metrics from DiagnosticsSnapshot.
   *
   * Shows: fps, resolution (w×h), framesDecoded, framesDropped, freezeCount
   * (highlighted with warn/danger tone), totalFreezesDuration, inboundVideoKbps,
   * and availableIncomingBitrate.
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Derived display values ──────────────────────────────────────────────────

  const resolution = $derived(
    snapshot?.width != null && snapshot?.height != null
      ? `${snapshot.width}×${snapshot.height}`
      : null,
  );

  const availKbps = $derived(
    snapshot?.availableIncomingBitrate != null
      ? Math.round(snapshot.availableIncomingBitrate / 1000)
      : null,
  );

  /** Freeze severity tone: warn for 1–2 freezes, danger for 3+. */
  const freezeTone = $derived((): "default" | "warn" | "danger" => {
    const c = snapshot?.freezeCount;
    if (c == null || c === 0) return "default";
    if (c <= 2) return "warn";
    return "danger";
  });

  /** Total freeze duration in seconds, rounded to 2 decimal places. */
  const freezeDurSec = $derived(
    snapshot?.totalFreezesDuration != null
      ? snapshot.totalFreezesDuration.toFixed(2)
      : null,
  );
</script>

<Panel title="Video">
  <div class="grid">
    <Stat label="FPS"        value={snapshot?.fps ?? null} />
    <Stat label="Resolution" value={resolution} />
    <Stat label="Decoded"    value={snapshot?.framesDecoded ?? null} />
    <Stat label="Dropped"    value={snapshot?.framesDropped ?? null} />
    <Stat label="Freezes"    value={snapshot?.freezeCount ?? null} tone={freezeTone()} />
    <Stat label="Freeze dur" value={freezeDurSec} unit="s" tone={freezeTone()} />
    <Stat label="Inbound"    value={snapshot?.inboundVideoKbps ?? null} unit="kbps" />
    <Stat label="Available"  value={availKbps} unit="kbps" />
  </div>
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }
</style>
