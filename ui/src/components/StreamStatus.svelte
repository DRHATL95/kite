<script lang="ts">
  /**
   * StreamStatus.svelte — Compact overlay showing session state + reconnect info.
   *
   * Reads connectionStore.state (SessionState) and maps it to a colour-coded
   * Badge.  When the state is 'reconnecting', also shows attempt counts from
   * connectionStore.snapshot.
   */

  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import Badge from "$lib/design/Badge.svelte";

  type BadgeTone = "success" | "warn" | "danger" | "neutral";

  /** Map SessionState → Badge tone. */
  function stateTone(state: string): BadgeTone {
    switch (state) {
      case "streaming":    return "success";
      case "connecting":   return "warn";
      case "reconnecting": return "warn";
      case "failed":       return "danger";
      default:             return "neutral";
    }
  }

  /** Human-readable label for the session state. */
  function stateLabel(state: string): string {
    switch (state) {
      case "idle":         return "Idle";
      case "connecting":   return "Connecting";
      case "streaming":    return "Streaming";
      case "reconnecting": return "Reconnecting";
      case "failed":       return "Failed";
      default:             return state;
    }
  }
</script>

<div class="stream-status" role="status" aria-live="polite" aria-atomic="true">
  <Badge tone={stateTone(connectionStore.state)}>
    {stateLabel(connectionStore.state)}
  </Badge>

  {#if connectionStore.state === "reconnecting" && connectionStore.snapshot}
    <span class="reconnect-info">
      Attempt {connectionStore.snapshot.currentAttempt} / {connectionStore.snapshot.maxAttempts}
      {#if connectionStore.snapshot.lastTriggerReason}
        &mdash; {connectionStore.snapshot.lastTriggerReason}
      {/if}
    </span>
  {/if}
</div>

<style>
  .stream-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    border-radius: var(--radius-sm);
  }

  .reconnect-info {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    white-space: nowrap;
  }
</style>
