<script lang="ts">
  /**
   * LogViewer — live, filterable log panel for the DiagnosticsHud.
   * Merges the logger's local mirror (instant) with periodic backend snapshots
   * (authoritative, interleaves Rust + UI). Level filter, search, copy, export,
   * open-folder, and the verbose toggle.
   */
  import { logStore } from "$lib/log/logStore.svelte.js";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { getRecentLogs, exportLogs, openLogDir, setLogVerbosity } from "$lib/ipc/commands.js";

  const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

  // Periodically pull the authoritative interleaved snapshot from Rust.
  $effect(() => {
    const id = setInterval(() => {
      getRecentLogs(2000)
        .then((recs) => logStore.replace(recs))
        .catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  });

  async function copy() {
    const text = logStore.filtered
      .map((r) => `${r.ts} ${r.level} ${r.target}: ${r.message}`)
      .join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  }

  function toggleVerbose() {
    settings.setLogVerbose(!settings.logVerbose);
    void setLogVerbosity(settings.logVerbose);
  }
</script>

<div class="logview">
  <div class="logview__bar">
    <select bind:value={logStore.minLevel} aria-label="Minimum level">
      {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
    </select>
    <input placeholder="search…" bind:value={logStore.search} aria-label="Search logs" />
    <button onclick={toggleVerbose} class:on={settings.logVerbose} title="Verbose/diagnostic capture">
      {settings.logVerbose ? "Verbose ON" : "Verbose"}
    </button>
    <button onclick={copy}>Copy</button>
    <button onclick={() => void exportLogs()}>Export</button>
    <button onclick={() => void openLogDir()}>Folder</button>
  </div>
  <ul class="logview__list">
    {#each logStore.filtered as r (r.ts + r.message)}
      <li class="logview__row logview__row--{r.level.toLowerCase()}">
        <span class="logview__lvl">{r.level}</span>
        <span class="logview__tgt">{r.target}</span>
        <span class="logview__msg">{r.message}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .logview { display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; }
  .logview__bar { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .logview__bar button.on { color: var(--accent); border-color: var(--accent); }
  .logview__list {
    list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 50vh;
    font-family: var(--font-mono); font-size: var(--text-xs);
  }
  .logview__row { display: flex; gap: var(--space-2); padding: 1px 0; white-space: pre-wrap; word-break: break-word; }
  .logview__lvl { flex: 0 0 auto; width: 3.5em; color: var(--text-dim); }
  .logview__tgt { flex: 0 0 auto; color: var(--text-dim); }
  .logview__row--warn .logview__lvl { color: var(--warn); }
  .logview__row--error .logview__lvl { color: var(--bad); }
  .logview__msg { flex: 1 1 auto; }
</style>
