<script lang="ts">
  /**
   * NetworkPanel.svelte — Network / ICE diagnostics from DiagnosticsSnapshot.
   *
   * Shows: rttMs, localCandidateType / remoteCandidateType as Badges (relay
   * is highlighted good/accent since it is the key Spec-3 signal — relay means
   * TURN is working), candidatePairState, iceConnectionState / iceGatheringState /
   * connectionState, and ICE provenance (source + stunCount/turnCount +
   * remoteCandidatesAdded + icePollAttemptsUsed).
   *
   * Semantic colour rule:
   *   - relay candidate type → good (accent: relay = TURN path is working)
   *   - srflx → neutral
   *   - RTT > 80ms → warn; RTT > 150ms → bad
   *   - source === 'xbox-provided' → good; 'fallback-only' → bad
   *   - connected/completed → good; checking/gathering/new → warn; disconnected/failed/closed → bad
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import Badge from "$lib/design/Badge.svelte";
  import type { DiagnosticsSnapshot, CandidateType } from "$lib/connection/types.js";

  // ── Thresholds ───────────────────────────────────────────────────────────────
  const RTT_WARN_MS = 80;
  const RTT_BAD_MS  = 150;

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Candidate-type badge tone ────────────────────────────────────────────────

  type BadgeTone = "good" | "success" | "warn" | "bad" | "danger" | "neutral";

  function candidateTone(type: CandidateType | null | undefined): BadgeTone {
    switch (type) {
      case "relay":  return "good";    // relay = TURN; key Spec-3 signal — accent
      case "srflx":  return "neutral";
      case "host":   return "neutral";
      case "prflx":  return "neutral";
      default:       return "neutral";
    }
  }

  // ── RTT tone ─────────────────────────────────────────────────────────────────

  const rttTone = $derived((): "good" | "warn" | "bad" | "neutral" => {
    const rtt = snapshot?.rttMs;
    if (rtt == null) return "neutral";
    if (rtt > RTT_BAD_MS)  return "bad";
    if (rtt > RTT_WARN_MS) return "warn";
    return "good";
  });

  // ── Connection state badge tone ──────────────────────────────────────────────

  function connTone(state: string | null | undefined): BadgeTone {
    switch (state) {
      case "connected":
      case "completed":   return "good";
      case "checking":
      case "gathering":
      case "new":         return "warn";
      case "disconnected":
      case "failed":
      case "closed":      return "bad";
      default:            return "neutral";
    }
  }

  // ── ICE provenance tone ──────────────────────────────────────────────────────

  const provenanceTone = $derived((): BadgeTone => {
    switch (snapshot?.source) {
      case "xbox-provided": return "good";
      case "fallback-only": return "bad";
      default:              return "neutral";
    }
  });

  const provenanceLabel = $derived((): string => {
    switch (snapshot?.source) {
      case "xbox-provided": return "xbox-provided";
      case "fallback-only": return "fallback-only";
      default:              return "unknown";
    }
  });
</script>

<Panel title="Network / ICE">
  <!-- RTT + candidate pair state -->
  <div class="grid">
    <Stat label="RTT" value={snapshot?.rttMs ?? null} unit="ms" tone={rttTone()} />
    <Stat label="Pair state" value={snapshot?.candidatePairState ?? "—"} />
  </div>

  <!-- Candidate types -->
  <div class="candidate-row">
    <div class="candidate-item">
      <span class="cand-label">Local</span>
      {#if snapshot?.localCandidateType != null}
        <Badge tone={candidateTone(snapshot.localCandidateType)}>
          {snapshot.localCandidateType}
        </Badge>
      {:else}
        <span class="placeholder">—</span>
      {/if}
    </div>
    <div class="candidate-item">
      <span class="cand-label">Remote</span>
      {#if snapshot?.remoteCandidateType != null}
        <Badge tone={candidateTone(snapshot.remoteCandidateType)}>
          {snapshot.remoteCandidateType}
        </Badge>
      {:else}
        <span class="placeholder">—</span>
      {/if}
    </div>
  </div>

  <!-- Connection states -->
  <div class="state-row">
    {#if snapshot != null}
      <Badge tone={connTone(snapshot.iceConnectionState)}>{snapshot.iceConnectionState}</Badge>
      <Badge tone={connTone(snapshot.iceGatheringState)}>{snapshot.iceGatheringState}</Badge>
      <Badge tone={connTone(snapshot.connectionState)}>{snapshot.connectionState}</Badge>
    {:else}
      <span class="placeholder">awaiting connection</span>
    {/if}
  </div>

  <!-- ICE provenance — Spec-3 key signal -->
  <div class="provenance">
    <span class="section-label">ICE Provenance</span>
    <div class="provenance-row">
      <Badge tone={provenanceTone()}>{provenanceLabel()}</Badge>
      <span class="prov-counts">
        STUN {snapshot?.stunCount ?? "—"} / TURN {snapshot?.turnCount ?? "—"}
      </span>
    </div>
    <div class="grid prov-grid">
      <Stat label="Remote cands" value={snapshot?.remoteCandidatesAdded ?? null} />
      <Stat label="ICE polls"    value={snapshot?.icePollAttemptsUsed ?? null} />
    </div>
  </div>
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
    margin-bottom: var(--space-3);
  }

  .prov-grid {
    margin-top: var(--space-2);
    margin-bottom: 0;
  }

  .candidate-row {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }

  .candidate-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .cand-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .state-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .provenance {
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
  }

  .section-label {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: var(--space-2);
  }

  .provenance-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .prov-counts {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .placeholder {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
