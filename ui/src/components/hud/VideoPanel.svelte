<script lang="ts">
  /**
   * VideoPanel.svelte — Video quality metrics from DiagnosticsSnapshot.
   *
   * Shows: fps, resolution (w×h), framesDecoded, framesDropped, freezeCount
   * (highlighted with warn tone), totalFreezesDuration, inboundVideoKbps,
   * and availableIncomingBitrate.
   *
   * Semantic colour rule:
   *   - freezeCount === 0 → good (accent green)
   *   - freezeCount > 0   → warn (amber)
   *   - framesDropped > 0 → warn
   *   - fps / resolution  → neutral text
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

  // ── Thresholds ───────────────────────────────────────────────────────────────
  const FREEZE_WARN = 1;          // any freeze at all is a warning
  const FRAMES_DROPPED_WARN = 0;  // any dropped frame → warn

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

  /**
   * Freeze tone: good (green) when healthy (no freezes), warn when any freeze occurred.
   * healthy = 0 freezes → good; any freeze → warn.
   */
  const freezeTone = $derived((): "good" | "warn" | "neutral" => {
    const c = snapshot?.freezeCount;
    if (c == null) return "neutral";
    if (c === 0) return "good";
    return "warn";
  });

  /** framesDropped tone: warn if any frames dropped. */
  const droppedTone = $derived((): "warn" | "neutral" => {
    const d = snapshot?.framesDropped;
    if (d == null || d <= FRAMES_DROPPED_WARN) return "neutral";
    return "warn";
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
    <Stat label="Dropped"    value={snapshot?.framesDropped ?? null} tone={droppedTone()} />
    <Stat label="Freezes"    value={snapshot?.freezeCount ?? null} tone={freezeTone()} />
    <Stat label="Freeze dur" value={freezeDurSec} unit="s" tone={freezeTone()} />
    <Stat label="Bitrate"    value={snapshot?.inboundVideoKbps ?? null} unit="kbps" />
    <Stat label="Avail. bw"  value={availKbps} unit="kbps" />
  </div>
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }
</style>
