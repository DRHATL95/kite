<script lang="ts">
  /**
   * NetworkPanel.svelte — Network / ICE diagnostics from DiagnosticsSnapshot.
   *
   * Shows: rttMs, localCandidateType / remoteCandidateType as Badges (relay
   * is highlighted warn since it is the key Spec-3 signal), candidatePairState,
   * iceConnectionState / iceGatheringState / connectionState, and ICE provenance
   * (source + stunCount/turnCount + remoteCandidatesAdded + icePollAttemptsUsed).
   */

  import Panel from "$lib/design/Panel.svelte";
  import Stat from "$lib/design/Stat.svelte";
  import Badge from "$lib/design/Badge.svelte";
  import type { DiagnosticsSnapshot, CandidateType } from "$lib/connection/types.js";

  interface Props {
    snapshot: DiagnosticsSnapshot | null;
  }

  let { snapshot }: Props = $props();

  // ── Candidate-type badge tone ────────────────────────────────────────────────

  type BadgeTone = "success" | "warn" | "danger" | "neutral";

  function candidateTone(type: CandidateType | null | undefined): BadgeTone {
    switch (type) {
      case "relay":  return "warn";    // relay = TURN; key Spec-3 signal
      case "srflx":  return "success";
      case "host":   return "neutral";
      case "prflx":  return "neutral";
      default:       return "neutral";
    }
  }

  // ── Connection state badge tone ──────────────────────────────────────────────

  function connTone(state: string | null | undefined): BadgeTone {
    switch (state) {
      case "connected":
      case "completed":   return "success";
      case "checking":
      case "gathering":
      case "new":         return "warn";
      case "disconnected":
      case "failed":
      case "closed":      return "danger";
      default:            return "neutral";
    }
  }

  // ── ICE provenance tone ──────────────────────────────────────────────────────

  const provenanceTone = $derived((): BadgeTone => {
    switch (snapshot?.source) {
      case "xbox-provided": return "success";
      case "fallback-only": return "danger";
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
    <Stat label="RTT" value={snapshot?.rttMs ?? null} unit="ms" />
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
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-text-dim);
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
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
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

  .provenance-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .prov-counts {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
  }

  .placeholder {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text-dim);
  }
</style>
