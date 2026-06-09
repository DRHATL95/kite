<script lang="ts">
  /**
   * Stat.svelte — Labeled metric component for diagnostics / HUD displays.
   *
   * Usage:
   *   <Stat label="FPS" value={30} />
   *   <Stat label="RTT" value={45} unit="ms" />
   *   <Stat label="Loss" value="2.1%" tone="warn" />
   *   <Stat label="State" value="streaming" tone="success" />
   */

  type Tone = "default" | "success" | "warn" | "danger";

  interface Props {
    /** The metric's label (e.g. "FPS", "RTT"). */
    label: string;
    /** The metric value to display. Pass null / undefined to show a placeholder. */
    value: string | number | null | undefined;
    /** Optional unit appended after the value (e.g. "ms", "kbps"). */
    unit?: string;
    /**
     * Colour tone applied to the value text.
     * 'default' uses the primary text colour.
     */
    tone?: Tone;
  }

  let { label, value, unit, tone = "default" }: Props = $props();

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
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
  }

  .stat__value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.2;
    color: var(--color-text);
  }

  .stat__unit {
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--color-text-dim);
    margin-left: 2px;
  }

  /* Tones */
  .stat__value--success { color: var(--color-success); }
  .stat__value--warn    { color: var(--color-warn); }
  .stat__value--danger  { color: var(--color-danger); }
  .stat__value--default { color: var(--color-text); }
</style>
