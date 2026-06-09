<script lang="ts">
  /**
   * Badge.svelte — Status pill component.
   *
   * Renders a small, coloured label chip indicating a status.
   * Tones map to the design-system colour tokens.
   *
   * Usage:
   *   <Badge tone="success">Connected</Badge>
   *   <Badge tone="warn">Reconnecting</Badge>
   *   <Badge tone="danger">Failed</Badge>
   *   <Badge tone="neutral">Idle</Badge>
   */

  import type { Snippet } from "svelte";

  type Tone = "good" | "success" | "warn" | "bad" | "danger" | "neutral";

  interface Props {
    /** Colour tone of the badge. Defaults to 'neutral'.
   * 'good'/'success' → accent green; 'warn' → amber; 'bad'/'danger' → red. */
    tone?: Tone;
    /** Badge text content. */
    children: Snippet;
    /** Additional CSS classes. */
    class?: string;
  }

  let { tone = "neutral", children, class: extraClass = "" }: Props = $props();
</script>

<span class="badge badge--{tone} {extraClass}" role="status">
  {@render children()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 1.4;
    white-space: nowrap;
  }

  /* Neutral — dimmed, outlined */
  .badge--neutral {
    background: color-mix(in srgb, var(--text-dim) 12%, transparent);
    color: var(--text-dim);
    border: 1px solid var(--text-dim);
  }

  /* Success / good → accent (healthy/active) */
  .badge--success,
  .badge--good {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border: 1px solid var(--accent);
  }

  /* Warn → warn token */
  .badge--warn {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
    border: 1px solid var(--warn);
  }

  /* Danger / bad → bad token */
  .badge--danger,
  .badge--bad {
    background: color-mix(in srgb, var(--bad) 12%, transparent);
    color: var(--bad);
    border: 1px solid var(--bad);
  }
</style>
