<script lang="ts">
  /**
   * Panel.svelte — Titled container with a slot for content.
   *
   * Usage:
   *   <Panel title="Connection Status">
   *     <p>Content goes here</p>
   *   </Panel>
   *
   *   <Panel title="Settings" headerRight={actionSnippet}>
   *     ...
   *   </Panel>
   */

  import type { Snippet } from "svelte";

  interface Props {
    /** Panel heading text. */
    title: string;
    /** Optional snippet rendered in the header's right side (e.g. a button). */
    headerRight?: Snippet;
    /** Panel body content. */
    children: Snippet;
    /** Additional CSS classes on the root element. */
    class?: string;
  }

  let {
    title,
    headerRight,
    children,
    class: extraClass = "",
  }: Props = $props();
</script>

<section class="panel {extraClass}">
  <header class="panel__header">
    <h2 class="panel__title">{title}</h2>
    {#if headerRight}
      <div class="panel__header-right">
        {@render headerRight()}
      </div>
    {/if}
  </header>

  <div class="panel__body">
    {@render children()}
  </div>
</section>

<style>
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    gap: var(--space-3);
  }

  .panel__title {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .panel__header-right {
    flex-shrink: 0;
  }

  .panel__body {
    padding: var(--space-4);
  }
</style>
