<script lang="ts">
  /**
   * Stat.svelte — Labeled metric component for diagnostics / HUD displays.
   *
   * Usage:
   *   <Stat label="FPS" value={30} />
   *   <Stat label="RTT" value={45} unit="ms" />
   *   <Stat label="Loss" value="2.1%" tone="warn" />
   *   <Stat label="State" value="streaming" tone="good" />
   */

  type Tone = "good" | "warn" | "bad" | "neutral" | "default" | "success" | "danger";

  interface Props {
    /** The metric's label (e.g. "FPS", "RTT"). */
    label: string;
    /** The metric value to display. Pass null / undefined to show a placeholder. */
    value: string | number | null | undefined;
    /** Optional unit appended after the value (e.g. "ms", "kbps"). */
    unit?: string;
    /**
     * Colour tone applied to the value text.
     * 'good' → accent green; 'warn' → amber; 'bad' → red; 'neutral'/'default' → primary text.
     */
    tone?: Tone;
  }

  let { label, value, unit, tone = "neutral" }: Props = $props();

  const displayValue = $derived(
    value === null || value === undefined ? "—" : String(value)
  );
</script>

<div class="stat">
  <span class="stat__label">{label}</span>
  <span class="stat__value stat__value--{tone}">
    {displayValue}{#if unit && value !== null && value !== undefined}<span class="stat__unit">{unit}</span>{/if}
  </span>
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .stat__label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
  }

  .stat__value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.2;
    color: var(--text);
  }

  .stat__unit {
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-dim);
    margin-left: 2px;
  }

  /* Tones */
  .stat__value--good    { color: var(--accent); }
  .stat__value--warn    { color: var(--warn); }
  .stat__value--bad     { color: var(--bad); }
  .stat__value--neutral { color: var(--text); }
  .stat__value--default { color: var(--text); }
  /* Legacy aliases kept for backward compatibility */
  .stat__value--success { color: var(--accent); }
  .stat__value--danger  { color: var(--bad); }
</style>
