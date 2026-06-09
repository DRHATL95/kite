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

  type Tone = "success" | "warn" | "danger" | "neutral";

  interface Props {
    /** Colour tone of the badge. Defaults to 'neutral'. */
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
    border-radius: var(--radius-lg);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.4;
    white-space: nowrap;
  }

  /* Neutral */
  .badge--neutral {
    background: var(--color-surface-2);
    color: var(--color-text-dim);
    border: 1px solid var(--color-border);
  }

  /* Success */
  .badge--success {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
    border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
  }

  /* Warn */
  .badge--warn {
    background: color-mix(in srgb, var(--color-warn) 15%, transparent);
    color: var(--color-warn);
    border: 1px solid color-mix(in srgb, var(--color-warn) 30%, transparent);
  }

  /* Danger */
  .badge--danger {
    background: color-mix(in srgb, var(--color-danger) 15%, transparent);
    color: var(--color-danger);
    border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
  }
</style>
