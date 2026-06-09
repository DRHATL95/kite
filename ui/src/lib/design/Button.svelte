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
    line-height: 1.4;
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      border-color var(--transition-fast),
      opacity var(--transition-fast);
    user-select: none;
    white-space: nowrap;
  }

  .btn:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  .btn:disabled,
  .btn[aria-disabled="true"] {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
  }

  /* Primary — Xbox green fill */
  .btn--primary {
    background: var(--color-accent);
    color: #ffffff;
    border-color: var(--color-accent);
  }

  .btn--primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }

  /* Ghost — outline only */
  .btn--ghost {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn--ghost:hover:not(:disabled) {
    background: var(--color-surface-2);
    border-color: var(--color-text-dim);
  }

  /* Danger — red fill */
  .btn--danger {
    background: var(--color-danger);
    color: #ffffff;
    border-color: var(--color-danger);
  }

  .btn--danger:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
