<script lang="ts">
  /**
   * Button.svelte — Base button component.
   *
   * Variants: primary (accent fill) | ghost (outline) | danger (red fill).
   * Forwards all standard button attributes and the click event.
   *
   * Usage:
   *   <Button onclick={handler}>Label</Button>
   *   <Button variant="ghost" disabled>Cancel</Button>
   *   <Button variant="danger" onclick={onDelete}>Delete</Button>
   */

  import type { Snippet } from "svelte";

  interface Props {
    /** Visual style. Defaults to 'primary'. */
    variant?: "primary" | "ghost" | "danger";
    /** Whether the button is non-interactive. */
    disabled?: boolean;
    /** Button type attribute. */
    type?: "button" | "submit" | "reset";
    /** Click handler. */
    onclick?: (e: MouseEvent) => void;
    /** Button label content. */
    children: Snippet;
    /** Additional CSS classes to merge onto the element. */
    class?: string;
  }

  let {
    variant = "primary",
    disabled = false,
    type = "button",
    onclick,
    children,
    class: extraClass = "",
  }: Props = $props();
</script>

<button
  {type}
  {disabled}
  {onclick}
  class="btn btn--{variant} {extraClass}"
  aria-disabled={disabled}
>
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1.4;
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      background 150ms ease,
      border-color 150ms ease,
      box-shadow 150ms ease,
      transform 120ms var(--ease-out),
      opacity 150ms ease;
    user-select: none;
    white-space: nowrap;
  }

  .btn:active:not(:disabled) {
    transform: translateY(1px);
  }

  .btn:disabled,
  .btn[aria-disabled="true"] {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
  }

  /* Primary — Carbon+Green accent fill */
  .btn--primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }

  .btn--primary:hover:not(:disabled) {
    filter: brightness(1.1);
    box-shadow: 0 4px 18px color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .btn--primary:active:not(:disabled) {
    background: var(--accent-press);
    border-color: var(--accent-press);
  }

  /* Ghost — transparent with border */
  .btn--ghost {
    background: transparent;
    color: var(--text-dim);
    border-color: var(--border);
  }

  .btn--ghost:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-2);
    border-color: var(--border);
  }

  /* Danger — transparent with bad-tone border + text */
  .btn--danger {
    background: transparent;
    color: var(--bad);
    border-color: var(--bad);
  }

  .btn--danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }
</style>
